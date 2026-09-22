# -*- coding: utf-8 -*-
"""
ui_to_api.py —— ComfyUI「界面格式工作流」转「API 格式」

背景：ComfyUI 存盘的工作流是界面格式（nodes / links / widgets_values），
而 POST /prompt 需要 API 格式（{nodeId: {class_type, inputs}}）。
服务端没有现成转换路由，所以这里自己实现。

设计原则（关键）：
  * 一个节点类型如果**不在 /object_info 里**，它就不是真实节点（PrimitiveNode /
    Reroute / Note / rgthree 的 Fast Muter 之类都属此类）→ **溶解掉**，把连线接续上去。
    这样就不需要维护"前端专用节点"名单，跟着 ComfyUI 升级自动正确。
  * 只保留 mode == 0 的节点（静音 mode=2 / 旁路 mode=4 都不进 API 图）。
  * 控件值按 object_info 声明的顺序位置对齐；带 control_after_generate 的
    （如 seed）在界面里占 2 个值，API 里只保留 1 个 —— 自动处理。

用法：
    from ui_to_api import convert
    api_graph = convert(workflow_dict, object_info_dict)
"""

from __future__ import annotations

# 这些类型在 ComfyUI 里是「控件」，其余字符串类型视为「连线」
# 注意：新版 ComfyUI 把下拉声明成 ["COMBO", {...}]，"COMBO" 是字符串标记；
# 老版则内联成 [["选项1","选项2",...], {...}]。两种都要认。
WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}

# 这些类型永远不会真的执行，视同前端专用
NON_EXECUTABLE = {"Note", "MarkdownNote", "PreviewAny", "__Reroute"}


def _is_widget_input(spec) -> bool:
    """spec 形如 [type, opts]；type 为 list（下拉选项）或基础类型时是控件。

    注意：ComfyUI 的 INPUT_TYPES() 返回**元组**，只有经 /object_info 走 JSON 才变列表。
    只认 list 的话，服务端构建 object_info 时这里会全部返回 False ——
    后果是**所有节点的控件值全丢、只剩连线**，极其隐蔽。
    """
    if not isinstance(spec, (list, tuple)) or not spec:
        return False
    t = spec[0]
    if isinstance(t, (list, tuple)):
        return True          # 老式内联下拉，例如 ["euler", "dpmpp_2m"]
    if isinstance(t, str) and (t in WIDGET_TYPES or t.startswith("COMBO")):
        return True
    return False


def widget_names(object_info: dict, class_type: str) -> list[str]:
    """按声明顺序返回该节点类型的控件输入名（位置与 widgets_values 对齐）。"""
    info = object_info.get(class_type)
    if not info:
        return []
    declared = info.get("input", {})
    names: list[str] = []
    for section in ("required", "optional"):
        for name, spec in (declared.get(section) or {}).items():
            if _is_widget_input(spec):
                names.append(name)
    return names


def _widget_spec(object_info: dict, class_type: str, name: str):
    info = object_info.get(class_type)
    if not info:
        return None
    declared = info.get("input", {})
    for section in ("required", "optional"):
        for n, spec in (declared.get(section) or {}).items():
            if n == name:
                return spec
    return None


def _has_control_after_generate(object_info: dict, class_type: str, name: str) -> bool:
    """seed 这类控件在界面上会多出一个 control_after_generate 下拉。"""
    spec = _widget_spec(object_info, class_type, name)
    if not spec or len(spec) < 2 or not isinstance(spec[1], dict):
        return False
    return bool(spec[1].get("control_after_generate"))


def _linked_input_names(node: dict) -> dict[str, str]:
    """
    返回 {输入名: 来源控件名}，用于识别「控件被真正转成了输入」。

    注意：新版 ComfyUI 里下拉/数值控件**本来就会在 inputs 里带一个 widget 引用**，
    但那只是控件的常规槽位，不代表被转成了输入。
    只有当该槽位**确实有连线**时，才算「控件被转成了输入」。
    """
    out = {}
    for slot in node.get("inputs") or []:
        if slot.get("link") is None:
            continue
        w = slot.get("widget")
        if isinstance(w, dict) and w.get("name"):
            out[slot.get("name") or w["name"]] = w["name"]
    return out


