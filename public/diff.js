/* 工作台控制器：阅读改动（默认）/ 统一 Diff / 分栏 Diff；行级评论与草稿 */
(function () {
  const D = {
    n: null,
    meta: null,
    all: { files: [], comments: [] }, // PR 全量快照，回到「全部改动」时恢复
    rev: { kind: "all" },             // all | commit
    revKey: "",                       // 正文/模型/滚动缓存的分区键
    revSeq: 0,                        // 视图代次令牌：每次切换提交/全部改动 +1，丢弃过期响应
    files: [],
    comments: [],
    texts: {},       // revKey -> path -> {base, head, headLoaded, baseLoaded, headTruncated, baseTruncated}
    commits: { items: [], truncated: false, loaded: false, loading: false, error: "" },
    commitDetails: new Map(),         // sha -> 提交详情
    merge: { options: null, loading: false, error: "", done: false, method: "" },
    file: null,
    mode: "reading", // reading | unified | split
    marks: true,
    drafts: [],
    event: "COMMENT",
    submitted: [],
    active: null,
    filter: "",
    stale: false,
    fetchedAt: null,
    loading: 0,
    err: "",
    commentsByPath: null,
    prefetchTotal: 0,
    prefetchDone: 0,
    chapterScrollBound: false,
    navIdx: -1,
    scrollPos: {}, // "path:mode" -> scrollTop
    lastViewKey: null,
    generation: 0,
    ref: null,       // 引用文档视图：{ stack, path, anchor, text, loading, error, candidates }
    tstate: {},      // path -> 表格视图状态（隐藏列 / 固定列 / 仅看变化 / 密度）
    theme: "paper",  // 文档主题：paper 纸白 / sepia 暖纸 / night 夜读
    tbl: "grid",     // 表格样式：grid 网格 / zebra 斑马 / plain 极简
    read: "standard", // 阅读宽度：narrow 窄 / standard 标准 / wide 宽
    pendingAnchor: null, // 深链待定位：{ line, endLine } 或 { heading }
    pendingFile: null,
    urlLine: null,   // 当前地址里的行号：重渲染（开评论、切标记）时保留，不要被清掉
  };

  const THEMES = ["paper", "sepia", "night"];
  const TBL_STYLES = ["grid", "zebra", "plain"];
  const READ_WIDTHS = ["narrow", "standard", "wide"];
  const MODES = ["reading"];

  const esc = window.DiffModel.esc;
  const isCsv = (path) => window.DiffModel.isCsvPath(path);

  /* ---------- 草稿持久化 ---------- */
  const draftsKey = (n) => `wb.drafts.${n}`;
  const newDraftId = () => window.crypto?.randomUUID?.()
    || `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const loadDrafts = () => {
    try {
      const raw = localStorage.getItem(draftsKey(D.n));
      const value = raw ? JSON.parse(raw) : [];
      D.drafts = Array.isArray(value) ? value.map((d) => ({ ...d, id: d.id || newDraftId() })) : [];
      if (Array.isArray(value) && value.some((d) => !d.id)) saveDrafts();
    } catch { D.drafts = []; }
  };
  const draftsOutdated = () => D.drafts.some((d) => !d.headSha || d.headSha !== D.meta?.headSha);
  const saveDrafts = () => {
    try { localStorage.setItem(draftsKey(D.n), JSON.stringify(D.drafts)); } catch { /* ignore */ }
  };
  const removeSubmittedDrafts = (pr, ids) => {
    const key = draftsKey(pr);
    try {
      const raw = localStorage.getItem(key);
      const persisted = raw ? JSON.parse(raw) : [];
      const remaining = (Array.isArray(persisted) ? persisted : []).filter((d) => !ids.has(d.id));
      if (remaining.length) localStorage.setItem(key, JSON.stringify(remaining));
      else localStorage.removeItem(key);
    } catch { /* 清理失败时保留持久化数据 */ }
    if (String(D.n) === String(pr)) D.drafts = D.drafts.filter((d) => !ids.has(d.id));
  };
  const clearDraftsStorage = () => { try { localStorage.removeItem(draftsKey(D.n)); } catch { /* ignore */ } };

  const fmt = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const curFile = () => D.files.find((f) => f.path === D.file) || null;
  const isCommitView = () => D.rev.kind === "commit";
  const commitDetail = () => (isCommitView() ? D.commitDetails.get(D.rev.sha) || null : null);
  const textsOf = (path) => {
    if (!D.texts[D.revKey]) D.texts[D.revKey] = {};
    return D.texts[D.revKey][path];
  };
  const setTexts = (path, value) => {
    if (!D.texts[D.revKey]) D.texts[D.revKey] = {};
    D.texts[D.revKey][path] = value;
  };
  const textOf = (path, side) => {
    const state = textsOf(path);
    return state ? state[side] || "" : "";
  };

  /* ---------- fetch with timeout ---------- */
  const FETCH_TIMEOUT = 15000;
  const fetchJSON = async (url, opts) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
    try {
      return await fetch(url, Object.assign({ credentials: "same-origin", signal: ac.signal }, opts));
    } finally { clearTimeout(timer); }
  };

  function spin(delta) {
    D.loading = Math.max(0, D.loading + delta);
    const el = document.getElementById("wbLoading");
    if (el) el.hidden = D.loading === 0;
  }

  /* 新代次接管加载状态：旧代次遗留的计数归零，旧请求的 finally 不再影响新代次 */
  function takeOverLoading() {
    D.loading = 0;
    const el = document.getElementById("wbLoading");
    if (el) el.hidden = true;
  }

  function toast(msg) {
    const el = document.getElementById("dtoast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2800);
  }

  /** 复制原始 PR 链接：优先 Clipboard API，被拒时退回选中文本复制。 */
  function copyPrLink() {
    const url = D.meta && D.meta.url;
    if (!url) return;
    const done = () => toast("已复制 PR 链接");
    const fallback = () => {
      const box = document.createElement("textarea");
      box.value = url;
      box.setAttribute("readonly", "");
      box.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.appendChild(box);
      box.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      box.remove();
      if (ok) done();
      else toast("复制失败，请点链接手动复制");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, fallback);
      return;
    }
    fallback();
  }

  /* ---------- 左侧面板：本地偏好 ---------- */
  const PREF = {
    view: "wb.nav.view",
    folded: (n) => `wb.nav.folded.${n}`,
    filesH: "wb.nav.filesH",
    navW: "wb.nav.w",
    sections: "wb.nav.sections",
    theme: "wb.doc.theme",
    tbl: "wb.doc.tbl",
    read: "wb.doc.read",
    docView: "wb.doc.docview",
    zoom: "wb.doc.zoom",
    focus: "wb.doc.focus",
    outline: "wb.doc.outline",
    reviewed: "wb.doc.reviewed",
  };
  const readPref = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  };
  const writePref = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存不下就只保留本次会话 */ }
  };
  const saveFolded = () => writePref(PREF.folded(D.n), Array.from(D.folded));

  /* ---------- 深链：主题、锚点、URL 同步 ---------- */
  const applyTheme = () => {
    const wb = document.getElementById("workbench");
    if (!wb) return;
    if (wb.dataset.theme !== D.theme) wb.dataset.theme = D.theme;
    if (wb.dataset.tbl !== D.tbl) wb.dataset.tbl = D.tbl;
    if (wb.dataset.read !== D.read) wb.dataset.read = D.read;
    if (D.syncLook) D.syncLook();
  };

  const routeState = (extra) => Object.assign({
    kind: "pr", n: D.n, file: D.file || null, mode: D.mode,
    commit: isCommitView() ? D.rev.sha : null,
    line: null, endLine: null, heading: null,
  }, extra || {});

  /** 引用文档视图有自己的地址语义，暂不与 URL 同步 */
  const syncUrl = (method, extra) => {
    if (!window.AppRoute || !D.n || D.ref) return;
    (method === "push" ? window.AppRoute.push : window.AppRoute.replace)(routeState(extra));
  };

  /** 副行时间：同一天只给时分，跨天给月-日 */
  function shortTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    const pad = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const setDocumentTitle = () => {
    if (!D.n) { document.title = "审批可视化"; return; }
    if (D.ref) { document.title = `${D.ref.path.split("/").pop()} · #${D.n}`; return; }
    const name = D.file ? D.file.split("/").pop() : "PR";
    const commit = isCommitView() ? `${D.rev.sha.slice(0, 7)} · ` : "";
    document.title = `#${D.n} · ${commit}${name} — 审批可视化`;
  };

  /** 顶栏可见的行号：滚动停下时把位置写回 URL */
  function topLine() {
    const docEl = document.getElementById("wbDoc");
    if (!docEl) return null;
    let line = null;
    for (const el of docEl.querySelectorAll("[data-line]")) {
      if (el.classList.contains("line-anchor")) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top < 140) line = Number(el.dataset.line); else break;
    }
    return Number.isFinite(line) ? line : null;
  }

  /** 深链定位：精确行 → 包含该行的多行块 → 最近的前一个块 */
  function applyAnchor() {
    const target0 = D.pendingAnchor;
    const content = document.getElementById("wbContent");
    if (!target0 || !content) return false;
    if (target0.heading) {
      D.pendingAnchor = null;
      scrollToAnchor(target0.heading);
      return true;
    }
    const line = Number(target0.line) || 0;
    if (!line) { D.pendingAnchor = null; return false; }
    let target = content.querySelector(`[data-line="${line}"]:not(.line-anchor)`);
    if (!target) {
      for (const el of content.querySelectorAll("[data-line][data-end-line]")) {
        if (Number(el.dataset.line) <= line && line <= Number(el.dataset.endLine)) { target = el; break; }
      }
    }
    if (!target) {
      for (const el of content.querySelectorAll("[data-line]")) {
        if (Number(el.dataset.line) <= line) target = el; else break;
      }
    }
    /* 正文还没渲染出来：保留锚点，等下一次 render 再试 */
    if (!target) return false;
    D.pendingAnchor = null;
    target.scrollIntoView({ block: "center" });
    target.style.outline = "2px solid var(--text)";
    target.style.outlineOffset = "3px";
    setTimeout(() => { target.style.outline = ""; target.style.outlineOffset = ""; }, 1600);
    D.urlLine = line;
    syncUrl("replace", { line, endLine: target0.endLine || null });
    return true;
  }

  /* ---------- 评论线程 ---------- */
  /** 把 inReplyTo 串成组并按行排序：一条根评论 + 它的回复算一个线程。 */
  function commentThreads(file) {
    const list = (file && D.commentsByPath && D.commentsByPath.get(file.path)) || [];
    if (!list.length) return [];
    const byId = new Map(list.filter((c) => c.id != null).map((c) => [c.id, c]));
    const groups = new Map();
    for (const c of list) {
      let root = c;
      let guard = 0;
      while (root && root.inReplyTo != null && byId.has(root.inReplyTo) && guard < 20) {
        root = byId.get(root.inReplyTo);
        guard += 1;
      }
      const key = root.id != null ? `c${root.id}` : `c${root.line}-${root.author}`;
      if (!groups.has(key)) {
        const line = root.line ?? null;
        groups.set(key, { key, root, replies: [], line, staleLine: line == null ? (root.originalLine ?? null) : null });
      }
      if (root !== c) groups.get(key).replies.push(c);
    }
    return [...groups.values()].sort((a, b) => (a.line || 0) - (b.line || 0));
  }

  /** 落在指定块行范围内的线程。行级锚点，所以块的起止行就够用。 */
  function threadsInBlock(file, b) {
    if (!file || b.startLine == null) return [];
    const end = b.endLine ?? b.startLine;
    return commentThreads(file).filter((t) => t.line != null && t.line >= b.startLine && t.line <= end);
  }

  /** 正文悬停气泡：先看这一段的线程，需要就回一句；完整讨论仍在评论树里。 */
  const canReply = () => Boolean(D.meta && D.meta.state === "open" && !D.meta.merged && !isCommitView());

  /** 回复面板默认收起：正文气泡与评论树共用同一套标记，点「回复」才展开输入框。 */
  function threadReplyHTML(t, where) {
    if (!canReply() || t.root.id == null) return "";
    const key = `${where}:${t.root.id}`;
    return `<div class="treply">`
      + `<button type="button" class="treply-open" data-act="reply-toggle" data-draft-key="${key}" aria-expanded="false">回复</button>`
      + `<div class="tcomposer" data-composer="${key}" hidden>`
        + `<textarea class="trta" rows="2" data-reply-to="${t.root.id}" data-draft-key="${key}" placeholder="回复 ${esc(t.root.author)}…"></textarea>`
        + `<button type="button" class="btn" data-act="reply" data-reply-to="${t.root.id}" data-draft-key="${key}">发送</button>`
      + `</div></div>`;
  }

  /** 展开 / 收起一条线程的回复面板；收起时草稿保留，重新展开还在。 */
  function toggleReply(act) {
    const key = act && act.dataset ? act.dataset.draftKey : "";
    const box = key ? document.querySelector(`[data-composer="${key}"]`) : null;
    if (!box) return;
    const open = box.hidden;
    box.hidden = !open;
    act.setAttribute("aria-expanded", String(open));
    act.textContent = open ? "取消回复" : "回复";
    if (open) {
      const ta = box.querySelector(".trta");
      if (ta) ta.focus();
    }
  }

  function commentBubbleHTML(threads, b, drafts) {
    const list = drafts || [];
    const draftRows = list.slice(0, 2).map((d) => {
      const first = esc(((d.body || "").split("\n").filter(Boolean)[0] || "").slice(0, 90));
      return `<div class="thr is-draft"><b>草稿</b><span class="tln">L${d.start} · 未发送</span>`
        + `<div class="tmsg">${first}</div></div>`;
    }).join("");
    const shown = threads.slice(0, 3).map((t) => {
      const first = esc(((t.root.body || "").split("\n").filter(Boolean)[0] || "").slice(0, 90));
      const replies = t.replies.length ? `<div class="trep">${t.replies.length} 条回复</div>` : "";
      return `<div class="thr"><b>${esc(t.root.author)}</b><span class="tln">L${t.line}</span>`
        + `<div class="tmsg">${first}</div>${replies}${threadReplyHTML(t, "doc")}</div>`;
    }).join("");
    const rest = Math.max(threads.length - 3, 0) + Math.max(list.length - 2, 0);
    const more = rest ? `<div class="tmore">此段还有 ${rest} 条待看</div>` : "";
    const head = []
      .concat(threads.length ? [`${threads.length} 个评论线程`] : [])
      .concat(list.length ? [`${list.length} 条草稿未发送`] : [])
      .join(" · ");
    return `<div class="cbubble" role="dialog" aria-label="第 ${b.startLine} 行附近的评论">`
      + `<div class="chead">此段 ${head}</div>${draftRows}${shown}${more}`
      + `<button type="button" class="clink" data-act="open-tree">在评论树中查看 →</button></div>`;
  }

  /** 本块里还没发出的本地草稿（按行范围重叠判定）。 */
  function draftsInBlock(file, b) {
    if (!file || !D.drafts || !D.drafts.length) return [];
    const start = b.startLine;
    const end = b.endLine ?? b.startLine;
    if (start == null) return [];
    const sha = refOf();
    return D.drafts.filter((d) => d.path === file.path
      /* 提交换过之后，同路径同行号是另一段文字；只标当前版本创建的那条 */
      && (!d.headSha || !sha || d.headSha === sha)
      && d.start != null && d.start <= end && (d.end ?? d.start) >= start);
  }

  /** 行 → 所在正文块：评论树与气泡靠它做「悬停哪里、正文哪里亮」。 */
  function blockAtLine(line) {
    if (!line) return null;
    return [...document.querySelectorAll("#wbDoc .md-block[data-line]")].find((el) => {
      const start = Number(el.dataset.line);
      const end = Number(el.dataset.endLine) || start;
      return line >= start && line <= end;
    }) || null;
  }

  function jumpToCommentLine(line) {
    if (!line) return;
    D.pendingAnchor = { line };
    applyAnchor();
    const block = blockAtLine(line);
    if (block) {
      block.classList.add("cflash");
      setTimeout(() => block.classList.remove("cflash"), 1200);
    }
  }

  const statusMark = (status) => (status === "added" ? "A" : status === "removed" ? "D" : status === "renamed" ? "R" : "M");
  const reviewInfo = (path) => {
    const drafts = D.drafts.filter((d) => d.path === path).length;
    const comments = D.commentsByPath ? (D.commentsByPath.get(path) || []).length : 0;
    return { drafts, comments, reviewed: drafts > 0 || comments > 0 };
  };

  /* ---------- 文件列表：树状 / 平铺 ---------- */
  function fileTree(filter) {
    const tree = window.DiffModel.buildFileTree(D.files);
    const q = filter.toLowerCase();
    if (!q) return { nodes: tree, hits: D.files.length };

    const hits = [];
    const prune = (nodes) => nodes.reduce((acc, node) => {
      if (node.type === "file") {
        if (node.path.toLowerCase().includes(q)) { acc.push(node); hits.push(node.path); }
        return acc;
      }
      const kids = prune(node.children);
      if (kids.length) {
        acc.push(Object.assign({}, node, {
          children: kids,
          count: kids.reduce((sum, kid) => sum + (kid.type === "dir" ? kid.count : 1), 0),
        }));
      }
      return acc;
    }, []);
    const nodes = prune(tree);
    return { nodes, hits: hits.length };
  }

  function fileRowHTML(file) {
    const mark = statusMark(file.status);
    const info = reviewInfo(file.path);
    return `<div class="trow tfile${D.file === file.path ? " is-active" : ""}${info.reviewed ? " reviewed" : ""}"`
      + ` data-path="${esc(file.path)}" role="treeitem" tabindex="-1" aria-selected="${D.file === file.path}"`
      + ` title="${esc(file.path)}">`
      + `<span class="twisty" aria-hidden="true"></span>`
      + `<span class="fmark ${mark}">${mark}</span>`
      + `<span class="tname">${esc(file.name)}</span>`
      + (info.reviewed ? `<span class="fdot" title="草稿 ${info.drafts} · 已有评论 ${info.comments}"></span>` : "")
      + (info.drafts ? `<span class="wb-badge" style="position:static">${info.drafts}</span>` : "")
      + `<span class="fnum"><em>+${file.additions}</em> −${file.deletions}</span>`
      + `</div>`;
  }

  function treeHTML(nodes, opts) {
    return nodes.map((node) => {
      if (node.type === "file") return fileRowHTML(node);
      const folded = !opts.forceOpen && D.folded.has(node.path);
      const head = `<div class="trow tdir${folded ? " is-folded" : ""}" data-dir="${esc(node.path)}" role="treeitem"`
        + ` aria-expanded="${!folded}" tabindex="-1" title="${esc(node.path)}">`
        + `<span class="twisty" aria-hidden="true"></span>`
        + `<span class="tname">${esc(node.name)}</span>`
        + `<span class="tcount">${node.count}</span>`
        + `</div>`;
      return folded ? head : head + `<div class="tnest" role="group">${treeHTML(node.children, opts)}</div>`;
    }).join("");
  }

  function flatListHTML(filter) {
    const q = filter.toLowerCase();
    const shown = D.files.filter((f) => !q || f.path.toLowerCase().includes(q));
    const html = shown.map((f) => {
      const mark = statusMark(f.status);
      const info = reviewInfo(f.path);
      return `<div class="fitem${D.file === f.path ? " is-active" : ""}${info.reviewed ? " reviewed" : ""}"`
        + ` data-path="${esc(f.path)}" title="${esc(f.path)}">`
        + `<span class="fmark ${mark}">${mark}</span>`
        + `<span class="fname" title="${esc(f.path)}">${esc(f.path.split("/").pop())}</span>`
        + `<span class="fnum"><em>+${f.additions}</em> −${f.deletions}</span>`
        + (info.reviewed ? `<span class="fdot" title="草稿 ${info.drafts} · 已有评论 ${info.comments}"></span>` : "")
        + (info.drafts ? `<span class="wb-badge" style="position:static">${info.drafts}</span>` : "")
        + `</div>`;
    }).join("");
    return { html, hits: shown.length };
  }

  /** 抽屉收起后在右缘留一个把手，避免「点掉箭头就再也打不开」。 */
  /** 打开抽屉：所有入口共用，保证右缘把手与面板状态一致 */
  function openDrawer() {
    const body = document.getElementById("wbBody");
    if (body) body.classList.add("drawer-open");
    syncDrawerHandle();
  }

  function syncDrawerHandle() {
    const btn = document.getElementById("wbDrawerOpen");
    if (!btn) return;
    if (document.getElementById("wbBody").classList.contains("drawer-open")) {
      btn.hidden = true;
      return;
    }
    const total = (D.comments || []).length;
    btn.textContent = total ? `意见 ${total}` : "意见";
    btn.hidden = false;
    // 面板开合会改变正文宽度 → 块高度随之变化，刻度要重量
  }

  function renderFiles() {
    const box = document.getElementById("wbFiles");
    if (!box) return;
    const tree = D.view === "tree";
    const { hits, html } = tree
      ? (() => {
        const { nodes, hits: matched } = fileTree(D.filter);
        return {
          hits: matched,
          html: nodes.length
            ? `<div class="wb-tree" role="group">${treeHTML(nodes, { forceOpen: !!D.filter })}</div>`
            : `<div class="dempty">没有匹配的文件</div>`,
        };
      })()
      : (() => {
        const { html: rows, hits: matched } = flatListHTML(D.filter);
        return {
          hits: matched,
          html: rows ? `<div class="wb-tree" role="group">${rows}</div>` : `<div class="dempty">没有匹配的文件</div>`,
        };
      })();
    box.innerHTML = html;
    setMeta("wbFilesMeta", D.filter ? `${hits}/${D.files.length} 个文件` : `${D.files.length} 个文件`);
    document.querySelectorAll(".wb-viewseg [data-view]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.view === D.view));
    });
  }

  const setMeta = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  function toggleDir(path, node) {
    const row = node || null;
    if (D.folded.has(path)) D.folded.delete(path);
    else D.folded.add(path);
    saveFolded();
    renderFiles();
    const next = Array.from(document.querySelectorAll('#wbFiles [data-dir]')).find((el) => el.dataset.dir === path);
    if (next) next.focus({ preventScroll: false });
    else if (row) row.focus();
  }

  /* 选中文件时展开祖先目录，保证左侧能看见当前文件 */
  function unfoldAncestors(path) {
    const parts = path.split("/").slice(0, -1);
    let prefix = "";
    let changed = false;
    parts.forEach((part) => {
      prefix = prefix ? `${prefix}/${part}` : part;
      if (D.folded.delete(prefix)) changed = true;
    });
    if (changed) saveFolded();
    return changed;
  }

  function initFileList() {
    const box = document.getElementById("wbFiles");
    if (!box) return;
    box.addEventListener("click", (e) => {
      const dir = e.target.closest("[data-dir]");
      if (dir) { toggleDir(dir.dataset.dir, dir); return; }
      const file = e.target.closest("[data-path]");
      if (file) selectFile(file.dataset.path);
    });

    box.addEventListener("focus", () => {
      if (!box.contains(document.activeElement) || document.activeElement === box) {
        const target = box.querySelector(".trow.is-active, .trow") || box.querySelector(".fitem");
        if (target) target.focus();
      }
    });

    /* 键盘：↑↓ 移动，← 折叠/回父级，→ 展开/进子级，Enter 打开 */
    box.addEventListener("keydown", (e) => {
      const rows = Array.from(box.querySelectorAll(".trow"));
      if (!rows.length) return;
      const current = document.activeElement;
      const index = rows.indexOf(current);
      const focusAt = (i) => {
        const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
        if (row) row.focus();
      };
      if (e.key === "ArrowDown") { focusAt(index < 0 ? 0 : index + 1); e.preventDefault(); return; }
      if (e.key === "ArrowUp") { focusAt(index < 0 ? rows.length - 1 : index - 1); e.preventDefault(); return; }
      if (e.key === "Home") { focusAt(0); e.preventDefault(); return; }
      if (e.key === "End") { focusAt(rows.length - 1); e.preventDefault(); return; }
      if (!current || index < 0) return;

      const isDir = current.classList.contains("tdir");
      if (e.key === "ArrowRight") {
        e.preventDefault();
        if (!isDir) return;
        if (current.classList.contains("is-folded")) { toggleDir(current.dataset.dir); return; }
        const nest = current.nextElementSibling;
        const first = nest && nest.classList.contains("tnest") ? nest.querySelector(".trow") : null;
        if (first) first.focus();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (isDir && !current.classList.contains("is-folded")) { toggleDir(current.dataset.dir); return; }
        const path = current.dataset.dir || current.dataset.path;
        const parentPath = path.split("/").slice(0, -1).join("/");
        const parent = rows.find((row) => row.dataset.dir === parentPath);
        if (parent) parent.focus();
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (isDir) toggleDir(current.dataset.dir);
        else if (current.dataset.path) selectFile(current.dataset.path);
      }
    });
  }

  /* ---------- 分区折叠 + 两处拖动 ---------- */
  function setSection(name, expanded) {
    const view = document.getElementById(name === "files" ? "wbFilesView" : "wbChaptersView");
    const head = document.getElementById(name === "files" ? "wbFilesHead" : "wbChaptersHead");
    if (!view || !head) return;
    view.classList.toggle("is-collapsed", !expanded);
    head.setAttribute("aria-expanded", String(expanded));
    const sections = readPref(PREF.sections, {});
    sections[name] = expanded;
    writePref(PREF.sections, sections);
  }

  function initSections() {
    const sections = readPref(PREF.sections, {});
    setSection("files", sections.files !== false);
    setSection("chapters", sections.chapters !== false);
    [["files", "wbFilesHead"], ["chapters", "wbChaptersHead"]].forEach(([name, id]) => {
      const head = document.getElementById(id);
      if (!head) return;
      head.addEventListener("click", () => {
        setSection(name, head.getAttribute("aria-expanded") !== "true");
      });
      head.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        setSection(name, head.getAttribute("aria-expanded") !== "true");
      });
    });
  }

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  function initSashes() {
    const body = document.getElementById("wbBody");
    const nav = document.getElementById("wbNav");
    const filesView = document.getElementById("wbFilesView");
    const filesHead = document.getElementById("wbFilesHead");
    const sashY = document.getElementById("wbSashY");
    const sashX = document.getElementById("wbSashX");
    if (!body || !nav || !sashX || !sashY) return;

    const NAV_MIN = 180;
    const FILES_MIN = 96;
    const CHAPTERS_MIN = 72;

    const navMax = () => Math.min(460, Math.max(NAV_MIN, Math.round(window.innerWidth * 0.5)));
    const filesMax = () => {
      const headH = filesHead ? filesHead.getBoundingClientRect().height || 24 : 24;
      return Math.max(FILES_MIN, (nav.clientHeight || 0) - headH - 8 - CHAPTERS_MIN);
    };

    const rootStyle = document.documentElement ? document.documentElement.style : null;
    const setVar = (el, name, value) => {
      if (el && el.style && typeof el.style.setProperty === "function") el.style.setProperty(name, value);
    };
    const cssNavW = () => {
      if (!window.getComputedStyle || !document.documentElement) return 0;
      return parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue("--nav-w")) || 0;
    };

    let navW = readPref(PREF.navW, 0) || cssNavW() || 228;
    setNavWidth(clamp(navW, NAV_MIN, navMax()));

    const savedH = readPref(PREF.filesH, 0);
    if (savedH) setFilesHeight(clamp(savedH, FILES_MIN, filesMax()));

    function setNavWidth(width) {
      setVar(rootStyle && document.documentElement, "--nav-w", `${Math.round(width)}px`);
      navW = width;
    }
    function setFilesHeight(height) {
      setVar(filesView, "--files-h", `${Math.round(height)}px`);
    }

    const drag = (ev, onMove, onEnd) => {
      ev.preventDefault();
      body.classList.add("is-dragging");
      const move = (e) => onMove(e);
      const end = () => {
        body.classList.remove("is-dragging");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        onEnd();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    };

    sashX.addEventListener("pointerdown", (ev) => {
      const startX = ev.clientX;
      const startW = nav.getBoundingClientRect().width;
      drag(ev, (e) => setNavWidth(clamp(startW + (e.clientX - startX), NAV_MIN, navMax())), () => writePref(PREF.navW, Math.round(navW)));
    });
    sashX.addEventListener("dblclick", () => {
      setNavWidth(228);
      writePref(PREF.navW, 228);
    });
    sashX.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 48 : 16;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      setNavWidth(clamp(navW + (e.key === "ArrowRight" ? step : -step), NAV_MIN, navMax()));
      writePref(PREF.navW, Math.round(navW));
    });

    sashY.addEventListener("pointerdown", (ev) => {
      if (document.getElementById("wbFilesView").classList.contains("is-collapsed")) setSection("files", true);
      const startY = ev.clientY;
      const startH = filesView.getBoundingClientRect().height;
      drag(ev, (e) => setFilesHeight(clamp(startH + (e.clientY - startY), FILES_MIN, filesMax())),
        () => writePref(PREF.filesH, Math.round(filesView.getBoundingClientRect().height)));
    });
    sashY.addEventListener("dblclick", () => {
      filesView.style.removeProperty("--files-h");
      writePref(PREF.filesH, 0);
    });
    sashY.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 48 : 12;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const now = filesView.getBoundingClientRect().height;
      setFilesHeight(clamp(now + (e.key === "ArrowDown" ? step : -step), FILES_MIN, filesMax()));
      writePref(PREF.filesH, Math.round(filesView.getBoundingClientRect().height));
    });

    if (typeof window.addEventListener === "function") {
      window.addEventListener("resize", () => {
        setNavWidth(clamp(navW, NAV_MIN, navMax()));
        const h = readPref(PREF.filesH, 0);
        if (h) setFilesHeight(clamp(h, FILES_MIN, filesMax()));
      });
    }
  }

  /* 正文顶部：当前文件的仓库相对路径 */
  function renderFilepath() {
    const bar = document.getElementById("wbFilepath");
    if (!bar) return;
    const file = D.ref ? null : curFile();
    if (!file) { bar.hidden = true; return; }
    const parts = file.path.split("/");
    const name = parts.pop();
    const mark = statusMark(file.status);
    bar.hidden = false;
    bar.title = file.path;
    const markEl = document.getElementById("wbFilepathMark");
    if (markEl) { markEl.textContent = mark; markEl.className = `fp-mark ${mark}`; }
    const dirEl = document.getElementById("wbFilepathDir");
    if (dirEl) dirEl.textContent = parts.length ? `${parts.join("/")}/` : "";
    const nameEl = document.getElementById("wbFilepathName");
    if (nameEl) nameEl.textContent = name;
  }

  /* ---------- 章节树 ---------- */
  function renderChapters() {
    renderChaptersInner();
    const count = document.querySelectorAll("#wbChapters .chapter, #wbChapters [data-ref-anchor]").length;
    setMeta("wbChaptersMeta", count ? `${count} 节` : "");
  }

  function renderChaptersInner() {
    const box = document.getElementById("wbChapters");
    if (!box) return;
    if (D.ref) { renderRefChapters(); return; }
    const file = curFile();
    const textState = file && textsOf(file.path);
    if (!textState || !textState.headLoaded) { box.innerHTML = `<div class="dempty">加载正文后显示章节…</div>`; return; }
    if (isCsv(file.path)) {
      const csv = csvModelFor(file);
      if (!csv.head.rows.length || (!file.patch && file.status !== "added")) {
        box.innerHTML = `<div class="dempty">—</div>`;
        return;
      }
      const rows = csv.head.rows;
      const changed = rows.filter((r) => r.state === "added" || r.state === "modified");
      const stat = `<div class="chapter-stat">CSV · ${rows.length} 行 × ${csv.columns} 列</div>`;
      if (!changed.length) { box.innerHTML = stat + `<div class="dempty">没有内容变化</div>`; return; }
      /* 整份文件都是新增 / 修改时逐行列没有导航价值，只留一条汇总。 */
      if (changed.length === rows.length) {
        box.innerHTML = stat + `<div class="chapter" data-line="${rows[0].startLine}" data-chapter="${rows[0].startLine}">`
          + `<span class="cdot"></span>全文件 ${rows.length} 行均有变化</div>`;
        return;
      }
      const shown = changed.slice(0, 40);
      box.innerHTML = stat
        + shown.map((r) => `<div class="chapter" data-line="${r.startLine}" data-chapter="${r.startLine}">`
          + `<span class="cdot"></span>L${r.startLine} ${r.state === "added" ? "新增" : "修改"}</div>`).join("")
        + (changed.length > shown.length ? `<div class="dempty">另有 ${changed.length - shown.length} 行变化，未列出</div>` : "");
      return;
    }
    const model = modelFor(file);
    if (!model) { box.innerHTML = `<div class="dempty">—</div>`; return; }
    const heads = model.headBlocks.filter((b) => b.type === "h1" || b.type === "h2" || b.type === "h3" || b.type === "h4");
    if (!heads.length) { box.innerHTML = `<div class="dempty">本文档没有标题</div>`; return; }
    /* 每节右侧一条 5 格微条：改了几处就填几格，未改动保持浅色 */
    const marks = model.headBlocks.filter((b) => b.startLine && b.changeState && b.changeState !== "normal" && b.changeState !== "same");
    box.innerHTML = heads.map((b, i) => {
      const next = i + 1 < heads.length ? heads[i + 1].startLine : Infinity;
      const count = marks.filter((m) => m.startLine >= b.startLine && m.startLine < next).length;
      const filled = Math.min(count, 5);
      const bar = `<span class="cbar${count ? "" : " is-empty"}" aria-hidden="true">`
        + [0, 1, 2, 3, 4].map((k) => `<i${k < filled ? ' class="on"' : ""}></i>`).join("")
        + `</span>`;
      const lvl = Number(b.type[1]);
      return `<div class="chapter l${lvl}${count ? " has-change" : ""}" data-line="${b.startLine}" data-chapter="${b.startLine}" title="${count ? `${count} 处改动 · ` : ""}${esc(b.title || "")}">`
        + `<span class="ctitle">${esc(b.title || "(无标题)")}</span>${bar}</div>`;
    }).join("");
  }

  /* 章节联动：滚动时高亮当前所在节，目录跟着走到可视区 */
  let spyFrame = 0;
  function syncChapterSpy() {
    if (spyFrame) return;
    const run = () => {
      spyFrame = 0;
      const doc = document.getElementById("wbDoc");
      const box = document.getElementById("wbChapters");
      if (!doc || !box || typeof doc.getBoundingClientRect !== "function") return;
      const items = Array.from(box.querySelectorAll(".chapter[data-line]"));
      if (!items.length) return;
      const edge = doc.getBoundingClientRect().top + 80;
      let current = items[0];
      for (const item of items) {
        const block = doc.querySelector(`[data-block="${item.dataset.line}"]`);
        if (!block) continue;
        if (block.getBoundingClientRect().top > edge) break;
        current = item;
      }
      items.forEach((item) => item.classList.toggle("active", item === current));
      const top = current.getBoundingClientRect().top;
      const view = box.getBoundingClientRect();
      if ((top < view.top || top > view.bottom - 24) && typeof current.scrollIntoView === "function") {
        current.scrollIntoView({ block: "nearest" });
      }
    };
    if (typeof requestAnimationFrame === "function") spyFrame = requestAnimationFrame(run);
    else run();
  }

  /* ---------- 差异模型缓存 ---------- */
  const modelCache = new Map();
  function cachedModel(file, kind, build) {
    const head = textOf(file.path, "head");
    const base = textOf(file.path, "base");
    const patch = file.patch || "";
    const key = kind + "|" + D.revKey + "|" + file.path;
    const hit = modelCache.get(key);
    if (hit && hit.head === head && hit.base === base && hit.patch === patch) return hit.value;
    const value = build(head, base, patch);
    modelCache.set(key, { head, base, patch, value });
    return value;
  }
  const modelFor = (file) => (file
    ? cachedModel(file, "md", window.DiffModel.buildModel)
    : null);
  const csvModelFor = (file) => (file
    ? cachedModel(file, "csv", window.DiffModel.csvModel)
    : null);

  /* ---------- 文档内的相对资源 ---------- */
  /* 仓库与提交都从已有字段推导：meta.url 形如 https://github.com/<owner>/<repo>/pull/16 */
  const repoOf = () => {
    const hit = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/i.exec((D.meta && D.meta.url) || "");
    return hit ? { owner: hit[1], repo: hit[2] } : null;
  };
  const refOf = () => (isCommitView() ? D.rev.sha : D.meta?.headSha);
  const rawUrlOf = (path, ref) => {
    const repo = repoOf();
    if (!repo || !path) return "";
    /* 逐段编码：路径里合法的 # 或 % 不编码会被当成片段/转义，取到别的文件 */
    const encoded = String(path).split("/").map((seg) => encodeURIComponent(seg)).join("/");
    return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodeURIComponent(ref || refOf())}/${encoded}`;
  };

  /**
   * 块内相对地址按「当前提交」解析：图片去 raw，仓库内文件去 raw，
   * 文档链接落到工作台的 /doc 页（同窗口打开，不新开标签）。
   */
  function resolveBlockUrls(html, file, ref) {
    if (!html) return html;
    const base = file ? file.path : "";
    const out = html.replace(/\b(src|href)="([^"]*)"/g, (match, attr, value) => {
      const raw = String(value || "").trim();
      if (!raw || raw.startsWith("#") || /^(https?:|mailto:|tel:|data:|blob:)/i.test(raw)) return match;
      const hit = window.DiffModel.resolveDocLink(raw, base);
      if (hit.kind !== "repo") return match;
      if (attr === "src") return `src="${esc(rawUrlOf(hit.path, ref))}"`;
      if (hit.isDoc) {
        const hash = hit.anchor ? `#${encodeURIComponent(hit.anchor)}` : "";
        const target = String(hit.path || "").split("/").map(encodeURIComponent).join("/");
        return `href="/doc/${target}?ref=${encodeURIComponent(ref || refOf())}${hash}"`;
      }
      /* 保留原始片段：PDF 的 #page=3 之类靠它定位，编码回写会失效 */
      return `href="${esc(rawUrlOf(hit.path, ref))}${hit.anchor ? `#${esc(hit.anchor)}` : ""}"`;
    });
    return out
      .replace(/<a\b[^>]*href="\/doc\/[^"]*"[^>]*>/g, (tag) => tag.replace(/\s+target="_blank"/, ""))
      .replace(/<img\b(?![^>]*\bloading=)/g, '<img loading="lazy" decoding="async"');
  }

  /* 旧文按文档排版渲染，但资源按 base 提交与改前路径解析：否则会显示改后的图片与链接 */
  const oldDocHtml = (text, file) => {
    const baseRef = isCommitView() ? (D.rev.parentSha || D.rev.sha) : D.meta?.baseSha;
    const oldPath = (file && file.previousPath) || (file ? file.path : "");
    return window.DiffModel.mdBlocks(text)
      .map((b) => resolveBlockUrls(b.html, { path: oldPath }, baseRef)).join("");
  };

  /**
   * 把新增文本在渲染结果里包一层 <ins>。
   * 按位置匹配：把纯文本片段拼成一条流，用游标保证新增行按文档顺序消费，
   * 同一段里同一句话出现多次时无法判断哪处是新增，直接不标，只留页边记号。
   */
  /* ---------- 文档缩放与全屏阅读 ---------- */
  const ZOOM_STEPS = [0.9, 1, 1.15, 1.3, 1.5];
  const ZOOM_MIN = ZOOM_STEPS[0];
  const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];
  const clampZoom = (v) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(Number(v) * 100) / 100));
  function applyZoom() {
    const z = clampZoom(D.zoom || 1);
    D.zoom = z;
    const root = document.documentElement || document.body;
    if (root && root.style && root.style.setProperty) root.style.setProperty("--doc-zoom", String(z));
    const label = document.getElementById("focusZoomLabel");
    if (label) label.textContent = `${Math.round(z * 100)}%`;
    document.querySelectorAll("[data-zoom]").forEach((b) => {
      b.setAttribute("aria-checked", String(Math.abs(Number(b.dataset.zoom) - z) < 0.001));
    });
  }
  function stepZoom(dir) {
    const cur = D.zoom || 1;
    let idx = ZOOM_STEPS.findIndex((v) => Math.abs(v - cur) < 0.001);
    if (idx < 0) idx = ZOOM_STEPS.reduce((best, v, i) => (Math.abs(v - cur) < Math.abs(ZOOM_STEPS[best] - cur) ? i : best), 0);
    D.zoom = clampZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, idx + dir))]);
    writePref(PREF.zoom, D.zoom);
    applyZoom();
  }
  /* 全屏阅读的左侧大纲：可隐藏，状态记忆 */
  function setOutline(on) {
    D.outline = Boolean(on);
    writePref(PREF.outline, D.outline);
    document.body.classList.toggle("outline-off", !D.outline);
    const btn = document.getElementById("focusOutline");
    if (btn) btn.setAttribute("aria-pressed", String(D.outline));
  }

  function setFocus(on) {
    D.focus = Boolean(on);
    writePref(PREF.focus, D.focus);
    if (document.body && document.body.classList) document.body.classList.toggle("reading-focus", D.focus);
    const bar = document.getElementById("focusBar");
    if (bar) bar.hidden = !D.focus;
    const btn = document.getElementById("wbFocusBtn");
    if (btn) btn.setAttribute("aria-pressed", String(D.focus));
    // 浏览器级全屏：失败也不影响页内焦点模式
    try {
      const p = D.focus && !document.fullscreenElement
        ? document.documentElement.requestFullscreen?.()
        : (!D.focus && document.fullscreenElement ? document.exitFullscreen?.() : null);
      // 用户可能拒绝或浏览器不允许，页内焦点模式仍要生效
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch { /* 同步抛错同样忽略 */ }
  }

  /* ---------- 已阅与改动清单 ---------- */
  /* 键里带侧别：base 第 N 行与 head 第 N 行是两处不同的内容 */
  const reviewKey = (file, line, side) => `${D.revKey}|${file ? file.path : ""}|${side || "head"}|${line}`;
  const isReviewed = (file, line, side) => Boolean(file && D.reviewed && D.reviewed[reviewKey(file, line, side)]);
  function setReviewed(file, line, side, on) {
    if (!file) return;
    const key = reviewKey(file, line, side);
    if (on) D.reviewed[key] = 1; else delete D.reviewed[key];
    writePref(PREF.reviewed, D.reviewed);
  }
  const STATE_LABEL = { added: "新增", modified: "修改", removed: "删除", moved: "搬移" };
  /** 当前文件的改动块（引擎为准，缺引擎时退回 DiffModel 的插入/删除） */
  /** 改前条目没有新行号：滚到最接近该行号的删除块并闪一下 */
  function jumpToBaseLine(line) {
    const blocks = [...document.querySelectorAll("#wbDoc .del-block[data-old-line]")];
    if (!blocks.length) return;
    let target = blocks[0];
    for (const el of blocks) {
      const l = Number(el.dataset.oldLine);
      if (Number.isFinite(l) && l <= line) target = el;
    }
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("cflash");
    window.setTimeout(() => target.classList.remove("cflash"), 1200);
  }

  function changeUnits(file) {
    if (!file) return [];
    const doc = semDocFor(file);
    if (doc) {
      return doc.filter((d) => d.state !== "normal").map((d) => ({
        /* 删除块只有 base 行号，没有 pair；用块自己的行，才能标已阅与跳转 */
        line: d.block.startLine != null ? d.block.startLine : (d.pair && d.pair.line) || null,
        side: d.block.side, state: d.state, tier: d.tier,
        text: String(d.block.text || "").slice(0, 60),
      }));
    }
    const model = modelFor(file);
    if (!model) return [];
    const out = [];
    for (const it of model.headInsertions || []) out.push({ line: it.afterNewLine, side: "head", state: "added", text: "" });
    for (const ch of (model.changes || [])) out.push({ line: ch.oldStartLine || null, side: "base", state: "removed", text: "" });
    return out;
  }
  function reviewStats(file) {
    const units = changeUnits(file);
    const done = units.filter((u) => u.line != null && isReviewed(file, u.line, u.side)).length;
    return { total: units.length, done };
  }
  function changeListHTML(file) {
    if (!file || viewState() !== "markup") return "";
    const units = changeUnits(file);
    if (!units.length) return "";
    const items = units.map((u) => {
      const done = u.line != null && isReviewed(file, u.line, u.side);
      const jumpAttr = u.line == null ? ""
        : u.side === "head" ? ` data-jump-to="${u.line}"` : ` data-jump-base="${u.line}"`;
      return `<li class="chg-item${done ? " is-done" : ""}"${jumpAttr}>`
        + `<button type="button" class="chg-rv${done ? " on" : ""}" data-review="${u.line}" data-review-side="${u.side}" aria-pressed="${done}" title="${done ? "取消已阅" : "标为已阅"}">✓</button>`
        + `<span class="chg-chip ${u.state}">${STATE_LABEL[u.state] || "改动"}</span>`
        + `<span class="chg-text">${esc(u.text || "（无文本）")}</span>`
        + `<span class="chg-line">L${u.line == null ? "-" : u.line}</span></li>`;
    }).join("");
    const { done, total } = reviewStats(file);
    // 改动不是评审焦点：默认收起，放在评论之后
    return `<details class="chg-fold"><summary>改动清单 · ${total} 处 · 已阅 ${done}</summary>`
      + `<div class="chg-head">改动 · ${total} 处 · 已阅 ${done}</div><ul class="chg-list">${items}</ul></details>`;
  }

  /* ---------- 显示状态：最终 / 原始 / 标记 ---------- */
  const VIEWS = ["markup", "final", "original"];
  const viewState = () => (VIEWS.includes(D.docView) ? D.docView : "markup");
  /** 最终=定稿正文，原始=改前正文；两者都不显示改动记号与评论入口 */
  function plainDocHTML(file, side) {
    const text = side === "base" ? textOf(file.path, "base") : textOf(file.path, "head");
    if (!text) return `<div class="dempty">正在加载正文…</div>`;
    const blocks = window.DiffModel.mdBlocks(text);
    const isHead = side !== "base";
    return `<div class="view-note">${isHead ? "最终稿（不显示改动）" : "改前版本（Base）"}`
      + ` · <button type="button" class="linkish" data-view-state="markup">回到标记视图</button></div>`
      + blocks.map((b) => `<div class="md-block" data-${isHead ? "" : "base-"}line="${b.startLine}">`
        + `${resolveBlockUrls(b.html, file)}</div>`).join("");
  }

  function readingHTML(file) {
    const textState = textsOf(file.path);
    const errMsg = (textState && textState.error) || D.err;
    if (!textState || !textState.headLoaded) {
      if (errMsg) return `<div class="error-box">${esc(errMsg)} <button type="button" class="retry" data-retry="1">重试</button></div>`;
      return `<div class="dempty">正在加载正文…</div>`;
    }
    if (isCsv(file.path)) return csvReadingHTML(file);
    if (viewState() !== "markup" && file.status !== "added" && file.status !== "removed") {
      const side = viewState() === "original" ? "base" : "head";
      /* 截断的文件不能当成全文展示：两个纯净视图都要先拦 */
      if (side === "base" ? textState.baseTruncated : textState.headTruncated) {
        return `<div class="error-box">文件超过读取上限（400 KB），当前内容不完整，请用 GitHub 原始文件查看。</div>`;
      }
      return plainDocHTML(file, side);
    }
    if (textState.headTruncated) {
      return `<div class="error-box">文件超过读取上限（400 KB），当前内容不完整，请用 GitHub 原始文件查看。</div>`;
    }
    // removed file: show base doc
    if (file.status === "removed") {
      if (textState.baseTruncated) {
        return `<div class="error-box">删除文件超过读取上限（400 KB），Base 内容不完整，请用 GitHub 查看完整版本。</div>`;
      }
      const baseBlocks = window.DiffModel.mdBlocks(textOf(file.path, "base"));
      return `<div class="del-block"><div class="del-head">此文件在本 PR 中已删除</div>`
        + `<div class="del-body">以下为删除前完整内容（Base 版本）：</div></div>`
        + baseBlocks.map((b) => `<div class="md-block" data-base-line="${b.startLine}">${resolveBlockUrls(b.html, file)}</div>`).join("");
    }

    const model = modelFor(file);
    // 新增文件：整份都是新增，逐块涂色没有信息量，改为顶部一条说明
    if (file.status === "added") {
      return addedFileNote() + model.headBlocks.map((b) => blockHtml(b, { plain: true })).join("");
    }

    // interleave head blocks + insertions
    if (!file.patch && file.status !== "added") {
      return `<div class="error-box">GitHub 未返回该文件的差异（文件过大）。无法在工作台中安全审阅此文件，请在 GitHub 中查看完整 Diff。<br><br><a href="${D.meta.url}/files#diff-${encodeURIComponent(file.path)}" target="_blank" rel="noopener">在 GitHub 中查看完整 Diff →</a></div>`;
    }
    const blocks = model.headBlocks;
    const insertions = model.headInsertions;
    let j = 0;
    let html = "";
    for (const b of blocks) {
      const pending = [];
      while (j < insertions.length && insertions[j].afterNewLine <= b.endLine) {
        pending.push(insertions[j]);
        j += 1;
      }
      if (b.type === "ul" || b.type === "ol") {
        const before = pending.filter((item) => item.afterNewLine < b.startLine);
        const inside = pending.filter((item) => item.afterNewLine >= b.startLine);
        html += before.map((item) => insertionHtml(item.change, file)).join("");
        const placed = listBlockWithInsertions(b, inside, file);
        html += placed.html;
        html += placed.unplaced.map((item) => insertionHtml(item.change, file)).join("");
      } else {
        html += pending.map((item) => insertionHtml(item.change, file)).join("");
        html += blockHtml(b, {});
      }
    }
    while (j < insertions.length) { html += insertionHtml(insertions[j].change, file); j += 1; }
    return html;
  }

  /* ---------- 语义 diff（引擎在 public/semdiff.js） ---------- */
  const semCache = new Map();
  /** 整份引擎结果（改动清单、已阅计数都用它） */
  function semDocFor(file) {
    if (!window.SemDiff || !file || isCsv(file.path)) return null;
    const head = textOf(file.path, "head");
    const base = textOf(file.path, "base");
    if (!head || base == null) return null;
    const key = D.revKey + "|" + file.path;
    const hit = semCache.get(key);
    if (hit && hit.head === head && hit.base === base) return hit.doc;
    let doc = null;
    try { doc = window.SemDiff.diffDocument(base, head); } catch (e) { doc = null; }
    semCache.set(key, { head, base, doc, map: null });
    return doc;
  }
  function mapOfDoc(doc) {
    if (!doc) return null;
    const map = new Map();
    for (const d of doc) if (d.block.side === "head") map.set(d.block.startLine, d);
    return map;
  }

  /** 当前文件的 head 块起始行 → 引擎条目（含 inline 区间与改前文本） */
  function semInlineFor(file) {
    if (!window.SemDiff || !file || isCsv(file.path)) return null;
    const head = textOf(file.path, "head");
    const base = textOf(file.path, "base");
    if (!head || base == null) return null;
    const key = D.revKey + "|" + file.path;
    const hit = semCache.get(key);
    if (hit && hit.head === head && hit.base === base) {
      if (!hit.map) hit.map = mapOfDoc(hit.doc);
      return hit.map;
    }
    const doc = semDocFor(file);
    const map = mapOfDoc(doc);
    semCache.set(key, { head, base, doc, map });
    return map;
  }

  /** 把引擎给出的插入区间投影进块 HTML；匹配失败就只留块级记号，不猜位置 */
  function applyInlineMarks(html, b) {
    if (!b || b.type === "code" || !window.SemDiff) return html;
    const map = semInlineFor(curFile());
    const entry = map && map.get(b.startLine);
    let ranges = entry && entry.inline;
    if (!ranges || !ranges.length) {
      /* 引擎拿不到整份 base（例如新增文件）时，退回块内配对保留的改前文本 */
      const old = (b.pairedChanges || (b.pairedChange ? [b.pairedChange] : []))
        .map((pc) => pc.oldText || "").join("\n").trim();
      if (!old) return html;
      try {
        ranges = window.SemDiff.diffBlock(old, window.SemDiff.plainText(html));
      } catch (e) { return html; }
    }
    if (!ranges || !ranges.length) return html;
    try { return window.SemDiff.projectInline(html, ranges); } catch (e) { return html; }
  }

  const LANG_ALIAS = { js: "javascript", ts: "typescript", jsx: "javascript", tsx: "typescript",
    sh: "bash", shell: "bash", zsh: "bash", yml: "yaml", md: "markdown", py: "python",
    golang: "go", rs: "rust", kt: "kotlin", htm: "xml", html: "xml", text: null, plaintext: null };
  function langOf(info) {
    const raw = String(info || "").trim().toLowerCase();
    if (!raw) return null;
    const name = Object.prototype.hasOwnProperty.call(LANG_ALIAS, raw) ? LANG_ALIAS[raw] : raw;
    if (!name) return null;
    if (!window.hljs || !window.hljs.getLanguage || !window.hljs.getLanguage(name)) return null;
    return name;
  }

  function fenceInfo(b) {
    const hit = /^\s*```+\s*([\w#+.-]*)/.exec(String(b.raw || ""));
    return hit ? hit[1] : "";
  }
  function fenceCode(b) {
    return String(b.raw || "").replace(/^\s*```+[^\n]*\n?/, "").replace(/\n?```+\s*$/, "");
  }

  let mmLoading = null;
  function loadMermaid() {
    if (window.mermaid) return Promise.resolve();
    if (mmLoading) return mmLoading;
    mmLoading = new Promise((resolve, reject) => {
      const sc = document.createElement("script");
      sc.src = "/mermaid.min.js";
      sc.defer = true;
      sc.onload = () => resolve();
      sc.onerror = () => reject(new Error("mermaid 脚本加载失败"));
      document.head.appendChild(sc);
    });
    return mmLoading;
  }
  function mermaidFailHTML(err, code) {
    const msg = esc(String((err && err.message) || err || "未知错误"));
    return `<div class="mm-fail"><div class="mm-fail-head">图表渲染失败</div>`
      + `<div class="mm-fail-msg">${msg}</div><pre class="mm-src">${esc(code)}</pre></div>`;
  }
  window.__mmMount = (root) => { mountMermaid(root); };
  async function mountMermaid(root) {
    const hosts = root.querySelectorAll("[data-mermaid]");
    if (!hosts.length) return;
    let failed = null;
    try { await loadMermaid(); } catch (e) { failed = e; }
    for (const host of hosts) {
      const code = host.getAttribute("data-src") || "";
      const box = host.querySelector(".mm-host");
      if (!box) continue;
      if (failed) { box.innerHTML = mermaidFailHTML(failed, code); continue; }
      try {
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
        });
        const out = await window.mermaid.render(`mm${Math.random().toString(36).slice(2)}`, code);
        box.innerHTML = out.svg || out;
      } catch (e) { box.innerHTML = mermaidFailHTML(e, code); }
    }
  }

  function addedFileNote() {
    return `<div class="added-note"><span class="added-tag">新增文件</span>`
      + `本 PR 新增，以下内容全部为新增行，未逐行标注。</div>`;
  }

  function csvBlockHTML(model, opts) {
    const plain = !!opts.plain;
    const counts = model.stats;
    const rows = model.head.rows;
    const delta = [counts.added ? `+${counts.added}` : "", counts.modified ? `~${counts.modified}` : "",
      counts.removed ? `−${counts.removed}` : ""].filter(Boolean).join(" ");
    const stat = (opts.newFile ? `<span class="diff-tag add">新增</span> ` : "")
      + `${rows.length} 行 · ${model.columns} 列 · 首行为表头 `
      + (plain ? `<span class="csv-delta none">全部行均为新增</span>`
        : delta ? `<span class="csv-delta">${delta}</span>` : `<span class="csv-delta none">无单元格变化</span>`);
    return `<div class="csv-block">`
      + tableShellHTML({ csv: true, stat, tools: csvToolsHTML({ noRows: plain }), table: csvReadingTable(model, plain), label: "CSV 数据表" })
      + `</div>`;
  }

  function csvCells(row, cols, tag, labels) {
    let out = "";
    for (let i = 0; i < cols; i += 1) {
      const changed = row.changedCells && row.changedCells.has(i);
      const label = labels && labels[i] != null ? ` data-label="${esc(labels[i])}"` : "";
      out += `<${tag} data-col="${i}"${label}${changed ? ' class="is-changed"' : ""}>${esc(row.cells[i] ?? "")}</${tag}>`;
    }
    return out;
  }

  function csvGutter(row, opts) {
    if (opts.anchors && row.commentLine) {
      return `<span class="line-anchor" data-line="${row.commentLine}" data-side="RIGHT" title="在第 ${row.commentLine} 行评论">`
        + `${row.commentLine}<i>+</i></span>`;
    }
    return `<span class="csv-num">${opts.oldLine ? "−" : ""}${row.startLine}</span>`;
  }

  function csvReadingHTML(file) {
    const textState = textsOf(file.path);
    if (file.status === "removed") {
      if (textState.baseTruncated) {
        return `<div class="error-box">删除文件超过读取上限（400 KB），Base 内容不完整，请用 GitHub 查看完整版本。</div>`;
      }
      const base = window.DiffModel.csvParse(textOf(file.path, "base"));
      const table = csvSimpleTable(base.rows, base.columns, { stateOf: () => "removed" });
      return `<div class="del-block"><div class="del-head">此文件在本 PR 中已删除</div>`
        + `<div class="del-body">以下为删除前的数据表（Base 版本，共 ${base.rows.length} 行）：</div></div>`
        + `<div class="csv-block">`
        + tableShellHTML({
          csv: true,
          stat: `Base · ${base.rows.length} 行 · ${base.columns} 列`,
          tools: csvToolsHTML(),
          table,
          label: "CSV 数据表（删除前）",
        })
        + `</div>`;
    }
    if (textState.headTruncated) {
      return `<div class="error-box">文件超过读取上限（400 KB），当前内容不完整，请用 GitHub 原始文件查看。</div>`;
    }
    if (!file.patch && file.status !== "added") {
      return `<div class="error-box">GitHub 未返回该文件的差异（文件过大）。无法在工作台中安全审阅此文件，请在 GitHub 中查看完整 Diff。<br><br><a href="${D.meta.url}/files#diff-${encodeURIComponent(file.path)}" target="_blank" rel="noopener">在 GitHub 中查看完整 Diff →</a></div>`;
    }
    if (file.status === "added") {
      return addedFileNote() + csvBlockHTML(csvModelFor(file), { plain: true, newFile: true });
    }
    return csvBlockHTML(csvModelFor(file), {});
  }

  function csvReadingTable(model, plain) {
    const rows = model.head.rows;
    if (!rows.length) return `<div class="dempty">（空 CSV 文件）</div>`;
    const cols = model.columns;
    const [header, ...rest] = rows;
    const labels = header.cells;
    const pending = plain ? [] : model.removed;
    let pi = 0;
    let body = "";
    const flush = (beforeLine) => {
      while (pi < pending.length && pending[pi].afterLine < beforeLine) {
        body += csvRowMarkup(pending[pi].row, cols, { state: "removed", oldLine: true, labels });
        pi += 1;
      }
    };
    const headState = (row) => (plain ? "normal" : row.state);
    let heading = csvRowMarkup(header, cols, { header: true, state: headState(header), anchors: true, labels });
    if (!plain && header.before) {
      heading = csvRowMarkup(header.before, cols, { header: true, state: "removed", oldLine: true, labels }) + heading;
    }
    flush(header.startLine);
    for (const row of rest) {
      flush(row.startLine);
      if (!plain && row.before) {
        body += csvRowMarkup(row.before, cols, { state: "removed", oldLine: true, labels });
      }
      body += csvRowMarkup(row, cols, { state: headState(row), anchors: true, labels });
    }
    flush(Infinity);
    return `<table class="csv-table">`
      + `<thead>${heading}</thead><tbody>${body}</tbody></table>`;
  }

  function csvRowMarkup(row, cols, opts) {
    const tag = opts.header ? "th" : "td";
    const state = opts.state || "normal";
    const cls = "csv-row" + (opts.header ? " is-header" : "") + (state === "normal" ? "" : " is-" + state);
    const attrs = opts.anchors
      ? ` data-line="${row.startLine}" data-end-line="${row.endLine}"${row.commentLine ? ` data-comment-line="${row.commentLine}"` : ""}`
      : ` data-old-line="${row.startLine}"`;
    return `<tr class="${cls}"${attrs}><${tag} class="csv-ln" data-col="ln">${csvGutter(row, opts)}</${tag}>`
      + `${csvCells(row, cols, tag, opts.labels)}</tr>`;
  }

  /* ---------- 表格外壳：表头/行号粘住 + 工具栏 + 边缘渐隐 ---------- */
  /* 新增文件的表没有"变化行"可言，不提供行过滤开关 */

  function csvSimpleTable(rows, cols, opts) {
    if (!rows.length) return `<div class="dempty">（空文件）</div>`;
    const [header, ...rest] = rows;
    const labels = header.cells;
    const stateOf = opts.stateOf || ((row) => row.state);
    return `<table class="csv-table">`
      + `<thead>${csvRowMarkup(header, cols, { header: true, state: stateOf(header), anchors: opts.anchors, labels })}</thead>`
      + `<tbody>${rest.map((row) => csvRowMarkup(row, cols, { state: stateOf(row), anchors: opts.anchors, labels })).join("")}</tbody>`
      + `</table>`;
  }

  function insertionHtml(ch, file) {
    return `<div class="del-block" data-old-line="${ch.oldStart}" data-change="${ch.id}">`
      + `<div class="del-head">删除（Base L${ch.oldStart}${ch.oldEnd > ch.oldStart ? "–" + ch.oldEnd : ""}）</div>`
      + `<div class="del-body">${oldDocHtml(ch.oldText, file)}</div>`
      + `<div class="del-jump" data-jump-source="${esc(file.path)}">在源码 Diff 中查看 →</div></div>`;
  }

  /* ---------- CSV 数据表 ---------- */

  function mergeBoxHTML() {
    if (!D.meta || D.meta.state !== "open" || D.meta.merged) return "";
    if (D.merge.done) {
      return `<div class="mergebox"><div class="mergehead">合并</div>`
        + `<div class="mergeok">已提交合并，正在重新读取 PR 状态。</div></div>`;
    }
    const options = D.merge.options;
    if (!options && D.merge.loading) {
      return `<div class="mergebox"><div class="mergehead">合并</div><div class="dhint">正在检查合并条件…</div></div>`;
    }
    if (D.merge.error) {
      return `<div class="mergebox"><div class="mergehead">合并</div>`
        + `<div class="mergewarn">${esc(D.merge.error)}</div>`
        + `<button class="btn ghost" type="button" data-act="merge-refresh">重新检查</button></div>`;
    }
    if (!options) return "";
    const labels = { merge: "创建合并提交", squash: "压缩为单个提交", rebase: "变基后合并" };
    const methods = options.methods || [];
    const method = methods.includes(D.merge.method) ? D.merge.method : (options.defaultMethod || methods[0] || "");
    const dirty = options.mergeable === false || options.mergeableState === "dirty";
    const disabled = !options.canMerge || dirty || !methods.length;
    const warning = !options.canMerge || dirty
      ? (options.reason || (dirty ? "存在合并冲突" : "当前不满足合并条件。"))
      : (["blocked", "behind", "unstable", "unknown"].includes(options.mergeableState || "")
        ? options.reason || `合并状态：${options.mergeableState}`
        : "");
    const squashHint = method === "squash"
      ? `<div class="dhint">squash 会把本 PR 的逐提交历史压缩成一个提交，事后再看“提交浏览”只能看到合并后的单个提交。</div>`
      : "";
    return `<div class="mergebox">`
      + `<div class="mergehead">合并</div>`
      + `<label class="mergelab">合并方式`
      + `<select id="wbMergeMethod"${methods.length ? "" : " disabled"}>`
      + methods.map((item) => `<option value="${esc(item)}"${item === method ? " selected" : ""}>${esc(labels[item] || item)}</option>`).join("")
      + `</select></label>`
      + `<button class="dmerge" id="wbMerge" type="button" data-act="merge"${disabled ? " disabled" : ""}>合并 PR</button>`
      + `<div class="dhint">${esc(options.baseRef)} ← ${esc(options.headRef)} · head ${esc(options.headSha.slice(0, 7))}</div>`
      + (warning ? `<div class="mergewarn">${esc(warning)}</div>` : "")
      + squashHint
      + `</div>`;
  }

  function tableShellHTML(opts) {
    return `<div class="table-shell${opts.csv ? " is-csv" : ""}" data-table>`
      + `<div class="tbar"><span class="tstat">${opts.stat || ""}</span><span class="tgrow"></span>${opts.tools || ""}</div>`
      + `<div class="tscroll" tabindex="0" role="region" aria-label="${opts.label || "表格"}，可横向滚动">${opts.table}</div>`
      + `<div class="tshadow l" aria-hidden="true"></div><div class="tshadow r" aria-hidden="true"></div>`
      + (opts.csv ? `<div class="colpanel" hidden></div>` : "")
      + `</div>`;
  }

  /* 阅读视图：Head 数据表，被删记录按锚点插回原位，被改记录上方保留旧记录。 */

  const csvToolsHTML = (opts) => ((opts && opts.noRows) ? ""
    : `<button class="tbtn" type="button" data-tbl="only" aria-pressed="false">仅看变化行</button>`)
    + `<button class="tbtn" type="button" data-tbl="cols" aria-expanded="false">列</button>`
    + `<button class="tbtn" type="button" data-tbl="density" aria-pressed="false">紧凑</button>`
    + `<button class="tbtn" type="button" data-tbl="full" aria-pressed="false">全屏</button>`;

  function listBlockWithInsertions(block, changes, file) {
    const ranges = window.DiffModel.listItemRanges(block.raw, block.startLine);
    const byLine = new Map();
    const unplaced = [];
    for (const item of changes) {
      const anchor = item.afterNewLine;
      const candidates = ranges
        .filter((range) => range.startLine <= anchor && range.endLine >= anchor)
        .sort((a, b) => b.startLine - a.startLine);
      const target = candidates[0];
      if (!target) { unplaced.push(item); continue; }
      if (!byLine.has(target.startLine)) byLine.set(target.startLine, []);
      byLine.get(target.startLine).push(item);
    }
    const stack = [];
    const rendered = blockHtml(block, {});
    const html = rendered.replace(/<li\b([^>]*)>|<\/li>/g, (tag, attrs) => {
      if (tag.startsWith("</li")) {
        const itemLine = stack.pop();
        const inserts = byLine.get(itemLine) || [];
        if (inserts.length) byLine.delete(itemLine);
        return tag + inserts.map((item) => `<li class="list-deleted-item">${insertionHtml(item.change, file)}</li>`).join("");
      }
      const mapped = /\bdata-line="(\d+)"/.exec(attrs || "");
      stack.push(mapped ? Number(mapped[1]) : null);
      return tag;
    });
    // 行号映射被放弃（itemLines 与 <li> 数量不一致）或目标项未渲染时，
    // byLine 中的删除内容不会插入列表；补回 unplaced，避免阅读模式漏看删除。
    for (const items of byLine.values()) unplaced.push(...items);
    return { html, unplaced };
  }

  /* 新增文件的统一说明：整份都是新增，不逐块/逐行涂色，但要说清楚它是新增文件。 */

  function blockHtml(b, opts) {
    let cls = "md-block";
    if (!opts.plain) {
      if (b.changeState === "added") cls += " is-added";
      else if (b.changeState === "modified-new" || b.changeState === "partial") cls += " is-modified-new";
      else if (b.changeState === "removed") cls += " is-removed";
    }
    const file = curFile();
    // 旧文按文档排版渲染（不再当作代码），相对资源同样按提交解析
    const oldBlock = (b.pairedChanges || (b.pairedChange ? [b.pairedChange] : []))
      .map((pc) => `<div class="del-block md-old"><div class="del-head">原文（已替换）</div>`
        + `<div class="del-body">${oldDocHtml(pc.oldText, file)}</div></div>`)
      .join("");
    // 代码块：逐行 data-line
    let bodyHtml = resolveBlockUrls(b.html, file);
    if (b.type === "code" && b.startLine != null) {
      const info = fenceInfo(b);
      const src = fenceCode(b);
      if (/^mermaid$/i.test(info)) {
        /* 图不在这里渲染：先占位，正文写完后按需加载 mermaid */
        const changed = b.changeState === "modified-new" || b.changeState === "partial";
        bodyHtml = `<div class="mm-block" data-mermaid="1" data-src="${esc(src)}">`
          + `${changed ? '<span class="mm-badge">图表已变更</span>' : ""}`
          + `<div class="mm-host">渲染中…</div></div>`;
      } else {
        const lang = langOf(info);
        let highlighted = esc(src);
        if (lang) {
          try { highlighted = window.hljs.highlight(src, { language: lang, ignoreIllegals: true }).value; } catch (e) { highlighted = esc(src); }
        }
        const lines = window.SemDiff ? window.SemDiff.splitHighlightedLines(highlighted) : highlighted.split("\n");
        /* 新增行按引擎的行级比较上色；删除行只出现在「原文」面板 */
        const adds = new Set();
        const map = semInlineFor(file);
        const entry = map && map.get(b.startLine);
        if (entry && entry.baseText != null && window.SemDiff) {
          try {
            for (const op of window.SemDiff.diffCodeLines(entry.baseText, src)) if (op.op === "add") adds.add(op.line);
          } catch (e) { /* 行级比较失败就不标，不影响正文 */ }
        }
        const wrapped = lines.map((ln, i) => {
          const on = adds.has(i + 1);
          return `<span class="code-line${on ? " is-add" : ""}" data-line="${b.startLine + i + 1}"${on ? ' data-gutter="+"' : ""}>${ln}</span>`;
        }).join("\n");
        bodyHtml = `<pre><code class="hljs${lang ? ` lang-${lang}` : ""}">${wrapped}</code></pre>`;
      }
    }
    // 表格：每个 <tr> 绑定源行（raw 第 0 行是表头，第 1 行是分隔行，渲染时被丢弃）
    if (b.type === "table" && b.startLine != null) {
      let rowIdx = -1;
      bodyHtml = bodyHtml.replace(/<tr\b([^>]*)>/g, (_m, attrs) => {
        rowIdx += 1;
        const rawIdx = rowIdx === 0 ? 0 : rowIdx + 1;
        return `<tr${attrs} data-line="${b.startLine + rawIdx}">`;
      });
    }
    // 列表：给每个 <li> 绑定源码行号（按 raw 顺序，跳过围栏内的假标记行；嵌套项也有行号）
    if ((b.type === "ul" || b.type === "ol") && b.raw) {
      const itemLines = window.DiffModel.listItemLines(b.raw, b.startLine);
      const liCount = (bodyHtml.match(/<li\b[^>]*>/g) || []).length;
      // 映射数量不一致时整体放弃行号映射，绝不把后续 <li> 错配到别的源码行。
      if (itemLines.length === liCount) {
        let liIdx = 0;
        bodyHtml = bodyHtml.replace(/<li\b([^>]*)>/g, (_match, attrs) => {
          const lineNum = itemLines[liIdx++];
          return lineNum == null ? `<li${attrs}>` : `<li${attrs} data-line="${lineNum}">`;
        });
      }
    }
    // 在块范围内找一个 hunk 覆盖的行作为评论锚点（从后往前找，优先命中改动行）
    const cl = modelFor(curFile())?.parsed?.commentableHeadLines;
    let anchorLine = null;
    if (cl) for (let l = (b.endLine ?? b.startLine); l >= b.startLine; l--) if (cl.has(l)) { anchorLine = l; break; }
    const anchor = anchorLine
      ? `<span class="line-anchor" data-line="${anchorLine}" data-side="RIGHT" role="button" title="在第 ${anchorLine} 行评论">L${anchorLine} +</span>`
      : "";
    /* 标题块：注入「#」，点击复制本段深链（与地址栏同一套 L 行号） */
    if (b.startLine != null && /^\s*<h[1-4][\s>]/.test(bodyHtml)) {
      bodyHtml = bodyHtml.replace(/^(\s*)<h([1-4])([^>]*)>/, (_m, pad, level, attrs) =>
        `${pad}<h${level}${attrs} data-line="${b.startLine}"><a class="hlink" href="#L${b.startLine}" data-hlink="${b.startLine}" title="复制本段链接" aria-label="复制第 ${b.startLine} 行所在标题的链接">#</a>`);
    }
    /* 行内记号：引擎给出的插入区间投影进 HTML，匹配失败则只留块级记号 */
    bodyHtml = applyInlineMarks(bodyHtml, b);
    /* 有评论的块：极浅底色 + 页边窄条，正文不出现数字；气泡悬停才出 */
    const threads = viewState() === "markup" ? threadsInBlock(file, b) : [];
    const drafts = viewState() === "markup" ? draftsInBlock(file, b) : [];
    let quiet = threads.length ? " has-comments" : "";
    if (drafts.length) quiet += " has-drafts";
    const stripe = threads.length ? `<span class="cstripe" aria-hidden="true"></span>` : "";
    // 草稿用页边虚线：读者一眼能分出「已发出的评论」和「我还压在本地没发」
    const dstripe = drafts.length ? `<span class="dstripe" aria-hidden="true" title="未发送的草稿"></span>` : "";
    const bubble = threads.length || drafts.length ? commentBubbleHTML(threads, b, drafts) : "";
    /* 改动块给一个「已阅」开关：点一下整块退成普通正文，计数随之更新 */
    const changedBlock = /is-(added|modified-new|removed)/.test(cls);
    const done = changedBlock && viewState() === "markup" && isReviewed(file, b.startLine, b.changeState === "removed" ? "base" : "head");
    if (done) cls += " is-reviewed";
    const rvBtn = changedBlock && viewState() === "markup"
      ? `<button type="button" class="rv-toggle${done ? " on" : ""}" data-review="${b.startLine}" data-review-side="${b.changeState === "removed" ? "base" : "head"}" aria-pressed="${done}" title="${done ? "取消已阅" : "标为已阅"}">✓ 已阅</button>`
      : "";
    return `<div class="${cls}${quiet}" data-line="${b.startLine}" data-end-line="${b.endLine}" data-block="${b.startLine}">${stripe}${dstripe}${rvBtn}${oldBlock}${bodyHtml}${anchor}${bubble}</div>`;
  }

  /** 评论树的一条线程：根评论 + 缩进的回复，整块可点，点了滚到正文对应行。 */
  function treeItemHTML(t, jumpable) {
    const canJump = jumpable !== false && t.line != null;
    const one = (c, kind) => `<div class="titem ${kind}"${canJump ? ` data-jump-to="${t.line}"` : ""}>`
      + `<div class="tmeta"><b>${esc(c.author)}</b><span class="tln">L${t.line ?? (t.staleLine != null ? `${t.staleLine}（位置已变）` : "?")}</span></div>`
      + `<div class="ttext">${esc((c.body || "").replace(/\n+/g, " "))}</div>`
      + (c.url ? `<a class="tlink" href="${esc(c.url)}" target="_blank" rel="noopener">GitHub ↗</a>` : "")
      + `</div>`;
    return `<div class="tthread">${one(t.root, "root")}${t.replies.map((c) => one(c, "reply")).join("")}${threadReplyHTML(t, "tree")}</div>`;
  }

  /* 块 → 评论树条目：按块的行范围匹配，多行段落里第 2 行以后的评论也能对上 */
  function treeItemsForBlock(block) {
    if (!block) return [];
    const start = Number(block.dataset.line) || 0;
    const end = Number(block.dataset.endLine) || start;
    return [...document.querySelectorAll("#wbDrawerBody [data-jump-to]")].filter((el) => {
      const line = Number(el.dataset.jumpTo);
      return line >= start && line <= end;
    });
  }

  /** 回复一条行级评论：成功后本地补进列表，不整页刷新，保住滚动位置与输入焦点。 */
  async function sendReply(commentId, text, btn) {
    const body = String(text || "").trim();
    if (!body) { toast("回复内容不能为空"); return; }
    const label = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "发送中…"; }
    try {
      const res = await fetchJSON(`/api/approvals/${D.n}/comments/${commentId}/replies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `回复失败（${res.status}）`);
      const target = (D.all.comments || []).find((c) => c.id === commentId);
      if (target) {
        D.all.comments.push({
          id: data.reply?.id ?? `local-${Date.now()}`,
          path: target.path,
          line: target.line,
          originalLine: target.originalLine,
          body,
          author: "我",
          url: data.reply?.url || null,
          inReplyTo: commentId,
          commitId: target.commitId ?? null,
          originalCommitId: target.originalCommitId ?? null,
        });
        rebuildComments();
        /* 重绘会重建正文里的回复框：先存下未发送的内容与焦点位置，发出去的那条清空 */
        const box = btn ? btn.parentElement.querySelector(".trta") : null;
        if (box) box.value = "";
        /* 气泡与评论树对同一线程各有一个回复框：草稿按「位置 + 线程」分别存取，互不覆盖 */
        const keyOf = (el) => (el && el.dataset ? (el.dataset.draftKey || el.dataset.replyTo) : null);
        const active = typeof document.activeElement === "object" ? document.activeElement : null;
        const focusKey = keyOf(active) || keyOf(btn);
        const kept = new Map([...document.querySelectorAll("#wbDoc .trta, #wbDrawerBody .trta")]
          .filter((el) => el.value && el.value.trim())
          .map((el) => [keyOf(el), el.value]));
        /* 已经展开（或正在写）的面板重绘后仍保持展开，否则用户会被合上 */
        const opened = new Set([...document.querySelectorAll("[data-composer]")]
          .filter((el) => !el.hidden)
          .map((el) => el.dataset.composer));
        render();
        document.querySelectorAll("#wbDoc .trta, #wbDrawerBody .trta").forEach((el) => {
          const v = kept.get(keyOf(el));
          if (v) el.value = v;
        });
        document.querySelectorAll("[data-composer]").forEach((box) => {
          const key = box.dataset.composer;
          if (!opened.has(key)) return;
          box.hidden = false;
          const act = document.querySelector(`[data-act="reply-toggle"][data-draft-key="${key}"]`);
          if (act) { act.setAttribute("aria-expanded", "true"); act.textContent = "取消回复"; }
        });
        if (focusKey) {
          const back = [...document.querySelectorAll("#wbDoc .trta, #wbDrawerBody .trta")]
            .find((el) => keyOf(el) === focusKey);
          if (back && typeof back.focus === "function") {
            back.focus();
            if (typeof back.setSelectionRange === "function") {
              back.setSelectionRange(back.value.length, back.value.length);
            }
          }
        }
      }
      toast("回复已提交");
    } catch (error) {
      toast(String(error.message || error));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label || "回复"; }
    }
  }

  function drawerHTML() {
    const parts = [];
    // existing comments for current file
    const file = curFile();
    const threads = file ? commentThreads(file) : [];
    /* 已删除文件渲染的是 base 正文，行号锚点不在当前文档里，评论条目不做跳转 */
    const jumpable = Boolean(file && file.status !== "removed");
    if (threads.length) {
      const replies = threads.reduce((n, t) => n + t.replies.length, 0);
      parts.push(`<div class="ctree-head">${isCommitView() ? "本提交的评论" : "评论树"} · ${threads.length} 线程${replies ? ` / ${replies} 回复` : ""}</div>`);
      parts.push(`<div class="ctree">${threads.map((t) => treeItemHTML(t, jumpable)).join("")}</div>`);
    } else if (file && D.commentsByPath) {
      parts.push(`<div class="ctree-head">评论树 · 此文件暂无评论</div>`);
    }
    if (isCommitView()) {
      parts.push(`<div class="dhint readonly-hint">历史提交为只读视图；切回「全部改动」后可继续评论、审批与合并。</div>`);
      return parts.join("");
    }
    // active composer
    if (D.active) {
      const a = D.active;
      parts.push(`<div class="composer"><div class="canchor">${esc(a.path.split("/").pop())} · ${lineSpan(a.start, a.end)}${a.unanchored ? " · 文字评论" : " · side=RIGHT"}</div>`
        + (a.unanchored ? `<div class="cm-hint">该范围不在本次 Diff 的改动行内，无法挂行级评论：将以整条评论提交，正文自动附上 <code>${esc(a.path)}</code> ${lineSpan(a.start, a.end)}。</div>` : "")
        + (a.quote ? `<blockquote class="cm-quote">${esc(a.quote)}</blockquote>` : "")
        + `<textarea id="wbcText" data-key="${esc(a.path + ":" + a.start + ":" + a.end)}" placeholder="写下判断依据或要求补充的内容。">${esc(a.body || "")}</textarea>`
        + `<div class="crow"><button class="btn" type="button" data-act="save">存为草稿</button><button class="btn ghost" type="button" data-act="cancel">取消</button></div></div>`);
    }
    // drafts
    if (D.drafts.length) {
      parts.push(`<div style="font-size:var(--fs-meta);color:var(--muted);margin:10px 0 4px;">本地草稿（${D.drafts.length}）</div>`);
      parts.push(D.drafts.map((d, idx) => {
        const outdated = !d.headSha || d.headSha !== D.meta?.headSha;
        return `<div class="ddraft"><div class="dloc">${esc(d.path.split("/").pop())} · ${lineSpan(d.start, d.end)}${d.unanchored ? ` <span class="dflag">文字评论</span>` : ""}${outdated ? " · 版本已变化" : ""}</div>`
          + (d.quote ? `<div class="dquote">${esc(d.quote.split("\n").join(" ").slice(0, 120))}</div>` : "")
          + `<div class="dbody2">${esc((d.body || "").split("\n").filter(Boolean)[0] || "")}</div>`
          + `<button type="button" class="dop" data-del="${idx}">删除</button></div>`;
      }).join(""));
    } else {
      parts.push(`<div class="dempty">还没有草稿。悬停段落点行号「+」，或选中文字后点「评论所选」。</div>`);
    }
    // review options
    if (!D.meta?.merged) {
      parts.push(`<div class="devopt">`
        + `<label class="devlab"><input type="radio" name="wbrev" value="APPROVE" data-ev="APPROVE"${D.event === "APPROVE" ? " checked" : ""}>批准</label>`
        + `<label class="devlab"><input type="radio" name="wbrev" value="COMMENT" data-ev="COMMENT"${D.event === "COMMENT" ? " checked" : ""}>仅评论</label>`
        + `<label class="devlab"><input type="radio" name="wbrev" value="REQUEST_CHANGES" data-ev="REQUEST_CHANGES"${D.event === "REQUEST_CHANGES" ? " checked" : ""}>请求修改</label>`
        + `</div>`);
      const canSubmit = D.event === "APPROVE"
        ? !draftsOutdated()
        : D.drafts.length > 0 && !draftsOutdated();
      const btnText = D.event === "APPROVE"
        ? (D.drafts.length ? `批准并附 ${D.drafts.length} 条意见` : "提交批准")
        : `提交 ${D.drafts.length} 条意见到 GitHub`;
      parts.push(`<button class="dsubmit" id="wbSubmit" type="button" ${canSubmit ? "" : "disabled"}>${btnText}</button>`);
      const hint = draftsOutdated() ? "PR 已有新提交：旧草稿行号可能失效，请删除后重新定位。"
        : D.event === "APPROVE" ? "批准将以你的名义在 GitHub 提交 Approve Review。"
        : "评论使用你本人令牌写入，页面不保存副本。";
      parts.push(`<div class="dhint">${hint}</div>`);
    } else {
      parts.push(`<div class="dhint">PR 已合并，GitHub 不允许再新增评论，此页只读。</div>`);
    }
    parts.push(mergeBoxHTML());
    const changeList = D.ref == null ? changeListHTML(curFile()) : "";
    if (changeList) parts.push(changeList);
    return parts.join("");
  }

  /* ---------- P3: 变更导航 ---------- */
  function changeElements() {
    const doc = document.getElementById("wbDoc");
    let els = doc.querySelectorAll(".line-anchor");
    if (!els.length) els = doc.querySelectorAll(".dline.add, .dline.del");
    if (!els.length) els = doc.querySelectorAll(".sb-head .is-added, .sb-head .is-modified-new, .sb-base .is-removed, .sb-base .is-partial");
    return Array.from(els);
  }
  /** 切换阅读/对照视图：只替换 URL，不新增历史 */
  function setMode(mode) {
    const next = MODES.includes(mode) ? mode : "reading";
    if (next === D.mode) return;
    D.mode = next;
    D.pendingAnchor = null;
    render();
  }

  function gotoChange(dir) {
    const els = changeElements();
    if (!els.length) return;
    if (D.navIdx < 0) D.navIdx = dir > 0 ? -1 : els.length;
    D.navIdx = (D.navIdx + dir + els.length) % els.length;
    const target = els[D.navIdx];
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.style.outline = "2px solid var(--text)";
    setTimeout(() => { target.style.outline = ""; }, 1500);
    document.getElementById("navCount").textContent = `${D.navIdx + 1}/${els.length}`;
  }
  function updateNavFloat() {
    const el = document.getElementById("navFloat");
    if (!el) return;
    const wb = document.getElementById("workbench");
    el.hidden = wb.hidden || !D.file || !!D.ref;
    if (!el.hidden) {
      const n = changeElements().length;
      document.getElementById("navCount").textContent = D.navIdx >= 0 ? `${D.navIdx + 1}/${n}` : `0/${n}`;
    }
  }

  /* ---------- 表格状态：列隐藏 / 固定列 / 仅看变化行 / 紧凑 / 全屏 ---------- */
  const CHANGED_ROW = /(^|\s)is-(added|modified|partial|removed)(\s|$)/;
  const tableStateKey = (path) => `wb.table.${path}`;

  function tableStateOf() {
    const key = (D.ref ? D.ref.path : D.file) || "_";
    if (!D.tstate[key]) {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(tableStateKey(key)) || "{}") || {}; } catch { saved = {}; }
      D.tstate[key] = {
        hidden: Array.isArray(saved.hidden) ? saved.hidden.filter((n) => Number.isInteger(n)) : [],
        pinned: Number.isInteger(saved.pinned) ? saved.pinned : null,
        only: !!saved.only,
        density: saved.density === "compact" ? "compact" : "loose",
      };
    }
    return D.tstate[key];
  }

  function saveTableState() {
    const path = D.ref ? D.ref.path : D.file;
    if (!path) return;
    const st = tableStateOf();
    try {
      localStorage.setItem(tableStateKey(path), JSON.stringify({
        hidden: st.hidden, pinned: st.pinned, only: st.only, density: st.density,
      }));
    } catch { /* ignore */ }
  }

  function syncTableScroll(scroller) {
    if (!scroller || !scroller.closest) return;
    const shell = scroller.closest(".table-shell");
    if (!shell) return;
    const max = scroller.scrollWidth - scroller.clientWidth;
    shell.classList.toggle("has-overflow", max > 4);
    shell.classList.toggle("at-start", scroller.scrollLeft <= 1);
    shell.classList.toggle("at-end", scroller.scrollLeft >= max - 1);
  }

  function toggleTableFull(shell, force) {
    const on = force === undefined ? !shell.classList.contains("is-full") : force;
    document.querySelectorAll(".table-shell.is-full").forEach((other) => {
      if (other !== shell) other.classList.remove("is-full");
    });
    shell.classList.toggle("is-full", on);
    document.body.classList.toggle("tbl-full-on", !!document.querySelector(".table-shell.is-full"));
    shell.querySelectorAll('[data-tbl="full"]').forEach((btn) => {
      btn.setAttribute("aria-pressed", String(on));
      btn.textContent = on ? "退出全屏" : "全屏";
    });
    if (on) {
      const scroller = shell.querySelector(".tscroll");
      if (scroller) requestAnimationFrame(() => syncTableScroll(scroller));
    }
  }

  /** 表格外壳与状态：Markdown 表格补外壳，CSV 表格还原列/行/密度设置。 */
  function decorateTables(root) {
    root.querySelectorAll("table").forEach((table) => {
      if (table.closest(".table-shell")) return;
      const rows = table.querySelectorAll("tr").length;
      const firstRow = table.querySelector("tr");
      const cols = firstRow ? firstRow.children.length : 0;
      const shell = document.createElement("div");
      shell.className = "table-shell";
      shell.setAttribute("data-table", "");
      shell.innerHTML = `<div class="tbar"><span class="tstat">${rows} 行 × ${cols} 列</span>`
        + `<span class="tgrow"></span><button class="tbtn" type="button" data-tbl="full" aria-pressed="false">全屏</button></div>`
        + `<div class="tscroll" tabindex="0" role="region" aria-label="表格，可横向滚动"></div>`
        + `<div class="tshadow l" aria-hidden="true"></div><div class="tshadow r" aria-hidden="true"></div>`;
      table.parentNode.insertBefore(shell, table);
      shell.querySelector(".tscroll").appendChild(table);
    });

    root.querySelectorAll(".table-shell").forEach((shell) => {
      if (!shell.querySelector(".tbar")) {
        const table = shell.querySelector("table");
        const rows = table ? table.querySelectorAll("tr").length : 0;
        const firstRow = table ? table.querySelector("tr") : null;
        const cols = firstRow ? firstRow.children.length : 0;
        shell.insertAdjacentHTML("afterbegin",
          `<div class="tbar"><span class="tstat">${rows} 行 × ${cols} 列</span>`
          + `<span class="tgrow"></span><button class="tbtn" type="button" data-tbl="full" aria-pressed="false">全屏</button></div>`);
        if (!shell.querySelector(".tshadow")) {
          shell.insertAdjacentHTML("beforeend",
            `<div class="tshadow l" aria-hidden="true"></div><div class="tshadow r" aria-hidden="true"></div>`);
        }
      }

      const table = shell.querySelector("table");
      if (!table) return;
      const st = tableStateOf();
      shell.classList.toggle("is-compact", st.density === "compact");
      table.querySelectorAll("[data-col]").forEach((cell) => {
        const col = cell.dataset.col;
        if (col === "ln") return;
        const index = Number(col);
        cell.hidden = st.hidden.includes(index);
        cell.classList.toggle("is-pinned", st.pinned === index);
      });
      /* 新增文件整份都是新增，没有可比对的变化行：不看持久化的行过滤状态 */
      const wholeFileNew = curFile()?.status === "added";
      table.querySelectorAll("tbody tr").forEach((row) => {
        row.hidden = !wholeFileNew && st.only && !CHANGED_ROW.test(row.className);
      });
      table.querySelectorAll("tbody td[data-col]").forEach((cell) => {
        if (cell.dataset.col === "ln") return;
        cell.classList.toggle("is-clip", (cell.textContent || "").length > 80);
      });

      shell.querySelectorAll('[data-tbl="only"]').forEach((btn) => btn.setAttribute("aria-pressed", String(st.only)));
      shell.querySelectorAll('[data-tbl="density"]').forEach((btn) => btn.setAttribute("aria-pressed", String(st.density === "compact")));

      if (table.classList.contains("csv-table")) {
        const labels = [];
        table.querySelectorAll("thead [data-col]").forEach((cell) => {
          if (cell.dataset.col === "ln") return;
          labels.push({ index: Number(cell.dataset.col), label: cell.textContent.trim() || `列 ${Number(cell.dataset.col) + 1}` });
        });
        const panel = shell.querySelector(".colpanel");
        if (panel) {
          panel.innerHTML = `<div class="colpanel-head">显示列 <span class="colpanel-count">${labels.length - st.hidden.length}/${labels.length}</span></div>`
            + labels.map(({ index, label }) => `<div class="colpanel-item">`
              + `<label><input type="checkbox" data-col-toggle="${index}"${st.hidden.includes(index) ? "" : " checked"}>`
              + `<span>${esc(label)}</span></label>`
              + `<button type="button" class="colpanel-pin${st.pinned === index ? " is-on" : ""}" data-col-pin="${index}" title="固定这一列">⌐</button>`
              + `</div>`).join("")
            + `<div class="colpanel-foot"><button type="button" class="tbtn" data-col-reset="1">全部显示</button></div>`;
        }
        shell.querySelectorAll('[data-tbl="cols"]').forEach((btn) => {
          btn.textContent = `列 ${labels.length - st.hidden.length}/${labels.length}`;
        });
      }

      const scroller = shell.querySelector(".tscroll");
      const lineCell = table.querySelector("thead .csv-ln");
      if (scroller && lineCell) {
        shell.style.setProperty("--ln-w", `${lineCell.getBoundingClientRect().width}px`);
      }
      if (scroller) requestAnimationFrame(() => syncTableScroll(scroller));
    });
  }

  function closeCellPopover() {
    const pop = document.getElementById("tblCellPop");
    if (pop) pop.remove();
  }

  function showCellPopover(cell) {
    closeCellPopover();
    const pop = document.createElement("div");
    pop.id = "tblCellPop";
    pop.className = "cellpop";
    pop.innerHTML = `<div class="cellpop-body">${esc(cell.textContent)}</div>`
      + `<div class="cellpop-row"><button class="tbtn" type="button" data-pop="copy">复制</button>`
      + `<button class="tbtn" type="button" data-pop="close">关闭</button></div>`;
    document.body.appendChild(pop);
    const rect = cell.getBoundingClientRect();
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 12));
    const top = Math.min(rect.bottom + 6, window.innerHeight - pop.offsetHeight - 12);
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(12, top)}px`;
  }

  /* ---------- 引用文档：文档里指向 PR 之外文件的链接 ---------- */
  const encPath = (path) => String(path).split("/").map(encodeURIComponent).join("/");
  const refTextCache = new Map();

  /** 一次标题与锚点的软跳转：先按 id 找，再按标题 slug 找回退。 */
  function scrollToAnchor(anchor) {
    if (!anchor) return false;
    const doc = document.getElementById("wbDoc");
    const byId = doc.querySelector(`[id="${String(anchor).replace(/"/g, '\\"')}"]`);
    if (byId) {
      byId.scrollIntoView({ block: "start", behavior: "smooth" });
      return true;
    }
    const slug = String(anchor).toLowerCase();
    for (const head of doc.querySelectorAll(".md-block[data-line] h1, .md-block h1, .md-block h2, .md-block h3, .md-block h4")) {
      if (window.DiffModel.slugify(head.textContent) === slug) {
        head.scrollIntoView({ block: "start", behavior: "smooth" });
        return true;
      }
    }
    return false;
  }

  async function openRefDoc(path, anchor, options) {
    const opts = options || {};
    const docEl = document.getElementById("wbDoc");
    if (!D.ref) {
      D.ref = { stack: [], path: "", anchor: "", ref: "", text: "", loading: false, error: "", candidates: [], token: 0 };
    } else if (!opts.fromBack && D.ref.path
      && (D.ref.path !== path || (D.ref.ref || "") !== (opts.ref || D.meta?.headSha || ""))) {
      D.ref.stack.push({ path: D.ref.path, anchor: D.ref.anchor, ref: D.ref.ref || "", scroll: docEl.scrollTop });
    }
    D.ref.path = path;
    D.ref.anchor = anchor || "";
    D.ref.error = "";
    D.ref.candidates = [];
    D.ref.token += 1;
    /* 请求按 token 认领：解析后的路径可能与请求的不同（后缀匹配），不能用字符串比对。 */
    const token = D.ref.token;
    D.active = null;
    D.navIdx = -1;

    const wantedRef = opts.ref || D.meta?.headSha || "";
    D.ref.ref = wantedRef;
    const cached = refTextCache.get(`${path}@${wantedRef}`);
    if (cached !== undefined) {
      D.ref.text = cached;
      D.ref.loading = false;
      render();
      if (D.ref.anchor) scrollToAnchor(D.ref.anchor);
      return;
    }

    D.ref.text = "";
    D.ref.loading = true;
    render();
    const myGen = D.generation;
    const ref = wantedRef;
    const current = () => D.generation === myGen && D.ref && D.ref.token === token;
    try {
      const response = await fetchJSON(
        `/api/doc?pr=${D.n}&path=${encodeURIComponent(path)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`,
      );
      const payload = await response.json().catch(() => ({}));
      if (!current()) return;
      if (!response.ok) {
        D.ref.error = payload.message || `打不开该文档（${response.status}）`;
        D.ref.candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
      } else {
        D.ref.text = payload.text || "";
        D.ref.path = payload.path || path;
        refTextCache.set(`${D.ref.path}@${D.ref.ref || ""}`, D.ref.text);
        if (payload.requested && payload.requested !== payload.path) {
          toast(`已按后缀匹配到 ${payload.path.split("/").slice(-2).join("/")}`);
        }
      }
    } catch (err) {
      if (!current()) return;
      D.ref.error = err.name === "AbortError" ? "加载引用文档超时" : String(err);
    }
    if (!current()) return;
    D.ref.loading = false;
    render();
    if (D.ref.anchor) scrollToAnchor(D.ref.anchor);
  }

  function closeRefDoc() {
    if (!D.ref) return;
    const previous = D.ref.stack.pop();
    if (!previous) {
      D.ref = null;
      render();
      return;
    }
    openRefDoc(previous.path, previous.anchor, { fromBack: true, ref: previous.ref });
    requestAnimationFrame(() => {
      const docEl = document.getElementById("wbDoc");
      if (docEl) docEl.scrollTop = previous.scroll || 0;
    });
  }

  function refCsvHTML(text) {
    const parsed = window.DiffModel.csvParse(text);
    if (!parsed.rows.length) return `<div class="dempty">（空 CSV 文件）</div>`;
    /* 引用文档只读：没有差异可比，去掉「仅看变化行」 */
    const tools = `<button class="tbtn" type="button" data-tbl="cols" aria-expanded="false">列</button>`
      + `<button class="tbtn" type="button" data-tbl="density" aria-pressed="false">紧凑</button>`
      + `<button class="tbtn" type="button" data-tbl="full" aria-pressed="false">全屏</button>`;
    return tableShellHTML({
      csv: true,
      stat: `${parsed.rows.length} 行 · ${parsed.columns} 列 · 首行为表头`,
      tools,
      table: csvSimpleTable(parsed.rows, parsed.columns, { stateOf: () => "normal" }),
      label: "引用 CSV 数据表",
    });
  }

  function refDocHTML() {
    const ref = D.ref;
    const backLabel = ref.stack.length
      ? "← 返回上一篇"
      : D.file ? `← 返回 ${D.file.split("/").pop()}` : "← 返回";
    const openRef = ref.ref || D.meta?.headSha || "";
    const openHref = `/doc/${encPath(ref.path)}${openRef ? `?ref=${encodeURIComponent(openRef)}` : ""}`;
    const bar = `<div class="refdoc-bar">`
      + `<button class="btn ghost refdoc-back" type="button" data-ref="back">${esc(backLabel)}</button>`
      + `<span class="refdoc-path" title="${esc(ref.path)}">${esc(ref.path)}</span>`
      + `<span class="refdoc-tag">引用文档 · 只读</span>`
      + (ref.loading ? "" : `<a class="refdoc-open" href="${esc(openHref)}" target="_blank" rel="noopener">新页签打开 ↗</a>`)
      + `</div>`;
    if (ref.loading) return bar + `<div class="dempty">正在加载引用文档…</div>`;
    if (ref.error) {
      const cands = ref.candidates.length
        ? `<div class="refdoc-cands"><div class="refdoc-candhead">可能是：</div>`
          + ref.candidates.map((c) => `<button type="button" class="refdoc-cand" data-ref-open="${esc(c)}">${esc(c)}</button>`).join("")
          + `</div>`
        : "";
      return bar + `<div class="error-box">${esc(ref.error)}<br><span class="refdoc-hint">${esc(ref.path)}</span></div>` + cands;
    }
    const body = isCsv(ref.path) ? refCsvHTML(ref.text) : window.DiffModel.renderMarkdown(ref.text, { demote: true });
    /* 相对链接按「文档自己所在路径 + 正文实际来自的提交」解析：两者必须同源，否则图片会去别的版本取 */
    const linked = resolveBlockUrls(body, { path: ref.path }, ref.ref || D.meta?.headSha || refOf());
    return bar + `<article class="md-block refdoc">${linked}</article>`;
  }

  function renderRefChapters() {
    const box = document.getElementById("wbChapters");
    if (!box) return;
    if (D.ref.loading) { box.innerHTML = `<div class="dempty">加载中…</div>`; return; }
    if (D.ref.error || !D.ref.text) { box.innerHTML = `<div class="dempty">—</div>`; return; }
    if (isCsv(D.ref.path)) {
      const parsed = window.DiffModel.csvParse(D.ref.text);
      box.innerHTML = `<div class="chapter-stat">引用 CSV · ${parsed.rows.length} 行 × ${parsed.columns} 列</div>`
        + `<div class="dempty">只读文档不做逐行导航</div>`;
      return;
    }
    const heads = window.DiffModel.mdBlocks(D.ref.text).filter((b) => /^h[1-4]$/.test(b.type));
    if (!heads.length) { box.innerHTML = `<div class="dempty">本文档没有标题</div>`; return; }
    box.innerHTML = heads.map((b) => {
      const lvl = Number(b.type[1]);
      return `<div class="chapter l${lvl}" data-ref-anchor="${esc(window.DiffModel.slugify(b.title || ""))}">`
        + `${esc(b.title || "(无标题)")}</div>`;
    }).join("");
  }

  /** /doc/<已编码路径>?ref=..#锚点 → 仓库路径与锚点；不是工作台内部链接则返回 null。 */
  function docLinkTarget(href) {
    const hit = /^\/doc\/([^?#]*)(?:\?[^#]*)?(?:#(.*))?$/.exec(String(href || ""));
    if (!hit) return null;
    const decode = (seg) => { try { return decodeURIComponent(seg); } catch { return seg; } };
    const query = /\?([^#]*)/.exec(String(href || ""));
    const refHit = query ? /(?:^|&)ref=([^&]*)/.exec(query[1]) : null;
    return {
      path: hit[1].split("/").map(decode).join("/"),
      anchor: hit[2] ? decode(hit[2]) : "",
      ref: refHit && refHit[1] ? decode(refHit[1]) : "",
    };
  }

  /** 拦截文档内链接：PR 文件就地切换，仓库其他文件用引用视图，外链照旧。 */
  function handleDocLink(event, link) {
    /* 明确要新页签的（外链、「新页签打开」）一律交给浏览器 */
    if (link.getAttribute("target") === "_blank") return false;
    /* Ctrl/Cmd/Shift/Alt + 点击 = 新页签、新窗口、下载：保持浏览器默认行为 */
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
    /* 正文内链已被改写成 /doc/...：先还原成仓库路径，再按原流程就地处理，不能整页跳出工作台 */
    const direct = docLinkTarget(link.getAttribute("href"));
    if (direct) {
      event.preventDefault();
      /* 链接指向别的提交（如「原文」块里的 base 链接）时，按那个提交打开引用视图；
         head 与当前视图提交都算「同一次审阅」，仍按 PR 文件就地切换 */
      const viewRefs = [refOf(), D.meta?.headSha].filter(Boolean);
      if (direct.ref && !viewRefs.includes(direct.ref)) {
        openRefDoc(direct.path, direct.anchor, { ref: direct.ref });
        return true;
      }
      if (D.files.some((f) => f.path === direct.path)) {
        D.ref = null;
        Promise.resolve(selectFile(direct.path)).then(() => {
          if (direct.anchor) scrollToAnchor(direct.anchor);
        });
      } else {
        /* 落回引用视图时带上链接的提交：否则提交视图里的内链会退回 PR head 版本 */
        openRefDoc(direct.path, direct.anchor, { ref: direct.ref || refOf() });
      }
      return true;
    }
    const orgRepo = /github\.com\/([^/]+)\/([^/]+)\//.exec(D.meta?.url || "");
    const resolved = window.DiffModel.resolveDocLink(link.getAttribute("href"), D.ref ? D.ref.path : D.file, {
      host: location.host,
      org: orgRepo ? orgRepo[1] : "",
      repo: orgRepo ? orgRepo[2] : "",
    });
    if (resolved.kind === "external") {
      link.target = "_blank";
      link.rel = "noopener";
      return false;
    }
    if (resolved.kind === "anchor") {
      event.preventDefault();
      scrollToAnchor(resolved.anchor);
      return true;
    }
    if (resolved.kind !== "repo") return false;

    event.preventDefault();
    if (!resolved.isDoc) {
      const href = `https://github.com/${orgRepo ? orgRepo[1] : ""}/${orgRepo ? orgRepo[2] : ""}`
        + `/blob/${encodeURIComponent(D.meta?.headSha || "")}/${encPath(resolved.path)}`;
      window.open(href, "_blank", "noopener");
      return true;
    }
    if (D.files.some((f) => f.path === resolved.path)) {
      D.ref = null;
      Promise.resolve(selectFile(resolved.path)).then(() => {
        if (resolved.anchor) scrollToAnchor(resolved.anchor);
      });
      return true;
    }
    openRefDoc(resolved.path, resolved.anchor);
    return true;
  }

  /* ---------- 主渲染 ---------- */
  function saveComposerText() {
    const ta = document.getElementById("wbcText");
    if (!ta || !D.active) return;
    const key = `${D.active.path}:${D.active.start}:${D.active.end}`;
    if (ta.dataset.key === key) D.active.body = ta.value;
  }
  function commitBarHTML() {
    if (!isCommitView()) return "";
    const detail = commitDetail();
    if (!detail) return `<div class="cb-empty">正在读取提交…</div>`;
    const parent = detail.parents[0] ? detail.parents[0].slice(0, 7) : "无";
    const headTag = detail.sha === D.meta.headSha
      ? `<span class="cb-badge ok">当前 head</span>`
      : `<span class="cb-badge warn">非最新 head</span>`;
    const mergeTag = detail.isMerge ? `<span class="cb-badge">合并提交</span>` : "";
    return `<div class="cb-main"><span class="cb-tag">历史提交</span>`
      + `<b class="cb-sha">${esc(detail.shortSha)}</b>`
      + `<span class="cb-headline">${esc(detail.headline)}</span>${headTag}${mergeTag}</div>`
      + `<div class="cb-meta">${esc(detail.authorName || detail.author)} · ${esc(fmt(detail.date))}`
      + ` · 父提交 ${esc(parent)} · ${detail.files.length}${detail.truncated ? "+" : ""} 个文件`
      + ` · +${detail.stats.additions}/−${detail.stats.deletions}</div>`
      + (detail.truncated
        ? `<div class="cb-warn">该提交改动过多，这里只列出前 ${detail.files.length} 个文件；完整改动请在 GitHub 查看。</div>`
        : "")
      + `<div class="cb-actions"><a href="${esc(detail.url)}" target="_blank" rel="noopener">在 GitHub 查看提交 ↗</a>`
      + `<button type="button" class="btn ghost" data-commit-all="1">回到全部改动</button></div>`;
  }

  function syncCommitPicker() {
    const wrap = document.getElementById("wbCommitPick");
    const sel = document.getElementById("wbCommitSelect");
    if (!wrap || !sel || !D.meta) return;
    const items = D.commits.items;
    const failed = Boolean(D.commits.error) && !items.length;
    const show = items.length > 0 || isCommitView() || D.commits.loading || failed;
    wrap.hidden = !show;
    if (!show) return;
    if (failed) {
      if (sel.dataset.sig !== "error") {
        sel.innerHTML = `<option>提交列表读取失败</option>`;
        sel.dataset.sig = "error";
        sel.disabled = true;
      }
      return;
    }
    if (D.commits.loading && !items.length) {
      if (sel.dataset.sig !== "loading") {
        sel.innerHTML = `<option>正在加载提交…</option>`;
        sel.dataset.sig = "loading";
        sel.disabled = true;
      }
      return;
    }
    const current = isCommitView() ? D.rev.sha : "";
    const opts = [`<option value="">全部改动 · ${esc(D.meta.baseSha.slice(0, 7))}…${esc(D.meta.headSha.slice(0, 7))}</option>`];
    for (const commit of items) {
      opts.push(`<option value="${esc(commit.sha)}">${esc(commit.shortSha)} · ${esc(commit.headline)}`
        + `${commit.sha === D.meta.headSha ? "（head）" : ""}</option>`);
    }
    if (isCommitView() && !items.some((commit) => commit.sha === current)) {
      opts.push(`<option value="${esc(current)}">${esc(current.slice(0, 7))}（不在提交列表）</option>`);
    }
    const html = opts.join("");
    if (sel.dataset.sig !== html) {
      sel.innerHTML = html;
      sel.dataset.sig = html;
    }
    sel.disabled = false;
    sel.value = current;
  }

  function render() {
    const meta = D.meta;
    if (!meta) return;
    saveComposerText();
    // 保存上一个视图的滚动位置（用旧 key）
    if (D.lastViewKey) {
      D.scrollPos[D.lastViewKey] = document.getElementById("wbDoc").scrollTop;
    }
    /* 屏幕标题：对象的名字；编号、作者、规模、head 落在副行 */
    const titleEl = document.getElementById("wbPrTitle");
    titleEl.textContent = meta.title;
    titleEl.title = meta.title;
    const detail = commitDetail();
    const bits = [`#${meta.number}`];
    if (detail) {
      bits.push(detail.shortSha, detail.authorName || detail.author);
      bits.push(`${detail.files.length}${detail.truncated ? "+" : ""} 个文件`, `+${detail.stats.additions}/−${detail.stats.deletions}`);
      if (detail.sha !== meta.headSha) bits.push("非最新 head");
    } else {
      if (meta.user) bits.push(meta.user);
      if (meta.updatedAt) bits.push(`更新 ${shortTime(meta.updatedAt)}`);
      bits.push(`${meta.changedFiles} 个文件`, `+${meta.additions}/−${meta.deletions}`, `head ${meta.headSha.slice(0, 7)}`);
    }
    if (D.stale) bits.push("缓存数据");
    document.getElementById("wbStats").textContent = bits.join(" · ");
    document.querySelectorAll(".wb-mode").forEach((b) => {
      const on = b.dataset.mode === D.mode;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    D.marks = viewState() === "markup";
    document.querySelectorAll("[data-view-state]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.viewState === viewState()));
    });
    const draftBadge = document.getElementById("wbDraftCount");
    if (draftBadge) {
      draftBadge.textContent = String(D.drafts.length);
      draftBadge.hidden = !D.drafts.length;
      draftBadge.title = `${D.drafts.length} 条未发送草稿`;
    }
    const seen = D.files.filter((f) => reviewInfo(f.path).reviewed).length;
    document.getElementById("wbProgress").textContent = isCommitView()
      ? (D.files.length ? `本提交 ${D.files.length} 个文件` : "")
      : (D.files.length ? `已审 ${seen}/${D.files.length}` : "");
    syncCommitPicker();
    const commitBar = document.getElementById("wbCommitBar");
    if (commitBar) {
      commitBar.hidden = !isCommitView();
      commitBar.innerHTML = isCommitView() ? commitBarHTML() : "";
    }

    /* 原始 PR 链接：顶栏露出一份，可点开也可复制 */
    const origUrl = D.meta.url || "";
    const origWrap = document.getElementById("wbOrigWrap");
    origWrap.hidden = !origUrl;
    if (origUrl) {
      const orig = document.getElementById("wbOrig");
      orig.href = origUrl;
      orig.title = origUrl;
      orig.textContent = "原始 PR ↗";
      orig.setAttribute("aria-label", `在 GitHub 打开 ${origUrl}`);
    }

    renderFiles();
    renderChapters();
    renderFilepath();

    const doc = document.getElementById("wbDoc");
    doc.classList.toggle("marks-off", !D.marks);
    const shell = document.getElementById("wbBody");
    if (shell) shell.classList.toggle("marks-off", !D.marks);
    doc.classList.toggle("readonly", isCommitView());
    doc.dataset.mode = D.mode;
    const file = curFile();
    doc.dataset.kind = D.ref ? "ref" : file && isCsv(file.path) ? "csv" : "";
    const content = document.getElementById("wbContent");
    if (D.ref) content.innerHTML = refDocHTML();
    else if (!file) {
      content.innerHTML = `<div class="dempty">${isCommitView() ? "该提交没有文件改动。" : "该 PR 没有变更文件。"}</div>`;
    }
    else content.innerHTML = readingHTML(file);

    decorateTables(content);
    if (window.__mmMount) window.__mmMount(content);

    const rvCount = document.getElementById("wbReviewCount");
    if (rvCount) {
      const st = file && viewState() === "markup" ? reviewStats(file) : { done: 0, total: 0 };
      rvCount.textContent = `已阅 ${st.done}/${st.total}`;
      rvCount.hidden = !st.total;
      rvCount.setAttribute("aria-label", `已阅 ${st.done} / ${st.total}，打开改动清单`);
    }
    const cmCount = document.getElementById("wbCommentCount");
    if (cmCount) cmCount.textContent = String(file ? commentThreads(file).length : 0);

    document.getElementById("wbDrawerBody").innerHTML = drawerHTML();
    syncDrawerHandle();
    // 恢复当前视图的滚动位置，记录本次 key
    const key = D.ref ? `ref:${D.ref.path}` : `${D.revKey}:${D.file}:${D.mode}`;
    D.lastViewKey = key;
    const saved = D.scrollPos[key];
    const docEl = document.getElementById("wbDoc");
    applyTheme();
    setDocumentTitle();
    D.lastRenderAt = Date.now();
    if (!D.pendingAnchor) syncUrl("replace", D.urlLine ? { line: D.urlLine } : null);
    requestAnimationFrame(() => {
      /* 深链优先于「上次滚动位置」：定位成功就不再恢复旧位置 */
      if (D.pendingAnchor) { applyAnchor(); return; }
      docEl.scrollTop = saved ?? 0;
    });
    updateNavFloat();
  }

  /* ---------- 选择文字反查行号 ---------- */
  /** 行号范围写法：L7 / L3–L7 */
  const lineSpan = (start, end) => (Number(end) > Number(start) ? `L${start}–L${end}` : `L${start}`);

  /** 提交到 GitHub 的正文：引用拼成 blockquote 放在正文前；文字评论再补位置行。 */
  function commentBody(draft) {
    const quoted = draft.quote
      ? `${String(draft.quote).split("\n").map((line) => `> ${line}`).join("\n")}\n\n`
      : "";
    if (!draft.unanchored) return quoted + draft.body;
    /* GitHub 只接受 diff 内的行，范围之外的行走整条评论：正文自带路径与行号范围 */
    return `${quoted}${draft.body}\n\n---\n位置：\`${draft.path}\` ${lineSpan(draft.start, draft.end)}（不在本次 Diff 范围内，按文字评论提交）`;
  }

  /** 引用原文：保留换行但截断到 6 行 / 400 字，避免把整段文档塞进评论。 */
  function clipQuote(raw) {
    const lines = String(raw || "").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 6);
    let out = lines.join("\n");
    if (out.length > 400) out = `${out.slice(0, 400)}…`;
    return out;
  }

  /** 列表项在源码里的行范围：<li data-line> 只给了起始行，结束行从块的 raw 反查。 */
  function listItemRange(li, block) {
    const start = Number(li.dataset.line);
    if (!Number.isInteger(start) || start <= 0) return null;
    const model = curFile() ? modelFor(curFile()) : null;
    const source = (model?.headBlocks || []).find((b) => b.startLine === Number(block.dataset.line));
    if (!source?.raw) return { start, end: start };
    const hit = window.DiffModel.listItemRanges(source.raw, source.startLine).find((r) => r.startLine === start);
    return { start, end: hit ? hit.endLine : start };
  }

  /* 比较用：去掉 Markdown 行内语法与空白，只留正文文字 */
  const normalizeText = (raw) => String(raw || "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~#>|]/g, "")
    .replace(/\s+/g, "");

  /** 多行块内按选中文字反查源码行：整行命中优先，否则用首尾片段匹配。 */
  function matchLinesInBlock(block, selected) {
    const start = Number(block.dataset.line);
    const model = curFile() ? modelFor(curFile()) : null;
    const source = (model?.headBlocks || []).find((b) => b.startLine === start);
    if (!source?.raw) return null;
    const rows = source.raw.split("\n").map((line, i) => ({ line: start + i, text: normalizeText(line) }))
      .filter((r) => r.text);
    const probe = normalizeText(selected);
    if (!probe || !rows.length) return null;
    const whole = rows.filter((r) => probe.includes(r.text));
    if (whole.length) return { start: whole[0].line, end: whole[whole.length - 1].line };
    const head = probe.slice(0, 20);
    const tail = probe.slice(-20);
    const part = rows.filter((r) => r.text.includes(head) || r.text.includes(tail)
      || head.includes(r.text) || tail.includes(r.text));
    if (!part.length) return null;
    return { start: part[0].line, end: part[part.length - 1].line };
  }

  function locateFromSelection(sel) {
    const elementOf = (n) => (n && n.nodeType === 1 ? n : n?.parentElement);
    const blockOf = (n) => {
      const el = elementOf(n);
      return el?.closest ? el.closest(".md-block[data-line][data-end-line]") : null;
    };
    const rangeOf = (n) => {
      const el = elementOf(n);
      if (!el?.closest) return null;
      const row = el.closest(".csv-row[data-line]");
      if (row) {
        const line = Number(row.dataset.commentLine || row.dataset.line);
        return Number.isInteger(line) && line > 0 ? { start: line, end: line } : null;
      }
      const codeLine = el.closest(".code-line[data-line]");
      if (codeLine) {
        const line = Number(codeLine.dataset.line);
        return Number.isInteger(line) && line > 0 ? { start: line, end: line } : null;
      }
      const tr = el.closest("tr[data-line]");
      if (tr) {
        const line = Number(tr.dataset.line);
        if (Number.isInteger(line) && line > 0) return { start: line, end: line };
      }
      const block = el.closest(".md-block[data-line][data-end-line]");
      if (!block) return null;
      const start = Number(block.dataset.line);
      const end = Number(block.dataset.endLine);
      if (!Number.isInteger(start) || start <= 0) return null;
      if (start === end) return { start, end };
      /* 多行块：先落到具体列表项（<li data-line> 由渲染阶段标注） */
      const li = el.closest("li[data-line]");
      return li ? listItemRange(li, block) : null;
    };
    const s = rangeOf(sel?.anchorNode);
    const e = rangeOf(sel?.focusNode);
    if (s && e) return { start: Math.min(s.start, e.start), end: Math.max(s.end, e.end) };

    /* 多行段落 / 引用 / 表格等：先按选中文字反查具体行，再退到整块范围 */
    const ba = blockOf(sel?.anchorNode);
    const bf = blockOf(sel?.focusNode);
    if (!ba || !bf) return null;
    if (ba === bf) {
      const matched = matchLinesInBlock(ba, sel.toString());
      if (matched) return matched;
    }
    const ra = { start: Number(ba.dataset.line), end: Number(ba.dataset.endLine) };
    const rb = { start: Number(bf.dataset.line), end: Number(bf.dataset.endLine) };
    return { start: Math.min(ra.start, rb.start), end: Math.max(ra.end, rb.end) };
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    const doc = document.getElementById("wbDoc");
    const body = document.body;

    doc.addEventListener("click", (e) => {
      const allBtn = e.target.closest("[data-commit-all]");
      if (allBtn) { selectAll(); return; }
      const retry = e.target.closest("[data-retry]");
      if (retry) { if (D.file) selectFile(D.file, true); return; }
      const replyToggle = e.target.closest('[data-act="reply-toggle"]');
      if (replyToggle) { toggleReply(replyToggle); return; }
      /* 气泡里的回复：就地提交，不离开正文 */
      const replyBtn = e.target.closest('[data-act="reply"]');
      if (replyBtn) {
        const id = Number(replyBtn.dataset.replyTo);
        const box = replyBtn.parentElement.querySelector(".trta");
        if (id) sendReply(id, box ? box.value : "", replyBtn);
        return;
      }
      const openTree = e.target.closest('[data-act="open-tree"]');
      if (openTree) {
        openDrawer();
        const jump = treeItemsForBlock(openTree.closest(".md-block"))[0];
        if (jump) jump.scrollIntoView({ block: "nearest" });
        return;
      }
      /* 标题「#」：把本段行号写进地址并复制整条深链 */
      const hlink = e.target.closest("a.hlink");
      if (hlink) {
        e.preventDefault();
        const line = Number(hlink.dataset.hlink);
        if (!D.n || !line) return;
        const state = { kind: "pr", n: D.n, file: D.file, mode: D.mode, line };
        const url = new URL(window.AppRoute.build(state), location.origin).toString();
        window.AppRoute.replace(state);
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(url).then(() => toast("已复制本段链接"), () => toast(url));
        } else toast(url);
        return;
      }
      const anchor = e.target.closest(".line-anchor, [data-plus]");
      if (anchor) {
        if (isCommitView()) { toast("历史提交为只读视图，不能新增行级评论"); return; }
        const line = Number(anchor.dataset.line);
        D.active = { path: D.file, start: line, end: line, quote: "" };
        render();
        body.classList.add("drawer-open");
        openDrawer();
        setTimeout(() => { const ta = document.getElementById("wbcText"); if (ta) ta.focus(); }, 50);
        return;
      }
      const refBack = e.target.closest("[data-ref]");
      if (refBack) { closeRefDoc(); return; }
      const refCandidate = e.target.closest("[data-ref-open]");
      if (refCandidate) { openRefDoc(refCandidate.dataset.refOpen, ""); return; }
      const link = e.target.closest("a[href]");
      if (link && handleDocLink(e, link)) return;
    });

    /* 表格工具栏：全屏 / 仅看变化行 / 列设置 / 密度 */
    const content = document.getElementById("wbContent");
    content.addEventListener("click", (e) => {
      const tool = e.target.closest("[data-tbl]");
      if (tool) {
        const shell = tool.closest(".table-shell");
        const st = tableStateOf();
        if (tool.dataset.tbl === "full") { toggleTableFull(shell); return; }
        if (tool.dataset.tbl === "only") { st.only = !st.only; saveTableState(); decorateTables(content); return; }
        if (tool.dataset.tbl === "density") {
          st.density = st.density === "compact" ? "loose" : "compact";
          saveTableState();
          decorateTables(content);
          return;
        }
        if (tool.dataset.tbl === "cols") {
          const panel = shell.querySelector(".colpanel");
          if (panel) {
            panel.hidden = !panel.hidden;
            tool.setAttribute("aria-expanded", String(!panel.hidden));
          }
          return;
        }
      }
      const colToggle = e.target.closest("[data-col-toggle]");
      if (colToggle) {
        const st = tableStateOf();
        const index = Number(colToggle.dataset.colToggle);
        st.hidden = colToggle.checked ? st.hidden.filter((n) => n !== index) : [...new Set([...st.hidden, index])];
        if (st.pinned === index && !colToggle.checked) st.pinned = null;
        saveTableState();
        decorateTables(content);
        return;
      }
      const colPin = e.target.closest("[data-col-pin]");
      if (colPin) {
        const st = tableStateOf();
        const index = Number(colPin.dataset.colPin);
        st.pinned = st.pinned === index ? null : index;
        if (st.pinned !== null) st.hidden = st.hidden.filter((n) => n !== st.pinned);
        saveTableState();
        decorateTables(content);
        return;
      }
      if (e.target.closest("[data-col-reset]")) {
        const st = tableStateOf();
        st.hidden = [];
        saveTableState();
        decorateTables(content);
        return;
      }
      const clip = e.target.closest("td.is-clip, th.is-clip");
      if (clip && !String(window.getSelection() || "")) {
        showCellPopover(clip);
        return;
      }
    });
    content.addEventListener("scroll", (e) => {
      const target = e.target;
      if (target && target.classList && target.classList.contains("tscroll")) syncTableScroll(target);
    }, true);
    /* #wbDoc 是正文的滚动容器，滚动事件不冒泡，只能直接挂在它身上 */
    const docScroll = document.getElementById("wbDoc");
    if (docScroll && typeof docScroll.addEventListener === "function") {
      docScroll.addEventListener("scroll", () => syncChapterSpy());
    }
    /* 图片按提交解析后仍可能 404：换成一则可点击的占位，不留破图标 */
    content.addEventListener("error", (e) => {
      const img = e.target;
      if (!img || img.tagName !== "IMG" || img.dataset.missing) return;
      if (typeof document.createElement !== "function") return;
      img.dataset.missing = "1";
      const src = img.getAttribute("src") || "";
      const name = decodeURIComponent(src.split("/").pop() || "图片");
      const miss = document.createElement("a");
      miss.className = "img-miss";
      miss.href = src;
      miss.target = "_blank";
      miss.rel = "noopener noreferrer";
      miss.textContent = `图片未能加载：${name}`;
      img.replaceWith(miss);
    }, true);
    document.addEventListener("click", (e) => {
      const rv = e.target.closest && e.target.closest("[data-review]");
      if (rv) {
        e.preventDefault();
        const line = Number(rv.dataset.review);
        const side = rv.dataset.reviewSide === "base" ? "base" : "head";
        const f = curFile();
        if (f && Number.isFinite(line)) {
          setReviewed(f, line, side, !isReviewed(f, line, side));
          render();
        }
        return;
      }
      if (!e.target.closest(".table-shell")) {
        document.querySelectorAll(".colpanel:not([hidden])").forEach((panel) => {
          panel.hidden = true;
          const btn = panel.closest(".table-shell")?.querySelector('[data-tbl="cols"]');
          if (btn) btn.setAttribute("aria-expanded", "false");
        });
      } else if (!e.target.closest(".colpanel") && !e.target.closest('[data-tbl="cols"]')) {
        document.querySelectorAll(".colpanel:not([hidden])").forEach((panel) => { panel.hidden = true; });
      }
      const pop = document.getElementById("tblCellPop");
      if (!pop) return;
      const inside = e.target.closest("#tblCellPop");
      if (inside) {
        const btn = e.target.closest("[data-pop]");
        if (btn && btn.dataset.pop === "copy") {
          const text = pop.querySelector(".cellpop-body")?.textContent || "";
          navigator.clipboard?.writeText(text).then(() => toast("已复制"), () => toast("复制失败"));
        }
        if (btn && btn.dataset.pop === "close") closeCellPopover();
        return;
      }
      if (!e.target.closest("td.is-clip, th.is-clip")) closeCellPopover();
    });

    // 章节跳转（绑在 wbNav 上，因为章节元素在导航栏内）
    document.getElementById("wbChapters").addEventListener("click", (e) => {
      const refChapter = e.target.closest("[data-ref-anchor]");
      if (refChapter) { scrollToAnchor(refChapter.dataset.refAnchor); return; }
      const chapter = e.target.closest("[data-chapter]");
      if (chapter) {
        const line = Number(chapter.dataset.chapter);
        const target = document.getElementById("wbDoc").querySelector(`[data-line="${line}"]`);
        if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    });

    /* brushing 的另一半：划过正文里的评论块，评论树对应条目也亮起来 */
    const clearTreeHighlight = () => {
      document.querySelectorAll("#wbDrawerBody .titem.chot").forEach((el) => el.classList.remove("chot"));
    };
    /* 图片加载、窗口缩放都会改变块高度：量完再摆一次刻度 */
    doc.addEventListener("mouseover", (e) => {
      clearTreeHighlight();
      const block = e.target.closest(".md-block.has-comments");
      if (!block) return;
      treeItemsForBlock(block).forEach((el) => el.classList.add("chot"));
    });
    doc.addEventListener("mouseleave", clearTreeHighlight);

    // drawer interactions (delegate on drawer body)
    const drawer = document.getElementById("wbDrawerBody");
    drawer.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]");
      if (act) {
        if (act.dataset.act === "merge") { mergePr(); return; }
        if (act.dataset.act === "merge-refresh") { loadMergeOptions(); return; }
        if (act.dataset.act === "reply-toggle") { toggleReply(act); return; }
        if (act.dataset.act === "reply") {
          const id = Number(act.dataset.replyTo);
          const box = act.parentElement.querySelector(".trta");
          if (id) sendReply(id, box ? box.value : "", act);
          return;
        }
        const ta = document.getElementById("wbcText");
        const text = ta ? ta.value.trim() : "";
        if (act.dataset.act === "cancel") { D.active = null; render(); return; }
        if (!text) { toast("先写点内容再存草稿"); return; }
        const a = D.active;
        D.drafts.push({
          id: newDraftId(), path: a.path, start: a.start, end: a.end,
          body: text, quote: a.quote || "", unanchored: !!a.unanchored, headSha: D.meta.headSha,
        });
        D.active = null;
        saveDrafts();
        render();
        toast("已存草稿");
        return;
      }
      const del = e.target.closest("[data-del]");
      if (del) { D.drafts.splice(Number(del.dataset.del), 1); saveDrafts(); render(); return; }
      const ev = e.target.closest("[data-ev]");
      if (ev) { D.event = ev.dataset.ev; render(); return; }
      const submit = e.target.closest("#wbSubmit");
      if (submit) submitDrafts();
      const jumpBase = e.target.closest("[data-jump-base]");
      if (jumpBase) { jumpToBaseLine(Number(jumpBase.dataset.jumpBase)); return; }
      const jump = e.target.closest("[data-jump-to]");
      if (jump) jumpToCommentLine(Number(jump.dataset.jumpTo));
    });
    /* brushing：悬停评论树的一条，正文对应块亮一下，反之亦然 */
    const brush = (on) => (e) => {
      const item = e.target.closest("[data-jump-to]");
      if (!item) return;
      const block = blockAtLine(Number(item.dataset.jumpTo));
      if (block) block.classList.toggle("cflash", on);
    };
    drawer.addEventListener("mouseover", brush(true));
    drawer.addEventListener("mouseout", brush(false));
    drawer.addEventListener("change", (e) => {
      if (e.target.id !== "wbMergeMethod") return;
      D.merge.method = e.target.value;
      writePref("wb.merge.method", D.merge.method);
      render();
    });

    // selection chip
    document.addEventListener("mouseup", (e) => {
      const wb = document.getElementById("workbench");
      if (wb.hidden) return;
      if (isCommitView()) { document.getElementById("dselchip").hidden = true; return; }
      if (e.target.closest("#dselchip") || e.target.closest(".composer") || !e.target.closest("#wbDoc")) return;
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (!text || text.length < 2) { document.getElementById("dselchip").hidden = true; return; }
      const rng = locateFromSelection(sel);
      if (!rng) {
        document.getElementById("dselchip").hidden = true;
        toast("无法精确定位所选内容，请改选单行、列表项或代码行。");
        return;
      }
      // 选区落到 hunk 之外：夹到块内可评论的行；一行都没有则降级为纯文字评论（行号写进正文）
      let unanchored = false;
      const cl = modelFor(curFile())?.parsed?.commentableHeadLines;
      if (cl && cl.size) {
        const hit = [];
        for (let line = rng.start; line <= rng.end; line += 1) if (cl.has(line)) hit.push(line);
        if (hit.length) {
          rng.start = hit[0];
          rng.end = hit[hit.length - 1];
        } else {
          unanchored = true;
        }
      }
      const chip = document.getElementById("dselchip");
      chip.dataset.start = String(rng.start);
      chip.dataset.end = String(rng.end);
      chip.dataset.quote = text;
      chip.dataset.unanchored = unanchored ? "1" : "";
      chip.style.left = Math.min(e.clientX + 8, window.innerWidth - 190) + "px";
      chip.style.top = (e.clientY + 10) + "px";
      chip.hidden = false;
      chip.textContent = (unanchored ? "文字评论 " : "评论所选 ") + lineSpan(rng.start, rng.end);
    });
    document.getElementById("dselchip").addEventListener("mousedown", (e) => e.preventDefault());

    // P3: 导航按钮
    document.getElementById("navPrev").addEventListener("click", () => gotoChange(-1));
    document.getElementById("navNext").addEventListener("click", () => gotoChange(1));

    // P3: 键盘快捷键（在工作台内且不在输入框时）
    document.addEventListener("keydown", (e) => {
      const wb = document.getElementById("workbench");
      if (wb.hidden) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Escape") {
        const full = document.querySelector(".table-shell.is-full");
        if (full) { toggleTableFull(full, false); return; }
        if (document.getElementById("tblCellPop")) { closeCellPopover(); return; }
        const panel = document.querySelector(".colpanel:not([hidden])");
        if (panel) { panel.hidden = true; return; }
        return;
      }
      if (e.key === "n") { e.preventDefault(); gotoChange(1); }
      else if (e.key === "p") { e.preventDefault(); gotoChange(-1); }
      else if (e.key === "1") { D.active = null; setMode("reading"); }
      else if (e.key === "2") { D.active = null; setMode("sidebyside"); }
      else if (e.key === "3") { D.active = null; setMode("unified"); }
      else if (e.key === "4") { D.active = null; setMode("split"); }
    });
    document.getElementById("dselchip").addEventListener("click", () => {
      const chip = document.getElementById("dselchip");
      D.active = {
        path: D.file,
        start: Number(chip.dataset.start),
        end: Number(chip.dataset.end),
        quote: clipQuote(chip.dataset.quote || ""),
        unanchored: chip.dataset.unanchored === "1",
      };
      chip.hidden = true;
      window.getSelection().removeAllRanges();
      render();
      openDrawer();
      setTimeout(() => { const ta = document.getElementById("wbcText"); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }, 50);
    });

    // chapter scroll-spy
    if (!D.chapterScrollBound) {
      D.chapterScrollBound = true;
      doc.addEventListener("scroll", () => {
        const blocks = doc.querySelectorAll(".md-block[data-line]");
        let activeLine = null;
        for (const b of blocks) {
          const rect = b.getBoundingClientRect();
          if (rect.top < 120) activeLine = Number(b.dataset.line);
          else break;
        }
        if (activeLine === null) return;
        document.querySelectorAll(".chapter").forEach((c) => c.classList.toggle("active", Number(c.dataset.chapter) === activeLine));
      }, { passive: true });
    }
  }

  /* ---------- 提交浏览 ---------- */
  function rebuildComments() {
    const all = D.all.comments || [];
    D.comments = isCommitView()
      ? all.filter((comment) => comment.originalCommitId === D.rev.sha || comment.commitId === D.rev.sha)
      : all.slice();
    D.commentsByPath = new Map();
    for (const comment of D.comments) {
      if (!D.commentsByPath.has(comment.path)) D.commentsByPath.set(comment.path, []);
      D.commentsByPath.get(comment.path).push(comment);
    }
  }

  async function ensureCommits(force = false) {
    const myGen = D.generation;
    if (D.commits.loaded && !force) return D.commits.items;
    if (D.commits.promise && !force) return D.commits.promise;
    D.commits.loading = true;
    const request = (async () => {
      try {
        const res = await fetchJSON(`/api/approvals/${D.n}/commits${force ? "?refresh=1" : ""}`);
        const data = await res.json().catch(() => ({}));
        if (D.generation !== myGen) return D.commits.items;
        if (!res.ok) throw new Error(data.message || `读取提交列表失败（${res.status}）`);
        D.commits.items = Array.isArray(data.items) ? data.items : [];
        D.commits.truncated = !!data.truncated;
        D.commits.loaded = true;
        D.commits.error = "";
        return D.commits.items;
      } catch (err) {
        if (D.generation !== myGen) return D.commits.items;
        D.commits.items = [];
        D.commits.error = String(err);
        return D.commits.items;
      } finally {
        if (D.generation === myGen) {
          D.commits.loading = false;
          D.commits.promise = null;
          /* 只刷新提交下拉：整页 render 会重建抽屉，把正在写的评论框焦点和光标弄丢 */
          if (D.rev.kind === "all") syncCommitPicker();
        }
      }
    })();
    D.commits.promise = request;
    return request;
  }

  async function ensureCommitDetail(sha, force = false) {
    const hit = D.commitDetails.get(sha);
    if (hit && !force) return hit;
    const res = await fetchJSON(`/api/approvals/${D.n}/commits/${encodeURIComponent(sha)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `读取提交失败（${res.status}）`);
    D.commitDetails.set(data.sha, data);
    return data;
  }

  function applyCommitView(detail, opts = {}) {
    D.rev = { kind: "commit", sha: detail.sha, parentSha: detail.parents[0] || null };
    D.revKey = `commit@${detail.sha}`;
    D.files = detail.files || [];
    rebuildComments();
    const candidates = [opts.file, D.pendingFile, D.file].filter(Boolean);
    D.file = candidates.find((path) => D.files.some((file) => file.path === path))
      || D.files[0]?.path
      || null;
    D.pendingFile = null;
    D.active = null;
    if (!opts.initial) D.pendingAnchor = null;
    D.urlLine = null;
    D.navIdx = -1;
    if (!opts.fromRoute) syncUrl("push");
    render();
    prefetchFiles(D.files, true);
  }

  async function selectCommit(sha, opts = {}) {
    const myGen = D.generation;
    /* 视图代次：再选一次提交或切回「全部改动」都会 +1，慢响应不能覆盖后来的选择 */
    const myRev = (D.revSeq += 1);
    const items = await ensureCommits(!!opts.force);
    if (D.generation !== myGen || D.revSeq !== myRev) return false;
    const wanted = String(sha || "").toLowerCase();
    const hit = items.find((commit) => commit.sha.toLowerCase() === wanted)
      || items.find((commit) => commit.sha.toLowerCase().startsWith(wanted));
    if (!hit) {
      toast("该提交不在当前 PR 中");
      if (opts.initial) selectAll({ fromRoute: true, initial: true });
      return false;
    }
    spin(1);
    try {
      const detail = await ensureCommitDetail(hit.sha);
      if (D.generation !== myGen || D.revSeq !== myRev) return false;
      applyCommitView(detail, { fromRoute: !!opts.fromRoute, file: opts.file, initial: !!opts.initial });
      return true;
    } catch (err) {
      if (D.generation !== myGen || D.revSeq !== myRev) return false;
      toast(`读取提交失败：${String(err)}`);
      if (opts.initial) selectAll({ fromRoute: true, initial: true });
      return false;
    } finally {
      if (D.generation === myGen) spin(-1);
    }
  }

  function selectAll(opts = {}) {
    D.revSeq += 1;
    D.rev = { kind: "all" };
    D.revKey = `all@${D.meta.headSha}`;
    D.files = D.all.files || [];
    rebuildComments();
    const candidates = [opts.file, D.pendingFile, D.file].filter(Boolean);
    D.file = candidates.find((path) => D.files.some((file) => file.path === path))
      || D.files[0]?.path
      || null;
    D.pendingFile = null;
    D.active = null;
    if (!opts.initial) D.pendingAnchor = null;
    D.urlLine = null;
    D.navIdx = -1;
    if (!opts.fromRoute) syncUrl("push");
    render();
    prefetchFiles(D.files, false);
  }

  /* ---------- 合并 ---------- */
  async function loadMergeOptions(force = false) {
    if (!D.meta || D.meta.state !== "open" || D.meta.merged) {
      D.merge.options = null;
      D.merge.loading = false;
      return;
    }
    const myGen = D.generation;
    D.merge.loading = true;
    D.merge.error = "";
    try {
      const res = await fetchJSON(`/api/approvals/${D.n}/merge-options${force ? "?refresh=1" : ""}`);
      const data = await res.json().catch(() => ({}));
      if (D.generation !== myGen) return;
      if (!res.ok) throw new Error(data.message || `读取合并条件失败（${res.status}）`);
      D.merge.options = data;
      if (!D.merge.method || !(data.methods || []).includes(D.merge.method)) {
        const saved = readPref("wb.merge.method", "");
        D.merge.method = (data.methods || []).includes(saved) ? saved : (data.defaultMethod || "");
      }
    } catch (err) {
      if (D.generation !== myGen) return;
      D.merge.error = String(err);
    } finally {
      if (D.generation === myGen) {
        D.merge.loading = false;
        /* 正在写评论时不整页重绘：合并区等下一次自然 render 再更新，避免抢走输入焦点 */
        if (D.rev.kind === "all" && !D.active) render();
      }
    }
  }

  async function mergePr() {
    if (!D.meta || isCommitView()) return;
    const select = document.getElementById("wbMergeMethod");
    const method = select ? select.value : D.merge.method;
    const options = D.merge.options;
    if (!options || !options.canMerge) {
      toast(options?.reason || "当前不满足合并条件");
      return;
    }
    if (!method) { toast("请选择合并方式"); return; }
    const labels = { merge: "创建合并提交", squash: "压缩为单个提交", rebase: "变基后合并" };
    if (!confirm(`确认合并 PR #${D.n}？\n\n方式：${labels[method] || method}\nhead：${D.meta.headSha.slice(0, 7)}\n\n合并会立即写入 GitHub，完成后此页转为只读。`)) return;
    const button = document.getElementById("wbMerge");
    if (button) { button.disabled = true; button.textContent = "合并中…"; }
    const myGen = D.generation;
    try {
      const res = await fetchJSON(`/api/approvals/${D.n}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sha: D.meta.headSha, method }),
      });
      const data = await res.json().catch(() => ({}));
      if (D.generation !== myGen) return;
      if (!res.ok) {
        D.merge.error = data.message || `合并失败（${res.status}）`;
        toast(`合并失败：${D.merge.error}`);
        render();
        return;
      }
      D.merge.done = true;
      toast(data.queued ? "已加入合并队列" : "已合并");
      await load(D.n, true, true);
    } catch (err) {
      if (D.generation !== myGen) return;
      D.merge.error = `合并未确认成功：${String(err)}`;
      toast(D.merge.error);
      render();
    }
  }

  /* ---------- 文件加载 ---------- */
  async function prefetchFiles(files, commit) {
    if (!files.length) { D.prefetchTotal = 0; D.prefetchDone = 0; return; }
    const myGen = D.generation;
    const snap = {
      pr: D.n,
      revKey: D.revKey,
      commit,
      headRef: commit ? D.rev.sha : D.meta.headSha,
      baseRef: commit ? D.rev.parentSha : D.meta.baseSha,
      files: files.map((file) => ({ path: file.path, status: file.status })),
    };
    D.prefetchTotal = snap.files.length;
    D.prefetchDone = 0;
    let idx = 0;
    const run = async () => {
      while (idx < snap.files.length) {
        const item = snap.files[idx];
        idx += 1;
        if (D.generation !== myGen || D.revKey !== snap.revKey) return;
        const have = textsOf(item.path);
        if (have && have.headLoaded && have.baseLoaded
          && have.headSha === snap.headRef && have.baseSha === snap.baseRef) {
          D.prefetchDone += 1;
          if (item.path === D.file) render();
          continue;
        }
        try {
          const headUrl = snap.commit
            ? `/api/approvals/${snap.pr}/commits/${snap.headRef}/file?path=${encodeURIComponent(item.path)}&side=head`
            : `/api/approvals/${snap.pr}/file?path=${encodeURIComponent(item.path)}&ref=${encodeURIComponent(snap.headRef)}`;
          const headRes = await fetchJSON(headUrl);
          if (D.generation !== myGen || D.revKey !== snap.revKey) return;
          const headPayload = await headRes.json().catch(() => ({}));
          if (!headRes.ok) throw new Error(headPayload.message || `读取正文失败（${headRes.status}）`);
          let basePayload = { text: "", truncated: false };
          const needBase = item.status !== "added" && (!snap.commit || snap.baseRef);
          if (needBase) {
            const baseUrl = snap.commit
              ? `/api/approvals/${snap.pr}/commits/${snap.headRef}/file?path=${encodeURIComponent(item.path)}&side=base`
              : `/api/approvals/${snap.pr}/file?path=${encodeURIComponent(item.path)}&ref=${encodeURIComponent(snap.baseRef)}`;
            const baseRes = await fetchJSON(baseUrl);
            if (D.generation !== myGen || D.revKey !== snap.revKey) return;
            if (!baseRes.ok) throw new Error(`读取改前正文失败（${baseRes.status}）`);
            basePayload = await baseRes.json().catch(() => ({}));
          }
          if (D.generation !== myGen || D.revKey !== snap.revKey) return;
          setTexts(item.path, {
            base: basePayload.text || "", head: headPayload.text || "",
            headLoaded: true, baseLoaded: true,
            headSha: snap.headRef, baseSha: snap.baseRef,
            headTruncated: !!headPayload.truncated, baseTruncated: !!basePayload.truncated,
            error: "",
          });
        } catch (err) {
          if (D.generation !== myGen || D.revKey !== snap.revKey) return;
          if (!textsOf(item.path)?.headLoaded) {
            setTexts(item.path, {
              base: "", head: "", headLoaded: false, baseLoaded: false,
              headTruncated: false, baseTruncated: false, error: String(err),
            });
          }
        }
        D.prefetchDone += 1;
        if (item.path === D.file) render();
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, snap.files.length) }, run));
  }

  async function selectFile(path, force, fromRoute) {
    const myGen = D.generation;
    const myRevKey = D.revKey;
    const myPr = D.n;
    const commit = isCommitView();
    const headRef = commit ? D.rev.sha : D.meta.headSha;
    const baseRef = commit ? D.rev.parentSha : D.meta.baseSha;
    D.file = path;
    D.active = null;
    D.navIdx = -1;
    D.err = "";
    if (D.view === "tree") unfoldAncestors(path);
    renderFiles();
    renderChapters();
    const activeRow = document.getElementById("wbFiles")?.querySelector(".trow.is-active, .fitem.is-active");
    if (activeRow && activeRow.scrollIntoView) activeRow.scrollIntoView({ block: "nearest" });
    const file = D.files.find((item) => item.path === path);
    if (!file) return;
    D.pendingAnchor = null;
    D.urlLine = null;
    if (!fromRoute) syncUrl("push");
    const cached = textsOf(path);
    if (!force && cached && cached.headLoaded && cached.baseLoaded
      && cached.headSha === headRef && cached.baseSha === baseRef) { render(); return; }
    spin(1);
    try {
      const headUrl = commit
        ? `/api/approvals/${myPr}/commits/${headRef}/file?path=${encodeURIComponent(path)}&side=head${force ? "&refreshText=1" : ""}`
        : `/api/approvals/${myPr}/file?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(headRef)}${force ? "&refreshText=1" : ""}`;
      const headRes = await fetchJSON(headUrl);
      const headPayload = await headRes.json().catch(() => ({}));
      if (!headRes.ok) throw new Error(`加载正文失败（${headRes.status}）：${headPayload.message || ""}`);
      /* 视图已经换掉：不必再取 base 正文，也不要写进新视图的缓存 */
      if (D.generation !== myGen || D.revKey !== myRevKey) return;
      let basePayload = { text: "", truncated: false };
      const needBase = file.status !== "added" && (!commit || baseRef);
      if (needBase) {
        const baseUrl = commit
          ? `/api/approvals/${myPr}/commits/${headRef}/file?path=${encodeURIComponent(path)}&side=base${force ? "&refreshText=1" : ""}`
          : `/api/approvals/${myPr}/file?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(baseRef)}${force ? "&refreshText=1" : ""}`;
        const baseRes = await fetchJSON(baseUrl);
        if (!baseRes.ok) throw new Error(`读取改前正文失败（${baseRes.status}）`);
        basePayload = await baseRes.json().catch(() => ({}));
      }
      if (D.generation !== myGen || D.revKey !== myRevKey) return;
      setTexts(path, {
        base: basePayload.text || "", head: headPayload.text || "",
        headLoaded: true, baseLoaded: true,
        headSha: headRef, baseSha: baseRef,
        headTruncated: !!headPayload.truncated, baseTruncated: !!basePayload.truncated,
        error: "",
      });
    } catch (err) {
      if (D.generation !== myGen || D.revKey !== myRevKey) return;
      D.err = err.name === "AbortError" ? "正文加载超时，请重试" : String(err);
      setTexts(path, {
        base: "", head: "", headLoaded: false, baseLoaded: false,
        headTruncated: false, baseTruncated: false, error: D.err,
      });
    } finally { if (D.generation === myGen) spin(-1); }
    if (D.generation === myGen) render();
  }

  /* ---------- 提交草稿 ---------- */
  async function submitDrafts() {
    if (!D.drafts.length && D.event !== "APPROVE") return;
    if (draftsOutdated()) { toast("PR 已有新提交，旧草稿不能提交"); return; }
    D.drafts = D.drafts.map((d) => ({ ...d, id: d.id || newDraftId() }));
    saveDrafts();
    const myGen = D.generation;
    const myPr = D.n;
    const myHeadSha = D.meta.headSha;
    const myEvent = D.event;
    const myDrafts = JSON.parse(JSON.stringify(D.drafts));
    const submittedIds = new Set(myDrafts.map((d) => d.id));
    const eventLabel = { APPROVE: "批准合并", COMMENT: "仅评论", REQUEST_CHANGES: "请求修改" }[myEvent] || myEvent;
    const plainCount = myDrafts.filter((d) => d.unanchored).length;
    const lineCount = myDrafts.length - plainCount;
    const parts = [];
    if (lineCount) parts.push(`${lineCount} 条行级意见`);
    if (plainCount) parts.push(`${plainCount} 条文字评论（正文附行号范围）`);
    const summary = parts.length ? `${eventLabel}（附 ${parts.join(" + ")}）` : eventLabel;
    if (!confirm(`确认提交 Review：${summary}？\n\n将以你的名义写入 GitHub，提交后不可撤回。`)) return;
    const btn = document.getElementById("wbSubmit");
    btn.disabled = true;
    btn.textContent = "提交中…";
    try {
      const payload = {
        commit_id: myHeadSha,
        event: myEvent,
        comments: myDrafts.map((d) => ({
          path: d.path,
          body: commentBody(d),
          line: d.end,
          side: "RIGHT",
          start_line: d.start < d.end ? d.start : undefined,
          plain: !!d.unanchored,
        })),
      };
      const res = await fetchJSON(`/api/approvals/${myPr}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        if (D.generation === myGen) {
          toast(`提交失败：${data.message || res.status}`);
          render();
        }
        return;
      }
      removeSubmittedDrafts(myPr, submittedIds);
      if (D.generation !== myGen) {
        // 期间可能已重新打开同一个 PR：D.drafts 被清理了，但抽屉仍是旧内容，
        // 继续按旧索引删除会误删其他草稿，需要重画。
        if (String(D.n) === String(myPr)) render();
        toast("已提交（但页面已刷新）");
        return;
      }
      const wrote = [];
      if (data.review) wrote.push(`review #${data.review.id}（${data.review.comments} 条行级）`);
      if (data.plainCount) wrote.push(`${data.plainCount} 条文字评论`);
      toast(`已写入 GitHub：${wrote.join(" + ") || "已提交"}`);
      await load(myPr, true, false);
    } catch (err) {
      if (D.generation !== myGen) return;
      toast(`提交未确认成功：${String(err)}`);
      render();
    }
  }

  /* ---------- 加载 PR ---------- */
  async function load(number, keepDrafts, force, opts = {}) {
    const oldN = D.n;
    const samePr = oldN === number;
    D.n = number;
    D.generation += 1;
    const myGen = D.generation;
    takeOverLoading();
    D.err = "";
    spin(1);
    try {
      const res = await fetchJSON(`/api/approvals/${number}/diff${force ? "?refreshMeta=1" : ""}`);
      if (D.generation !== myGen) return; // 已切换/刷新
      if (res.status === 401) { location.href = "/auth/login"; return; }
      const data = await res.json();
      if (D.generation !== myGen) return;
      if (!res.ok) { document.getElementById("wbContent").innerHTML = `<div class="error-box">读取变更失败：${esc(data.message || res.status)}</div>`; return; }
      const oldSha = D.meta ? D.meta.headSha : null;
      const oldBaseSha = D.meta ? D.meta.baseSha : null;
      const headChanged = Boolean(oldSha && (oldSha !== data.meta.headSha || oldBaseSha !== data.meta.baseSha));
      D.meta = data.meta;
      D.all = { files: data.files || [], comments: data.comments || [] };
      D.stale = !!data.stale;
      D.fetchedAt = new Date();
      if (!samePr || headChanged) {
        D.commits = { items: [], truncated: false, loaded: false, loading: false, error: "" };
        D.commitDetails = new Map();
      }
      D.merge = {
        options: null,
        loading: false,
        error: "",
        /* 合并已在这次会话里提交过：重新读取失败时不要退回「可合并」按钮 */
        done: samePr ? D.merge.done : false,
        method: readPref("wb.merge.method", "") || "",
      };
      if (!keepDrafts) { D.drafts = []; loadDrafts(); }
      if (headChanged) { D.texts = {}; modelCache.clear(); }
      D.rev = { kind: "all" };
      D.revKey = `all@${D.meta.headSha}`;
      D.files = D.all.files;
      rebuildComments();
      const wanted = D.pendingFile && D.files.some((f) => f.path === D.pendingFile) ? D.pendingFile : null;
      if (D.pendingFile && !wanted) toast("该文件不在本 PR 中，已切到第一个文件。");
      D.file = wanted
        || (D.files.find((f) => f.path === D.file) || D.files[0] || null)?.path
        || null;
      D.pendingFile = null;
      render();
      loadMergeOptions();
      /* 提交列表与正文并行拉取：列表慢只影响提交选择器，不该挡住默认阅读视图 */
      const commitsReady = ensureCommits(force || headChanged);
      if (opts.commit) {
        await commitsReady;
        if (D.generation !== myGen) return;
        const selected = await selectCommit(opts.commit, {
          fromRoute: true,
          initial: true,
          file: opts.file,
        });
        if (!selected && D.generation === myGen) await prefetchFiles(D.files, false);
      } else {
        await prefetchFiles(D.files, false);
      }
    } finally { if (D.generation === myGen) spin(-1); }
  }

  /* ---------- 顶栏/侧栏事件 ---------- */
  function bindTopbar() {
    document.querySelectorAll(".wb-mode").forEach((b) => {
      b.addEventListener("click", () => setMode(b.dataset.mode));
    });
    document.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest("[data-view-state]");
      if (!btn) return;
      e.preventDefault();
      const next = btn.dataset.viewState;
      if (!VIEWS.includes(next) || next === viewState()) return;
      D.docView = next;
      writePref(PREF.docView, next);
      render();
    });
    document.getElementById("wbCommitSelect").addEventListener("change", (e) => {
      const sha = e.target.value;
      if (!sha) selectAll();
      else selectCommit(sha);
    });
    document.getElementById("wbCommitBar").addEventListener("click", (e) => {
      if (e.target.closest("[data-commit-all]")) selectAll();
    });

    /* 外观弹层：文档主题 + 表格样式（只影响阅读呈现，不写进 URL） */
    const lookBtn = document.getElementById("wbLookBtn");
    const lookPop = document.getElementById("wbLookPop");
    const closeLook = () => { lookPop.hidden = true; lookBtn.setAttribute("aria-expanded", "false"); };
    lookBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = lookPop.hidden;
      lookPop.hidden = !open;
      lookBtn.setAttribute("aria-expanded", String(open));
    });
    lookPop.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => { if (!lookPop.hidden) closeLook(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !lookPop.hidden) closeLook(); });
    D.syncLook = () => {
      lookPop.querySelectorAll("[data-theme]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.theme === D.theme)));
      lookPop.querySelectorAll("[data-tbl]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.tbl === D.tbl)));
      lookPop.querySelectorAll("[data-read]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.read === D.read)));
    };
    lookPop.querySelectorAll("[data-theme]").forEach((b) => b.addEventListener("click", () => {
      D.theme = b.dataset.theme;
      writePref(PREF.theme, D.theme);
      applyTheme();
    }));
    lookPop.querySelectorAll("[data-tbl]").forEach((b) => b.addEventListener("click", () => {
      D.tbl = b.dataset.tbl;
      writePref(PREF.tbl, D.tbl);
      applyTheme();
    }));
    lookPop.querySelectorAll("[data-zoom]").forEach((b) => b.addEventListener("click", () => {
      D.zoom = clampZoom(b.dataset.zoom);
      writePref(PREF.zoom, D.zoom);
      applyZoom();
    }));
    lookPop.querySelectorAll("[data-read]").forEach((b) => b.addEventListener("click", () => {
      D.read = b.dataset.read;
      writePref(PREF.read, D.read);
      applyTheme();
    }));
    document.getElementById("wbDrawerBtn").addEventListener("click", () => {
      document.getElementById("wbBody").classList.toggle("drawer-open");
      syncDrawerHandle();
    });
    document.getElementById("wbDrawerFold").addEventListener("click", () => {
      document.getElementById("wbBody").classList.remove("drawer-open");
      syncDrawerHandle();
    });
    document.getElementById("wbFocusBtn").addEventListener("click", () => setFocus(!D.focus));
    document.getElementById("focusExit").addEventListener("click", () => setFocus(false));
    const fo = document.getElementById("focusOutline");
    if (fo) fo.addEventListener("click", () => setOutline(!D.outline));
    document.getElementById("focusZoomIn").addEventListener("click", () => stepZoom(1));
    document.getElementById("focusZoomOut").addEventListener("click", () => stepZoom(-1));
    document.getElementById("focusDrawer").addEventListener("click", () => {
      document.getElementById("wbBody").classList.toggle("drawer-open");
      syncDrawerHandle();
    });
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && D.focus) setFocus(false);
    });
    document.addEventListener("keydown", (e) => {
      const wb = document.getElementById("workbench");
      if (wb && wb.hidden) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); stepZoom(1); return; }
      if (mod && e.key === "-") { e.preventDefault(); stepZoom(-1); return; }
      if (mod && e.key === "0") { e.preventDefault(); D.zoom = 1; writePref(PREF.zoom, 1); applyZoom(); return; }
      const t = e.target;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (!mod && !e.altKey && !typing && (e.key === "f" || e.key === "F")) {
        e.preventDefault(); setFocus(!D.focus); return;
      }
      if (e.key === "Escape" && D.focus) {
        // 表格全屏、单元格弹层、列面板优先消费 Esc
        const busy = document.querySelector(".table-shell.is-full")
          || document.getElementById("tblCellPop")
          || document.querySelector(".colpanel:not([hidden])")
          || document.querySelector("#wbDrawerBody .composer");
        if (!busy) setFocus(false);
      }
    });
    document.addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (!e.target.closest || !e.target.closest("#wbDoc")) return;
      e.preventDefault();
      stepZoom(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    const rvBtn = document.getElementById("wbReviewCount");
    if (rvBtn) rvBtn.addEventListener("click", () => {
      openDrawer();
      const fold = document.querySelector("#wbDrawerBody .chg-fold");
      if (fold) fold.open = true;
      const head = document.querySelector("#wbDrawerBody .chg-head");
      if (head) head.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    document.getElementById("wbDrawerOpen").addEventListener("click", () => {
      openDrawer();
      syncDrawerHandle();
    });
    document.getElementById("wbNavFold").addEventListener("click", () => {
      document.getElementById("wbBody").classList.toggle("nav-collapsed");
    });
    document.getElementById("wbNavToggle").addEventListener("click", () => {
      document.getElementById("wbBody").classList.toggle("nav-collapsed");
    });
    document.getElementById("wbFilter").addEventListener("input", (e) => { D.filter = e.target.value; renderFiles(); });
    document.getElementById("wbOrigCopy").addEventListener("click", () => copyPrLink());
    document.querySelectorAll(".wb-viewseg [data-view]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (D.view === btn.dataset.view) return;
        D.view = btn.dataset.view;
        writePref(PREF.view, D.view);
        renderFiles();
      });
    });
    initFileList();
    initSections();
    initSashes();
  }

  let bound = false;
  let scrollSyncTimer = null;

  /** 滚动停下后把「顶部行号」写回 URL，保证复制地址栏就是当前所在位置 */
  function bindScrollSync() {
    const docEl = document.getElementById("wbDoc");
    if (!docEl) return;
    docEl.addEventListener("scroll", () => {
      clearTimeout(scrollSyncTimer);
      scrollSyncTimer = setTimeout(() => {
        if (!D.n || D.ref || D.pendingAnchor) return;
        /* 渲染后的程序化滚动不算用户位移，避免每开一个文件就带 #L */
        if (Date.now() - (D.lastRenderAt || 0) < 700) return;
        const line = topLine();
        if (line) { D.urlLine = line; syncUrl("replace", { line }); }
      }, 450);
    }, { passive: true });
  }

  async function mountPr(number, opts = {}) {
    if (!bound) { bind(); bindTopbar(); bindScrollSync(); bound = true; }
    document.getElementById("workbench").hidden = false;
    document.body.classList.add("wb-mode-on");
    D.view = readPref(PREF.view, "tree") === "flat" ? "flat" : "tree";
    D.theme = THEMES.includes(readPref(PREF.theme, "paper")) ? readPref(PREF.theme, "paper") : "paper";
    D.tbl = TBL_STYLES.includes(readPref(PREF.tbl, "grid")) ? readPref(PREF.tbl, "grid") : "grid";
    D.read = READ_WIDTHS.includes(readPref(PREF.read, "standard")) ? readPref(PREF.read, "standard") : "standard";
    D.docView = VIEWS.includes(readPref(PREF.docView, "markup")) ? readPref(PREF.docView, "markup") : "markup";
    D.zoom = clampZoom(readPref(PREF.zoom, 1) || 1);
    D.focus = Boolean(readPref(PREF.focus, false));
    applyZoom();
    D.outline = readPref(PREF.outline, true) !== false;
    if (D.focus) setFocus(true);
    const rv = readPref(PREF.reviewed, {});
    /* 旧版本键是 revKey|path|line，没有侧别：按 head 认领，避免升级后已阅全清零 */
    D.reviewed = {};
    for (const [k, v] of Object.entries(rv && typeof rv === "object" ? rv : {})) {
      const parts = String(k).split("|");
      if (parts.length === 3) D.reviewed[`${parts[0]}|${parts[1]}|head|${parts[2]}`] = v;
      else D.reviewed[k] = v;
    }
    const folded = readPref(PREF.folded(number), []);
    D.folded = new Set(Array.isArray(folded) ? folded : []);
    /* 窄屏下文件导航默认收起，避免占满阅读宽度；宽屏保持展开 */
    document.getElementById("wbBody").classList.toggle("nav-collapsed", window.innerWidth <= 900);
    document.getElementById("wbLoading").hidden = false;
    D.ref = null;
    refTextCache.clear();
    if (MODES.includes(opts.mode)) D.mode = opts.mode;
    D.pendingFile = opts.file || null;
    D.pendingAnchor = opts.line
      ? { line: opts.line, endLine: opts.endLine || null }
      : opts.heading ? { heading: opts.heading } : null;
    await load(number, false, false, opts);
  }

  /** 前进/后退落回工作台：按 URL 切换 PR / 文件 / 视图 / 行号，不再写 URL */
  async function applyRoute(state) {
    if (!state || state.kind !== "pr") return;
    const anchor = state.line
      ? { line: state.line, endLine: state.endLine || null }
      : state.heading ? { heading: state.heading } : null;
    if (state.n !== D.n) { await mountPr(state.n, state); return; }
    /* 提交视图与「全部改动」之间切换，由 load 负责拉取提交归属 */
    const curCommit = isCommitView() ? D.rev.sha.toLowerCase() : null;
    const wantCommit = state.commit ? state.commit.toLowerCase() : null;
    const sameRev = wantCommit === null ? curCommit === null : Boolean(curCommit && curCommit.startsWith(wantCommit));
    if (!sameRev) {
      D.pendingAnchor = anchor;
      /* 前进/后退可能同时换了视图与阅读方式：先落 mode，再切视图，并保留路由里的锚点 */
      if (state.mode && MODES.includes(state.mode)) D.mode = state.mode;
      if (wantCommit) await selectCommit(wantCommit, { fromRoute: true, file: state.file, initial: true });
      else selectAll({ fromRoute: true, file: state.file, initial: true });
      return;
    }
    if (state.mode && MODES.includes(state.mode) && state.mode !== D.mode) {
      D.mode = state.mode;
      D.pendingAnchor = anchor || D.pendingAnchor;
      render();
      return;
    }
    if (state.file && state.file !== D.file) {
      D.pendingAnchor = anchor;
      await selectFile(state.file, false, true);
      return;
    }
    if (anchor) {
      D.pendingAnchor = anchor;
      if (!applyAnchor()) render();
      return;
    }
    const docEl = document.getElementById("wbDoc");
    if (docEl) docEl.scrollTop = 0;
  }

  window.DiffView = {
    mount: (number, opts) => mountPr(number, opts),
    applyRoute,
    refresh: (number, force) => load(number, true, !!force),
    unmount: () => {
      document.getElementById("workbench").hidden = true;
      const handle = document.getElementById("wbDrawerOpen");
      if (handle) handle.hidden = true;
      const shell = document.getElementById("wbBody");
      if (shell) shell.classList.remove("drawer-open");
      document.body.classList.remove("wb-mode-on");
      document.body.classList.remove("tbl-full-on");
      closeCellPopover();
      D.ref = null;
      D.pendingAnchor = null;
      D.pendingFile = null;
      document.title = "审批可视化";
    },
  };
})();
