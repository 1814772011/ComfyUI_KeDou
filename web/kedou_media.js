// kedou_media.js —— 「蝌蚪图片加载器」节点的前端扩展（自绘多选面板）
//
// 不使用官方 image_upload 控件的原因（依据前端 WidgetSelect bundle 的实现）：
//   * 该控件仅支持单选，bundle 中未出现 multiselect；
//   * 它还附带「遮罩编辑器 / 下载」两个按钮，与本节点职责重叠。
// 因此参照 MiniMaxH3-Easy 媒体加载器的做法：唯一控件为隐藏的
// media_state(JSON)，媒体清单由本文件的自绘面板管理。
//
// 面板：图片 N + 上传图片 / 从库里选 + 图片缩略图网格（序号 + × 移除）；
//       点缩略图放大预览；底部输出槽按「选了几张」由前端重建（后端声明满 10 个）。
//
// 注意：media_state 是位置型控件，只能隐藏、不可删除（computeSize = () => [0, -4]），
//    否则节点上的其它控件值会整体错位。

import { app } from "../../scripts/app.js";

const NODE_CLASS = "KedouImageLoader";
// 输出槽上限。ComfyUI 的 RETURN_TYPES 必须静态声明，所以「不限制数量」只能体现为
// 给一个足够大的上限（原来是 10，2026-09-28 提到 50）。实际露出几个由 syncOutputs 按需控制：
// 初始 1 个，连到第 n 个才露出第 n+1 个 —— 所以上限调大不会让节点界面变长。
const IMG_SLOTS = 50;
const IMG_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"];
const VID_EXTS = [".mp4", ".mov", ".webm", ".avi", ".mkv"];
const AUD_EXTS = [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"];

const CSS = [
  // 2026-09-28 试过 flex:1 + align-self:stretch 撑满，**已撤回**：
  // 卡片高度会被计入节点尺寸 → 撑高卡片 → 节点变高 → 容器变高 → 卡片再变高（正反馈），
  // 最后节点被撑到拖不小。所以回到 height:100%（它不会引起这个循环）。
  // 注意：右侧输出槽栏不能碰，卡片宽度靠父容器留给它的空间，这里不设宽度。
  ".kd-card{border:1px solid var(--border-color,#3a3a44);border-radius:10px;overflow:hidden;",
  "background:var(--comfy-input-bg,rgba(0,0,0,.28));display:flex;flex-direction:column;height:100%;}",
  ".kd-top{display:flex;align-items:center;gap:8px;padding:7px 10px;flex:none;",
  "border-bottom:1px solid var(--border-color,#3a3a44);}",
  ".kd-top b{font-size:12px;font-weight:600;}",
  ".kd-top em{font-style:normal;font-size:11px;color:var(--descrip-text,#9a9aa6);}",
  // 开关（toggle switch）：批次 / 选择模式共用
  ".kd-sw{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--descrip-text,#9a9aa6);cursor:pointer;flex:none;user-select:none;}",
  ".kd-sw i{width:26px;height:14px;border-radius:999px;background:rgba(127,127,127,.35);position:relative;transition:background .15s;flex:none;}",
  ".kd-sw i::after{content:\"\";position:absolute;left:2px;top:2px;width:10px;height:10px;border-radius:50%;background:#fff;transition:transform .15s;}",
  ".kd-sw input{display:none;}",
  ".kd-sw input:checked + i{background:var(--p-primary-color,#4a7dff);}",
  ".kd-sw input:checked + i::after{transform:translateX(12px);}",
  // 选择模式下的格子状态：选中的主色描边 + 顺序徽标；未选中的序号变暗
  ".kd-cell.kd-picked{border-color:var(--p-primary-color,#4a7dff);box-shadow:0 0 0 1px var(--p-primary-color,#4a7dff);}",
  ".kd-cell.kd-picked .kd-no{background:var(--p-primary-color,#4a7dff);color:#fff;font-weight:600;}",
  // 框选：拖拽时画的临时选框
  ".kd-marquee{position:fixed;z-index:100002;border:1px solid var(--p-primary-color,#4a7dff);",
  "background:rgba(74,125,255,.12);pointer-events:none;}",
  ".kd-cell.kd-skip .kd-no{opacity:.35;}",
  ".kd-btns{margin-left:auto;display:flex;gap:6px;}",
  ".kd-btn{border:1px solid var(--border-color,#3a3a44);background:transparent;color:var(--fg-color,#e7e7ea);",
  "font:inherit;font-size:11px;padding:3px 10px;border-radius:7px;cursor:pointer;}",
  ".kd-btn:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}",
  ".kd-btn.kd-p{border-color:transparent;background:var(--p-primary-color,#4a7dff);color:#fff;font-weight:600;}",
  ".kd-btn[disabled]{opacity:.45;cursor:default;}",
  ".kd-body{padding:8px 10px 10px;display:flex;flex-direction:column;gap:9px;flex:1;overflow:auto;}",
  ".kd-sec{display:flex;flex-direction:column;gap:6px;}",
  ".kd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px;}",
  ".kd-cell{position:relative;aspect-ratio:1/1;border-radius:10px;overflow:hidden;",
  "border:1px solid var(--border-color,#3a3a44);background:rgba(127,127,127,.14);",
  "transition:transform .12s ease,border-color .12s ease,box-shadow .12s ease;}",
  // hover 反馈：描边高亮 + 图片由 cover 改 contain（完整显示，不再被方形裁掉）
  ".kd-cell:hover{border-color:var(--p-primary-color,#4a7dff);z-index:3;",
  "box-shadow:0 0 0 1px var(--p-primary-color,#4a7dff),0 4px 14px rgba(0,0,0,.35);}",
  ".kd-cell img{width:100%;height:100%;object-fit:cover;display:block;}",
  ".kd-cell:hover img{object-fit:contain;}",
  // 悬浮放大层：跟随鼠标显示完整大图。
  // 为什么不是给格子加 scale：格子在 .kd-libbody / .kd-body 这些 overflow:auto 的滚动容器里，
  // transform 放大的部分会被容器裁掉；所以用 fixed 定位的独立层。
  ".kd-zoom{position:fixed;z-index:100001;pointer-events:none;display:none;",
  "max-width:344px;border-radius:10px;overflow:hidden;",
  "border:2px solid var(--p-primary-color,#4a7dff);",
  "box-shadow:0 10px 30px rgba(0,0,0,.55);background:var(--comfy-menu-bg,#232329);}",
  ".kd-zoom img{display:block;max-width:340px;max-height:340px;width:auto;height:auto;object-fit:contain;}",
  ".kd-no{position:absolute;left:4px;bottom:4px;font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;",
  "background:rgba(0,0,0,.66);color:#fff;max-width:calc(100% - 8px);overflow:hidden;text-overflow:ellipsis;",
  "white-space:nowrap;}",
  ".kd-x{position:absolute;right:3px;top:3px;width:17px;height:17px;line-height:15px;padding:0;border:0;",
  "border-radius:50%;cursor:pointer;background:rgba(0,0,0,.6);color:#fff;font-size:11px;opacity:0;transition:opacity .12s;}",
  ".kd-cell:hover .kd-x{opacity:1;}",
  ".kd-empty{padding:12px 6px;text-align:center;font-size:11.5px;color:var(--descrip-text,#9a9aa6);}",
  ".kd-lib{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);",
  "display:flex;align-items:center;justify-content:center;}",
  ".kd-libwin{width:min(820px,92vw);height:min(600px,86vh);display:flex;flex-direction:column;",
  "background:var(--comfy-menu-bg,#232329);color:var(--fg-color,#e7e7ea);border:1px solid var(--border-color,#3a3a44);",
  "border-radius:12px;overflow:hidden;font:12.5px/1.6 system-ui,sans-serif;}",
  ".kd-libtop{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border-color,#3a3a44);}",
  ".kd-libtop b{font-size:13.5px;}",
  ".kd-libtop input{margin-left:auto;width:180px;padding:4px 10px;border-radius:999px;",
  "border:1px solid var(--border-color,#3a3a44);background:transparent;color:inherit;font:inherit;outline:none;}",
  ".kd-libbody{flex:1;overflow:auto;padding:12px;}",
  ".kd-libfoot{display:flex;align-items:center;gap:10px;padding:10px 12px;border-top:1px solid var(--border-color,#3a3a44);}",
  ".kd-libfoot i{font-style:normal;font-size:11px;opacity:.75;}",
  ".kd-big{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.82);",
  "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;",
  "padding:24px;cursor:zoom-out;}",
  ".kd-big img{max-width:92vw;max-height:84vh;object-fit:contain;border-radius:8px;display:block;}",
  ".kd-bigcap{font:12px/1.6 system-ui,sans-serif;color:#e8e8ee;opacity:.85;word-break:break-all;text-align:center;}",
].join("");

let cssDone = false;
function ensureCss() {
  if (cssDone || document.getElementById("kd-two-css")) {
    cssDone = true;
    return;
  }
  console.log("[kedou] 前端扩展已加载 · build 2026-09-28c");
  const s = document.createElement("style");
  s.id = "kd-two-css";
  s.textContent = CSS;
  document.head.appendChild(s);
  cssDone = true;
}

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function wOf(node, name) {
  return (node.widgets || []).find((w) => w.name === name);
}

function baseName(v) {
  const p = String(v || "").replace(/\\/g, "/").split("/");
  return p[p.length - 1] || String(v || "");
}

function subOf(v) {
  const s = String(v || "").replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(0, i) : "";
}

function viewUrl(name, sub) {
  return "/view?" + new URLSearchParams({ filename: name, subfolder: sub || "", type: "input" }).toString();
}

// 缩略图 URL：走 ComfyUI 原生的 /view?...&preview= 参数（2026-09-28 实测，本机 output 图取样）。
// 不加 preview 就是原图——output 图片中位 2.7MB，媒体库一次渲染 400 张 ≈ 1GB，打开必卡。
// 参数格式 "<格式>;<质量>;<resize>"，实测结论：
//   jpeg;50;0.0 -> 184KB / 0.031s  ← 用它
//   webp;90;0.0 -> 154KB / 0.23s   （webp 编码比 jpeg 慢 7 倍，体积只小 17%，不划算）
//   webp 的 quality 位实测无效（90/75/50 输出字节数完全一样）
//   resize 位给 512/256 反而变大（628KB），所以用 0.0（不缩放，只转格式+降质）
// 注意 preview 结果 ComfyUI 不缓存，每次请求都重新编码（0.03s，可接受）。
// 分号不要 encodeURIComponent —— 实测未编码才能被后端正确解析。
function thumbUrl(name, sub) {
  return viewUrl(name, sub) + "&preview=jpeg;50;0.0";
}

// ---- 悬浮放大预览（媒体库网格 + 图片加载器面板共用） ----
// 鼠标移到格子上时，在鼠标旁边浮出一张完整大图（contain，不裁切，主色高亮边）。
// 用 dataset 记住当前 url，只在换图时才重设 src —— 否则 mousemove 每动一下都会重新发起请求。
let kdZoomEl = null;
function kdZoomBox() {
  if (kdZoomEl && document.contains(kdZoomEl)) return kdZoomEl;
  const d = document.createElement("div");
  d.className = "kd-zoom";
  d.appendChild(document.createElement("img"));
  document.body.appendChild(d);
  kdZoomEl = d;
  return d;
}
function kdZoomShow(url, x, y) {
  const d = kdZoomBox();
  if (d.dataset.url !== url) {
    d.firstElementChild.src = url;
    d.dataset.url = url;
  }
  d.style.display = "block";
  const W = 344, H = 344, pad = 16;
  let left = x + pad;
  let top = y + pad;
  if (left + W > window.innerWidth) left = Math.max(8, x - W - pad);
  if (top + H > window.innerHeight) top = Math.max(8, window.innerHeight - H - 8);
  d.style.left = left + "px";
  d.style.top = top + "px";
}
function kdZoomHide() { if (kdZoomEl) kdZoomEl.style.display = "none"; }
// url 可以是字符串，也可以是函数（图片加载器的 src 会在 input→output 回退时变化，需要现取）
function attachZoom(cell, urlOrFn) {
  if (!urlOrFn) return;
  const getUrl = typeof urlOrFn === "function" ? urlOrFn : () => urlOrFn;
  const at = (e) => { const u = getUrl(); if (u) kdZoomShow(u, e.clientX, e.clientY); };
  cell.addEventListener("mouseenter", at);
  cell.addEventListener("mousemove", at);
  cell.addEventListener("mouseleave", kdZoomHide);
}

// 框选：在容器空白处按下拖动画框，松手后把与框相交的格子索引回调出去（按网格顺序）。
// 格子上按下不启动（那是点击选中/预览），从格间空隙和网格外的空白拖。
function kdMarquee(container, getCells, onDone, enabled) {
  container.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest(".kd-cell, button, input")) return;
    if (enabled && !enabled()) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const box = document.createElement("div");
    box.className = "kd-marquee";
    document.body.appendChild(box);
    const move = (ev) => {
      box.style.left = Math.min(sx, ev.clientX) + "px";
      box.style.top = Math.min(sy, ev.clientY) + "px";
      box.style.width = Math.abs(ev.clientX - sx) + "px";
      box.style.height = Math.abs(ev.clientY - sy) + "px";
    };
    const up = (ev) => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      box.remove();
      const r = { l: Math.min(sx, ev.clientX), t: Math.min(sy, ev.clientY),
                  r: Math.max(sx, ev.clientX), b: Math.max(sy, ev.clientY) };
      const hit = [];
      getCells().forEach((cell, i) => {
        const cr = cell.getBoundingClientRect();
        if (cr.left < r.r && cr.right > r.l && cr.top < r.b && cr.bottom > r.t) hit.push(i);
      });
      if (hit.length) onDone(hit);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

function hideWidget(w, on) {
  if (!w) return;
  if (on) {
    if (w._kdHidden) {
      w._kdHidden = false;
      if (w._kdType) w.type = w._kdType;
      if (w._kdCompute) w.computeSize = w._kdCompute;
      if (w.inputEl) w.inputEl.style.display = "";
      if (w.element) w.element.style.display = "";
      if ("hidden" in w) w.hidden = false;
    }
    return;
  }
  if (w._kdHidden) return;
  w._kdHidden = true;
  if (!w._kdType) w._kdType = w.type;
  // 关键：光改 computeSize 在新前端（Vue 渲染控件）里藏不住 ——
  // 还得把类型标成 converted-widget，前端就跳过绘制；值仍照常随工作流序列化。
  w.type = "converted-widget";
  if (!w._kdCompute) w._kdCompute = w.computeSize;
  w.computeSize = () => [0, -4];
  if (w.inputEl) w.inputEl.style.display = "none";
  if (w.element) w.element.style.display = "none";
  if ("hidden" in w) w.hidden = true;
  if (!w._kdSerializeSaved) {
    w._kdSerializeSaved = w.serializeValue || null;
    w.serializeValue = async () => w.value;   // 值照常进工作流 / API 图
  }
}

function hookWidget(w, fn) {
  if (!w || w._kdHooked) return;
  w._kdHooked = true;
  const prev = w.callback;
  w.callback = function () {
    const r = typeof prev === "function" ? prev.apply(this, arguments) : undefined;
    setTimeout(fn, 0);
    return r;
  };
}

// ---------------------------------------------------------------- 状态
function readState(node) {
  const w = wOf(node, "media_state");
  let obj = null;
  try {
    obj = JSON.parse(w ? String(w.value == null ? "" : w.value) : "");
  } catch (e) {
    obj = null;
  }
  const list = obj && Array.isArray(obj.images) ? obj.images : [];
  return {
    images: list
      .map((it) => (it && typeof it === "object" ? it : { filename: it }))
      .filter((it) => it && typeof it.filename === "string" && it.filename.trim())
      .slice(0, IMG_SLOTS),
    // 批次 / 选择模式字段：批次循环与选择输出都靠它们驱动，读取入口必须带出来
    batch: !!(obj && obj.batch),
    cursor: (obj && Number(obj.cursor)) || 0,
    select: !!(obj && obj.select),
    picked: (obj && Array.isArray(obj.picked)) ? obj.picked.filter((f) => typeof f === "string") : [],
  };
}

function writeState(node, state) {
  const w = wOf(node, "media_state");
  if (!w) return;
  // batch/cursor/select/picked 必须一起写：批次循环与选择输出都靠它们驱动，
  // 上次就吃过「序列化只写一部分、其余字段被静默丢掉」的亏
  w.value = JSON.stringify({
    images: state.images.map((it) => ({ filename: it.filename })),
    batch: !!state.batch,
    cursor: Math.max(0, Number(state.cursor) || 0),
    select: !!state.select,
    picked: (state.picked || []).filter((f) => typeof f === "string"),
  });
  try {
    if (typeof w.callback === "function") w.callback(w.value);
  } catch (e) {
    /* callback 不是必须的 */
  }
  node.setDirtyCanvas(true, true);
}

// ---------------------------------------------------------------- 输出槽重建
function linksOf(node, index) {
  const out = node && node.outputs ? node.outputs[index] : null;
  return Array.isArray(out && out.links) ? out.links.slice() : (out && out.link != null ? [out.link] : []);
}

// 删槽/重排后需重指已有连线的起点槽号，否则连线会落到错误的输入槽。
// LiteGraph 用 origin_slot；Vue 图适配器用 originSlot / from_slot / fromSlot，四个都写。
function repointLinks(node) {
  const graph = (node && node.graph) || app.graph;
  if (!graph || !node || !Array.isArray(node.outputs)) return;
  node.outputs.forEach((_out, index) => {
    for (const id of linksOf(node, index)) {
      const link = typeof graph.getLink === "function" ? graph.getLink(id) : graph.links && graph.links[id];
      if (!link) continue;
      link.origin_slot = index;
      if ("originSlot" in link) link.originSlot = index;
      if ("from_slot" in link) link.from_slot = index;
      if ("fromSlot" in link) link.fromSlot = index;
    }
  });
}

function resizeToContent(node) {
  if (!node || typeof node.computeSize !== "function" || typeof node.setSize !== "function") return;
  const measured = node.computeSize();
  if (!Array.isArray(measured) || !Number.isFinite(Number(measured[1]))) return;
  const w = Math.max(300, Number(node.size && node.size[0]) || 0, Number(measured[0]) || 0);
  const h = Math.max(1, Math.ceil(Number(measured[1])));
  if (Math.abs((Number(node.size && node.size[1]) || 0) - h) > 1) node.setSize([w, h]);
}

// 兜底：直接把高度写给卡片。为什么需要它——ComfyUI 不一定把卡片直接放进宿主容器，
// 中间可能隔一层 wrapper，那样 height:100% / flex:1 都会失效，卡片退回内容高度并被居中
// （这就是输出槽一多、上下就留白的原因）。所以这里向上找若干层，取最高的那个祖先高度；
// 祖先高度都不可信时，再按节点高度推算（扣掉标题栏等固定开销），并夹住不让它超出节点。
function fitCard(node, quick) {
  const ui = node && node._kdUI;
  if (!ui || !ui.card) return;
  const card = ui.card;
  const host = card.parentElement;
  if (!host) return;
  // 拖拽节点边缘缩放不会触发 renderPanel —— 用 ResizeObserver 盯住容器，
  // 容器一变（拉大/缩小）就走 quick 模式实时跟随，卡片才能一直铺满。
  if (!node.__kdRO && typeof ResizeObserver === "function") {
    node.__kdRO = new ResizeObserver(function () { fitCard(node, true); });
    node.__kdRO.observe(host);
  }
  // 两条硬知识（都是实测教训）：
  // ① node.size[1] 是画布坐标，DOM 容器是 CSS 像素，两套坐标系不能互相换算，高度只能实测；
  // ② 卡片高度会被计入节点尺寸 —— 撑高卡片 → 节点变高 → 容器变高 → 卡片再变高是正反馈，
  //    所以「容器高 ≈ 上次设置的卡片高 + off」就是平衡态，此时必须停手，否则节点会自己长个不停。
  let contentH = Number(node.__kdContentH || 0);
  if (!quick) {
    // 完整测量（图片增删/连线变化时）：清掉拉伸回到内容布局，量真实的偏移与内容高度
    if (host.style.height) host.style.height = "";
    if (card.style.height) card.style.height = "";
    node.__kdOff = card.offsetTop;         // 卡片起始位置 = 输出槽区结束处
    contentH = card.scrollHeight;
    node.__kdContentH = contentH;
  }
  const off = Number(node.__kdOff || 0);
  const hostH = host.clientHeight;
  const prev = Number(node.__kdFitH || 0);
  if (prev && Math.abs(hostH - (prev + off)) < 12) return;   // 平衡态，动它只会爬升
  const target = hostH - off - 6;          // 从槽位区结束处一路撑到容器底部
  if (target > contentH + 20 && target > 150) {
    card.style.height = target + "px";
    node.__kdFitH = target;
  } else if (prev) {
    // 内容已经够高（图片多到自然占满）—— 去掉拉伸，让卡片回自然高度
    card.style.height = "";
    delete node.__kdFitH;
  }
}

function syncOutputs(node) {
  if (!node.outputs) node.outputs = [];
  let hi = -1;
  node.outputs.forEach((o, i) => {
    if (o && o.links && o.links.length) hi = i;
  });
  // 输出只随连线增长：连到第 hi 槽就露出 hi+1（下一个空位），初始 1 个，上限 10。
  const n = Math.max(1, Math.min(IMG_SLOTS, hi + 2));
  let changed = false;
  while (node.outputs.length > n) {
    const last = node.outputs[node.outputs.length - 1];
    if (last && last.links && last.links.length) break; // 有连线的一律不删
    node.outputs.pop();
    changed = true;
  }
  while (node.outputs.length < n) {
    const i = node.outputs.length + 1;
    if (typeof node.addOutput === "function") node.addOutput("image_" + i, "IMAGE");
    else node.outputs.push({ name: "image_" + i, type: "IMAGE", links: [] });
    changed = true;
  }
  node.outputs.forEach((o, i) => {
    const label = "图片" + (i + 1);
    if (o.name !== "image_" + (i + 1)) o.name = "image_" + (i + 1);
    o.type = "IMAGE";
    o.display_name = label;
    if ("label" in o) o.label = label;
  });
  if (changed) repointLinks(node);
  return changed;
}

// ---------------------------------------------------------------- 放大预览
function openBig(name, sub) {
  const ov = document.createElement("div");
  ov.className = "kd-big";
  const img = document.createElement("img");
  let tried = false;
  img.onerror = () => {
    if (tried) {
      img.alt = "读不到这张图";
      return;
    }
    tried = true;
    img.src = viewUrl(name, sub).replace("type=input", "type=output");
  };
  img.src = viewUrl(name, sub);
  const cap = document.createElement("div");
  cap.className = "kd-bigcap";
  cap.textContent = (sub ? sub + "/" : "") + name;
  ov.append(img, cap);

  function close() {
    ov.remove();
    document.removeEventListener("keydown", onKey, true);
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  ov.onclick = close;
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(ov);
}

// ---------------------------------------------------------------- 媒体库弹窗（走桥接 /ps/media）
async function fetchLibrary(kind, q) {
  const qs = new URLSearchParams({ type: kind, tab: "all", q: q || "" }).toString();
  for (const p of ["/ps/media?", "/api/ps/media?"]) {
    try {
      const r = await fetch(p + qs);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.ok) return j.items || [];
    } catch (e) {
      /* 试下一个前缀 */
    }
  }
  return null;
}

function openLibrary(onPick) {
  ensureCss();   // 样式原本只在节点面板 build() 里注入；从这里单独打开时也得有，否则整个弹窗是裸的
  const picked = new Map();
  const ov = document.createElement("div");
  ov.className = "kd-lib";
  const win = document.createElement("div");
  win.className = "kd-libwin";
  const top = document.createElement("div");
  top.className = "kd-libtop";
  top.innerHTML = '<b>从媒体库选图片</b>';
  const search = document.createElement("input");
  search.placeholder = "搜索文件名…";
  top.appendChild(search);
  const body = document.createElement("div");
  body.className = "kd-libbody";
  const foot = document.createElement("div");
  foot.className = "kd-libfoot";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "kd-btn";
  cancelBtn.textContent = "取消";
  cancelBtn.style.marginLeft = "auto";
  const tip = document.createElement("i");
  const okBtn = document.createElement("button");
  okBtn.className = "kd-btn kd-p";
  foot.append(cancelBtn, tip, okBtn);
  win.append(top, body, foot);
  ov.appendChild(win);
  ov.onclick = (e) => { if (e.target === ov) close(); };
  document.body.appendChild(ov);

  function close() { ov.remove(); }
  cancelBtn.onclick = close;
  okBtn.onclick = () => {
    const list = [...picked.values()];
    close();
    if (list.length) onPick(list);
  };
  // 防抖 300ms：否则每敲一个字符都重新请求后端并重建整个网格（400 张缩略图重来一遍）
  let searchTimer = null;
  search.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 300);
  };

  function syncFoot() {
    tip.textContent = picked.size ? "已选 " + picked.size + " 个" : "";
    okBtn.textContent = picked.size ? "加入 " + picked.size + " 个" : "加入";
    okBtn.disabled = !picked.size;
  }

  // 分批渲染：一次只画 80 格（400 格即便都是缩略图，首屏也要等十几秒），
  // 滚到底部再增量追加 —— 追加而不是重建，已渲染的格子不会重新加载图片。
  const BATCH = 80;
  let curItems = [], shown = 0, gridEl = null;
  let anchorIdx = -1;   // Shift 范围多选的锚点（上一次点击的格子序号）

  // 批量重画选中描边：点击单格只动一处，Shift/框选会改一整片，统一刷一遍
  function updateOutlines() {
    if (!gridEl) return;
    gridEl.querySelectorAll(".kd-cell").forEach((c) => {
      c.style.outline = picked.has(c.dataset.kdKey) ? "2px solid var(--p-primary-color,#4a7dff)" : "none";
    });
  }

  // 框选：网格空白处按下拖动画框，松手把框内图片加入选择（不清除已有，叠加式）
  kdMarquee(body, () => gridEl ? Array.from(gridEl.querySelectorAll(".kd-cell")) : [], (idxs) => {
    for (const i of idxs) {
      const it = curItems[i];
      if (!it) continue;
      const kk = (it.subfolder ? it.subfolder + "/" : "") + it.name;
      if (!picked.has(kk)) picked.set(kk, { filename: kk });
    }
    updateOutlines();
    syncFoot();
  });

  function mkCell(it, idx) {
    const key = (it.subfolder ? it.subfolder + "/" : "") + it.name;
    const cell = document.createElement("div");
    cell.className = "kd-cell";
    cell.dataset.kdKey = key;
    cell.style.outline = picked.has(key) ? "2px solid var(--p-primary-color,#4a7dff)" : "none";
    const src = (it.url || viewUrl(it.name, it.subfolder)) + "&preview=jpeg;50;0.0";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = src;
    img.onerror = () => { img.style.visibility = "hidden"; };
    cell.appendChild(img);
    const no = document.createElement("span");
    no.className = "kd-no";
    no.textContent = it.name;
    cell.appendChild(no);
    attachZoom(cell, src);
    cell.onclick = (e) => {
      if (e.shiftKey && anchorIdx >= 0) {
        // Shift 范围多选：从上次点击的格子到本次，整段加入选择
        const lo = Math.min(anchorIdx, idx), hi = Math.max(anchorIdx, idx);
        for (let k = lo; k <= hi; k++) {
          const it2 = curItems[k];
          if (!it2) continue;
          const kk = (it2.subfolder ? it2.subfolder + "/" : "") + it2.name;
          if (!picked.has(kk)) picked.set(kk, { filename: kk });
        }
      } else if (picked.has(key)) {
        picked.delete(key);
      } else {
        picked.set(key, { filename: key });
      }
      anchorIdx = idx;
      updateOutlines();
      syncFoot();
    };
    return cell;
  }

  function appendBatch() {
    if (!gridEl) return;
    const next = curItems.slice(shown, shown + BATCH);
    let k = shown;
    for (const it of next) gridEl.appendChild(mkCell(it, k++));
    shown = k;
  }

  function render() {
    syncFoot();
    body.style.color = "";
    body.textContent = "读取中…";
    fetchLibrary("image", search.value).then((items) => {
      body.innerHTML = "";
      if (items === null) {
        body.textContent = "桥接插件未加载：重启一次 ComfyUI 即可（/ps/media 拿不到）。";
        body.style.color = "var(--descrip-text,#9a9aa6)";
        return;
      }
      if (!items.length) {
        body.textContent = "没有匹配的图片。";
        body.style.color = "var(--descrip-text,#9a9aa6)";
        return;
      }
      curItems = items; shown = 0; anchorIdx = -1;
      gridEl = document.createElement("div");
      gridEl.className = "kd-grid";
      body.appendChild(gridEl);
      appendBatch();          // 先渲染第一批，剩下的滚动到底再追加
      body.onscroll = () => {
        if (shown >= curItems.length) return;
        if (body.scrollTop + body.clientHeight >= body.scrollHeight - 140) appendBatch();
      };
    });
  }
  render();
}