class Converter:
    def __init__(self, object_info: dict):
        self.info = object_info or {}

    # ---------- 基础判定 ----------
    def is_real(self, class_type: str) -> bool:
        return class_type in self.info and class_type not in NON_EXECUTABLE

    def is_active(self, node: dict) -> bool:
        return int(node.get("mode", 0)) == 0

    # ---------- 连线解析（会穿过前端专用节点） ----------
    def _link_by_id(self, workflow: dict) -> dict:
        out = {}
        for l in workflow.get("links") or []:
            # 兼容 [id, origin, oslot, target, tslot, type] 与对象形式
            if isinstance(l, dict):
                out[l.get("id")] = l
            elif isinstance(l, (list, tuple)) and len(l) >= 5:
                out[l[0]] = {"id": l[0], "origin_id": l[1], "origin_slot": l[2],
                             "target_id": l[3], "target_slot": l[4]}
        return out

    def _nodes_by_id(self, workflow: dict) -> dict:
        return {n.get("id"): n for n in workflow.get("nodes") or []}

    def _resolve_source(self, workflow: dict, links: dict, nodes: dict,
                        node_id, slot_index, depth: int = 0):
        """
        把 (node_id, slot_index) 追到真正的上游真实节点。
        途中遇到前端专用节点（Reroute / Primitive / 非真实类型）就穿过或取其字面值。
        返回 (kind, payload)：
            ("link", (real_node_id, out_slot))
            ("value", 字面量)   # 来自 PrimitiveNode
            (None, None)
        """
        if depth > 64:
            return (None, None)
        node = nodes.get(node_id)
        if node is None:
            return (None, None)

        if self.is_real(node.get("type")):
            return ("link", (node_id, int(slot_index or 0)))

        # ---- 非真实节点：溶解 ----
        ctype = node.get("type")

        # PrimitiveNode：输出被当作目标控件的一个值
        if ctype == "PrimitiveNode":
            vals = node.get("widgets_values") or []
            if vals:
                return ("value", vals[0])
            # 少数情况 Primitive 自己也有输入
            for slot in node.get("inputs") or []:
                if slot.get("link") is not None:
                    lk = links.get(slot["link"])
                    if lk:
                        return self._resolve_source(
                            workflow, links, nodes,
                            lk["origin_id"], lk.get("origin_slot", 0), depth + 1)
            return (None, None)

        # Reroute / 其它：把输入当输出接续下去
        ins = [s for s in (node.get("inputs") or []) if s.get("link") is not None]
        if ins:
            lk = links.get(ins[0]["link"])
            if lk:
                return self._resolve_source(workflow, links, nodes,
                                            lk["origin_id"], lk.get("origin_slot", 0),
                                            depth + 1)
        return (None, None)

    # ---------- 主流程 ----------
    def convert(self, workflow: dict) -> dict:
        nodes = self._nodes_by_id(workflow)
        links = self._link_by_id(workflow)
        out: dict = {}

        for node in workflow.get("nodes") or []:
            ctype = node.get("type")
            if not self.is_real(ctype):
                continue                      # 前端专用 / 注释
            if not self.is_active(node):
                continue                      # 静音或旁路

            node_id = node.get("id")
            inputs: dict = {}
            converted = _linked_input_names(node)   # 被转成输入的控件

            # 1) 控件值（严格按位置对齐；被转成输入的控件仍占用位置，只是不输出）
            wnames = widget_names(self.info, ctype)
            wvals = node.get("widgets_values") or []
            if isinstance(wvals, dict):            # 新版可能存成对象
                for n in wnames:
                    if n in wvals and n not in converted:
                        inputs[n] = wvals[n]
            else:
                idx = 0
                for n in wnames:
                    if idx >= len(wvals):
                        break
                    val = wvals[idx]
                    idx += 1
                    if _has_control_after_generate(self.info, ctype, n):
                        idx += 1                   # 界面多占一位，API 不要
                    if n in converted:
                        continue                   # 值被连线取代，不作为控件输出
                    inputs[n] = val
            # 2) 连线（含被转成输入的控件）
            for slot in node.get("inputs") or []:
                if slot.get("link") is None:
                    continue
                lk = links.get(slot["link"])
                if not lk:
                    continue
                kind, payload = self._resolve_source(
                    workflow, links, nodes, lk["origin_id"], lk.get("origin_slot", 0))
                name = slot.get("name") or (slot.get("widget") or {}).get("name")
                if not name:
                    continue
                if kind == "link":
                    inputs[name] = [str(payload[0]), payload[1]]
                elif kind == "value":
                    inputs[name] = payload

            out[str(node_id)] = {
                "class_type": ctype,
                "inputs": inputs,
                "_meta": {"title": node.get("title") or ctype},
            }

        # 3) 清理悬空引用：指向被静音/旁路/已溶解节点的连线要丢掉
        present = set(out.keys())
        for nd in out.values():
            for k in list(nd["inputs"].keys()):
                v = nd["inputs"][k]
                if (isinstance(v, list) and len(v) == 2
                        and isinstance(v[0], str) and v[0] not in present):
                    del nd["inputs"][k]
        return out


