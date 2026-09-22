// kedou_media.js —— 「蝌蚪图片加载器」节点的前端扩展（自绘多选面板）
//
// 为什么不用官方那套 image_upload 控件（读前端 WidgetSelect bundle 确认过）：
//   * 它**写死单选**（multiselect 在该 bundle 里出现 0 次）；
//   * 还自带「遮罩编辑器 / 下载」两个按钮，用户明确说多余。
// 所以照参考实现（MiniMaxH3-Easy 媒体加载器）的做法：唯一控件是隐藏的
// media_state(JSON)，媒体清单交给这里的自绘面板管理。
//
// 面板：媒体资源 N + 上传媒体 / 从库里选 + 图片缩略图网格（序号 + × 移除）；
//       点缩略图放大预览；底部输出槽按「选了几张」由前端重建（后端声明满 10 个）。
//
// ⚠️ media_state 是位置型控件，只能「藏」不能「删」（computeSize = () => [0, -4]），
//    否则节点上的其它控件值会整体错位。

import { app } from "../../scripts/app.js";

const NODE_CLASS = "KedouImageLoader";
const IMG_SLOTS = 10;
const IMG_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"];
const VID_EXTS = [".mp4", ".mov", ".webm", ".avi", ".mkv"];
const AUD_EXTS = [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"];

const CSS = [
  ".kd-card{border:1px solid var(--border-color,#3a3a44);border-radius:10px;overflow:hidden;",
  "background:var(--comfy-input-bg,rgba(0,0,0,.28));display:flex;flex-direction:column;height:100%;}",
  ".kd-top{display:flex;align-items:center;gap:8px;padding:7px 10px;flex:none;",
  "border-bottom:1px solid var(--border-color,#3a3a44);}",
  ".kd-top b{font-size:12px;font-weight:600;}",
  ".kd-top em{font-style:normal;font-size:11px;color:var(--descrip-text,#9a9aa6);}",
  ".kd-btns{margin-left:auto;display:flex;gap:6px;}",
  ".kd-btn{border:1px solid var(--border-color,#3a3a44);background:transparent;color:var(--fg-color,#e7e7ea);",
  "font:inherit;font-size:11px;padding:3px 10px;border-radius:7px;cursor:pointer;}",
  ".kd-btn:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}",
  ".kd-btn.kd-p{border-color:transparent;background:var(--p-primary-color,#4a7dff);color:#fff;font-weight:600;}",
  ".kd-btn[disabled]{opacity:.45;cursor:default;}",
  ".kd-body{padding:8px 10px 10px;display:flex;flex-direction:column;gap:9px;flex:1;overflow:auto;}",
  ".kd-sec{display:flex;flex-direction:column;gap:6px;}",
  ".kd-st{font-size:11px;color:var(--descrip-text,#9a9aa6);display:flex;align-items:center;gap:6px;}",
  ".kd-st b{font-weight:600;}",
  ".kd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px;}",
  ".kd-cell{position:relative;aspect-ratio:1/1;border-radius:10px;overflow:hidden;",
  "border:1px solid var(--border-color,#3a3a44);background:rgba(127,127,127,.14);}",
  ".kd-cell img{width:100%;height:100%;object-fit:cover;display:block;}",
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
  };
}

