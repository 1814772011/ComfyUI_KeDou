# ComfyUI_KeDou · 蝌蚪桥接

把 ComfyUI 里的工作流变成可点击的 **App**。

ComfyUI 本身没有"列出我的工作流和它们的参数"这样的接口，外部面板（启动器、Photoshop 面板等）拿不到数据。本插件补上这一层桥接：**列出应用 → 读取参数 → 回填取值 → 转成可直接提交的 API 格式 → 一键把工作流打包成应用包**。

> 纯 Python 标准库实现，无第三方依赖，一个文件夹即装即用。

---

## 安装

1. 把整个 `ComfyUI_KeDou/` 文件夹放进 `<ComfyUI>/custom_nodes/`
2. 重启 ComfyUI

```
custom_nodes/ComfyUI_KeDou/
├── __init__.py          # HTTP 路由 + 自定义节点
├── ui_to_api.py         # 界面格式 → API 格式转换
├── web/kedou_media.js   # 节点前端扩展（缩略图网格 / 媒体选择器）
├── pyproject.toml       # 节点元数据（Comfy Registry / Manager）
└── LICENSE
```

---

## 它提供什么

### 一、本地 HTTP 路由（挂在 ComfyUI 自己的端口上，默认 8188）

| 路由 | 方法 | 用途 |
|---|---|---|
| `/ps/apps` | GET | 列出全部「应用」：`{id, name, desc, param_count, has_image_input, node_count, format}` |
| `/ps/apps/{app_id}` | GET | 取单个应用定义：参数列表 + 输出节点 |
| `/ps/apps/{app_id}/values` | POST | 把面板上的编辑写回工作流文件（持久化） |
| `/ps/apps/{app_id}/graph` | POST | 界面格式 → **API 格式**，返回可直接 `POST /prompt` 的图 |
| `/ps/media` | GET | 列媒体文件：`?type=image\|video\|audio&tab=all\|input\|output&q=关键词` |
| `/ps/pack/candidates` | GET | 打包前：列出工作流里**可暴露成参数的控件候选** |
| `/ps/pack` | POST | 按已有工作流文件生成 `<stem>.kapp.json` 应用包 |
| `/ps/pack/save` | POST | 打包面板专用：前端已构好 API 图，这里只校验 + 落盘 |

### 二、自定义节点

| 节点 | 显示名 | 说明 |
|---|---|---|
| `KedouImageLoader` | 蝌蚪图片加载器 | 直接在节点上选图（缩略图网格，由 `web/kedou_media.js` 渲染），输出一批图像。 |

---

## 两种「应用」来源

插件同时识别两种工作流，**同名时 `.kapp.json` 优先**：

|  | 官方应用模式 | 自研应用包 `.kapp.json` |
|---|---|---|
| **识别方式** | 文件名 `*.app.json`，或 `extra.linearMode == true` | `{"kedou_app": 1, ...}` |
| **参数定义** | `extra.linearData.inputs` 勾选（勾到哪个控件就叫什么名） | `params` 逐条声明 `node` + `input` + `widget` |
| **图格式** | 界面格式，每次运行都要做 UI→API 翻译 | **直接存 API 格式**，无翻译、无位置对位 |
| **参数** | `linearData` 勾选 | 显式声明 |
| **输出** | `extra.linearData.outputs` | 显式列出节点 id |

应用包长这样：

```json
{
  "kedou_app": 1,
  "name": "示例应用",
  "desc": "",
  "graph": { "3": { "class_type": "KSampler", "inputs": { } } },
  "params": [
    { "node": "6", "input": "text", "label": "提示词", "widget": "text", "default": "" }
  ],
  "outputs": ["9"]
}
```

> 设计取舍：官方应用模式有三笔"税"——参数靠勾选、`widgets_values` 按位置对位、每次运行都要翻译一遍。
> 应用包把这三样全部显式化，插件本身保持**纯通道**：声明是什么就是什么，不对任何具体应用做特判。

---

## 关于这个项目

这是个人自研工具链的**桥接层**，原本为了配合自己用的工作流启动器和 Photoshop 面板（把常用工作流做成"点一下就出图"的小应用）而写，现在把桥接部分单独开放出来。

**其他部分（启动器、PS 面板）暂未开源**，仅自用与小范围分发。如果你觉得这套思路有用、想聊聊——

<!-- CONTACT:START -->
> 想交流、想问工作流、想聊聊「把工作流做成应用」这套思路？
>
> **B 站：赛博唐僧** → https://space.bilibili.com/401403590
>
> 合集「comfyui 插件」里有这些节点的实际效果与踩坑记录，欢迎来聊。
<!-- CONTACT:END -->

---

## License

[MIT](LICENSE) —— 随便用、随便改、随便再分发，保留版权声明即可。