def widget_index(object_info: dict, class_type: str, name: str):
    """
    控件名 -> 它在 widgets_values 数组里的下标。
    注意带 control_after_generate 的控件会多占一格（如 seed），前面的控件要相应位移。
    找不到返回 None。
    """
    names = widget_names(object_info, class_type)
    if name not in names:
        return None
    idx = 0
    for n in names:
        if n == name:
            return idx
        idx += 1
        if _has_control_after_generate(object_info, class_type, n):
            idx += 1
    return None


def _copy_node(n: dict) -> dict:
    """浅拷贝节点，但把 inputs 单独复制，避免改写原始工作流。"""
    m = dict(n)
    ins = n.get("inputs")
    if isinstance(ins, list):
        m["inputs"] = [dict(s) if isinstance(s, dict) else s for s in ins]
    elif isinstance(ins, dict):
        m["inputs"] = dict(ins)
    return m


def _parse_link(l):
    """兼容对象与数组两种连线写法，返回 (origin_id, origin_slot, target_id, target_slot)。"""
    if isinstance(l, dict):
        return (l.get("origin_id"), l.get("origin_slot"),
                l.get("target_id"), l.get("target_slot"))
    if isinstance(l, (list, tuple)) and len(l) >= 5:
        return (l[1], l[2], l[3], l[4])
    return (None, None, None, None)


