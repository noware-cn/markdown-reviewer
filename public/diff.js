/* 工作台控制器：阅读改动（默认）/ 统一 Diff / 分栏 Diff；行级评论与草稿 */
(function () {
  const D = {
    n: null,
    meta: null,
    files: [],
    comments: [],
    texts: {},       // path -> {base, head, headLoaded, baseLoaded, headTruncated, baseTruncated}
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
  };

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
  const textOf = (path, side) => (D.texts[path] ? D.texts[path][side] || "" : "");

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
    const textState = file && D.texts[file.path];
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
    box.innerHTML = heads.map((b) => {
      const lvl = Number(b.type[1]);
      const changed = b.changeState !== "normal";
      return `<div class="chapter l${lvl}${changed ? " empty2" : ""}" data-line="${b.startLine}" data-chapter="${b.startLine}">`
        + (changed ? `<span class="cdot"></span>` : "")
        + esc(b.title || "(无标题)") + `</div>`;
    }).join("");
  }

  /* ---------- 差异模型缓存 ---------- */
  const modelCache = new Map();
  function cachedModel(file, kind, build) {
    const head = textOf(file.path, "head");
    const base = textOf(file.path, "base");
    const patch = file.patch || "";
    const key = kind + "|" + file.path + "|" + (D.meta?.headSha || "");
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

  /* ---------- 阅读改动渲染 ---------- */
  function readingHTML(file) {
    const textState = D.texts[file.path];
    const errMsg = (textState && textState.error) || D.err;
    if (!textState || !textState.headLoaded) {
      if (errMsg) return `<div class="error-box">${esc(errMsg)} <button type="button" class="retry" data-retry="1">重试</button></div>`;
      return `<div class="dempty">正在加载正文…</div>`;
    }
    if (isCsv(file.path)) return csvReadingHTML(file);
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
        + baseBlocks.map((b) => `<div class="md-block" data-base-line="${b.startLine}">${b.html}</div>`).join("");
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

  function blockHtml(b, opts) {
    let cls = "md-block";
    let tag = "";
    if (!opts.plain) {
      if (b.changeState === "added") { cls += " is-added"; tag = `<span class="diff-tag add">新增</span>`; }
      else if (b.changeState === "modified-new") {
        cls += " is-modified-new";
        tag = `<span class="diff-tag mod">修改</span>`;
      }
      else if (b.changeState === "partial") {
        cls += " is-modified-new";
        tag = `<span class="diff-tag mod">修改</span>`;
      }
    }
    // 显示所有配对删除内容（可能有多处修改）
    const oldBlocks = (b.pairedChanges || (b.pairedChange ? [b.pairedChange] : []))
      .map((pc) => `<div class="del-block"><div class="del-head">旧内容（已替换）</div><div class="del-body"><pre>${esc(pc.oldText)}</pre></div></div>`)
      .join("");
    const oldBlock = oldBlocks;
    // 代码块：逐行 data-line
    let bodyHtml = b.html;
    if (b.type === "code" && b.startLine != null) {
      bodyHtml = bodyHtml.replace(/(<pre><code>)([\s\S]*?)(<\/code><\/pre>)/, (_m, open, code, close) => {
        const lines = code.split("\n");
        const wrapped = lines.map((ln, i) => `<span class="code-line" data-line="${b.startLine + i + 1}">${ln}</span>`).join("\n");
        return open + wrapped + close;
      });
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
    return `<div class="${cls}" data-line="${b.startLine}" data-end-line="${b.endLine}" data-block="${b.startLine}">${oldBlock}${tag}${bodyHtml}${anchor}</div>`;
  }

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
  function addedFileNote() {
    return `<div class="added-note"><span class="added-tag">新增文件</span>`
      + `本 PR 新增，以下内容全部为新增行，未逐行标注。</div>`;
  }

  function insertionHtml(ch, file) {
    return `<div class="del-block" data-old-line="${ch.oldStart}" data-change="${ch.id}">`
      + `<div class="del-head">删除（Base L${ch.oldStart}${ch.oldEnd > ch.oldStart ? "–" + ch.oldEnd : ""}）</div>`
      + `<div class="del-body"><pre>${esc(ch.oldText)}</pre></div>`
      + `<div class="del-jump" data-jump-source="${esc(file.path)}">在源码 Diff 中查看 →</div></div>`;
  }

  /* ---------- CSV 数据表 ---------- */
  function csvGutter(row, opts) {
    if (opts.anchors && row.commentLine) {
      return `<span class="line-anchor" data-line="${row.commentLine}" data-side="RIGHT" title="在第 ${row.commentLine} 行评论">`
        + `${row.commentLine}<i>+</i></span>`;
    }
    return `<span class="csv-num">${opts.oldLine ? "−" : ""}${row.startLine}</span>`;
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
  const csvToolsHTML = (opts) => ((opts && opts.noRows) ? ""
    : `<button class="tbtn" type="button" data-tbl="only" aria-pressed="false">仅看变化行</button>`)
    + `<button class="tbtn" type="button" data-tbl="cols" aria-expanded="false">列</button>`
    + `<button class="tbtn" type="button" data-tbl="density" aria-pressed="false">紧凑</button>`
    + `<button class="tbtn" type="button" data-tbl="full" aria-pressed="false">全屏</button>`;

  function tableShellHTML(opts) {
    return `<div class="table-shell${opts.csv ? " is-csv" : ""}" data-table>`
      + `<div class="tbar"><span class="tstat">${opts.stat || ""}</span><span class="tgrow"></span>${opts.tools || ""}</div>`
      + `<div class="tscroll" tabindex="0" role="region" aria-label="${opts.label || "表格"}，可横向滚动">${opts.table}</div>`
      + `<div class="tshadow l" aria-hidden="true"></div><div class="tshadow r" aria-hidden="true"></div>`
      + (opts.csv ? `<div class="colpanel" hidden></div>` : "")
      + `</div>`;
  }

  /* 阅读视图：Head 数据表，被删记录按锚点插回原位，被改记录上方保留旧记录。 */
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

  function csvReadingHTML(file) {
    const textState = D.texts[file.path];
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

  function csvSideBySideHTML(file) {
    const textState = D.texts[file.path];
    const errMsg = (textState && textState.error) || D.err;
    if (!textState || !textState.headLoaded || !textState.baseLoaded) {
      if (errMsg) return `<div class="error-box">${esc(errMsg)} <button type="button" class="retry" data-retry="1">重试</button></div>`;
      return `<div class="dempty">正在加载前后版本…</div>`;
    }
    if (textState.headTruncated || textState.baseTruncated) {
      return `<div class="error-box">文件超过读取上限（400 KB），前后对照内容不完整，请用 GitHub 查看完整版本。</div>`;
    }
    if (!file.patch && file.status !== "added" && file.status !== "removed") {
      return `<div class="error-box">GitHub 未返回该文件的差异（文件过大）。<a href="${D.meta.url}/files#diff-${encodeURIComponent(file.path)}" target="_blank" rel="noopener">在 GitHub 中查看完整 Diff →</a></div>`;
    }
    const model = csvModelFor(file);
    const forceHead = file.status === "added";
    const forceBase = file.status === "removed";
    const baseTable = csvSimpleTable(model.base.rows, model.columns, { stateOf: forceBase ? () => "removed" : undefined });
    const headTable = csvSimpleTable(model.head.rows, model.columns, { anchors: true, stateOf: forceHead ? () => "added" : undefined });
    return `<div class="sb2">`
      + `<div class="sb-col sb-base"><div class="sb-col-head">Base（变更前）</div>`
      + tableShellHTML({ csv: true, stat: "Base", tools: csvToolsHTML(), table: baseTable, label: "Base CSV 数据表" })
      + `</div>`
      + `<div class="sb-col sb-head"><div class="sb-col-head">Head（变更后）</div>`
      + tableShellHTML({ csv: true, stat: "Head", tools: csvToolsHTML(), table: headTable, label: "Head CSV 数据表" })
      + `</div>`
      + `</div>`;
  }

  function sideBySideHTML(file) {
    if (isCsv(file.path)) return csvSideBySideHTML(file);
    const textState = D.texts[file.path];
    const errMsg = (textState && textState.error) || D.err;
    if (!textState || !textState.headLoaded || !textState.baseLoaded) {
      if (errMsg) return `<div class="error-box">${esc(errMsg)} <button type="button" class="retry" data-retry="1">重试</button></div>`;
      return `<div class="dempty">正在加载前后版本…</div>`;
    }
    if (textState.headTruncated || textState.baseTruncated) {
      return `<div class="error-box">文件超过读取上限（400 KB），前后对照内容不完整，请用 GitHub 查看完整版本。</div>`;
    }
    if (!file.patch && file.status !== "added" && file.status !== "removed") {
      return `<div class="error-box">GitHub 未返回该文件的差异（文件过大）。<a href="${D.meta.url}/files#diff-${encodeURIComponent(file.path)}" target="_blank" rel="noopener">在 GitHub 中查看完整 Diff →</a></div>`;
    }
    const model = modelFor(file);
    const leftBlocks = model.baseBlocks || [];
    const rightBlocks = model.headBlocks || [];
    const leftHtml = leftBlocks.map((b) => {
      let cls = "md-block";
      let tag = "";
      if (b.changeState === "removed") { cls += " is-removed"; tag = `<span class="diff-tag del">删除</span>`; }
      else if (b.changeState === "partial") { cls += " is-partial"; tag = `<span class="diff-tag mod">修改</span>`; }
      return `<div class="${cls}" data-base-line="${b.startLine}">${tag}${b.html}</div>`;
    }).join("");
    const rightHtml = rightBlocks.map((b) => {
      let cls = "md-block";
      let tag = "";
      if (b.changeState === "added" || file.status === "added") { cls += " is-added"; tag = `<span class="diff-tag add">新增</span>`; }
      else if (b.changeState === "modified-new" || b.changeState === "partial") { cls += " is-modified-new"; tag = `<span class="diff-tag mod">修改</span>`; }
      return `<div class="${cls}" data-line="${b.startLine}">${tag}${b.html}</div>`;
    }).join("");
    return `<div class="sb2">`
      + `<div class="sb-col sb-base"><div class="sb-col-head">Base（变更前）</div>${leftHtml || '<div class="dempty">（空文件）</div>'}</div>`
      + `<div class="sb-col sb-head"><div class="sb-col-head">Head（变更后）</div>${rightHtml || '<div class="dempty">（空文件）</div>'}</div>`
      + `</div>`;
  }

  /* ---------- 源码 Diff（保留） ---------- */
  function unifiedHTML(file) {
    const patch = file.patch || "";
    const rows = window.DiffModel.parsePatch(patch);
    if (!rows.ops.length) return `<div class="dempty">GitHub 未返回该文件 patch（文件过大或为二进制）。</div>`;
    let html = "";
    for (const op of rows.ops) {
      if (op.t === "ctx") {
        html += `<div class="dline ctx" data-line="${op.new}"><span class="ln">${op.old}</span><span class="ln">${op.new}</span><span class="sg"></span><span class="tx">${esc(op.text)}</span></div>`;
      } else if (op.t === "add") {
        html += `<div class="dline add" data-line="${op.new}"><span class="ln"></span><span class="ln">${op.new}</span><span class="sg">+</span><span class="tx">${esc(op.text)}</span></div>`;
      } else {
        html += `<div class="dline del"><span class="ln">${op.old}</span><span class="ln"></span><span class="sg">−</span><span class="tx">${esc(op.text)}</span></div>`;
      }
    }
    return html;
  }

  function splitHTML(file) {
    const rows = window.DiffModel.parsePatch(file.patch || "");
    if (!rows.ops.length) return `<div class="dempty">GitHub 未返回该文件 patch。</div>`;
    let left = "";
    let right = "";
    for (const op of rows.ops) {
      if (op.t === "ctx") {
        left += `<div class="dline ctx"><span class="ln">${op.old}</span><span class="tx">${esc(op.text)}</span></div>`;
        right += `<div class="dline ctx" data-line="${op.new}"><span class="ln">${op.new}</span><span class="tx">${esc(op.text)}</span></div>`;
      } else if (op.t === "del") {
        left += `<div class="dline del"><span class="ln">${op.old}</span><span class="tx">${esc(op.text)}</span></div>`;
        right += `<div class="dline"><span class="ln"></span><span class="tx"></span></div>`;
      } else {
        left += `<div class="dline"><span class="ln"></span><span class="tx"></span></div>`;
        right += `<div class="dline add" data-line="${op.new}"><span class="ln">${op.new}</span><span class="tx">${esc(op.text)}</span></div>`;
      }
    }
    return `<div class="split2"><div class="scol">${left}</div><div class="scol">${right}</div></div>`;
  }

  /* ---------- 抽屉内容 ---------- */
  function drawerHTML() {
    const parts = [];
    // existing comments for current file
    const file = curFile();
    if (file && D.commentsByPath) {
      const list = D.commentsByPath.get(file.path) || [];
      if (list.length) {
        parts.push(`<div style="font-size:12px;color:var(--ink-3);margin:4px 0;">历史评论（${list.length}）</div>`);
        parts.push(list.map((c) => `<div class="commentnote"><b>${esc(c.author)} · L${c.line || c.originalLine}</b><br>${esc(c.body.replace(/\n+/g, " "))}${c.url ? ` <a href="${esc(c.url)}" target="_blank" rel="noopener">→</a>` : ""}</div>`).join(""));
      }
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
      parts.push(`<div style="font-size:12px;color:var(--ink-3);margin:10px 0 4px;">本地草稿（${D.drafts.length}）</div>`);
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
        ? (D.drafts.length ? `批准并附 ${D.drafts.length} 条意见` : "批准合并")
        : `提交 ${D.drafts.length} 条意见到 GitHub`;
      parts.push(`<button class="dsubmit" id="wbSubmit" type="button" ${canSubmit ? "" : "disabled"}>${btnText}</button>`);
      const hint = draftsOutdated() ? "PR 已有新提交：旧草稿行号可能失效，请删除后重新定位。"
        : D.event === "APPROVE" ? "批准将以你的名义在 GitHub 提交 Approve Review。"
        : "评论使用你本人令牌写入，页面不保存副本。";
      parts.push(`<div class="dhint">${hint}</div>`);
    } else {
      parts.push(`<div class="dhint">PR 已合并，GitHub 不允许再新增评论，此页只读。</div>`);
    }
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
  function gotoChange(dir) {
    const els = changeElements();
    if (!els.length) return;
    if (D.navIdx < 0) D.navIdx = dir > 0 ? -1 : els.length;
    D.navIdx = (D.navIdx + dir + els.length) % els.length;
    const target = els[D.navIdx];
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.style.outline = "2px solid var(--mod)";
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
      D.ref = { stack: [], path: "", anchor: "", text: "", loading: false, error: "", candidates: [], token: 0 };
    } else if (!opts.fromBack && D.ref.path && D.ref.path !== path) {
      D.ref.stack.push({ path: D.ref.path, anchor: D.ref.anchor, scroll: docEl.scrollTop });
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

    const cached = refTextCache.get(`${path}@${D.meta?.headSha}`);
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
    const ref = D.meta?.headSha || "";
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
        refTextCache.set(`${D.ref.path}@${D.meta?.headSha}`, D.ref.text);
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
    openRefDoc(previous.path, previous.anchor, { fromBack: true });
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
    const openHref = `/doc/${encPath(ref.path)}${D.meta?.headSha ? `?ref=${encodeURIComponent(D.meta.headSha)}` : ""}`;
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
    const body = isCsv(ref.path) ? refCsvHTML(ref.text) : window.DiffModel.renderMarkdown(ref.text);
    return bar + `<article class="md-block refdoc">${body}</article>`;
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

  /** 拦截文档内链接：PR 文件就地切换，仓库其他文件用引用视图，外链照旧。 */
  function handleDocLink(event, link) {
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
  function render() {
    const meta = D.meta;
    if (!meta) return;
    saveComposerText();
    // 保存上一个视图的滚动位置（用旧 key）
    if (D.lastViewKey) {
      D.scrollPos[D.lastViewKey] = document.getElementById("wbDoc").scrollTop;
    }
    document.getElementById("wbPrTitle").textContent = `#${meta.number} ${meta.title}`;
    document.getElementById("wbStats").textContent =
      `${meta.changedFiles} 文件 · +${meta.additions}/−${meta.deletions} · head ${meta.headSha.slice(0, 7)}`
      + (D.stale ? " · 缓存数据" : "");
    document.querySelectorAll(".wb-mode").forEach((b) => {
      const on = b.dataset.mode === D.mode;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    document.getElementById("wbMarks").checked = D.marks;
    document.getElementById("wbDraftCount").textContent = String(D.drafts.length);

    /* 原始 PR 链接：顶栏露出一份，可点开也可复制 */
    const origUrl = D.meta.url || "";
    const origWrap = document.getElementById("wbOrigWrap");
    origWrap.hidden = !origUrl;
    if (origUrl) {
      const orig = document.getElementById("wbOrig");
      orig.href = origUrl;
      orig.title = origUrl;
      orig.textContent = origUrl.replace(/^https?:\/\//, "");
    }

    renderFiles();
    renderChapters();
    renderFilepath();

    const doc = document.getElementById("wbDoc");
    doc.classList.toggle("marks-off", !D.marks);
    doc.dataset.mode = D.mode;
    const file = curFile();
    doc.dataset.kind = D.ref ? "ref" : file && isCsv(file.path) ? "csv" : "";
    const content = document.getElementById("wbContent");
    if (D.ref) content.innerHTML = refDocHTML();
    else if (!file) { content.innerHTML = `<div class="dempty">该 PR 没有变更文件。</div>`; }
    else if (D.mode === "unified") content.innerHTML = unifiedHTML(file);
    else if (D.mode === "split") content.innerHTML = splitHTML(file);
    else if (D.mode === "sidebyside") content.innerHTML = sideBySideHTML(file);
    else content.innerHTML = readingHTML(file);

    decorateTables(content);

    document.getElementById("wbDrawerBody").innerHTML = drawerHTML();
    // 恢复当前视图的滚动位置，记录本次 key
    const key = D.ref ? `ref:${D.ref.path}` : `${D.file}:${D.mode}`;
    D.lastViewKey = key;
    const saved = D.scrollPos[key];
    const docEl = document.getElementById("wbDoc");
    requestAnimationFrame(() => { docEl.scrollTop = saved ?? 0; });
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
      const retry = e.target.closest("[data-retry]");
      if (retry) { if (D.file) selectFile(D.file, true); return; }
      const anchor = e.target.closest(".line-anchor, [data-plus]");
      if (anchor) {
        const line = Number(anchor.dataset.line);
        D.active = { path: D.file, start: line, end: line, quote: "" };
        render();
        body.classList.add("drawer-open");
        document.getElementById("wbBody").classList.add("drawer-open");
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
    document.addEventListener("click", (e) => {
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

    // drawer interactions (delegate on drawer body)
    const drawer = document.getElementById("wbDrawerBody");
    drawer.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]");
      if (act) {
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
    });

    // selection chip
    document.addEventListener("mouseup", (e) => {
      const wb = document.getElementById("workbench");
      if (wb.hidden) return;
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
      else if (e.key === "1") { D.active = null; D.mode = "reading"; render(); }
      else if (e.key === "2") { D.active = null; D.mode = "sidebyside"; render(); }
      else if (e.key === "3") { D.active = null; D.mode = "unified"; render(); }
      else if (e.key === "4") { D.active = null; D.mode = "split"; render(); }
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
      document.getElementById("wbBody").classList.add("drawer-open");
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

  /* ---------- 文件加载 ---------- */
  async function selectFile(path, force) {
    const myGen = D.generation;
    const myPr = D.n;
    D.file = path;
    D.active = null;
    D.navIdx = -1;
    D.err = "";
    if (D.view === "tree") unfoldAncestors(path);
    renderFiles();
    renderChapters();
    const activeRow = document.getElementById("wbFiles")?.querySelector(".trow.is-active, .fitem.is-active");
    if (activeRow && activeRow.scrollIntoView) activeRow.scrollIntoView({ block: "nearest" });
    const meta = D.meta;
    const file = D.files.find((item) => item.path === path);
    if (!file) return;
    if (!force && D.texts[path] && D.texts[path].headLoaded && D.texts[path].baseLoaded
      && D.texts[path].headSha === meta.headSha && D.texts[path].baseSha === meta.baseSha) { render(); return; }
    spin(1);
    try {
      const headR = await fetchJSON(`/api/approvals/${myPr}/file?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(meta.headSha)}${force ? "&refreshText=1" : ""}`);
      const headP = await headR.json().catch(() => ({}));
      if (!headR.ok) throw new Error(`加载正文失败（${headR.status}）：${headP.message || ""}`);
      let baseP = { text: "", truncated: false };
      if (file.status !== "added") {
        const baseR = await fetchJSON(`/api/approvals/${myPr}/file?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(meta.baseSha)}${force ? "&refreshText=1" : ""}`);
        if (!baseR.ok) throw new Error(`读取改前正文失败（${baseR.status}）`);
        baseP = await baseR.json().catch(() => ({}));
      }
      if (D.generation !== myGen) return;
      D.texts[path] = {
        base: baseP.text || "", head: headP.text || "",
        headLoaded: true, baseLoaded: true,
        headSha: meta.headSha, baseSha: meta.baseSha,
        headTruncated: !!headP.truncated, baseTruncated: !!baseP.truncated,
      };
    } catch (err) {
      if (D.generation !== myGen) return;
      D.err = err.name === "AbortError" ? "正文加载超时，请重试" : String(err);
      D.texts[path] = { base: "", head: "", headLoaded: false, baseLoaded: false, headTruncated: false, baseTruncated: false };
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
  async function load(number, keepDrafts, force) {
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
      D.meta = data.meta;
      D.files = data.files || [];
      D.comments = data.comments || [];
      D.stale = !!data.stale;
      D.fetchedAt = new Date();
      D.commentsByPath = new Map();
      for (const c of D.comments) {
        if (!D.commentsByPath.has(c.path)) D.commentsByPath.set(c.path, []);
        D.commentsByPath.get(c.path).push(c);
      }
      if (!keepDrafts) { D.drafts = []; loadDrafts(); }
      if (oldSha && (oldSha !== D.meta.headSha || oldBaseSha !== D.meta.baseSha)) { D.texts = {}; modelCache.clear(); }
      D.file = (D.files.find((f) => f.path === D.file) || D.files[0] || null)?.path || null;
      render();

      // 预加载：冻结 PR / SHA / 文件清单，后续只读快照；每个 await 后校验代次
      const snap = {
        pr: number,
        headSha: D.meta.headSha,
        baseSha: D.meta.baseSha,
        files: D.files.map((f) => ({ path: f.path, status: f.status })),
      };
      const order = snap.files.map((f) => f.path);
      D.prefetchTotal = order.length;
      D.prefetchDone = 0;
      let idx = 0;
      const run = async () => {
        while (idx < order.length) {
          const p = order[idx]; idx += 1;
          if (D.generation !== myGen) return;
          const file = snap.files.find((f) => f.path === p);
          const have = D.texts[p];
          if (have && have.headLoaded && have.baseLoaded
            && have.headSha === snap.headSha && have.baseSha === snap.baseSha) {
            D.prefetchDone += 1;
            if (p === D.file) render();
            continue;
          }
          try {
            const hr = await fetchJSON(`/api/approvals/${snap.pr}/file?path=${encodeURIComponent(p)}&ref=${encodeURIComponent(snap.headSha)}`);
            if (D.generation !== myGen) return;
            const hp = await hr.json().catch(() => ({}));
            if (D.generation !== myGen) return;
            if (!hr.ok) throw new Error(hp.message || `读取正文失败（${hr.status}）`);
            let bp = { text: "", truncated: false };
            if (file && file.status !== "added") {
              const br = await fetchJSON(`/api/approvals/${snap.pr}/file?path=${encodeURIComponent(p)}&ref=${encodeURIComponent(snap.baseSha)}`);
              if (D.generation !== myGen) return;
              if (!br.ok) throw new Error(`读取 Base 正文失败（${br.status}）`);
              bp = await br.json().catch(() => ({}));
              if (D.generation !== myGen) return;
            }
            D.texts[p] = { base: bp.text || "", head: hp.text || "", headLoaded: true, baseLoaded: true, headSha: snap.headSha, baseSha: snap.baseSha, headTruncated: !!hp.truncated, baseTruncated: !!bp.truncated, error: "" };
          } catch (err) {
            if (D.generation !== myGen) return;
            if (!D.texts[p]?.headLoaded) {
              D.texts[p] = { base: "", head: "", headLoaded: false, baseLoaded: false, headTruncated: false, baseTruncated: false, error: String(err) };
            }
          }
          D.prefetchDone += 1;
          if (p === D.file) render();
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, order.length) }, run));
    } finally { if (D.generation === myGen) spin(-1); }
  }

  /* ---------- 顶栏/侧栏事件 ---------- */
  function bindTopbar() {
    document.querySelectorAll(".wb-mode").forEach((b) => {
      b.addEventListener("click", () => { D.mode = b.dataset.mode; D.active = null; render(); });
    });
    document.getElementById("wbMarks").addEventListener("change", (e) => { D.marks = e.target.checked; render(); });
    document.getElementById("wbDrawerBtn").addEventListener("click", () => {
      document.getElementById("wbBody").classList.toggle("drawer-open");
    });
    document.getElementById("wbDrawerFold").addEventListener("click", () => {
      document.getElementById("wbBody").classList.remove("drawer-open");
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
  window.DiffView = {
    mount: async (number) => {
      if (!bound) { bind(); bindTopbar(); bound = true; }
      document.getElementById("workbench").hidden = false;
      document.body.classList.add("wb-mode-on");
      D.view = readPref(PREF.view, "tree") === "flat" ? "flat" : "tree";
      const folded = readPref(PREF.folded(number), []);
      D.folded = new Set(Array.isArray(folded) ? folded : []);
      /* 窄屏下文件导航默认收起，避免占满阅读宽度；宽屏保持展开 */
      document.getElementById("wbBody").classList.toggle("nav-collapsed", window.innerWidth <= 900);
      document.getElementById("wbLoading").hidden = false;
      D.ref = null;
      refTextCache.clear();
      await load(number, false, false);
    },
    refresh: (number, force) => load(number, true, !!force),
    unmount: () => {
      document.getElementById("workbench").hidden = true;
      document.body.classList.remove("wb-mode-on");
      document.body.classList.remove("tbl-full-on");
      closeCellPopover();
      D.ref = null;
    },
  };
})();