function writeState(node, state) {
  const w = wOf(node, "media_state");
  if (!w) return;
  w.value = JSON.stringify({ images: state.images.map((it) => ({ filename: it.filename })) });
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

// 删槽/重排之后把已有连线的起点槽号重指 —— 不重指，线就会跑到别的口上。
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
  search.oninput = () => render();

  function render() {
    tip.textContent = picked.size ? "已选 " + picked.size + " 个" : "";
    okBtn.textContent = picked.size ? "加入 " + picked.size + " 个" : "加入";
    okBtn.disabled = !picked.size;
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
      const grid = document.createElement("div");
      grid.className = "kd-grid";
      for (const it of items) {
        const key = (it.subfolder ? it.subfolder + "/" : "") + it.name;
        const cell = document.createElement("div");
        cell.className = "kd-cell";
        cell.style.outline = picked.has(key) ? "2px solid var(--p-primary-color,#4a7dff)" : "none";
        const img = document.createElement("img");
        img.loading = "lazy";
        img.src = it.url || viewUrl(it.name, it.subfolder);
        img.onerror = () => { img.style.visibility = "hidden"; };
        cell.appendChild(img);
        const no = document.createElement("span");
        no.className = "kd-no";
        no.textContent = it.name;
        cell.appendChild(no);
        cell.onclick = () => {
          if (picked.has(key)) picked.delete(key);
          else picked.set(key, { filename: key });
          render();
        };
        grid.appendChild(cell);
      }
      body.appendChild(grid);
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
  ui.body.innerHTML = "";

  const sec = document.createElement("div");
  sec.className = "kd-sec";
  const st = document.createElement("div");
  st.className = "kd-st";
  st.innerHTML = "<b>图片</b><span>" + state.images.length + "</span>";
  sec.appendChild(st);

  if (!state.images.length) {
    const d = document.createElement("div");
    d.className = "kd-empty";
    d.textContent = "还没有图片 —— 用「上传媒体」或「从库里选」加。";
    sec.appendChild(d);
    ui.body.appendChild(sec);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "kd-grid";
  state.images.forEach((it, i) => {
    const cell = document.createElement("div");
    cell.className = "kd-cell";
    cell.title = it.filename;
    const img = document.createElement("img");
    img.loading = "lazy";
    let tried = false;
    img.onerror = () => {
      if (tried) {
        img.style.visibility = "hidden";
        return;
      }
      tried = true;
      img.src = viewUrl(baseName(it.filename), subOf(it.filename))
        .replace("type=input", "type=output");
    };
    img.src = viewUrl(baseName(it.filename), subOf(it.filename));
    cell.appendChild(img);
    const no = document.createElement("span");
    no.className = "kd-no";
    no.textContent = String(i + 1);
    cell.appendChild(no);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "kd-x";
    x.textContent = "×";
    x.onclick = (e) => {
      e.stopPropagation();
      const st2 = readState(node);
      st2.images.splice(i, 1);
      writeState(node, st2);
      renderPanel(node);
    };
    cell.appendChild(x);
    cell.onclick = () => openBig(baseName(it.filename), subOf(it.filename));
    grid.appendChild(cell);
  });
  sec.appendChild(grid);
  ui.body.appendChild(sec);
  setTimeout(() => resizeToContent(node), 0);   // 高度贴内容，不留大片空白
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

function uiSetBusy(node, busy) {
  const up = node._kdUI && node._kdUI.upBtn;
  if (!up) return;
  up.disabled = busy;
  up.textContent = busy ? "上传中…" : "上传媒体";
}

function build(node) {
  ensureCss();
  hideWidget(wOf(node, "media_state"), false);

  const card = document.createElement("div");
  card.className = "kd-card";
  const top = document.createElement("div");
  top.className = "kd-top";
  const title = document.createElement("b");
  title.textContent = "媒体资源";
  const count = document.createElement("em");
  const btns = document.createElement("div");
  btns.className = "kd-btns";
  const libBtn = document.createElement("button");
  libBtn.className = "kd-btn";
  libBtn.textContent = "从库里选";
  const upBtn = document.createElement("button");
  upBtn.className = "kd-btn kd-p";
  upBtn.textContent = "上传媒体";
  const fileEl = document.createElement("input");
  fileEl.type = "file";
  fileEl.multiple = true;
  fileEl.accept = IMG_EXTS.join(",");
  fileEl.style.display = "none";
  btns.append(libBtn, upBtn, fileEl);
  top.append(title, count, btns);
  const body = document.createElement("div");
  body.className = "kd-body";
  card.append(top, body);

  node._kdUI = { card, body, count, libBtn, upBtn, fileEl };
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
// 「打包成应用」内嵌面板（kapp 打包面板专用）
// --------------------------------------------------------------------
// 入口按钮：优先挂 ComfyUI 顶层菜单（app.ui.menuContainer / 旧版 .comfy-menu），
// 都失败则右下角悬浮 pill。点击弹侧面板：从 app.graph._nodes 收集启用节点的
// widget 候选，勾选 + 改名 + 改控件类型，点「生成应用包」把 graph（app.graphToPrompt()
// 的 output 即 API 格式）与勾选参数 POST 到 /ps/pack/save。不依赖工作流先保存。
// 这套逻辑与上面的 KedouImageLoader 面板完全独立，互不影响。

const KP_WIDGETS = ["text", "number", "toggle", "combo", "image", "kedou_media"];
const KPCSS = [
  ".kp-ov{position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,.45);display:flex;justify-content:flex-end;}",
  ".kp-panel{width:min(400px,94vw);height:100vh;background:rgba(28,28,34,.98);color:#e7e7ea;",
  "border-left:1px solid #3a3a44;display:flex;flex-direction:column;font:12.5px/1.5 system-ui,sans-serif;",
  "box-shadow:-8px 0 30px rgba(0,0,0,.4);}",
  ".kp-hd{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:move;",
  "border-bottom:1px solid #3a3a44;user-select:none;}",
  ".kp-hd b{font-size:13.5px;}",
  ".kp-hd .kp-x{margin-left:auto;width:22px;height:22px;border:0;border-radius:6px;cursor:pointer;",
  "background:transparent;color:#cfcfd6;font-size:15px;}",
  ".kp-hd .kp-x:hover{background:rgba(255,255,255,.1);}",
  ".kp-body{padding:12px;display:flex;flex-direction:column;gap:10px;flex:1;overflow:auto;}",
  ".kp-field{display:flex;flex-direction:column;gap:4px;}",
  ".kp-field label{font-size:11px;color:#9a9aa6;}",
  ".kp-field input,.kp-field textarea{background:rgba(0,0,0,.3);border:1px solid #3a3a44;",
  "color:#e7e7ea;font:inherit;padding:6px 8px;border-radius:7px;outline:none;width:100%;box-sizing:border-box;}",
  ".kp-field input:focus,.kp-field textarea:focus{border-color:#4a7dff;}",
  ".kp-toolbar{display:flex;align-items:center;gap:8px;}",
  ".kp-tbtn{border:1px solid #3a3a44;background:transparent;color:#e7e7ea;font:inherit;font-size:11px;",
  "padding:4px 10px;border-radius:7px;cursor:pointer;}",
  ".kp-tbtn:hover{border-color:#4a7dff;color:#4a7dff;}",
  ".kp-count{margin-left:auto;font-size:11px;color:#9a9aa6;}",
  ".kp-row{display:flex;align-items:flex-start;gap:7px;padding:7px 8px;border:1px solid #3a3a44;border-radius:8px;",
  "background:rgba(0,0,0,.18);}",
  ".kp-row input[type=checkbox]{width:15px;height:15px;accent-color:#4a7dff;cursor:pointer;margin-top:5px;flex:none;}",
  ".kp-box{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}",
  ".kp-lab{background:rgba(0,0,0,.3);border:1px solid #3a3a44;color:inherit;font:inherit;font-size:11.5px;",
  "padding:4px 6px;border-radius:6px;outline:none;width:100%;box-sizing:border-box;}",
  ".kp-lab:focus{border-color:#4a7dff;}",
  ".kp-sel{width:84px;flex:none;font-size:11px;padding:4px;background:rgba(0,0,0,.3);border:1px solid #3a3a44;",
  "color:inherit;border-radius:6px;outline:none;align-self:center;}",
  ".kp-sub{font-size:10.5px;color:#7c7c86;}",
  ".kp-val{font-size:10.5px;color:#8a8a94;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".kp-err{color:#ff7a7a;font-size:11.5px;min-height:14px;}",
  ".kp-ft{padding:10px 12px;border-top:1px solid #3a3a44;}",
  ".kp-gen{width:100%;border:0;background:#4a7dff;color:#fff;font:inherit;font-weight:600;font-size:13px;",
  "padding:9px;border-radius:8px;cursor:pointer;}",
  ".kp-gen:hover{background:#3d6ce8;}",
  ".kp-gen[disabled]{opacity:.5;cursor:default;}",
  ".kp-menu-btn{margin-left:8px;padding:4px 10px;border:1px solid #3a3a44;background:transparent;color:#cfcfd6;",
  "font:inherit;font-size:12px;border-radius:7px;cursor:pointer;}",
  ".kp-menu-btn:hover{border-color:#4a7dff;color:#4a7dff;}",
  ".kp-pill{position:fixed;right:18px;bottom:18px;z-index:99990;padding:10px 16px;border:0;border-radius:999px;",
  "background:rgba(20,20,26,.85);color:#e7e7ea;font:inherit;font-size:13px;cursor:pointer;",
  "box-shadow:0 6px 20px rgba(0,0,0,.45);backdrop-filter:blur(6px);}",
  ".kp-pill:hover{background:rgba(40,40,50,.92);}",
  ".kp-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(12px);",
  "z-index:99999;padding:10px 18px;border-radius:9px;background:rgba(30,30,38,.96);color:#e7e7ea;",
  "font:13px/1.5 system-ui,sans-serif;box-shadow:0 8px 26px rgba(0,0,0,.5);opacity:0;transition:.3s;pointer-events:none;}",
  ".kp-toast.kp-show{opacity:1;transform:translateX(-50%) translateY(0);}",
  ".kp-toast.kp-err{background:rgba(70,20,24,.96);color:#ffb3b3;border:1px solid #a33;}",
  // 侧栏内嵌模式覆盖（挂进 ComfyUI 左侧栏页签时用）
  // 背景保留深色卡片：面板文字是浅色，透明底会在白色侧栏里变成「白字白底」隐形；
  // 高度 auto —— 超长内容由页签容器滚动（openPackPanel 里会给宿主开 overflowY）
  ".kp-inset{position:static;width:auto;height:auto;max-height:none;border:0;border-radius:10px;box-shadow:none;background:rgba(28,28,34,.98);color:#e7e7ea;}",
  // 参数按节点分组的折叠组
  ".kp-grp{border:1px solid #3a3a44;border-radius:8px;background:rgba(0,0,0,.18);overflow:hidden;}",
  ".kp-ghead{display:flex;align-items:center;gap:6px;padding:7px 8px;cursor:pointer;user-select:none;}",
  ".kp-ghead:hover{background:rgba(255,255,255,.05);}",
  ".kp-gcaret{font-size:9px;color:#9a9aa6;transition:transform .15s;flex:none;}",
  ".kp-gtitle{font-size:12px;font-weight:600;color:#e7e7ea;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".kp-gcnt{margin-left:auto;font-size:10.5px;color:#9a9aa6;flex:none;}",
  ".kp-gsel{border:1px solid #3a3a44;background:transparent;color:#cfcfd6;font:inherit;font-size:10.5px;padding:2px 7px;border-radius:6px;cursor:pointer;flex:none;}",
  ".kp-gsel:hover{border-color:#4a7dff;color:#4a7dff;}",
  ".kp-gbody{display:flex;flex-direction:column;gap:7px;padding:8px;}",
  ".kp-syncbtn.kp-on,.kp-tbtn.kp-on{border-color:#4a7dff;color:#4a7dff;background:rgba(74,125,255,.12);}",
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
  // 别按类型名猜 —— 猜成 text 的话应用里下拉会退化成输入框
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
      // 已转换为输入且连着上游的 widget：值由上游驱动，打包成可调参数只会在运行时把连线注坏 —— 不给勾
      if (w.type === "converted-widget" && Array.isArray(node.inputs)
          && node.inputs.some((inp) => inp && inp.name === w.name && inp.link != null)) continue;
      const widget = suggestWidget(node, w);
      // 能力采集与建议类型解耦：选项/范围/多行一律从真机控件对象抓下来存进候选，
      // 用户手动改控件类型（如文本→下拉）时能力不丢 —— 之前只在建议=combo 时抓，
      // 自定义类型名的下拉（ResolutionSelector 的 aspect_ratio）就丢成输入框了
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
  titleEl.textContent = "打包成应用";
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
  allBtn.className = "kp-tbtn";
  allBtn.textContent = "全选";
  const clrBtn = document.createElement("button");
  clrBtn.className = "kp-tbtn";
  clrBtn.textContent = "清空";
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
  toolbar.append(allBtn, clrBtn, syncBtn, selOnlyBtn, cnt);

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
      // 面板自然高度常超页签可视区 —— 让页签容器自己滚，否则「生成应用包」够不着
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

  const updateCount = () => {
    cnt.textContent = "已选 " + rows.filter((r) => r.cb.checked).length;
    for (const g of groups) {
      const sel = g.rows.filter((r) => r.cb.checked).length;
      g.cntEl.textContent = sel ? sel + "/" + g.rows.length : g.rows.length + " 项";
    }
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
    empty.style.color = "#9a9aa6";
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
    selAll.title = "勾选此节点全部参数";
    selAll.onclick = (e) => {
      e.stopPropagation();
      g.rows.forEach((r) => { r.cb.checked = true; });
      updateCount(); applyFilter();
    };
    const gcnt = document.createElement("span");
    gcnt.className = "kp-gcnt";
    head.append(caret, ttl, selAll, gcnt);
    head.onclick = () => { g.open ? closeGroup(g) : openGroup(g, false); };
    const bodyEl = document.createElement("div");
    bodyEl.className = "kp-gbody";
    bodyEl.style.display = "none";
    grp.append(head, bodyEl);
    rowsWrap.appendChild(grp);
    Object.assign(g, { headEl: head, bodyEl, caretEl: caret, cntEl: gcnt, grpEl: grp });

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
          if (g) openGroup(g, true);
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

  allBtn.onclick = () => { rows.forEach((r) => { r.cb.checked = true; }); updateCount(); applyFilter(); };
  clrBtn.onclick = () => { rows.forEach((r) => { r.cb.checked = false; }); updateCount(); applyFilter(); };
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
      kpToast("已生成 " + (j.file || kapp.name) + "，启动器刷新即可看到");
      closePackPanel();
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
  // 用户指定：入口放左侧栏 —— 新版前端的官方侧栏页签接口
  try {
    if (app.extensionManager && typeof app.extensionManager.registerSidebarTab === "function") {
      // ⚠️ 本机前端实测：挂载走 e.render(el)（旧文档的 content 字段会被忽略 → 页签空白）。
      // 两个字段都传，新旧版本通吃。
      const packTabContent = (el) => {
        try { openPackPanel(el); }
        catch (e) { console.error("[kedou] 侧栏面板挂载失败", e); }
      };
      app.extensionManager.registerSidebarTab({
        id: "kedou-pack",
        icon: "pi pi-box",
        title: "打包成应用",
        tooltip: "把当前工作流打包成 kapp 应用",
        content: packTabContent,
        render: packTabContent,
      });
      return;                       // 侧栏挂载成功，不再需要悬浮球/菜单按钮
    }
  } catch (e) { console.warn("[kedou] 侧栏页签挂载失败，退回悬浮球/菜单", e); }
  // 新版 ComfyUI 前端里 app.ui.menuContainer 是隐藏的遗留兼容壳（按钮挂进去=看不见）。
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
  btn.textContent = "打包成应用";
  btn.title = "把当前工作流打包成 kapp 应用";
  btn.onclick = openPackPanel;
  // 保险：前端框架重渲染可能把外挂按钮抹掉 —— 3 秒后不在文档里就重挂为悬浮 pill
  setTimeout(function () {
    if (!document.contains(btn)) {
      const pill = document.createElement("button");
      pill.className = "kp-pill";
      pill.textContent = "打包成应用";
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
