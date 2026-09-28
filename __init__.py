# -*- coding: utf-8 -*-
"""
ComfyUI_KeDou —— 修图工坊 · ComfyUI 桥接（v2：直接对接原生「应用模式」）

作用：让 PS 插件读出 ComfyUI 里的「应用」，以及每个应用的参数。
      ComfyUI 默认没有"列出我的工作流"的接口，本扩展补上。

数据来源：原生应用 = <ComfyUI>/user/default/workflows/**/*.json 里
      * 文件名以 .app.json 结尾，或
      * extra.linearMode == true
      参数定义 = extra.linearData.inputs，形如 [["<图uuid>:<节点id>:<控件名>", "<控件名>"], ...]
      输出     = extra.linearData.outputs（节点 id 列表）
自研应用包：*.kapp.json（kedou_app: 1）—— graph 直接存 API 格式（无 UI→API 翻译、
      无 widgets_values 位置对位），params 逐条声明 node+input+widget，outputs 显式列出。
      同 stem 同时存在 .kapp.json 与 .app.json 时 kapp 优先。打包：POST /ps/pack。

路由：
      GET  /ps/apps                    -> {"apps":[{id,name,desc,param_count,has_image_input,node_count,format}]}
      GET  /ps/apps/{app_id}           -> {id,name,params:[...],outputs:[...]}
      POST /ps/apps/{app_id}/values    -> 把面板上的编辑写回工作流文件
      POST /ps/apps/{app_id}/graph     -> 界面格式转 API 格式（可直接 POST /prompt）
      GET  /ps/media                   -> {ok,items:[{name,subfolder,kind,tab,size,mtime,url}]}
      GET  /ps/pack/candidates         -> {ok,source,candidates:[{node,input,label,node_type,widget,default}]}
      POST /ps/pack                    -> {ok,file,param_count,node_count,outputs}（生成 .kapp.json）
      POST /ps/pack/save               -> {ok,file,param_count,node_count}（kapp 打包面板专用：前端已构好 API 图，只校验+落盘）

自定义节点（NODE_CLASS_MAPPINGS）：
      KedouImageLoader  蝌蚪图片加载器 —— 在面板上多选图片，一张图一路 IMAGE 输出（最多 10 路）
      节点上的缩略图网格由前端扩展 web/kedou_media.js 渲染，
      值以 JSON 写入隐藏控件 media_state，故启动器 / PS 插件也可直接驱动。

安装：把整个 ComfyUI_KeDou/ 文件夹放进 <ComfyUI>/custom_nodes/ 即可（自包含，一个文件夹就是全部）：
      ComfyUI_KeDou/
          __init__.py          本文件（HTTP 路由 + 自定义节点）
          ui_to_api.py         界面格式 → API 格式转换（由 _load_converter 就地加载）
          web/kedou_media.js   节点前端扩展（媒体组缩略图网格 + 媒体选择器）
      插件名取目录名 ComfyUI_KeDou。启动器的插件白名单按 os.listdir() 的原始条目名
      匹配，故插件预设里应写 `ComfyUI_KeDou`。
      改完重启 ComfyUI。
"""

from __future__ import annotations

import copy
import json
import os
import re

# ---- 只有在 ComfyUI 里才有这两个依赖；单独跑脚本做测试时允许缺失 ----
try:
    from aiohttp import web
    from server import PromptServer
    _HAS_COMFY = True
except Exception:                                   # noqa: BLE001
    web = None
    PromptServer = None
    _HAS_COMFY = False

try:
    from nodes import NODE_CLASS_MAPPINGS as _NODE_MAP
except Exception:                                   # noqa: BLE001
    _NODE_MAP = {}