async function uploadFiles(files) {
  const added = [];
  for (const f of files) {
    const low = String(f.name).toLowerCase();
    if (!IMG_EXTS.some((e) => low.endsWith(e))) continue;
    const fd = new FormData();
    fd.append("image", f);
    fd.append("overwrite", "true");
    for (const p of ["/upload/image", "/api/upload/image"]) {
      try {
        const r = await fetch(p, { method: "POST", body: fd });
        if (!r.ok) continue;
        const j = await r.json();
        if (j && j.name) {
          added.push({ filename: (j.subfolder ? j.subfolder + "/" : "") + j.name });
          break;
        }
      } catch (e) {
        /* 试下一个前缀 */
      }
    }
  }
  return added;
}

// ---------------------------------------------------------------- 面板
function renderPanel(node) {
  const ui = node._kdUI;
  if (!ui) return;
  const state = readState(node);
  syncOutputs(node);   // 输出槽只随连线增长（初始 1 个，连一个长一个）
  ui.count.textContent = String(state.images.length);
  // 两个开关与按钮的状态跟随（赋值 checked 不会触发 onchange，安全）
  if (ui.swBatchCb) ui.swBatchCb.checked = !!state.batch;
  if (ui.swSelCb) ui.swSelCb.checked = !!state.select;
  const effN = effectiveImages(state).length;
  if (ui.runBtn) {
    ui.runBtn.style.display = state.batch ? "" : "none";
    ui.runBtn.textContent = "▶ 跑 " + effN + " 张";
    ui.runBtn.disabled = !effN;
  }
  ui.body.innerHTML = "";

  const sec = document.createElement("div");
  sec.className = "kd-sec";

  if (!state.images.length) {
    const d = document.createElement("div");
    d.className = "kd-empty";
    d.textContent = "还没有图片 —— 用「上传图片」或「从库里选」加。";
    sec.appendChild(d);
    ui.body.appendChild(sec);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "kd-grid";
  // 选择模式：点击 = 按顺序选中/取消（选中顺序即输出顺序），不放大预览；
  // 普通模式：点击 = 放大预览，hover 跟随。
  const selMode = !!state.select;
  const pickOrder = {};
  (state.picked || []).forEach((f, idx) => { if (!(f in pickOrder)) pickOrder[f] = idx + 1; });
  state.images.forEach((it, i) => {
    const cell = document.createElement("div");
    cell.className = "kd-cell";
    cell.title = it.filename;
    const img = document.createElement("img");
    img.loading = "lazy";
    // 先按 input 找，找不到再退到 output；悬浮预览要跟着用最终那个地址
    let zoomSrc = thumbUrl(baseName(it.filename), subOf(it.filename));
    let tried = false;
    img.onerror = () => {
      if (tried) {
        img.style.visibility = "hidden";
        return;
      }
      tried = true;
      zoomSrc = thumbUrl(baseName(it.filename), subOf(it.filename)).replace("type=input", "type=output");
      img.src = zoomSrc;
    };
    img.src = zoomSrc;
    cell.appendChild(img);
    if (!selMode) attachZoom(cell, () => zoomSrc);
    // 序号：普通模式 = 面板顺序；选择模式下选中的显示选择顺序号（主色徽标），未选中的变暗
    const pk = selMode ? (pickOrder[it.filename] || 0) : 0;
    const no = document.createElement("span");
    no.className = "kd-no";
    no.textContent = selMode && pk ? String(pk) : String(i + 1);
    if (selMode) {
      no.style.background = pk ? "var(--p-primary-color,#4a7dff)" : "";
      no.style.opacity = pk ? "" : ".35";
    }
    cell.appendChild(no);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "kd-x";
    x.textContent = "×";
    x.onclick = (e) => {
      e.stopPropagation();
      const st2 = readState(node);
      st2.images.splice(i, 1);
      if (st2.picked) st2.picked = st2.picked.filter((f) => f !== it.filename);   // 同步清理选择集
      writeState(node, st2);
      renderPanel(node);
    };
    cell.appendChild(x);
    if (selMode) {
      cell.classList.toggle("kd-picked", !!pk);
      cell.onclick = (e) => {
        const st2 = readState(node);
        st2.picked = st2.picked || [];
        if (e.shiftKey && typeof node.__kdAnchor === "number" && node.__kdAnchor >= 0
            && node.__kdAnchor < state.images.length) {
          // Shift 范围多选：从上次点击到本次，整段按面板顺序加入选择
          const lo = Math.min(node.__kdAnchor, i), hi = Math.max(node.__kdAnchor, i);
          for (let k = lo; k <= hi; k++) {
            const fn = state.images[k].filename;
            if (st2.picked.indexOf(fn) < 0) st2.picked.push(fn);
          }
        } else {
          const at = st2.picked.indexOf(it.filename);
          if (at >= 0) st2.picked.splice(at, 1);
          else st2.picked.push(it.filename);
        }
        node.__kdAnchor = i;
        writeState(node, st2);
        renderPanel(node);
      };
    } else {
      cell.onclick = () => openBig(baseName(it.filename), subOf(it.filename));
    }
    grid.appendChild(cell);
  });
  sec.appendChild(grid);
  ui.body.appendChild(sec);
  // 先把卡片顶满，再算节点高度，最后再顶一次（节点高度变了，容器高度也跟着变）
  fitCard(node);
  setTimeout(() => { resizeToContent(node); fitCard(node); }, 0);
}

async function uploadFilesWrapper(node, files) {
  uiSetBusy(node, true);
  const added = await uploadFiles(files);
  const state = readState(node);
  state.images = state.images.concat(added).slice(0, IMG_SLOTS);
  writeState(node, state);
  uiSetBusy(node, false);
  renderPanel(node);
}

// 当前「生效」的图片列表：选择模式开且有选中 → 选中的（按选择顺序）；否则全部照片。
// 批次循环的次数、输出槽的启用数都以它为准。
function effectiveImages(state) {
  if (state.select && state.picked && state.picked.length) {
    const map = {};
    state.images.forEach((it) => { map[it.filename] = it; });
    const list = state.picked.filter((f) => map[f]).map((f) => map[f]);
    if (list.length) return list;
  }
  return state.images;
}

function uiSetBusy(node, busy) {
  const ui = node._kdUI;
  if (!ui) return;
  if (ui.upBtn) {
    ui.upBtn.disabled = busy;
    ui.upBtn.textContent = busy ? "上传中…" : "上传图片";
  }
  if (ui.libBtn) ui.libBtn.disabled = busy;
  if (ui.runBtn) {
    const st = readState(node);
    ui.runBtn.disabled = !!busy || !(st.images || []).length;
  }
}

// 批次运行：把当前选的 N 张图逐张排队 —— 每次改 media_state 的游标再提交，
// ComfyUI 队列按顺序一张张跑完整条链路。每次下游只吃 1 张，显存恒定，
// 各张尺寸也可以不同。跑完游标停在最后，下次点批次按钮照常从第 1 张开始。
async function runBatch(node) {
  const state = readState(node);
  const n = effectiveImages(state).length;
  if (!n) { kpToast("没有图片可跑", true); return; }
  uiSetBusy(node, true);
  try {
    for (let i = 0; i < n; i++) {
      const st = readState(node);
      st.batch = true;
      st.cursor = i;
      writeState(node, st);
      console.log("[kedou] 批次提交 " + (i + 1) + "/" + n + " cursor=" + i
        + " widget=" + (wOf(node, "media_state") || {}).value);
      await app.queuePrompt(0);        // 内部会 graphToPrompt，cursor=i 随图一起进队列
      kpToast("批次 " + (i + 1) + "/" + n + " 已入队");
    }
    kpToast("批次提交完成：已排入 " + n + " 张，ComfyUI 会按队列依次跑完");
  } catch (e) {
    kpToast("批次提交失败：" + (e && e.message ? e.message : String(e)), true);
  } finally {
    uiSetBusy(node, false);
  }
}

function build(node) {
  ensureCss();
  hideWidget(wOf(node, "media_state"), false);

  const card = document.createElement("div");
  card.className = "kd-card";
  const top = document.createElement("div");
  top.className = "kd-top";
  const title = document.createElement("b");
  title.textContent = "图片";
  const count = document.createElement("em");
  const btns = document.createElement("div");
  btns.className = "kd-btns";
  const libBtn = document.createElement("button");
  libBtn.className = "kd-btn";
  libBtn.textContent = "从库里选";
  const upBtn = document.createElement("button");
  upBtn.className = "kd-btn kd-p";
  upBtn.textContent = "上传图片";
  const fileEl = document.createElement("input");
  fileEl.type = "file";
  fileEl.multiple = true;
  fileEl.accept = IMG_EXTS.join(",");
  fileEl.style.display = "none";
  // 批次模式开关：打开后「跑 N 张」按钮出现，点一下把所有图片逐张排队（每次从图片1 出一张）
  const runBtn = document.createElement("button");
  runBtn.className = "kd-btn kd-p";
  runBtn.style.display = "none";
  runBtn.onclick = () => runBatch(node);
  btns.append(libBtn, upBtn, runBtn, fileEl);
  // 批次 / 选择两个开关（toggle 样式）
  const mkSwitch = (label, title) => {
    const lab = document.createElement("label");
    lab.className = "kd-sw";
    lab.title = title;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    lab.append(cb, document.createElement("i"), document.createTextNode(label));
    return { lab, cb };
  };
  const swBatch = mkSwitch("批次", "批次模式：打开后点「跑 N 张」，按当前生效的图片自动排队，每张独立跑一遍工作流，从图片1 依次输出");
  const swSel = mkSwitch("选择", "选择模式：打开后点击面板图片即选中（按点击顺序编号），再点取消；此时只输出被选中的照片，且点击不再放大预览");
  swBatch.cb.onchange = function () {
    const st = readState(node);
    st.batch = swBatch.cb.checked;
    writeState(node, st);
    renderPanel(node);
  };
  swSel.cb.onchange = function () {
    const st = readState(node);
    st.select = swSel.cb.checked;
    if (!st.select) st.picked = [];   // 关掉选择模式 = 回到全部输出，选择集清空
    writeState(node, st);
    renderPanel(node);
  };
  top.append(title, count, swBatch.lab, swSel.lab, btns);
  const body = document.createElement("div");
  body.className = "kd-body";
  card.append(top, body);

  node._kdUI = { card, body, count, libBtn, upBtn, fileEl, runBtn, swBatchCb: swBatch.cb, swSelCb: swSel.cb };
  // 框选：网格空白处拖动画框，框内图片批量加入选择（仅选择模式生效；格子上按下不启动）
  kdMarquee(body, () => Array.from(body.querySelectorAll(".kd-cell")), (idxs) => {
    const st = readState(node);
    if (!st.select) return;
    st.picked = st.picked || [];
    for (const i of idxs) {
      const fn = (st.images[i] || {}).filename;
      if (fn && st.picked.indexOf(fn) < 0) st.picked.push(fn);
    }
    writeState(node, st);
    renderPanel(node);
  }, () => !!readState(node).select);
  node.addDOMWidget("kedou_media", "div", card, {
    getMinHeight: () => 200,
    hideOnZoom: false,
    serialize: false,
  });

  upBtn.onclick = () => fileEl.click();
  fileEl.onchange = () => {
    const files = [...(fileEl.files || [])];
    fileEl.value = "";
    if (files.length) uploadFilesWrapper(node, files);
  };
  libBtn.onclick = () => {
    openLibrary((list) => {
      const state = readState(node);
      const have = new Set(state.images.map((it) => it.filename));
      for (const it of list) if (!have.has(it.filename)) state.images.push({ filename: it.filename });
      state.images = state.images.slice(0, IMG_SLOTS);
      writeState(node, state);
      renderPanel(node);
    });
  };

  hookWidget(wOf(node, "media_state"), () => renderPanel(node));
  const onConn = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    const r = typeof onConn === "function" ? onConn.apply(this, arguments) : undefined;
    setTimeout(() => { syncOutputs(node); resizeToContent(node); }, 0);
    return r;
  };
  const onCfg = node.onConfigure;
  node.onConfigure = function () {
    const r = typeof onCfg === "function" ? onCfg.apply(this, arguments) : undefined;
    setTimeout(() => renderPanel(node), 0);
    return r;
  };
  // 节点被删除时断开 ResizeObserver，否则观察着一个已移除的容器属于白占内存
  const onRm = node.onRemoved;
  node.onRemoved = function () {
    if (node.__kdRO) { node.__kdRO.disconnect(); node.__kdRO = null; }
    return typeof onRm === "function" ? onRm.apply(this, arguments) : undefined;
  };
  const size = node.size || [360, 320];
  node.setSize([Math.max(Number(size[0]) || 0, 360), Math.max(Number(size[1]) || 0, 320)]);
  renderPanel(node);
}

