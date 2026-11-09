const state = { items: [], filter: "all", keyword: "", selected: null, source: "", updatedAt: null, stale: false };

const route = window.AppRoute;
let enteredFromList = false;
let searchTimer = null;

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));

const fmtDate = (value) => {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const stateLabel = { open: "进行中", merged: "已合并", closed: "已关闭" };

const visible = () => {
  const keyword = state.keyword.trim().toLowerCase();
  return state.items.filter((item) => {
    if (state.filter !== "all" && item.state !== state.filter) return false;
    if (!keyword) return true;
    return [item.title, String(item.number), item.requester]
      .some((field) => String(field).toLowerCase().includes(keyword));
  });
};

const renderList = () => {
  const items = visible();
  document.getElementById("listMeta").textContent =
    `共 ${state.items.length} 条 PR，当前显示 ${items.length} 条`;
  document.getElementById("list").innerHTML = items.map((item) => `
    <li class="item${String(item.number) === String(state.selected) ? " active" : ""}" data-number="${esc(item.number)}">
      <span class="item-num">#${esc(item.number)}</span>
      <div class="item-title">${esc(item.title)}</div>
      <div class="item-meta">
        <span class="item-author">${esc(item.requester)}</span>
        <span class="dot" aria-hidden="true">·</span>
        <span class="item-time">更新于 ${fmtDate(item.updatedAt)}</span>
      </div>
      <span class="badge ${esc(item.state)}">${esc(stateLabel[item.state] || item.state)}</span>
    </li>`).join("") || `<li class="list-empty">没有匹配的 PR</li>`;
};

/* ---------- 列表状态 ↔ URL ---------- */

/** 把 URL 上的筛选写回控件（刷新、前进后退都要走一遍） */
const syncFilterControls = () => {
  document.querySelectorAll("#filters .chip").forEach((chip) => {
    const on = chip.dataset.state === state.filter;
    chip.classList.toggle("active", on);
    chip.setAttribute("aria-pressed", String(on));
  });
  const input = document.getElementById("search");
  if (input.value !== state.keyword) input.value = state.keyword;
};

const syncListUrl = () => {
  route.replace({
    kind: "list",
    state: state.filter === "all" ? null : state.filter,
    q: state.keyword.trim() || null,
  });
};

const applyListRoute = (parsed) => {
  state.filter = parsed.state || "all";
  state.keyword = parsed.q || "";
  syncFilterControls();
};

const syncStatus = () => {
  const at = document.getElementById("syncAt");
  const badge = document.getElementById("sourceBadge");
  if (at) at.textContent = state.updatedAt ? `更新于 ${fmtDate(state.updatedAt)}` : "加载中";
  if (badge) {
    badge.textContent = state.source === "github"
      ? (state.stale ? "GitHub 暂不可用 · 缓存数据" : "数据源 GitHub")
      : "演示数据（MOCK）";
  }
};

const toastHint = (message) => {
  const el = document.getElementById("dtoast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastHint._t);
  toastHint._t = setTimeout(() => el.classList.remove("show"), 2800);
};

/* 进入工作台：hideList 时不写 URL（刷新恢复 / 前进后退已经由浏览器写好） */
/**
 * 同一时刻页面只有一个 h1：当前屏幕的名字在标题层级里，另一屏的标题降级为普通元素。
 * 列表与工作台都只是显隐切换，DOM 里始终同时存在两块，所以进出时要显式换回来。
 */
const setTitleTag = (id, tag) => {
  const el = document.getElementById(id);
  if (!el || el.tagName === tag.toUpperCase()) return;
  const next = document.createElement(tag);
  next.id = id;
  next.className = el.className;
  next.textContent = el.textContent;
  if (el.getAttribute("title")) next.setAttribute("title", el.getAttribute("title"));
  el.replaceWith(next);
};

const enterWorkbench = async (number, opts = {}, historyMode = "push") => {
  state.selected = number;
  setTitleTag("wbPrTitle", "h1");
  setTitleTag("listTitle", "div");
  renderList();
  if (historyMode === "push") {
    route.push({
      kind: "pr",
      n: number,
      file: opts.file || null,
      mode: opts.mode || null,
      line: opts.line || null,
      endLine: opts.endLine || null,
      heading: opts.heading || null,
    });
  }
  if (window.DiffView) await window.DiffView.mount(number, opts);
};

const exitWorkbench = (fromHistory) => {
  if (window.DiffView) window.DiffView.unmount();
  state.selected = null;
  setTitleTag("wbPrTitle", "div");
  setTitleTag("listTitle", "h1");
  document.title = "审批可视化";
  renderList();
  if (fromHistory) return;
  /* 从列表点进来的可以回退；直接打开深链时没有上一页，改成替换成列表 */
  if (enteredFromList) history.back();
  else route.replace({ kind: "list" });
  enteredFromList = false;
};

const doRefresh = async () => {
  if (document.body.classList.contains("wb-mode-on")) {
    // 工作台内刷新
    if (window.DiffView && state.selected) await window.DiffView.refresh(state.selected, true);
    return;
  }
  try {
    const res = await fetch("/api/approvals?refresh=1", { credentials: "same-origin" });
    if (res.status === 401) { location.href = loginUrl(); return; }
    const data = await res.json();
    state.items = data.items || [];
    state.source = data.source || "";
    state.stale = !!data.stale;
    state.updatedAt = new Date();
    syncStatus();
    renderList();
  } catch { toastHint("同步失败"); }
};

/** 会话过期时把当前地址带回去，登录后回到原位 */
const loginUrl = () => `/auth/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;

const boot = async () => {
  const parsed = route.parse();
  const [meR, listR] = await Promise.all([
    fetch("/api/me", { credentials: "same-origin" }),
    fetch("/api/approvals", { credentials: "same-origin" }),
  ]);
  if (meR.status === 401 || listR.status === 401) { location.href = loginUrl(); return; }
  const profile = await meR.json();
  document.getElementById("userChip").textContent = profile.login;
  const data = await listR.json();
  if (!listR.ok) {
    const detail = document.getElementById("detail");
    detail.hidden = false;
    detail.innerHTML = `<div class="error-box">读取列表失败：${esc(data.message || listR.status)}</div>`;
    return;
  }
  state.items = data.items || [];
  state.source = data.source || "";
  state.stale = !!data.stale;
  state.updatedAt = new Date();
  syncStatus();

  if (parsed.kind === "pr") {
    /* 深链直达：先把 URL 规范化（补零的 PR 号等），再挂工作台，避免闪一下列表 */
    enteredFromList = false;
    state.selected = parsed.n;
    route.replace(parsed);
    await enterWorkbench(parsed.n, parsed, "silent");
    return;
  }

  applyListRoute(parsed);
  renderList();
};

/* ---------- 浏览器前进/后退 ---------- */
route.onPop(async (parsed) => {
  if (parsed.kind === "pr") {
    enteredFromList = true;
    state.selected = parsed.n;
    await enterWorkbench(parsed.n, parsed, "silent");
    return;
  }
  if (document.body.classList.contains("wb-mode-on")) exitWorkbench(true);
  applyListRoute(parsed);
  renderList();
});

document.getElementById("filters").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  state.filter = chip.dataset.state;
  syncFilterControls();
  renderList();
  syncListUrl();
});
document.getElementById("search").addEventListener("input", (e) => {
  state.keyword = e.target.value;
  renderList();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(syncListUrl, 300);
});
document.getElementById("list").addEventListener("click", (e) => {
  const item = e.target.closest(".item");
  if (!item) return;
  enteredFromList = true;
  enterWorkbench(Number(item.dataset.number));
});
document.getElementById("refreshBtn").addEventListener("click", doRefresh);
document.getElementById("wbBack").addEventListener("click", () => exitWorkbench(false));

boot();
