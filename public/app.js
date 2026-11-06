const state = { items: [], filter: "all", keyword: "", selected: null, source: "", updatedAt: null, stale: false };

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
      <div class="item-title">#${esc(item.number)} ${esc(item.title)}</div>
      <div class="item-sub">
        <span class="badge ${esc(item.state)}">${esc(stateLabel[item.state] || item.state)}</span>
        <span>${esc(item.requester)}</span>
        <span>更新于 ${fmtDate(item.updatedAt)}</span>
      </div>
    </li>`).join("") || `<li class="item-sub">没有匹配的 PR</li>`;
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

/* 进入工作台：隐藏列表视图，全屏渲染 PR。 */
const enterWorkbench = async (number) => {
  state.selected = number;
  renderList();
  if (window.DiffView) await window.DiffView.mount(number);
};

const exitWorkbench = () => {
  if (window.DiffView) window.DiffView.unmount();
};

const doRefresh = async () => {
  if (document.body.classList.contains("wb-mode-on")) {
    // 工作台内刷新
    if (window.DiffView && state.selected) await window.DiffView.refresh(state.selected, true);
    return;
  }
  try {
    const res = await fetch("/api/approvals?refresh=1", { credentials: "same-origin" });
    if (res.status === 401) { location.href = "/auth/login"; return; }
    const data = await res.json();
    state.items = data.items || [];
    state.source = data.source || "";
    state.stale = !!data.stale;
    state.updatedAt = new Date();
    syncStatus();
    renderList();
  } catch { toastHint("同步失败"); }
};

const boot = async () => {
  const [meR, listR] = await Promise.all([
    fetch("/api/me", { credentials: "same-origin" }),
    fetch("/api/approvals", { credentials: "same-origin" }),
  ]);
  if (meR.status === 401 || listR.status === 401) { location.href = "/auth/login"; return; }
  const profile = await meR.json();
  document.getElementById("userChip").textContent = profile.login;
  const data = await listR.json();
  if (!listR.ok) {
    document.getElementById("detail").innerHTML = `<div class="error-box">读取列表失败：${esc(data.message || listR.status)}</div>`;
    return;
  }
  state.items = data.items || [];
  state.source = data.source || "";
  state.stale = !!data.stale;
  state.updatedAt = new Date();
  syncStatus();
  renderList();
};

document.getElementById("filters").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  document.querySelectorAll(".chip").forEach((n) => n.classList.remove("active"));
  chip.classList.add("active");
  state.filter = chip.dataset.state;
  renderList();
});
document.getElementById("search").addEventListener("input", (e) => { state.keyword = e.target.value; renderList(); });
document.getElementById("list").addEventListener("click", (e) => {
  const item = e.target.closest(".item");
  if (item) enterWorkbench(Number(item.dataset.number));
});
document.getElementById("refreshBtn").addEventListener("click", doRefresh);
document.getElementById("wbBack").addEventListener("click", exitWorkbench);

boot();