app.registerExtension({
  name: "kedou.imageLoader",
  async nodeCreated(node) {
    const cls = (node.constructor && node.constructor.comfyClass) || node.comfyClass || "";
    if (cls !== NODE_CLASS) return;
    try {
      build(node);
    } catch (e) {
      console.error("[kedou] 图片加载器界面构建失败", e);
    }
  },
});

// ====================================================================
// 「打包应用」内嵌面板（kapp 打包面板专用）
// --------------------------------------------------------------------
// 入口按钮：优先挂 ComfyUI 顶层菜单（app.ui.menuContainer / 旧版 .comfy-menu），
// 都失败则右下角悬浮 pill。点击弹侧面板：从 app.graph._nodes 收集启用节点的
// widget 候选，勾选 + 改名 + 改控件类型，点「生成应用包」把 graph（app.graphToPrompt()
// 的 output 即 API 格式）与勾选参数 POST 到 /ps/pack/save。不依赖工作流先保存。
// 这套逻辑与上面的 KedouImageLoader 面板完全独立，互不影响。

const KP_WIDGETS = ["text", "number", "toggle", "combo", "image", "kedou_media"];
// 主题适配（2026-09-28）：全部颜色改走 ComfyUI 主题变量，白/黑主题自动切换。
// 实测取自本机 comfyui_frontend_package 的 main-*.css：
//   随主题变（可用）：--fg-color(黑#fff/白#000) --bg-color --content-bg(#4e4e4e/#e0e0e0)
//                    --interface-panel-surface(charcoal-800/white) --interface-stroke
//                    --error-text --backdrop
//   恒定深色（不可用，白主题下仍是黑块）：--comfy-menu-bg --comfy-input-bg
//                    --border-color --descrip-text --input-text
// 所有 var() 都带一份深色回退值，老前端没有这些变量时保持原外观。
const KPCSS = [
  ".kp-ov{position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,.45);display:flex;justify-content:flex-end;}",
  ".kp-panel{width:min(400px,94vw);height:100vh;background:var(--interface-panel-surface,rgba(28,28,34,.98));color:var(--fg-color,#e7e7ea);",
  "border-left:1px solid var(--interface-stroke,#3a3a44);display:flex;flex-direction:column;font:12.5px/1.5 system-ui,sans-serif;",
  "box-shadow:-8px 0 30px rgba(0,0,0,.4);}",
  ".kp-hd{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:move;",
  "border-bottom:1px solid var(--interface-stroke,#3a3a44);user-select:none;}",
  ".kp-hd b{font-size:13.5px;}",
  ".kp-hd .kp-x{margin-left:auto;width:22px;height:22px;border:0;border-radius:6px;cursor:pointer;",
  "background:transparent;color:var(--fg-color,#e7e7ea);opacity:.7;font-size:15px;}",
  ".kp-hd .kp-x:hover{background:var(--content-bg,#e0e0e0);opacity:1;}",
  ".kp-body{padding:12px;display:flex;flex-direction:column;gap:10px;flex:1;overflow:auto;}",
  ".kp-field{display:flex;flex-direction:column;gap:4px;}",
  ".kp-field label{font-size:11px;color:var(--fg-color,#e7e7ea);opacity:.62;}",
  ".kp-field input,.kp-field textarea{background:var(--content-bg,#e0e0e0);border:1px solid var(--interface-stroke,#3a3a44);",
  "color:var(--fg-color,#e7e7ea);font:inherit;padding:6px 8px;border-radius:7px;outline:none;width:100%;box-sizing:border-box;}",
  ".kp-field input:focus,.kp-field textarea:focus{border-color:var(--p-primary-color,#4a7dff);}",
  ".kp-toolbar{display:flex;align-items:center;gap:8px;}",
  ".kp-tbtn{border:1px solid var(--interface-stroke,#3a3a44);background:transparent;color:var(--fg-color,#e7e7ea);font:inherit;font-size:11px;",
  "padding:4px 10px;border-radius:7px;cursor:pointer;}",
  ".kp-tbtn:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}",
  ".kp-count{margin-left:auto;font-size:11px;color:var(--fg-color,#e7e7ea);opacity:.62;}",
  ".kp-row{display:flex;align-items:flex-start;gap:7px;padding:7px 8px;border:1px solid var(--interface-stroke,#3a3a44);border-radius:8px;",
  "background:transparent;}",
  ".kp-row input[type=checkbox]{width:15px;height:15px;accent-color:var(--p-primary-color,#4a7dff);cursor:pointer;margin-top:5px;flex:none;}",
  ".kp-box{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}",
  ".kp-lab{background:var(--content-bg,#e0e0e0);border:1px solid var(--interface-stroke,#3a3a44);color:inherit;font:inherit;font-size:11.5px;",
  "padding:4px 6px;border-radius:6px;outline:none;width:100%;box-sizing:border-box;}",
  ".kp-lab:focus{border-color:var(--p-primary-color,#4a7dff);}",
  ".kp-sel{width:84px;flex:none;font-size:11px;padding:4px;background:var(--content-bg,#e0e0e0);border:1px solid var(--interface-stroke,#3a3a44);",
  "color:inherit;border-radius:6px;outline:none;align-self:center;}",
  ".kp-sub{font-size:10.5px;color:var(--fg-color,#e7e7ea);opacity:.58;}",
  ".kp-val{font-size:10.5px;color:var(--fg-color,#e7e7ea);opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".kp-err{color:var(--error-text,#ff7a7a);font-size:11.5px;min-height:14px;}",
  ".kp-ft{padding:10px 12px;border-top:1px solid var(--interface-stroke,#3a3a44);}",
  ".kp-gen{width:100%;border:0;background:var(--p-primary-color,#4a7dff);color:#fff;font:inherit;font-weight:600;font-size:13px;",
  "padding:9px;border-radius:8px;cursor:pointer;}",
  ".kp-gen:hover{filter:brightness(1.1);}",
  ".kp-gen[disabled]{opacity:.5;cursor:default;}",
  ".kp-menu-btn{margin-left:8px;padding:4px 10px;border:1px solid var(--interface-stroke,#3a3a44);background:transparent;color:var(--fg-color,#e7e7ea);",
  "font:inherit;font-size:12px;border-radius:7px;cursor:pointer;}",
  ".kp-menu-btn:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}",
  ".kp-pill{position:fixed;right:18px;bottom:18px;z-index:99990;padding:10px 16px;border:1px solid var(--interface-stroke,#3a3a44);border-radius:999px;",
  "background:var(--interface-panel-surface,rgba(20,20,26,.85));color:var(--fg-color,#e7e7ea);font:inherit;font-size:13px;cursor:pointer;",
  "box-shadow:0 6px 20px rgba(0,0,0,.45);backdrop-filter:blur(6px);}",
  ".kp-pill:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}",
  ".kp-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(12px);",
  "z-index:99999;padding:10px 18px;border-radius:9px;border:1px solid var(--interface-stroke,#3a3a44);",
  "background:var(--interface-panel-surface,rgba(30,30,38,.96));color:var(--fg-color,#e7e7ea);",
  "font:13px/1.5 system-ui,sans-serif;box-shadow:0 8px 26px rgba(0,0,0,.5);opacity:0;transition:.3s;pointer-events:none;}",
  ".kp-toast.kp-show{opacity:1;transform:translateX(-50%) translateY(0);}",
  ".kp-toast.kp-err{border-color:var(--error-text,#a33);color:var(--error-text,#ffb3b3);}",
  // 侧栏内嵌模式覆盖（挂进 ComfyUI 左侧栏页签时用）
  // 2026-09-28：底色改为随主题。原来是写死的深色 rgba(28,28,34,.98)——当初是怕
  // 「白底 + 浅字」隐形才涂黑，结果白色主题下变成一块黑砖；正解是底和字都跟着主题走。
  // 高度 auto —— 超长内容由页签容器滚动（openPackPanel 里会给宿主开 overflowY）
  ".kp-inset{position:static;width:auto;height:auto;max-height:none;border:0;border-radius:10px;box-shadow:none;background:var(--interface-panel-surface,rgba(28,28,34,.98));color:var(--fg-color,#e7e7ea);}",
  // 参数按节点分组的折叠组
  ".kp-grp{border:1px solid var(--interface-stroke,#3a3a44);border-radius:8px;background:transparent;overflow:hidden;}",
  ".kp-ghead{display:flex;align-items:center;gap:6px;padding:7px 8px;cursor:pointer;user-select:none;}",
  ".kp-ghead:hover{background:var(--content-bg,#e0e0e0);}",
  ".kp-gcaret{font-size:9px;color:var(--fg-color,#e7e7ea);opacity:.6;transition:transform .15s;flex:none;}",
  ".kp-gtitle{font-size:12px;font-weight:600;color:var(--fg-color,#e7e7ea);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  // 计数左、按钮右：计数靠 margin-left:auto 顶到右边，按钮跟在它后面贴最右。
  // 按钮定宽 + 居中 —— 「全选」和「取消全选」字数不同，不定宽会让各行按钮左右参差。
  ".kp-gcnt{margin-left:auto;font-size:10.5px;color:var(--fg-color,#e7e7ea);opacity:.6;flex:none;}",
  ".kp-gsel{border:1px solid var(--interface-stroke,#3a3a44);background:transparent;color:var(--fg-color,#e7e7ea);font:inherit;font-size:10.5px;padding:2px 7px;border-radius:6px;cursor:pointer;flex:none;min-width:60px;text-align:center;}",
  // 顶部「全选/取消全选」同理定宽，切换时不挤动右邻居
  ".kp-tbtn.kp-tall{min-width:66px;text-align:center;}",
  ".kp-gsel:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}",
  ".kp-gbody{display:flex;flex-direction:column;gap:7px;padding:8px;}",
  ".kp-syncbtn.kp-on,.kp-tbtn.kp-on{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);background:rgba(74,125,255,.12);}",
].join("");

let kpCssDone = false;
function ensurePackCss() {
  if (kpCssDone || document.getElementById("kp-css")) {
    kpCssDone = true;
    return;
  }
  const s = document.createElement("style");
  s.id = "kp-css";
  s.textContent = KPCSS;
  document.head.appendChild(s);
  kpCssDone = true;
}

let kpOverlay = null;
function kpOnKey(e) { if (e.key === "Escape") closePackPanel(); }

function closePackPanel() {
  if (kpOverlay) { kpOverlay.remove(); kpOverlay = null; }
  document.removeEventListener("keydown", kpOnKey, true);
}

function kpToast(msg, isErr) {
  const t = document.createElement("div");
  t.className = "kp-toast" + (isErr ? " kp-err" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.classList.add("kp-show"); }, 10);
  setTimeout(() => { t.classList.remove("kp-show"); setTimeout(() => t.remove(), 300); }, 2800);
}

function kpPreview(v, widget) {
  if (widget === "image" || widget === "kedou_media") {
    const s = String(v == null ? "" : v);
    return (s.split("/").pop() || "（未选）").slice(0, 40);
  }
  if (v === true || v === false) return String(v);
  if (v == null) return "（空）";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
}

function suggestWidget(node, w) {
  const ntype = node.type || node.comfyClass || "";
  if (ntype === "KedouImageLoader" && w.name === "media_state") return "kedou_media";
  if (ntype === "LoadImage" && w.name === "image") return "image";
  if (w.type === "INT" || w.type === "FLOAT") return "number";
  if (w.type === "BOOLEAN") return "toggle";
  if (w.type === "COMBO") return "combo";
  // 自定义类型名（如 ResolutionSelector 的 aspect_ratio）：控件对象里有选项列表就是下拉，
  // 不应按类型名推断：判为 text 会使应用中的下拉退化为输入框
  const vals = comboValuesOf(w);
  if (vals && vals.length) return "combo";
  return "text";
}

// 真机 combo 选项列表：标准在 w.options.values；个别插件给函数（动态生成），调用一次取回
function comboValuesOf(w) {
  const o = w && w.options;
  if (!o) return null;
  let v = o.values;
  if (typeof v === "function") {
    try { v = v(); } catch (_e) { return null; }
  }
  return Array.isArray(v) ? v : null;
}

function collectCandidates() {
  const nodes = (app.graph && app.graph._nodes) || [];
  const out = [];
  for (const node of nodes) {
    if (node.mode !== 0) continue;                 // 跳过被静音（NEVER / bypass）的节点
    const ntype = node.type || node.comfyClass || "";
    const title = (node.title || "").trim();
    const widgets = node.widgets || [];
    for (const w of widgets) {
      if (w.name === "control_after_generate" || w.type === "control_after_generate") continue;
      if (w.name === "kedou_media") continue;       // DOM 控件（媒体选择器 UI 本身），不是值
      if (w.type === "converted-widget" &&
          !(ntype === "KedouImageLoader" && w.name === "media_state")) continue;  // 隐藏格
      // 已转换为输入且连着上游的 widget：值由上游驱动，打包成可调参数会在运行时破坏连线，故不提供勾选
      if (w.type === "converted-widget" && Array.isArray(node.inputs)
          && node.inputs.some((inp) => inp && inp.name === w.name && inp.link != null)) continue;
      const widget = suggestWidget(node, w);
      // 能力采集与建议类型解耦：选项/范围/多行一律从真机控件对象取下来存进候选，
      // 用户手动改控件类型（如文本→下拉）时能力不丢：仅按建议类型采集时，
      // 自定义类型名的下拉（ResolutionSelector 的 aspect_ratio）会落为空输入框
      const opt = w.options && typeof w.options === "object" ? w.options : {};
      let min, max, step;
      if (typeof opt.min === "number") min = opt.min;
      if (typeof opt.max === "number") max = opt.max;
      if (typeof opt.step === "number") step = opt.step;
      const options = comboValuesOf(w) ? comboValuesOf(w).slice() : null;
      const multiline = !!opt.multiline;
      out.push({
        node: String(node.id), input: w.name, widget, default: w.value,
        node_type: ntype, node_title: title,
        min, max, step, options, multiline,
        label: title || w.name,
        valuePreview: kpPreview(w.value, widget),
      });
    }
  }
  return out;
}

function defaultAppName() {
  try {
    const g = app.graph;
    if (g && g.title) return g.title;
  } catch (_) { /* ignore */ }
  try {
    const wf = app.workflowManager && app.workflowManager.activeWorkflow;
    if (wf && wf.name) return wf.name;
  } catch (_) { /* ignore */ }
  return "untitled";
}

function openPackPanel(hostEl) {
  ensurePackCss();
  const sidebar = !!hostEl;                         // 侧栏模式：内容直接挂进页签元素
  if (sidebar) {
    if (hostEl.dataset.kpMounted) return;           // 已挂过，不重复
    hostEl.dataset.kpMounted = "1";
  } else if (kpOverlay) return;                     // 面板已开，不叠加

  const ov = sidebar ? null : document.createElement("div");
  if (ov) ov.className = "kp-ov";
  const panel = document.createElement("div");
  panel.className = "kp-panel" + (sidebar ? " kp-inset" : "");

  const hd = document.createElement("div");
  hd.className = "kp-hd";
  const titleEl = document.createElement("b");
  titleEl.textContent = "打包应用";
  const x = document.createElement("button");
  x.className = "kp-x";
  x.textContent = "×";
  x.onclick = closePackPanel;
  hd.append(titleEl, x);

  const body = document.createElement("div");
  body.className = "kp-body";

  const nameField = document.createElement("div");
  nameField.className = "kp-field";
  const nameLab = document.createElement("label");
  nameLab.textContent = "应用名";
  const nameInput = document.createElement("input");
  nameInput.value = defaultAppName();
  nameField.append(nameLab, nameInput);

  const descField = document.createElement("div");
  descField.className = "kp-field";
  const descLab = document.createElement("label");
  descLab.textContent = "描述（可选）";
  const descInput = document.createElement("input");
  descInput.placeholder = "一句话说明这个应用干嘛的";
  descField.append(descLab, descInput);

  const toolbar = document.createElement("div");
  toolbar.className = "kp-toolbar";
  const allBtn = document.createElement("button");
  allBtn.className = "kp-tbtn kp-tall";
  allBtn.textContent = "全选";
  allBtn.title = "全部勾选 / 全部取消";
  const cnt = document.createElement("span");
  cnt.className = "kp-count";
  cnt.textContent = "已选 0";
  const syncBtn = document.createElement("button");
  syncBtn.className = "kp-tbtn kp-syncbtn";
  syncBtn.textContent = "点画布选";
  syncBtn.title = "进入后，在画布上点哪个节点，这里就自动展开那个节点的参数";
  const selOnlyBtn = document.createElement("button");
  selOnlyBtn.className = "kp-tbtn";
  selOnlyBtn.textContent = "只看已选";
  selOnlyBtn.title = "只显示已勾选的参数";
  toolbar.append(allBtn, syncBtn, selOnlyBtn, cnt);

  const rowsWrap = document.createElement("div");
  rowsWrap.style.display = "flex";
  rowsWrap.style.flexDirection = "column";
  rowsWrap.style.gap = "7px";

  const err = document.createElement("div");
  err.className = "kp-err";

  const ft = document.createElement("div");
  ft.className = "kp-ft";
  const gen = document.createElement("button");
  gen.className = "kp-gen";
  gen.textContent = "生成应用包";
  ft.appendChild(gen);

  body.append(nameField, descField, toolbar, rowsWrap, err);
  if (sidebar) {
    // 侧栏模式：无标题栏/遮罩/Esc，内容直接挂进页签
    panel.append(body, ft);
    try {
      // 面板自然高度常超页签可视区 —— 让页签容器自行滚动，否则「生成应用包」按钮会超出可视范围
      hostEl.style.overflowY = "auto";
      hostEl.style.maxHeight = "100%";
      hostEl.style.boxSizing = "border-box";
    } catch (_) { /* ignore */ }
    hostEl.appendChild(panel);
  } else {
    panel.append(hd, body, ft);
    ov.appendChild(panel);

    ov.onclick = (e) => { if (e.target === ov) closePackPanel(); };
    document.body.appendChild(ov);
    kpOverlay = ov;
    document.addEventListener("keydown", kpOnKey, true);
  }

  // ---- 收集候选并渲染（按节点分组；官方构建模式同款节奏：点画布节点 -> 面板展开该组） ----
  const candidates = collectCandidates();
  const rows = [];
  const groups = [];
  let onlySel = false;

  // 「全选 / 取消全选」是同一个按钮的两态：全勾满了显示「取消全选」，否则显示「全选」。
  // 任何勾选变化（单条、组全选、顶部全选）都会走 updateCount -> 这里，保持一致。
  const syncToggleLabels = () => {
    allBtn.textContent = (rows.length && rows.every((r) => r.cb.checked)) ? "取消全选" : "全选";
    for (const g of groups) {
      if (!g.selAllEl) continue;
      g.selAllEl.textContent = (g.rows.length && g.rows.every((r) => r.cb.checked)) ? "取消全选" : "全选";
    }
  };
  const updateCount = () => {
    cnt.textContent = "已选 " + rows.filter((r) => r.cb.checked).length;
    for (const g of groups) {
      const sel = g.rows.filter((r) => r.cb.checked).length;
      g.cntEl.textContent = sel ? sel + "/" + g.rows.length : g.rows.length + " 项";
    }
    syncToggleLabels();
  };
  const applyFilter = () => {
    for (const g of groups) {
      const anyChecked = g.rows.some((r) => r.cb.checked);
      g.grpEl.style.display = (!onlySel || anyChecked) ? "" : "none";
      if (onlySel) {
        if (anyChecked) g.open = true;
        for (const r of g.rows) r.el.style.display = r.cb.checked ? "" : "none";
      } else {
        for (const r of g.rows) r.el.style.display = "";
      }
      g.bodyEl.style.display = (g.open && (!onlySel || anyChecked)) ? "" : "none";
      g.caretEl.style.transform = g.open ? "rotate(90deg)" : "";
    }
  };

  if (!candidates.length) {
    const empty = document.createElement("div");
    empty.style.color = "var(--fg-color,#9a9aa6)";
    empty.style.opacity = ".62";
    empty.style.fontSize = "11.5px";
    empty.textContent = "当前工作流没有可暴露的控件（节点都是连线型？）。";
    rowsWrap.appendChild(empty);
  }

  // 按节点分组（保持画布顺序）；默认全部收起 —— 用「点画布选」或点组标题展开
  const byNode = new Map();
  for (const c of candidates) {
    if (!byNode.has(c.node)) byNode.set(c.node, []);
    byNode.get(c.node).push(c);
  }

  const openGroup = (g, scroll) => {
    g.open = true;
    g.bodyEl.style.display = "";
    g.caretEl.style.transform = "rotate(90deg)";
    if (scroll) {
      try {
        const scroller = sidebar ? hostEl : (rowsWrap.closest(".kp-ov") || rowsWrap.parentElement);
        const top = g.headEl.getBoundingClientRect().top
          - scroller.getBoundingClientRect().top + scroller.scrollTop - 6;
        scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      } catch (_) { /* ignore */ }
    }
  };
  const closeGroup = (g) => {
    g.open = false;
    g.bodyEl.style.display = "none";
    g.caretEl.style.transform = "";
  };

  for (const [nodeId, list] of byNode) {
    const g = { node: nodeId, rows: [], open: false };
    const grp = document.createElement("div");
    grp.className = "kp-grp";
    const head = document.createElement("div");
    head.className = "kp-ghead";
    const caret = document.createElement("span");
    caret.className = "kp-gcaret";
    caret.textContent = "▶";
    const ttl = document.createElement("span");
    ttl.className = "kp-gtitle";
    ttl.textContent = list[0].node_title || list[0].node_type || ("节点 " + nodeId);
    ttl.title = ttl.textContent;
    const selAll = document.createElement("button");
    selAll.className = "kp-gsel";
    selAll.textContent = "全选";
    selAll.title = "本节点参数全选 / 全不选";
    selAll.onclick = (e) => {
      e.stopPropagation();
      const all = g.rows.length > 0 && g.rows.every((r) => r.cb.checked);
      g.rows.forEach((r) => { r.cb.checked = !all; });
      updateCount(); applyFilter();
    };
    const gcnt = document.createElement("span");
    gcnt.className = "kp-gcnt";
    head.append(caret, ttl, gcnt, selAll);   // 计数在左、按钮贴最右，各行按钮才对齐
    head.onclick = () => { g.open ? closeGroup(g) : openGroup(g, false); };
    const bodyEl = document.createElement("div");
    bodyEl.className = "kp-gbody";
    bodyEl.style.display = "none";
    grp.append(head, bodyEl);
    rowsWrap.appendChild(grp);
    Object.assign(g, { headEl: head, bodyEl, caretEl: caret, cntEl: gcnt, selAllEl: selAll, grpEl: grp });

    for (const c of list) {
      const row = document.createElement("div");
      row.className = "kp-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      const box = document.createElement("div");
      box.className = "kp-box";
      const lab = document.createElement("input");
      lab.className = "kp-lab";
      lab.value = c.label;
      const sub = document.createElement("div");
      sub.className = "kp-sub";
      sub.textContent = "#" + c.node + " · " + c.input;
      const val = document.createElement("div");
      val.className = "kp-val";
      val.textContent = "当前值：" + c.valuePreview;
      box.append(lab, sub, val);
      const sel = document.createElement("select");
      sel.className = "kp-sel";
      for (const opt of KP_WIDGETS) {
        const o = document.createElement("option");
        o.value = opt;
        o.textContent = opt;
        if (opt === c.widget) o.selected = true;
        sel.appendChild(o);
      }
      row.append(cb, box, sel);
      bodyEl.appendChild(row);
      const entry = { cb, lab, sel, c, el: row };
      rows.push(entry);
      g.rows.push(entry);
      cb.onchange = () => { updateCount(); if (onlySel) applyFilter(); };
    }
    groups.push(g);
  }
  updateCount();

  // 画布点选联动：进入后点画布上的节点，这里自动展开并滚动到该节点分组
  let syncOn = false, syncTimer = null, lastSel = null;
  syncBtn.onclick = () => {
    syncOn = !syncOn;
    syncBtn.classList.toggle("kp-on", syncOn);
    syncBtn.textContent = syncOn ? "联动中…" : "点画布选";
    if (syncOn) {
      lastSel = null;
      syncTimer = setInterval(() => {
        try {
          const sel = app.canvas && app.canvas.selected_nodes;
          const ids = sel ? Object.keys(sel) : [];
          if (ids.length !== 1 || ids[0] === lastSel) return;
          lastSel = ids[0];
          const g = groups.find((x) => x.node === ids[0]);
          if (g) {
            // 手风琴：展开选中的这组时顺手收起其他组，不然一眼看不出打开的是哪一个。
            // 先收再开——收完布局定了，openGroup 的滚动定位才算得准。
            for (const x of groups) if (x !== g && x.open) closeGroup(x);
            openGroup(g, true);
          }
        } catch (_) { /* ignore */ }
      }, 350);
    } else {
      clearInterval(syncTimer);
    }
  };

  // 只看已选
  selOnlyBtn.onclick = () => {
    onlySel = !onlySel;
    selOnlyBtn.classList.toggle("kp-on", onlySel);
    if (onlySel) groups.forEach((g) => { if (g.rows.some((r) => r.cb.checked)) g.open = true; });
    applyFilter();
  };

  // 顶部「全选 / 取消全选」：同一个按钮的两态（已全勾 -> 再点就是取消全选）
  allBtn.onclick = () => {
    const all = rows.length > 0 && rows.every((r) => r.cb.checked);
    rows.forEach((r) => { r.cb.checked = !all; });
    updateCount(); applyFilter();
  };
  gen.onclick = () => doGenerate({ nameInput, descInput, rows, err, gen });

  // ---- 标题栏拖拽 + 视口夹持（仅浮层模式；侧栏模式由 ComfyUI 管布局） ----
  if (sidebar) return;
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  hd.addEventListener("pointerdown", (e) => {
    if (e.target === x) return;
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    const r = panel.getBoundingClientRect();
    ox = r.left;
    oy = r.top;
    try { hd.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  });
  hd.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    let nx = ox + (e.clientX - sx);
    let ny = oy + (e.clientY - sy);
    nx = Math.max(-w + 40, Math.min(window.innerWidth - 40, nx));
    ny = Math.max(0, Math.min(window.innerHeight - h, ny));
    panel.style.position = "fixed";
    panel.style.left = nx + "px";
    panel.style.top = ny + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  });
  hd.addEventListener("pointerup", (e) => {
    dragging = false;
    try { hd.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  });
}

async function doGenerate(ctx) {
  const checked = ctx.rows.filter((r) => r.cb.checked);
  if (!checked.length) {
    ctx.err.textContent = "请至少勾选一个参数";
    return;
  }
  ctx.gen.disabled = true;
  ctx.gen.textContent = "生成中…";
  ctx.err.textContent = "";
  let output;
  try {
    const pr = await app.graphToPrompt();
    output = (pr && pr.output) || {};
  } catch (e) {
    ctx.err.textContent = "获取工作流失败：" + (e && e.message ? e.message : e);
    ctx.gen.disabled = false;
    ctx.gen.textContent = "生成应用包";
    return;
  }
  const params = checked.map((r) => {
    const c = r.c;
    const p = {
      node: c.node, input: c.input,
      label: r.lab.value.trim() || c.label,
      widget: r.sel.value,
      default: c.default,
      node_type: c.node_type,
      node_title: c.node_title,
    };
    if (p.widget === "number") {
      if (c.min != null) p.min = c.min;
      if (c.max != null) p.max = c.max;
      if (c.step != null) p.step = c.step;
    }
    if (p.widget === "combo" && c.options) p.options = c.options;
    if (p.widget === "text" && c.multiline) p.multiline = true;
    return p;
  });
  const outputs = [];
  for (const id of Object.keys(output)) {
    const ct = output[id] && output[id].class_type;
    if (String(ct || "").toLowerCase().includes("save")) outputs.push(id);
  }
  const kapp = {
    kedou_app: 1,
    name: ctx.nameInput.value.trim() || defaultAppName(),
    desc: ctx.descInput.value.trim(),
    graph: output,
    params,
    outputs,
  };
  try {
    const resp = await fetch("/ps/pack/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: kapp.name, desc: kapp.desc, kapp }),
    });
    let j = null;
    try { j = await resp.json(); } catch (_) { /* ignore */ }
    if (!resp.ok || !j || !j.ok) {
      const msg = (j && j.error) ? j.error : ("HTTP " + resp.status);
      ctx.err.textContent = "生成失败：" + msg;
      kpToast("生成失败：" + msg, true);
    } else {
      const warns = (j.warnings && j.warnings.length) ? j.warnings : [];
      if (warns.length) {
        // 有提醒（如缺输入但不影响打包）时留着面板，用户看完错误行再手动关
        ctx.err.style.color = "";
        ctx.err.textContent = "已生成 " + (j.file || "") + "，" + warns.length
          + " 条提醒：" + warns.slice(0, 4).join("；") + (warns.length > 4 ? "…" : "");
        kpToast("已生成，但有 " + warns.length + " 条提醒，面板里有明细", true);
      } else {
        kpToast("已生成 " + (j.file || kapp.name) + "，启动器刷新即可看到");
        closePackPanel();
      }
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    ctx.err.textContent = "请求失败：" + msg;
    kpToast("请求失败：" + msg, true);
  } finally {
    ctx.gen.disabled = false;
    ctx.gen.textContent = "生成应用包";
  }
}

function mountPackButton() {
  ensurePackCss();   // 必须先注样式：无样式按钮落在 body 末尾，会被 100vh 画布挤出屏幕外
  // 入口挂载在左侧栏：新版前端的官方侧栏页签接口
  try {
    if (app.extensionManager && typeof app.extensionManager.registerSidebarTab === "function") {
      // 注意：挂载使用 e.render(el)，旧文档记载的 content 字段会被忽略，导致页签空白。
      // 两个字段都传，新旧版本通吃。
      const packTabContent = (el) => {
        try { openPackPanel(el); }
        catch (e) { console.error("[kedou] 侧栏面板挂载失败", e); }
      };
      app.extensionManager.registerSidebarTab({
        id: "kedou-pack",
        icon: "pi pi-box",
        title: "打包应用",
        tooltip: "把当前工作流打包成 kapp 应用",
        content: packTabContent,
        render: packTabContent,
      });
      return;                       // 侧栏挂载成功，不再需要悬浮球/菜单按钮
    }
  } catch (e) { console.warn("[kedou] 侧栏页签挂载失败，退回悬浮球/菜单", e); }
  // 新版 ComfyUI 前端里 app.ui.menuContainer 是隐藏的遗留兼容壳（按钮挂进去不会显示）。
  // 规矩：只挂进「真实可见」的容器；都不行就退到永远可见的悬浮 pill。
  function visible(el) {
    if (!el || !el.appendChild) return false;
    const r = el.getBoundingClientRect();
    return !!(el.offsetParent || r.width > 0) && r.width > 0 && r.height > 0;
  }
  let target = null;
  try {
    if (app.ui && app.ui.menuContainer && visible(app.ui.menuContainer)) target = app.ui.menuContainer;
  } catch (_) { /* ignore */ }
  if (!target) {
    const m = document.querySelector(".comfyui-menu");        // 新版顶部菜单栏
    if (visible(m)) target = m;
  }
  if (!target) {
    const m = document.querySelector(".comfy-menu");          // 旧版底部菜单
    if (visible(m)) target = m;
  }
  const btn = document.createElement("button");
  if (target) {
    btn.className = "kp-menu-btn";
    target.appendChild(btn);
  } else {
    btn.className = "kp-pill";
    document.body.appendChild(btn);
  }
  btn.textContent = "打包应用";
  btn.title = "把当前工作流打包成 kapp 应用";
  btn.onclick = openPackPanel;
  // 防御：前端框架重渲染可能移除外挂按钮，3 秒后若不在文档中则重挂为悬浮 pill
  setTimeout(function () {
    if (!document.contains(btn)) {
      const pill = document.createElement("button");
      pill.className = "kp-pill";
      pill.textContent = "打包应用";
      pill.title = "把当前工作流打包成 kapp 应用";
      pill.onclick = openPackPanel;
      document.body.appendChild(pill);
    }
  }, 3000);
}

app.registerExtension({
  name: "kedou.packPanel",
  setup() {
    try {
      mountPackButton();
    } catch (e) {
      console.error("[kedou] 打包按钮挂载失败", e);
    }
  },
});