def flatten_subgraphs(workflow: dict):
    """
    把「子图实例」展开成扁平节点，使转换器不必理解子图。

    子图里有两个虚拟节点：inputNode（子图对外的输入）与 outputNode（子图对外的输出）。
      * 内部连线 origin == inputNode  -> 换成该实例对应输入槽的来源
      * 内部连线 target == outputNode -> 记录为该实例对应输出槽的来源
    内联节点 id 前缀为 "<实例id>~"，并重建全部连线 id（避免与原子图 id 冲突）。

    返回 (新工作流, 说明列表)。嵌套子图暂不支持，会在说明里标出。
    """
    defs = (workflow.get("definitions") or {}).get("subgraphs") or []
    sub_by_id = {str(s.get("id")): s for s in defs}
    if not sub_by_id:
        return workflow, []

    notes: list[str] = []
    flat_nodes: list = []
    flat_links: list = []
    next_id = [1]

    def add_link(o_id, o_sl, t_id, t_sl):
        lid = next_id[0]
        next_id[0] += 1
        flat_links.append({"id": lid, "origin_id": o_id, "origin_slot": int(o_sl or 0),
                           "target_id": t_id, "target_slot": int(t_sl or 0)})

    # 根图上：(目标节点, 槽位) -> (来源节点, 槽位)
    root_link_idx = {}
    for l in workflow.get("links") or []:
        o, os_, ti, ts = _parse_link(l)
        root_link_idx[(str(ti), int(ts or 0))] = (o, int(os_ or 0))

    inst_out: dict[str, dict] = {}

    for n in workflow.get("nodes") or []:
        t = str(n.get("type"))
        if t not in sub_by_id:
            flat_nodes.append(_copy_node(n))
            continue

        S = sub_by_id[t]
        inner = S.get("nodes") or []
        if any(str(m.get("type")) in sub_by_id for m in inner):
            notes.append("跳过嵌套子图实例 %s（暂不支持）" % n.get("id"))
            continue

        pref = "%s~" % n.get("id")

        # 注意：inputNode / outputNode 可能是对象（{"id": -10, ...}），也可能直接是 id
        in_raw, out_raw = S.get("inputNode"), S.get("outputNode")
        in_id = str(in_raw.get("id") if isinstance(in_raw, dict) else in_raw)
        out_id = str(out_raw.get("id") if isinstance(out_raw, dict) else out_raw)

        # 实例每个输入槽的来源：优先按实例 inputs[i].link 的连线 id 去找
        root_by_lid = {}
        for l in workflow.get("links") or []:
            if isinstance(l, dict):
                root_by_lid[l.get("id")] = (l.get("origin_id"), l.get("origin_slot"))
            elif isinstance(l, (list, tuple)) and len(l) >= 3:
                root_by_lid[l[0]] = (l[1], l[2])
        inst_in = {}
        for i, slot in enumerate(n.get("inputs") or []):
            lid = slot.get("link") if isinstance(slot, dict) else None
            if lid is not None and lid in root_by_lid:
                inst_in[i] = root_by_lid[lid]
            elif (str(n.get("id")), i) in root_link_idx:
                inst_in[i] = root_link_idx[(str(n.get("id")), i)]

        # 内联内部节点（跳过虚拟节点；通常虚拟节点不在 nodes 里）
        inlined = 0
        for m in inner:
            if str(m.get("id")) in (in_id, out_id):
                continue
            m2 = _copy_node(m)
            m2["id"] = pref + str(m.get("id"))
            flat_nodes.append(m2)
            inlined += 1

        # 内部连线
        outs: dict[int, tuple] = {}
        for l in S.get("links") or []:
            o, os_, ti, ts = _parse_link(l)
            if str(o) == in_id:
                src = inst_in.get(int(os_ or 0))
                if not src:
                    continue                     # 该输入槽没接东西
                o, os_ = src[0], src[1]
            else:
                o = pref + str(o)
            if str(ti) == out_id:
                outs.setdefault(int(ts or 0), (o, int(os_ or 0)))
                continue
            add_link(o, os_, pref + str(ti), ts)

        inst_out[str(n.get("id"))] = outs
        notes.append("展开子图实例 %s（%s）：内联 %d 个节点、接出 %d 个输出"
                     % (n.get("id"), S.get("name") or "未命名", inlined, len(outs)))

    # 根图连线：喂给实例输入的丢弃（已内联）；取自实例输出的改成内联源
    for l in workflow.get("links") or []:
        o, os_, ti, ts = _parse_link(l)
        if str(ti) in inst_out:
            continue
        if str(o) in inst_out:
            m = inst_out[str(o)].get(int(os_ or 0))
            if not m:
                continue
            o, os_ = m
        add_link(o, os_, ti, ts)

    # 用 (目标, 槽位) 重建每个节点的 inputs[].link
    by_target = {}
    for l in flat_links:
        by_target[(str(l["target_id"]), l["target_slot"])] = l["id"]
    for nd in flat_nodes:
        ins = nd.get("inputs")
        if isinstance(ins, list):
            for i, slot in enumerate(ins):
                if isinstance(slot, dict):
                    slot["link"] = by_target.get((str(nd.get("id")), i))
        elif isinstance(ins, dict):
            ins["link"] = by_target.get((str(nd.get("id")), 0))

    wf = dict(workflow)
    wf["nodes"] = flat_nodes
    wf["links"] = flat_links
    wf["definitions"] = {}
    return wf, notes


def convert_ex(workflow: dict, object_info: dict):
    """转换并返回 (API 图, 说明列表)。"""
    wf, notes = flatten_subgraphs(workflow)
    return Converter(object_info).convert(wf), notes


def convert(workflow: dict, object_info: dict) -> dict:
    return convert_ex(workflow, object_info)[0]