def _find_comfy_root() -> str:
    """
    从本文件往上找到「包含 custom_nodes 的那一层」= ComfyUI 根目录。

    不能写死 os.path.dirname(os.path.dirname(__file__))：
       单文件插件形态（custom_nodes/x.py）算出来正好是 ComfyUI，
       但文件夹包形态（custom_nodes/x/__init__.py）会算成 custom_nodes，
       于是 WORKFLOW_DIR 指向不存在的地方 → /ps/apps 返回空列表、
       启动器和 PS 插件上「一个应用都没有」，且不报任何错误（最难查的情况）。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    for _ in range(6):
        if os.path.isdir(os.path.join(here, "custom_nodes")):
            return here
        up = os.path.dirname(here)
        if up == here:
            break
        here = up
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # 非标准安装的兜底


COMFY_ROOT = _find_comfy_root()
WORKFLOW_DIR = os.path.join(COMFY_ROOT, "user", "default", "workflows")
if not os.path.isdir(os.path.join(COMFY_ROOT, "custom_nodes")):
    # 启动自检：根目录推断错误时立即报出，避免应用列表为空却无任何提示
    print("[KeDou] 警告：ComfyUI 根目录推断可能不对 -> %s" % COMFY_ROOT)

# 前端扩展目录 —— 本插件是「一个文件夹」的包形态，所以就是包内的 web/。
# 访问路径 = /extensions/ComfyUI_KeDou/kedou_media.js
#   命名取模块名（= 目录名 ComfyUI_KeDou），不是 WEB_DIRECTORY 的名字。
# 为什么现在能安心用 "./web"：
#   包形态下 nodes.py 的 module_dir = 包目录本身，而目录插件只加载 __init__.py，
#   包内的 .py / .js 不会被当插件重复加载。
#   注意：单文件插件形态下 module_dir 为 custom_nodes/ 本身，"./web" 会指向
#   所有单文件插件共享的 custom_nodes/web，该形态需另起目录。
WEB_DIRECTORY = "./web"

# 这些节点类型代表"要一张图进来"
IMAGE_LOADERS = {
    "LoadImage", "LoadImageMask", "LoadImageOutput", "ImageOnlyCheckpointLoader",
    "Load Image (Base64)", "ETN_LoadImageBase64", "LoadImageFromUrl",
}
# 管道参数：不暴露到面板（属于工作流作者范畴，非面向用户的可调项）
NOISE_INPUTS = {"filename_prefix"}

# 给面板用的中文类型名
KIND_CN = {"text": "提示词", "number": "数值", "bool": "开关", "image": "图像"}

# 下拉选项最多带多少条（LoadImage 的文件名列表可能上千条，对面板没意义还占体积）
OPTIONS_CAP = 200

# 控件名 -> 面向修图师的兜底标签
FALLBACK_LABEL = {
    "prompt": "提示词", "text": "文本", "text1": "文本 1", "text2": "文本 2",
    "positive": "正向提示词", "negative": "负向提示词",
    "value": "数值", "image": "图像", "mask": "蒙版",
    "filename_prefix": "文件名前缀", "seed": "随机种子",
    "steps": "步数", "cfg": "引导强度", "denoise": "重绘幅度",
    "width": "宽度", "height": "高度", "scale": "缩放", "strength": "强度",
}


# ---------------------------------------------------------------- 基础工具
def _safe_id(app_id: str) -> bool:
    """防路径穿越：只允许纯文件名（不含 / \\ 和 ..）"""
    return bool(app_id) and "/" not in app_id and "\\" not in app_id and ".." not in app_id


def _clean_label(node: dict, widget: str) -> str:
    """
    显示名优先取节点标题；"#01. Pos Prompt" 这种去掉 #序号前缀后仍可读。
    标题为空或只剩 #序号 时，退回按控件名给的兜底名。
    """
    title = (node.get("title") or "").strip()
    if title:
        stripped = re.sub(r"^#\s*\d+\s*[.、:]?\s*", "", title).strip()
        if stripped:
            return stripped
    return FALLBACK_LABEL.get(widget, widget)


def _kind_of(node: dict, widget: str, default) -> str:
    """把控件归成四种输入类型：image / number / bool / text"""
    ntype = str(node.get("type") or "")
    if ntype in IMAGE_LOADERS and widget in ("image", "mask"):
        return "image"
    if ntype.startswith("Primitive") or widget in ("seed", "steps", "cfg", "denoise",
                                                   "width", "height", "scale", "value"):
        if isinstance(default, bool):
            return "bool"
        if isinstance(default, (int, float)):
            return "number"
    if isinstance(default, bool):
        return "bool"
    if isinstance(default, (int, float)):
        return "number"
    return "text"


def _widget_values(node: dict) -> list:
    wv = node.get("widgets_values")
    if isinstance(wv, list):
        return wv
    if isinstance(wv, dict):
        return list(wv.values())
    if wv is None:
        return []
    return [wv]


def _split_ref(ref: str):
    """节点引用形如 "<图uuid>:<节点id>:<控件名>"，也见过 "<节点id>:<控件名>"。"""
    parts = str(ref).split(":")
    if len(parts) >= 3:
        return parts[-2], parts[-1]
    if len(parts) == 2:
        return parts[0], parts[1]
    return str(ref), ""


# ---------------------------------------------------------------- 应用解析
def is_app_workflow(data: dict, filename: str = "") -> bool:
    if filename.lower().endswith("app.json"):
        return True
    extra = data.get("extra") or {}
    return bool(extra.get("linearMode"))


def find_app_files(root: str = None) -> list:
    root = root or WORKFLOW_DIR
    out = []
    for r, _dirs, files in os.walk(root):
        for fn in files:
            if fn.startswith(".") or not fn.lower().endswith(".json"):
                continue
            low = fn.lower()
            if low.endswith(".kapp.json") or low.endswith("app.json"):
                out.append(os.path.join(r, fn))
    # 同 stem 同时有 .kapp.json 与 .app.json：kapp 优先（自研格式遮蔽官方格式）
    by_stem = {}
    for p in out:
        stem = _stem(os.path.basename(p)).lower()
        prev = by_stem.get(stem)
        if prev is None or (p.lower().endswith(".kapp.json")
                            and not prev.lower().endswith(".kapp.json")):
            by_stem[stem] = p
    return sorted(by_stem.values())


def build_object_info(types) -> dict:
    """
    从 ComfyUI 自己的节点注册表取输入声明（不必走 HTTP）。
    返回结构与 /object_info 一致：{type: {"input": {required, optional}, "output": [...]}}
    output = RETURN_TYPES（打包校验连线槽号要用）。
    """
    if not _NODE_MAP:
        return {}
    out = {}
    for t in types:
        cls = _NODE_MAP.get(t)
        if cls is None:
            continue
        try:
            it = cls.INPUT_TYPES()
        except Exception:                            # noqa: BLE001
            continue
        try:
            rt = [str(x) for x in (cls.RETURN_TYPES or ())]
        except Exception:                            # noqa: BLE001
            rt = []
        out[t] = {"input": {"required": it.get("required", {}) or {},
                            "optional": it.get("optional", {}) or {}},
                  "output": rt}
    return out


def _stem(filename: str) -> str:
    """应用名 = 文件名去掉 .kapp.json / .app.json / .json 后缀（ComfyUI 应用列表也按文件名显示）"""
    low = filename.lower()
    if low.endswith(".kapp.json"):
        return filename[:-len(".kapp.json")]
    if low.endswith(".app.json"):
        return filename[:-len(".app.json")]
    if low.endswith(".json"):
        return filename[:-len(".json")]
    return filename


def _rel(path: str) -> str:
    """相对 ComfyUI 根目录；跨盘符时 relpath 会抛异常，退回绝对路径。"""
    try:
        return os.path.relpath(path, COMFY_ROOT).replace("\\", "/")
    except Exception:                                # noqa: BLE001
        return str(path).replace("\\", "/")


def build_spec(path: str, object_info: dict = None) -> dict:
    """读一个应用文件，产出面板要用的规格。object_info 省略时自动从节点注册表取。"""
    if os.path.basename(path).lower().endswith(".kapp.json"):
        return build_kapp_spec(path, object_info)
    with open(path, "r", encoding="utf-8") as f:
        wf = json.load(f)

    nodes = wf.get("nodes") or []
    by_id = {str(n.get("id")): n for n in nodes}
    meta = wf.get("extra") or {}
    ld = meta.get("linearData") or {}
    if object_info is None and _NODE_MAP:
        object_info = build_object_info(sorted({str(n.get("type")) for n in nodes}))

    # 应用名 = 文件名去掉 .app.json / .json 后缀（ComfyUI 的「应用」列表也是按文件名显示的）
    stem = _stem(os.path.basename(path))
    app_id = stem

    params = []
    for entry in (ld.get("inputs") or []):
        if not isinstance(entry, (list, tuple)) or len(entry) < 2:
            continue
        node_id = _split_ref(entry[0])[0]
        widget = str(entry[1])
        node = by_id.get(str(node_id))
        if node is None:
            continue
        wv = _widget_values(node)
        default = wv[0] if wv else None
        kind = _kind_of(node, widget, default)
        node_type = str(node.get("type") or "")
        item = {
            "node": str(node_id),
            "input": widget,
            "label": _clean_label(node, widget),
            "kind": kind,
            "default": default,
            "spec": widget_spec(object_info, node_type, widget),
            "node_type": node_type,
            "node_title": (node.get("title") or "").strip(),
        }
        if kind == "image":
            item["source"] = "canvas"          # 默认取 PS 当前画布（见设计文档）
            item["spec"].pop("options", None)  # 图像输入由 PS 供给，不需要候选文件名列表
            item["spec"].pop("options_truncated", None)
        if widget in NOISE_INPUTS:
            item["hidden"] = True              # 管道参数，面板不显示
        params.append(item)

    # 标签去重：多个字段同名时自动加序号，免得面板上出现一排一模一样的输入框。
    # （在 ComfyUI 中为节点起有意义的名称可从根本上避免；此处为兜底）
    dup = {}
    for p in params:
        if not p.get("hidden"):
            dup[p["label"]] = dup.get(p["label"], 0) + 1
    seq = {}
    for p in params:
        if p.get("hidden"):
            continue
        base_label = p["label"]
        if dup[base_label] > 1:
            seq[base_label] = seq.get(base_label, 0) + 1
            p["label"] = "%s %d" % (base_label, seq[base_label])

    # 面向人的一句话概述
    tally = {}
    for p in params:
        if p.get("hidden"):
            continue
        tally[p["kind"]] = tally.get(p["kind"], 0) + 1
    desc = " · ".join("%d 个%s" % (v, KIND_CN.get(k, k)) for k, v in tally.items()) \
        or "无可调参数"

    return {
        "id": app_id,
        "name": stem,
        "desc": desc,
        "path": _rel(path),
        "params": params,
        "outputs": [str(x) for x in (ld.get("outputs") or [])],
        "param_count": sum(1 for p in params if not p.get("hidden")),
        "node_count": len(nodes),
        "has_image_input": any(p["kind"] == "image" for p in params),
        "has_subgraph": bool((wf.get("definitions") or {}).get("subgraphs")),
        "linear_mode": bool(meta.get("linearMode")),
        "filename": os.path.basename(path),
    }


def list_apps() -> list:
    apps = []
    for p in find_app_files():
        fname = os.path.basename(p)
        fmt = "kapp" if fname.lower().endswith(".kapp.json") else "official"
        try:
            spec = build_spec(p)
        except Exception as e:                       # noqa: BLE001
            # 不静默吞掉：把错误带出去，方便排查
            apps.append({"id": fname, "name": fname, "desc": "", "param_count": 0,
                         "node_count": 0, "has_image_input": False,
                         "linear_mode": False, "filename": fname, "format": fmt,
                         "error": "%s: %s" % (type(e).__name__, e)})
            continue
        item = {k: spec[k] for k in
                ("id", "name", "desc", "param_count", "node_count",
                 "has_image_input", "linear_mode", "filename")}
        item["format"] = fmt
        apps.append(item)
    return apps


def get_app(app_id: str, object_info: dict = None):
    if not _safe_id(app_id):
        return None
    for p in find_app_files():
        base = os.path.basename(p)
        if _stem(base) == app_id or base == app_id:
            return build_spec(p, object_info)
    return None


# ---------------------------------------------------------------- 控件下标
_WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}


def _is_widget_spec(spec) -> bool:
    # 注意：ComfyUI 的 INPUT_TYPES() 惯例返回元组 ("STRING", {...})，
    # 只有经 /object_info 走 JSON 序列化后才变成列表。两种都要认 ——
    # 只认 list 的话，服务端构建 object_info 时会把所有控件判为无效，
    # 静默退化成 STRING（表现为：数值框变成单行文本、multiline 丢失）。
    if not isinstance(spec, (list, tuple)) or not spec:
        return False
    t = spec[0]
    if isinstance(t, (list, tuple)):
        return True          # 内联下拉选项
    if isinstance(t, str):
        return t in _WIDGET_TYPES or t.startswith("COMBO")
    return False


def _declared_widgets(object_info: dict, class_type: str) -> list:
    """按声明顺序返回该类型的控件名（与 widgets_values 位置对齐）。"""
    info = (object_info or {}).get(class_type)
    if not info:
        return []
    declared = info.get("input", {})
    names = []
    for section in ("required", "optional"):
        for nm, spec in (declared.get(section) or {}).items():
            if _is_widget_spec(spec):
                names.append(nm)
    return names


def _ctl_after_gen(object_info: dict, class_type: str, name: str) -> bool:
    info = (object_info or {}).get(class_type)
    if not info:
        return False
    for section in ("required", "optional"):
        spec = (info.get("input", {}).get(section) or {}).get(name)
        if isinstance(spec, (list, tuple)) and len(spec) > 1 and isinstance(spec[1], dict):
            return bool(spec[1].get("control_after_generate"))
    return False


def _widget_index(object_info: dict, class_type: str, name: str):
    names = _declared_widgets(object_info, class_type)
    if name not in names:
        return None
    idx = 0
    for n in names:
        if n == name:
            return idx
        idx += 1
        if _ctl_after_gen(object_info, class_type, n):
            idx += 1
    return None


# ------------------------------------------------- 控件规格（通用，零应用定制）
#
# 设计原则：插件是纯通道。
#   应用由任何人用 ComfyUI 的 App Builder 搭好，接上就能用；
#   不允许出现"针对某个应用/某个特定节点"的特判（那等于插件作者在替别人接线）。
#
# 所以这里只做类型驱动的通用推断：控件长什么样，完全由节点自己声明的规格决定。
# 面板怎么画（文本框/滑杆/下拉/分段选择器）属于"呈现"，归 PS 侧按 spec 自行决定。


def _find_spec(object_info: dict, class_type: str, name: str):
    """在 object_info 里取出某类型某控件的 (声明类型, 选项字典)。"""
    info = (object_info or {}).get(class_type)
    if not info:
        return None, {}
    for section in ("required", "optional"):
        spec = (info.get("input", {}).get(section) or {}).get(name)
        if isinstance(spec, (list, tuple)) and spec:
            opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
            return spec[0], opts
    return None, {}


def widget_spec(object_info: dict, class_type: str, name: str) -> dict:
    """
    给面板用的控件规格，完全由节点声明推导：
      {"type": "INT|FLOAT|STRING|COMBO|BOOLEAN|…",
       "min","max","step","options","multiline","range_size"}
    range_size 只在能算出来时给（面板可用它决定是否渲染成分段选择器）。
    """
    first, opts = _find_spec(object_info, class_type, name)
    out = {"type": "STRING"}
    if isinstance(first, list):
        out["type"] = "COMBO"
        vals = [str(x) for x in first]
        if len(vals) > OPTIONS_CAP:
            vals = vals[:OPTIONS_CAP]
            out["options_truncated"] = True
        out["options"] = vals
    elif isinstance(first, str):
        out["type"] = first
        # 自定义类型名也可能带选项列表（如 ResolutionSelector 的 aspect_ratio）：
        # 有 choices/options 就一并给出，避免下拉在应用中退化为输入框
        ch = opts.get("choices") or opts.get("options")
        if isinstance(ch, (list, tuple)) and ch:
            vals = [str(x) for x in ch]
            if len(vals) > OPTIONS_CAP:
                vals = vals[:OPTIONS_CAP]
                out["options_truncated"] = True
            out["options"] = vals
    for k in ("min", "max", "step"):
        if isinstance(opts.get(k), (int, float)):
            out[k] = opts[k]
    if isinstance(opts.get("multiline"), bool):
        out["multiline"] = opts["multiline"]
    if out["type"] in ("INT", "FLOAT") and "min" in out and "max" in out:
        step = out.get("step") or (1 if out["type"] == "INT" else 0.01)
        try:
            out["range_size"] = int(round((out["max"] - out["min"]) / step)) + 1
        except Exception:                            # noqa: BLE001
            pass
    return out


# ---------------------------------------------------------------- 回写工作流
def _find_path(app_id: str):
    for p in find_app_files():
        if _stem(os.path.basename(p)) == app_id or os.path.basename(p) == app_id:
            return p
    return None


def update_values(app_id: str, values: dict, object_info: dict = None) -> dict:
    """
    把 {“<节点id>:<控件名>”: 值} 写回工作流文件（方案 A：提示词库住在工作流里）。
    第一次写之前会留一份 .bak 备份。
    """
    path = _find_path(app_id)
    if path is None:
        return {"ok": False, "error": "app not found: %s" % app_id}

    with open(path, "r", encoding="utf-8") as f:
        wf = json.load(f)
    by_id = {str(n.get("id")): n for n in (wf.get("nodes") or [])}
    if object_info is None and _NODE_MAP:
        object_info = build_object_info(sorted(set(str(n.get("type")) for n in wf.get("nodes") or [])))

    changed, failed = [], []
    for key, val in (values or {}).items():
        nid, _, widget = str(key).partition(":")
        node = by_id.get(str(nid))
        if node is None:
            failed.append({"key": key, "why": "no such node"})
            continue
        ntype = str(node.get("type") or "")
        idx = _widget_index(object_info, ntype, widget) if object_info else None
        wv = node.get("widgets_values")
        if idx is None:
            # 没有 object_info 或名字对不上：退一步，若只有一个值就直接写
            if isinstance(wv, list) and len(wv) == 1:
                idx = 0
            elif not isinstance(wv, list):
                node["widgets_values"] = [val]
                changed.append(key)
                continue
            else:
                failed.append({"key": key, "why": "cannot locate widget index"})
                continue
        if not isinstance(wv, list):
            node["widgets_values"] = [val]
            changed.append(key)
            continue
        while len(wv) <= idx:
            wv.append(None)
        wv[idx] = val
        changed.append(key)

    if changed:
        bak = path + ".bak"
        if not os.path.exists(bak):
            try:
                with open(bak, "w", encoding="utf-8") as f:
                    json.dump(wf, f, ensure_ascii=False, indent=2)
            except Exception:                        # noqa: BLE001
                pass
        with open(path, "w", encoding="utf-8") as f:
            json.dump(wf, f, ensure_ascii=False, indent=2)

    return {"ok": not failed, "changed": changed, "failed": failed, "path": _rel(path)}


# ------------------------------------------------- 出图：应用 -> 可提交的 API 图
# 分工原则（保持桥接极薄）：
#   桥接只做需要 ComfyUI 内部知识的事 —— 应用发现、参数翻译、界面格式转 API 格式。
#   上传 / 提交 / 取结果全部走 ComfyUI 原生接口，桥接不重复实现：
#     POST /upload/image (multipart, subfolder=ps_upload, overwrite=true)
#     POST /prompt       API 图
#     GET  /history/{id} GET /view

_CONVERTER = None


def _load_converter():
    """加载同目录的 ui_to_api.py（custom_nodes 不在 sys.path 时按文件路径加载）。"""
    global _CONVERTER
    if _CONVERTER is not None:
        return _CONVERTER
    try:
        import ui_to_api as m                      # noqa: PLC0415
        _CONVERTER = m
        return m
    except Exception:                              # noqa: BLE001
        pass
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ui_to_api.py")
    if not os.path.exists(p):
        return None
    try:
        import importlib.util                      # noqa: PLC0415
        spec = importlib.util.spec_from_file_location("ui_to_api", p)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        _CONVERTER = m
        return m
    except Exception:                              # noqa: BLE001
        return None


def _inject_values(graph: dict, values: dict):
    """把面板值注入 API 图（官方格式与 kapp 共用）。

    连线保护：目标输入当前值是 [节点id, 槽号] 二元组 = 连线，跳过并报告；
    节点不在图 / 没有该输入名 = failed。绝不静默。
    """
    applied, skipped, failed = [], [], []
    for key, val in (values or {}).items():
        nid, _, widget = str(key).partition(":")
        node = graph.get(str(nid))
        if node is None:
            failed.append({"key": key, "why": "节点不在可执行图中（可能被静音/未安装）"})
            continue
        cur = (node.get("inputs") or {}).get(widget, "__MISSING__")
        if cur == "__MISSING__":
            failed.append({"key": key, "why": "该节点没有这个输入名"})
            continue
        if (isinstance(cur, list) and len(cur) == 2 and isinstance(cur[0], str)):
            skipped.append({"key": key, "why": "该输入是连线，不能直接赋值"})
            continue
        node["inputs"][widget] = val
        applied.append(key)
    return applied, skipped, failed


def build_graph(app_id: str, values: dict = None, object_info: dict = None) -> dict:
    """
    把应用转成可直接 POST /prompt 的 API 图，并注入面板上的值。
    values 形如 {"33:prompt": "文本", "119:value": 2, "114:image": "ps_upload/x.png"}
    """
    path = _find_path(app_id)
    if path is not None and _is_kapp(path):
        return _build_graph_kapp(path, values, object_info)
    conv = _load_converter()
    if conv is None:
        return {"ok": False, "error": "ui_to_api.py 未随桥接一起安装（两个文件都要）"}
    path = _find_path(app_id)
    if path is None:
        return {"ok": False, "error": "app not found: %s" % app_id}

    with open(path, "r", encoding="utf-8") as f:
        wf = json.load(f)
    nodes = wf.get("nodes") or []
    types = sorted({str(n.get("type")) for n in nodes})
    if object_info is None and _NODE_MAP:
        object_info = build_object_info(types)

    graph, notes = conv.convert_ex(wf, object_info or {})

    # 把值注入 API 图（API 图里的输入名就是控件名）
    applied, skipped, failed = _inject_values(graph, values)

    # 如实报出"被溶解掉的未知节点"，不静默（这类多半是未安装的自定义节点）
    sub_ids = set(str(s.get("id")) for s in
                  ((wf.get("definitions") or {}).get("subgraphs") or []))
    front_ok = {"PrimitiveNode", "Reroute", "Note", "MarkdownNote", "__Reroute"}
    unknown = {}
    for n in nodes:
        t = str(n.get("type"))
        if int(n.get("mode", 0)) != 0 or t in sub_ids or t in front_ok:
            continue
        if object_info and t not in object_info:
            unknown[t] = unknown.get(t, 0) + 1

    return {
        "ok": not failed,
        "graph": graph,
        "node_count": len(graph),
        "applied": applied,
        "skipped": skipped,
        "failed": failed,
        "float_notes": notes,                       # 子图展开说明
        "unknown_types": unknown,                   # 疑似未安装的节点
        "path": _rel(path),
    }


# ---------------------------------------------------------------- 自研应用包（kapp）
#
# 官方应用模式（linearMode）的三项额外成本：参数靠 linearData 勾选（勾到哪个控件就叫什么名）、
# widgets_values 按位置对位、每次运行都要 UI→API 翻译。kapp 把三样全部显式化：
#   * graph 直接存 API 格式（「导出 API 格式」同构）—— 没有翻译、没有位置对位；
#   * params 逐条声明 node + input + widget —— 插件不推断、不特判；
#   * outputs 显式列出 SaveImage 类节点 id。
# 打包：POST /ps/pack（source = 任意 UI 格式工作流，含 .app.json）。
# 插件仍是纯通道：声明是什么就是什么，不针对任何应用做特判。

_KAPP_WIDGETS = ("text", "number", "toggle", "combo", "image", "kedou_media")
_KAPP_KIND = {"text": "text", "number": "number", "toggle": "bool",
              "combo": "combo", "image": "image", "kedou_media": "text"}


def _is_kapp(path: str) -> bool:
    return os.path.basename(path).lower().endswith(".kapp.json")


def _load_kapp(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or int(data.get("kedou_app") or 0) != 1:
        raise ValueError("不是 kapp 应用包（缺少 kedou_app: 1）")
    if not isinstance(data.get("graph"), dict) or not data["graph"]:
        raise ValueError("kapp 缺少 graph（API 格式工作流）")
    return data


def _kapp_param_item(entry: dict, object_info: dict) -> dict:
    """声明条目 -> 面板参数（与官方格式同形，多带 widget 字段）。"""
    node_id = str(entry.get("node") or "")
    input_name = str(entry.get("input") or "")
    widget = str(entry.get("widget") or "text")
    if widget not in _KAPP_WIDGETS:
        raise ValueError("未知 widget 类型：%s" % widget)
    ctype = str(entry.get("node_type") or "")
    spec = widget_spec(object_info, ctype, input_name)
    item = {
        "node": node_id,
        "input": input_name,
        "label": str(entry.get("label") or input_name),
        "kind": _KAPP_KIND.get(widget, "text"),
        "widget": widget,
        "default": entry.get("default"),
        "spec": spec,
        "node_type": ctype,
        "node_title": str(entry.get("node_title") or ""),
    }
    if widget == "number":
        for k in ("min", "max", "step"):
            if entry.get(k) is not None:
                item[k] = entry[k]
                item["spec"][k] = entry[k]
        if not item["spec"].get("type"):
            item["spec"]["type"] = "INT"
    if widget == "combo" and isinstance(entry.get("options"), list) and entry["options"]:
        item["spec"]["options"] = entry["options"]
    if widget == "text" and entry.get("multiline"):
        item["multiline"] = True
        item["spec"]["multiline"] = True
    if widget == "image":
        item["source"] = "canvas"          # 与官方格式同语义：默认取 PS 当前画布
        item["spec"].pop("options", None)
        item["spec"].pop("options_truncated", None)
    if input_name in NOISE_INPUTS:
        item["hidden"] = True              # 管道参数，面板不显示
    return item


def build_kapp_spec(path: str, object_info: dict = None) -> dict:
    """kapp 的面板规格：参数完全按声明来，不推断。"""
    data = _load_kapp(path)
    graph = data["graph"]
    if object_info is None and _NODE_MAP:
        object_info = build_object_info(sorted({str(v.get("class_type")) for v in graph.values()}))
    params = []
    for entry in (data.get("params") or []):
        if not isinstance(entry, dict):
            continue
        try:
            params.append(_kapp_param_item(entry, object_info))
        except ValueError as exc:
            raise ValueError("%s（参数 node=%s input=%s）"
                             % (exc, entry.get("node"), entry.get("input")))

    # 标签去重：与官方格式同一套兜底
    dup = {}
    for p in params:
        if not p.get("hidden"):
            dup[p["label"]] = dup.get(p["label"], 0) + 1
    seq = {}
    for p in params:
        if p.get("hidden"):
            continue
        if dup[p["label"]] > 1:
            seq[p["label"]] = seq.get(p["label"], 0) + 1
            p["label"] = "%s %d" % (p["label"], seq[p["label"]])

    tally = {}
    for p in params:
        if p.get("hidden"):
            continue
        tally[p["kind"]] = tally.get(p["kind"], 0) + 1
    desc = str(data.get("desc") or "").strip() or \
        " · ".join("%d 个%s" % (v, KIND_CN.get(k, k)) for k, v in tally.items()) or "无可调参数"

    stem = _stem(os.path.basename(path))
    return {
        "id": stem,
        "name": str(data.get("name") or stem),
        "desc": desc,
        "path": _rel(path),
        "params": params,
        "outputs": [str(x) for x in (data.get("outputs") or [])],
        "param_count": sum(1 for p in params if not p.get("hidden")),
        "node_count": len(graph),
        "has_image_input": any(p["kind"] == "image" for p in params),
        "has_subgraph": False,
        "linear_mode": False,
        "format": "kapp",
        "filename": os.path.basename(path),
    }


def _build_graph_kapp(path: str, values: dict, object_info: dict) -> dict:
    """kapp 取图：graph 已是 API 格式，深拷贝 + 注值即可（无转换）。"""
    data = _load_kapp(path)
    graph = copy.deepcopy(data["graph"])
    if object_info is None and _NODE_MAP:
        object_info = build_object_info(sorted({str(v.get("class_type")) for v in graph.values()}))
    applied, skipped, failed = _inject_values(graph, values)
    unknown = {}
    for node in graph.values():
        t = str(node.get("class_type"))
        if object_info and t not in object_info:
            unknown[t] = unknown.get(t, 0) + 1
    return {
        "ok": not failed,
        "graph": graph,
        "node_count": len(graph),
        "applied": applied,
        "skipped": skipped,
        "failed": failed,
        "float_notes": [],
        "unknown_types": unknown,
        "path": _rel(path),
    }


def _find_workflow_file(name: str):
    """按文件名或 stem 在 WORKFLOW_DIR 里找工作流（打包的 source）。"""
    want = os.path.basename(str(name or ""))
    if not want or not _safe_id(want):
        return None
    stem = _stem(want).lower()
    for r, _dirs, files in os.walk(WORKFLOW_DIR):
        for fn in files:
            if fn == want or _stem(fn).lower() == stem:
                return os.path.join(r, fn)
    return None


def _suggest_widget(object_info: dict, class_type: str, name: str) -> str:
    """打包候选的建议 widget（按节点声明推断，仅两处品牌特判：本家节点）。
    自定义类型名不按名称推断：声明 cfg 里带 choices/options 选项列表的即为下拉 ——
    判为 text 会使应用中的下拉退化为输入框（ResolutionSelector 的 aspect_ratio 即如此）。"""
    if class_type == "KedouImageLoader" and name == "media_state":
        return "kedou_media"
    if class_type == "LoadImage" and name == "image":
        return "image"
    decl, cfg = _find_spec(object_info, class_type, name)
    if decl in ("INT", "FLOAT"):
        return "number"
    if decl == "BOOLEAN":
        return "toggle"
    if decl == "COMBO":
        return "combo"
    if isinstance(cfg, dict):
        ch = cfg.get("choices") or cfg.get("options")
        if isinstance(ch, (list, tuple)) and ch:
            return "combo"
    return "text"


def pack_candidates(source: str) -> dict:
    """GET /ps/pack/candidates —— 列出 UI 工作流里全部可暴露的控件候选。"""
    path = _find_workflow_file(source)
    if path is None:
        return {"ok": False, "error": "找不到工作流文件：%s" % source}
    with open(path, "r", encoding="utf-8") as f:
        wf = json.load(f)
    nodes = [n for n in (wf.get("nodes") or []) if int(n.get("mode", 0)) == 0]
    if not nodes:
        return {"ok": False, "error": "该文件不是 UI 格式工作流（没有 nodes）"}
    object_info = build_object_info(sorted({str(n.get("type")) for n in nodes})) if _NODE_MAP else {}
    out = []
    for node in nodes:
        ctype = str(node.get("type") or "")
        wv = _widget_values(node)
        vi = 0
        for name in _declared_widgets(object_info, ctype):
            default = wv[vi] if vi < len(wv) else None
            vi += 1
            if _ctl_after_gen(object_info, ctype, name):
                vi += 1                     # control_after_generate 隐藏格
            out.append({
                "node": str(node.get("id")),
                "input": name,
                "label": _clean_label(node, name),
                "node_type": ctype,
                "widget": _suggest_widget(object_info, ctype, name),
                "default": default,
            })
    return {"ok": True, "source": os.path.basename(path), "candidates": out}


def pack_app(source: str, params: list, name: str = None, desc: str = "") -> dict:
    """POST /ps/pack —— UI 工作流 + 勾选参数 -> 生成 <stem>.kapp.json（与 source 同目录）。"""
    path = _find_workflow_file(source)
    if path is None:
        return {"ok": False, "error": "找不到工作流文件：%s" % source}
    decls = []
    for p in (params or []):
        if not isinstance(p, dict):
            continue
        widget = str(p.get("widget") or "text")
        if widget not in _KAPP_WIDGETS:
            return {"ok": False, "error": "未知 widget 类型：%s" % widget}
        if not str(p.get("node") or "") or not str(p.get("input") or ""):
            return {"ok": False, "error": "参数缺少 node 或 input"}
        decls.append(p)
    if not decls:
        return {"ok": False, "error": "没有勾选任何参数"}
    conv = _load_converter()
    if conv is None:
        return {"ok": False, "error": "ui_to_api.py 未随桥接一起安装（两个文件都要）"}
    with open(path, "r", encoding="utf-8") as f:
        wf = json.load(f)
    nodes = wf.get("nodes") or []
    by_id = {str(n.get("id")): n for n in nodes}
    object_info = build_object_info(sorted({str(n.get("type")) for n in nodes})) if _NODE_MAP else {}
    try:
        graph, _notes = conv.convert_ex(wf, object_info or {})
    except Exception as e:                       # noqa: BLE001
        return {"ok": False, "error": "UI→API 转换失败：%s: %s" % (type(e).__name__, e)}
    # 完整性校验（与 save_kapp 同一标准）：转换后的图 + 勾选参数一起验，坏包不落盘
    vinfo = object_info or build_object_info(sorted({str(v.get("class_type")) for v in graph.values()}))
    if vinfo:
        errs, warns = _kapp_validate(graph, decls, vinfo)
        if errs:
            head = errs[:8]
            more = "" if len(errs) <= 8 else "（另有 %d 个问题）" % (len(errs) - 8)
            return {"ok": False,
                    "error": "打包图完整性校验未通过，共 %d 个问题：%s%s"
                             % (len(errs), "；".join(head), more)}

    kparams = []
    for p in decls:
        node_id = str(p.get("node"))
        input_name = str(p.get("input"))
        widget = str(p.get("widget") or "text")
        node = by_id.get(node_id)
        ctype = str((node or {}).get("type") or "")
        wv = _widget_values(node) if node else []
        vi = _widget_index(object_info, ctype, input_name)
        default = wv[vi] if (vi is not None and vi < len(wv)) else None
        if node:
            label = str(p.get("label") or _clean_label(node, input_name))
        else:
            label = str(p.get("label") or input_name)
        spec = widget_spec(object_info, ctype, input_name)
        item = {
            "node": node_id,
            "input": input_name,
            "label": label,
            "widget": widget,
            "default": default,
            "node_type": ctype,
            "node_title": ((node.get("title") or "").strip() if node else ""),
        }
        if widget == "number":
            item["min"] = spec.get("min")
            item["max"] = spec.get("max")
            item["step"] = spec.get("step")
        if widget == "combo":
            item["options"] = spec.get("options") or []
        if widget == "text" and spec.get("multiline"):
            item["multiline"] = True
        kparams.append(item)

    outputs = [nid for nid, node in graph.items()
               if "save" in str(node.get("class_type", "")).lower()]
    stem = _stem(os.path.basename(path))
    kapp = {
        "kedou_app": 1,
        "name": str(name or stem),
        "desc": str(desc or ""),
        "graph": graph,
        "params": kparams,
        "outputs": outputs,
    }
    out_path = os.path.join(os.path.dirname(path), stem + ".kapp.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(kapp, f, ensure_ascii=False, indent=1)
    return {"ok": True, "file": _rel(out_path), "param_count": len(kparams),
            "node_count": len(graph), "outputs": outputs, "warnings": warns}


# ---------------------------------------------------------------- kapp 打包面板专用（只校验 + 落盘）
#
# 与 pack_app（按文件名读取 UI 工作流、服务端做 UI→API 转换）不同，这个入口给
# 「打包成应用」前端面板用：面板已经用 app.graphToPrompt() 拿到 API 格式图，
# 直接把成品 kapp 发过来。所以这里只做校验 + 落盘，不再翻译、不再碰工作流文件。
# 桥接仍是纯通道：声明是什么就是什么，不针对任何应用做特判。

def _kapp_validate(graph: dict, params: list, object_info: dict):
    """kapp 落盘前的完整性校验（打包面板 / 服务端打包共用）。返回 (errs, warns)。

    errs = 确定性的坏包，落盘前拦截；warns = 只是可能有问题，允许打包。
    拦截的（与 ComfyUI 自己的 prompt 校验同标准，运行时必挂）：
      1. 节点类型未注册；
      2. 连线指向不存在的节点 / 槽号越界；
      3. 参数勾在了悬空连线上（运行时注值必失败）。
    降级为提醒的（2026-09-28，用户实测 TextEncodeQwenImageEdit21 的 images 不连也能跑）：
      「缺必需输入」——很多节点对缺失输入有默认值或容错，打包时静态判断不了运行时行为，
      一刀切会误伤（ComfyUI 运行时自己会给出权威报错，到时再连也不迟）。
    """
    errs = []
    warns = []
    # 1) 节点类型必须已注册
    for nid, node in graph.items():
        ct = str(node.get("class_type") or "")
        if ct not in object_info:
            errs.append("节点 %s（%s）的类型未注册（插件没装或没重启生效）" % (nid, ct or "?"))
    # 2) 逐节点：连线目标存在、槽号合法；缺必需输入降级为提醒
    for nid, node in graph.items():
        ct = str(node.get("class_type") or "")
        info = object_info.get(ct)
        if not info:
            continue
        inputs = node.get("inputs") or {}
        for k, v in inputs.items():
            if (isinstance(v, (list, tuple)) and len(v) == 2
                    and isinstance(v[0], (str, int)) and not isinstance(v[0], bool)
                    and not isinstance(v[1], bool)):
                up = graph.get(str(v[0]))
                if up is None:
                    errs.append("节点 %s 的输入 %s 连到不在图里的节点 %s（画布上删了上游？）" % (nid, k, v[0]))
                    continue
                upct = str(up.get("class_type") or "")
                outs = object_info.get(upct, {}).get("output") or []
                slot = v[1]
                if outs and (not isinstance(slot, int) or slot < 0 or slot >= len(outs)):
                    errs.append("节点 %s 的输入 %s 连到 %s 的槽 %s，但该类型只有 %d 个输出"
                                % (nid, k, v[0], slot, len(outs)))
        req = (info.get("input") or {}).get("required") or {}
        for wname, spec in req.items():
            if wname in inputs:
                continue
            if not (isinstance(spec, (list, tuple)) and spec):
                continue        # 声明解析不了的不强求，避免自造误报
            warns.append("节点 %s（%s）缺输入 %s —— 多数节点能容错；若运行时报缺这个输入，"
                         "回画布连上再重新打包一次" % (nid, ct, wname))
    # 3) 参数必须指向图中真实存在的「普通输入」（不能是连线）
    for p in (params or []):
        if not isinstance(p, dict):
            continue
        nid = str(p.get("node") or "")
        wname = str(p.get("input") or "")
        shown = str(p.get("label") or wname)
        node = graph.get(nid)
        if node is None:
            errs.append("参数「%s」指向的节点 %s 不在打包图里" % (shown, nid))
            continue
        val = (node.get("inputs") or {}).get(wname)
        if val is None:
            errs.append("参数「%s」（%s:%s）不在打包图里 —— 画布上该输入是悬空连线，回画布修复后重新打包"
                        % (shown, nid, wname))
        elif isinstance(val, (list, tuple)) and len(val) == 2:
            errs.append("参数「%s」（%s:%s）在画布上是连线（来自节点 %s），不能作为可调参数；"
                        "要暴露它请在画布上把该输入转回普通输入（右键节点 → 转换为输入的反向操作）后重新打包"
                        % (shown, nid, wname, val[0]))
    return errs, warns


def save_kapp(name: str, desc, kapp) -> dict:
    """kapp 打包面板专用（POST /ps/pack/save）。

    校验 + 落盘：
      * kapp 必须是 dict，且 kedou_app == 1；
      * graph 必须是非空 dict（API 格式工作流）；
      * params 必须是 list，且每一条 widget 在 _KAPP_WIDGETS 内；
      * name 经 _safe_id 防穿越 + _stem 去 .kapp.json/.app.json/.json 后缀清洗；
      * 写 WORKFLOW_DIR/<stem>.kapp.json（UTF-8、ensure_ascii=False）。
    不合法如实返回中文错误，绝不静默。
    """
    if not isinstance(kapp, dict):
        return {"ok": False, "error": "kapp 必须是对象（需含 kedou_app / graph / params）"}
    if int(kapp.get("kedou_app") or 0) != 1:
        return {"ok": False, "error": "kedou_app 必须为 1（不是合法的 kapp 包）"}
    graph = kapp.get("graph")
    if not isinstance(graph, dict) or not graph:
        return {"ok": False, "error": "graph 必须是非空的 API 格式工作流"}
    params = kapp.get("params")
    if not isinstance(params, list):
        return {"ok": False, "error": "params 必须是列表"}
    for i, p in enumerate(params):
        if not isinstance(p, dict):
            return {"ok": False, "error": "第 %d 个参数不是对象" % (i + 1)}
        widget = str(p.get("widget") or "text")
        if widget not in _KAPP_WIDGETS:
            return {"ok": False, "error": "第 %d 个参数 widget 非法：%s（允许：%s）"
                    % (i + 1, widget, "、".join(_KAPP_WIDGETS))}
    raw = str(name or "").strip()
    if not raw:
        return {"ok": False, "error": "应用名不能为空"}
    if not _safe_id(raw):
        return {"ok": False, "error": "应用名含非法字符（不能含 / \\ 或 ..）"}
    stem = _stem(raw)
    if stem.lower().endswith(".kapp"):           # 兜底：用户误带 .kapp 后缀
        stem = stem[: -len(".kapp")]
    if not stem:
        return {"ok": False, "error": "应用名清洗后为空（请换个名字）"}
    # 完整性校验：坏图坚决不落盘，把问题在人能看懂的地方说清楚
    vinfo = build_object_info(sorted({str(v.get("class_type")) for v in graph.values()})) if _NODE_MAP else {}
    if vinfo:
        errs, warns = _kapp_validate(graph, params, vinfo)
        if errs:
            head = errs[:8]
            more = "" if len(errs) <= 8 else "（另有 %d 个问题）" % (len(errs) - 8)
            return {"ok": False,
                    "error": "打包图完整性校验未通过，共 %d 个问题：%s%s"
                             % (len(errs), "；".join(head), more)}
    out_dir = WORKFLOW_DIR
    try:
        os.makedirs(out_dir, exist_ok=True)
    except Exception as e:                        # noqa: BLE001
        return {"ok": False, "error": "工作流目录不可写：%s" % e}
    out_path = os.path.join(out_dir, stem + ".kapp.json")
    try:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(kapp, f, ensure_ascii=False, indent=1)
    except Exception as e:                        # noqa: BLE001
        return {"ok": False, "error": "写入失败：%s" % e}
    return {"ok": True, "file": _rel(out_path), "param_count": len(params),
            "node_count": len(graph), "warnings": warns}


# ---------------------------------------------------------------- 路由
if _HAS_COMFY:

    # UXP 的 fetch 会做跨域检查，而 ComfyUI 默认不回 CORS 头 →
    # PS 插件请求会被浏览器内核拦掉（表现为"连不上"）。
    # 这里只给 /ps/ 下的路由加 CORS，不影响 ComfyUI 自己的接口。
    @web.middleware
    async def _ps_cors_middleware(request, handler):
        if not request.path.startswith("/ps/"):
            return await handler(request)
        if request.method == "OPTIONS":
            resp = web.Response(status=204)
        else:
            resp = await handler(request)
        try:
            resp.headers["Access-Control-Allow-Origin"] = "*"
            resp.headers["Access-Control-Allow-Headers"] = "*"
            resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        except Exception:                            # noqa: BLE001
            pass
        return resp

    try:
        PromptServer.instance.app.middlewares.append(_ps_cors_middleware)
    except Exception as _e:                          # noqa: BLE001
        print("[KeDou] CORS 中间件注册失败（插件可能仍能用，但跨域可能被拦）:", _e)

    @PromptServer.instance.routes.get("/ps/apps")
    async def ps_apps_list(request):
        return web.json_response({"apps": list_apps(), "root": WORKFLOW_DIR})

    @PromptServer.instance.routes.get("/ps/apps/{app_id}")
    async def ps_apps_get(request):
        app_id = request.match_info.get("app_id", "")
        if not _safe_id(app_id):
            return web.json_response({"error": "bad id"}, status=400)
        spec = get_app(app_id)
        if spec is None:
            return web.json_response({"error": "app not found"}, status=404)
        return web.json_response(spec)

    @PromptServer.instance.routes.post("/ps/apps/{app_id}/values")
    async def ps_apps_values(request):
        """把面板上的编辑写回工作流文件（提示词库持久化，方案 A）"""
        app_id = request.match_info.get("app_id", "")
        if not _safe_id(app_id):
            return web.json_response({"error": "bad id"}, status=400)
        try:
            body = await request.json()
        except Exception:                            # noqa: BLE001
            return web.json_response({"error": "bad json"}, status=400)
        values = (body or {}).get("values") if isinstance(body, dict) else None
        if not isinstance(values, dict):
            return web.json_response(
                {"error": 'body must be {"values": {"<node>:<widget>": value}}'}, status=400)
        result = update_values(app_id, values)
        return web.json_response(result, status=200 if result.get("ok") else 400)

    @PromptServer.instance.routes.post("/ps/apps/{app_id}/graph")
    async def ps_apps_graph(request):
        """界面格式转 API 格式 + 注入面板的值，返回可直接 POST /prompt 的图"""
        app_id = request.match_info.get("app_id", "")
        if not _safe_id(app_id):
            return web.json_response({"error": "bad id"}, status=400)
        try:
            body = await request.json()
        except Exception:                            # noqa: BLE001
            body = {}
        values = (body or {}).get("values") if isinstance(body, dict) else None
        result = build_graph(app_id, values or {})
        return web.json_response(result, status=200 if result.get("ok") else 400)


# ---------------------------------------------------------------- 图片加载器
# 一个节点，只做图片：自绘的多选面板（不是官方那套 image_upload 控件）。
#
# 不使用官方 image_upload 控件的原因（依据前端 WidgetSelect bundle 的实现）：
#   * 该控件仅支持单选 —— WidgetSelect bundle 里 multiselect 出现 0 次；
#   * 它还自带「遮罩编辑器 / 下载」两个按钮，与本节点职责重叠。
# 因此参照 MiniMaxH3-Easy 媒体加载器：唯一控件为一个隐藏的
# media_state(JSON)，清单由自绘面板管理；要的媒体在这里仅解码一次。
#
# media_state 形如 {"images":[{"filename":"a.png"}, ...]}，只接受相对路径
# （拒绝绝对路径与 ..），input 找不到会再试 output —— 保证工作流文件可移植、
# ComfyUI 的目录保护仍然管用。
#
# 输出：选几张就几路 IMAGE，上限 IMG_SLOTS 路（2026-09-28 从 10 提到 50 —— 用户要「不再限制数量」）。
# ComfyUI 的 RETURN_TYPES 必须静态声明，所以「不限制」只能体现为给一个足够大的上限；
# 实际露出几个由前端 syncOutputs 按需控制（初始 1 个、连一个露一个），上限调大不影响界面。
# 注意 load() 里不足的槽是复用最后一个 tensor 的**引用**，不额外占显存。
# 空槽给 None，不抛异常 —— ComfyUI 会把所有输出都算一遍哪怕没接线。

IMG_SLOTS = 50
IMG_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif")


def _image_files() -> list:
    """input 目录里的图片（相对 POSIX 路径，含子目录），排序后返回。"""
    in_dir, _out = _media_dirs()
    got = []
    if not os.path.isdir(in_dir):
        return got
    for r, _dirs, files in os.walk(in_dir):
        for fn in files:
            if fn.lower().endswith(IMG_EXTS):
                sub = os.path.relpath(r, in_dir).replace("\\", "/")
                got.append(fn if sub == "." else (sub + "/" + fn))
    return sorted(got)


def _media_state_value(value) -> dict:
    """media_state 规范化为 {"images":[{"filename":...}]}，只留合法的相对路径。"""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            value = {}
    out = {"images": [], "batch": False, "cursor": 0, "select": False, "picked": []}
    if not isinstance(value, dict):
        return out
    # 批次模式字段（2026-09-28）：batch 开关 + 游标，前端批次循环时逐份改 cursor 再排队
    out["batch"] = bool(value.get("batch"))
    try:
        out["cursor"] = int(value.get("cursor") or 0)
    except (TypeError, ValueError):
        out["cursor"] = 0
    # 选择模式字段（2026-09-28）：select 开关 + 按选择顺序排列的文件名列表
    out["select"] = bool(value.get("select"))
    pk = value.get("picked")
    if isinstance(pk, list):
        out["picked"] = [str(x).replace("\\", "/").lstrip("/") for x in pk if str(x).strip()]
    raw_list = value.get("images")
    if not isinstance(raw_list, list):
        return out
    seen = set()
    for raw in raw_list:
        name = str((raw.get("filename") if isinstance(raw, dict) else raw) or "").strip()
        name = name.replace("\\", "/").lstrip("/")
        if not name or "\x00" in name or os.path.isabs(name):
            continue
        parts = [p for p in name.split("/") if p and p != "."]
        if not parts or any(p == ".." for p in parts):
            continue
        norm = "/".join(parts)
        if norm in seen:
            continue
        seen.add(norm)
        out["images"].append({"filename": norm})
        if len(out["images"]) >= IMG_SLOTS:
            break
    return out


def _media_input_path(filename: str) -> str:
    """媒体文件名 -> 绝对路径：先找 input，找不到再试 output（媒体库「已生成」选的图也能跑）。

    两个目录都走 folder_paths 的越界检查（相对路径 + 拒绝 ..），安全性不变。
    """
    try:
        from folder_paths import (get_annotated_filepath, get_input_directory,   # noqa: PLC0415
                                  get_output_directory)
        path = get_annotated_filepath(filename, get_input_directory())
        if os.path.isfile(path):
            return path
        path = get_annotated_filepath(filename, get_output_directory())
    except Exception:                                       # noqa: BLE001
        in_dir, out_dir = _media_dirs()
        path = os.path.join(in_dir, filename.replace("/", os.sep))
        if not os.path.isfile(path):
            path = os.path.join(out_dir, filename.replace("/", os.sep))
    if not os.path.isfile(path):
        raise ValueError("媒体加载器找不到文件（input / output 都没有）：%s" % filename)
    return path


def _media_state_json(value) -> str:
    return json.dumps(_media_state_value(value), ensure_ascii=True, separators=(",", ":"))


def _load_image(filename: str):
    """单图 -> (1,H,W,3) float32 张量，与官方 LoadImage 的输出形状一致。"""
    import numpy as np                                  # noqa: PLC0415
    import torch                                        # noqa: PLC0415
    from PIL import Image, ImageOps                     # noqa: PLC0415
    im = ImageOps.exif_transpose(Image.open(_media_input_path(filename))).convert("RGB")
    arr = np.array(im).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]


class KedouImageLoader:
    """蝌蚪图片加载器 —— 在面板上挑图片，一张图一路输出。"""

    CATEGORY = "蝌蚪 · Kedou"
    FUNCTION = "load"
    RETURN_TYPES = ("IMAGE",) * IMG_SLOTS
    RETURN_NAMES = tuple("image_%d" % i for i in range(1, IMG_SLOTS + 1))
    DESCRIPTION = ("在面板上挑图片（可多选、可上传），一张图一路 IMAGE 输出（上限 %d 路）。"
                   "未启用的槽输出 None，下游多图节点会忽略该路；"
                   "开「选择」可从面板上按点击顺序挑选要输出的照片；"
                   "开「批次」并点「跑 N 张」可让这些图从图片1 依次自动跑完。" % IMG_SLOTS)

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"media_state": ("STRING", {"default": "", "multiline": False})}}

    @classmethod
    def IS_CHANGED(cls, media_state="", **_kw):
        """文件增删或文件本身变了都要重跑，否则 ComfyUI 会拿旧缓存。"""
        state = _media_state_value(media_state)
        sig = []
        for entry in state["images"]:
            name = entry["filename"]
            try:
                st = os.stat(_media_input_path(name))
                sig.append((name, st.st_mtime_ns, st.st_size))
            except (OSError, ValueError):
                sig.append((name, None, None))
        # 批次游标必须进签名：cursor 变了文件没变，不加的话 ComfyUI 会拿缓存不重跑
        if state.get("batch"):
            sig.append(("batch", state.get("cursor")))
        # 选择模式同理：开关切换、选中集合变化、甚至只改选择顺序，输出都会变，都要进签名
        sig.append(("select", state.get("select"), tuple(state.get("picked") or [])))
        return repr(sig)

    @classmethod
    def VALIDATE_INPUTS(cls, media_state="", **_kw):
        """2026-09-28 改：部分失效放行 —— 与 load() 的容错对齐（失败图占位 None，槽位不错位）。
        用户清理过输出目录后面板残留旧文件名，旧版一票否决把整个提交拦死；
        现在只有全部失效才拦（此时才真的没有一张可出）。"""
        state = _media_state_value(media_state)
        first_err = None
        missing = 0
        for entry in state["images"]:
            try:
                _media_input_path(entry["filename"])
            except ValueError as exc:
                missing += 1
                if first_err is None:
                    first_err = str(exc)
        if state["images"] and missing == len(state["images"]):
            return first_err or "媒体加载器找不到任何一张面板图片（input / output 都没有）"
        return True

    def load(self, media_state=""):
        state = _media_state_value(media_state)
        # 临时诊断（定位批次 cursor 丢失用，查完删）：打印每次执行实际收到的 media_state
        print("[kedou] load 收到 media_state：", str(media_state or "")[:260])
        # 槽位语义（2026-09-28 六修）：**启用槽 = 面板上的实际照片数**。
        # 多余的槽输出 None —— 下游多图节点（如 TextEncodeQwenImageEdit21 固定 21 个图输入）
        # 对 None 容错并忽略该路参考图。旧版「复用最后一张填满」会让下游收到 N 份相同
        # 参考图，参考图权重翻倍、生成效果跑偏（用户实测），已废弃。
        # 批次模式：只有图片1 输出当前游标那张，其余槽全部 None（连着的线等于忽略信号）。
        # 加载失败的图也占位为 None：槽与面板序号一一对应，不会前移错位。
        # 选择模式（2026-09-28）：select 开 + picked 非空 → 只输出被选中的照片，
        # 顺序 = 选择顺序（picked[0] → 图片1）。picked 里已不在面板上的文件名自动跳过；
        # picked 为空或全失效时回退为全部照片，避免「选了又全取消」后一个槽都不出。
        imgs = state["images"]
        if state.get("select") and state.get("picked"):
            by_name = {e["filename"]: e for e in imgs}
            picked_imgs = [by_name[f] for f in state["picked"] if f in by_name]
            if picked_imgs:
                imgs = picked_imgs
        if state.get("batch"):
            if not imgs:
                raise ValueError("蝌蚪图片加载器：没有可用的图片 —— 请在加载器/应用面板里先选择图片")
            cur = max(0, min(int(state.get("cursor") or 0), len(imgs) - 1))
            entry = imgs[cur]
            pick = _load_image(entry["filename"])
            print("[kedou] 批次 %d/%d：%s" % (cur + 1, len(imgs), entry["filename"]))
            out = [pick]
        else:
            out = []
            for entry in imgs:
                try:
                    out.append(_load_image(entry["filename"]))
                except (OSError, ValueError) as e:
                    print("[kedou] 图片读不出来，该槽给空：%s（%s）" % (entry["filename"], e))
                    out.append(None)
            if not any(x is not None for x in out):
                # 全都读不出来才算无图；个别失败只空对应槽，不前移错位
                raise ValueError("蝌蚪图片加载器：没有可用的图片 —— 请在加载器/应用面板里先选择图片")
            ok = sum(1 for x in out if x is not None)
            print("[kedou] 图片加载器：%d/%d 张有效；未启用槽输出 None（下游多图节点会忽略）"
                  % (ok, IMG_SLOTS))
        # 填充到 IMG_SLOTS：未启用的槽一律 None
        while len(out) < IMG_SLOTS:
            out.append(None)
        return tuple(out)


# ComfyUI 要求 custom_nodes 至少导出节点映射（可以为空）
NODE_CLASS_MAPPINGS = {
    "KedouImageLoader": KedouImageLoader,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "KedouImageLoader": "蝌蚪图片加载器",
}


# ---------------------------------------------------------------- 媒体库（共享协议）
# 目的：让「媒体选择器」在启动器 / PS 插件 / ComfyUI 内的节点上共用同一份数据与协议。
# 只提供清单与预览地址；上传走 ComfyUI 原生 /upload/image，不重复造轮子。
MEDIA_EXTS = {
    "image": (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"),
    "video": (".mp4", ".mov", ".webm", ".avi", ".mkv"),
    "audio": (".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"),
}
MEDIA_CAP = 400          # 单次最多返回多少条（上千条对选择器没意义还占带宽）
# 遍历时的收集上限，防目录爆炸；**排序完成后**再按 MEDIA_CAP 截断。
# 2026-09-28 修：以前是用 MEDIA_CAP 在循环里就 break，等于「先收满 400 再排序」，
# 排序只在碰巧遍历到的那 400 个里生效 —— 「最新在前」是假的（实测返回里混着去年的图）。
MEDIA_SCAN_CAP = 5000


def _media_dirs():
    """输入/输出目录：优先 ComfyUI 的 folder_paths（尊重它的路径配置），取不到再按根目录兜底。"""
    try:
        from folder_paths import get_input_directory, get_output_directory  # noqa: PLC0415
        return get_input_directory(), get_output_directory()
    except Exception:                                   # noqa: BLE001
        return os.path.join(COMFY_ROOT, "input"), os.path.join(COMFY_ROOT, "output")


def list_media(mtype="image", tab="all", q="", cap=MEDIA_CAP):
    """媒体清单：{name,subfolder,kind,tab,size,mtime,url}；tab = all|input|output。"""
    import urllib.parse as _up
    in_dir, out_dir = _media_dirs()
    exts = MEDIA_EXTS.get(str(mtype or "image"), MEDIA_EXTS["image"])
    items = []
    for tab_name, base in (("input", in_dir), ("output", out_dir)):
        if tab not in ("all", tab_name):
            continue
        if not os.path.isdir(base):
            continue
        for r, _dirs, files in os.walk(base):
            for fn in files:
                if fn.startswith(".") or not fn.lower().endswith(exts):
                    continue
                if q and str(q).lower() not in fn.lower():
                    continue
                try:
                    st = os.stat(os.path.join(r, fn))
                except Exception:                       # noqa: BLE001
                    continue
                sub = os.path.relpath(r, base).replace("\\", "/")
                if sub == ".":
                    sub = ""
                items.append({
                    "name": fn, "subfolder": sub, "kind": str(mtype or "image"), "tab": tab_name,
                    "size": st.st_size, "mtime": int(st.st_mtime),
                    "url": "/view?filename=%s&subfolder=%s&type=%s" % (
                        _up.quote(fn), _up.quote(sub), tab_name),
                })
                if len(items) >= MEDIA_SCAN_CAP:
                    break
            if len(items) >= MEDIA_SCAN_CAP:
                break
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return items[:cap]


if _HAS_COMFY:
    @PromptServer.instance.routes.get("/ps/media")
    async def ps_media(request):
        """GET /ps/media?type=image|video|audio&tab=all|input|output&q=关键词"""
        qq = request.query
        return web.json_response({"ok": True, "items": list_media(
            qq.get("type", "image"), qq.get("tab", "all"), qq.get("q", ""))})

    @PromptServer.instance.routes.get("/ps/pack/candidates")
    async def ps_pack_candidates(request):
        """GET /ps/pack/candidates?source=<工作流文件名> —— 打包前的控件候选清单"""
        return web.json_response(pack_candidates(request.query.get("source", "")))

    @PromptServer.instance.routes.post("/ps/pack")
    async def ps_pack(request):
        """POST /ps/pack {source, name?, desc?, params:[{node,input,label,widget}]}
        —— 生成 <stem>.kapp.json（自研应用包，graph 为 API 格式）"""
        try:
            body = await request.json()
        except Exception:                            # noqa: BLE001
            return web.json_response({"ok": False, "error": "bad json"}, status=400)
        if not isinstance(body, dict):
            return web.json_response({"ok": False, "error": "bad json"}, status=400)
        return web.json_response(pack_app(
            str(body.get("source") or ""), body.get("params") or [],
            name=body.get("name"), desc=body.get("desc")))

    @PromptServer.instance.routes.post("/ps/pack/save")
    async def ps_pack_save(request):
        """POST /ps/pack/save {name, desc?, kapp}
        —— kapp 打包面板专用：前端已用 graphToPrompt() 构好 API 图，这里只校验+落盘。
        不依赖工作流文件先保存（与 /ps/pack 按文件打包区分）。"""
        try:
            body = await request.json()
        except Exception:                            # noqa: BLE001
            return web.json_response({"ok": False, "error": "bad json"}, status=400)
        if not isinstance(body, dict):
            return web.json_response({"ok": False, "error": "bad json"}, status=400)
        result = save_kapp(body.get("name"), body.get("desc"), body.get("kapp"))
        return web.json_response(result, status=200 if result.get("ok") else 400)
