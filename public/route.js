/* =====================================================================
   前端路由：URL 是唯一可信状态来源
   /                       列表（?state=all|open|merged&q=）
   /pr/16                  工作台，默认第一个文件
   /pr/16/blob/<路径>?mode=split#L120-L140
   /doc/<路径>?ref=<sha>#标题
   约定：mode=reading 是默认值，不写进 URL；路径按段编码，保留斜杠。
   ===================================================================== */
(function () {
  const MODES = ["reading", "sidebyside", "unified", "split"];
  const LIST_STATES = ["all", "open", "merged"];

  const encPath = (path) => String(path || "").split("/").map(encodeURIComponent).join("/");
  const decPath = (path) => String(path || "").split("/").map((seg) => {
    try { return decodeURIComponent(seg); } catch { return seg; }
  }).join("/");

  const parseAnchor = (hash) => {
    const raw = String(hash || "").replace(/^#/, "");
    if (!raw) return { line: null, endLine: null, heading: null };
    const m = raw.match(/^L(\d+)(?:-L?(\d+))?$/i);
    if (m) {
      const line = Number(m[1]);
      const end = m[2] ? Number(m[2]) : 0;
      return { line: line > 0 ? line : null, endLine: end > line ? end : null, heading: null };
    }
    let heading = raw;
    try { heading = decodeURIComponent(raw); } catch { /* 保留原样 */ }
    return { line: null, endLine: null, heading: heading || null };
  };

  const parse = (input) => {
    const url = input instanceof URL ? input : new URL(input || location.href, location.origin);
    const path = url.pathname;

    if (path.startsWith("/doc/")) {
      return { kind: "doc", path: decPath(path.slice(5)), search: url.search, hash: url.hash };
    }

    const pr = path.match(/^\/pr\/(\d+)(?:\/blob\/(.+?))?\/?$/);
    if (pr) {
      const mode = url.searchParams.get("mode");
      const commit = url.searchParams.get("commit");
      const anchor = parseAnchor(url.hash);
      return {
        kind: "pr",
        n: Number(pr[1]),
        file: pr[2] ? decPath(pr[2]) : null,
        mode: MODES.includes(mode) ? mode : null,
        commit: commit && /^[0-9a-f]{7,40}$/i.test(commit) ? commit.toLowerCase() : null,
        line: anchor.line,
        endLine: anchor.endLine,
        heading: anchor.heading,
      };
    }

    const state = url.searchParams.get("state");
    const q = url.searchParams.get("q");
    return {
      kind: "list",
      state: LIST_STATES.includes(state) ? state : null,
      q: q || null,
    };
  };

  const build = (state) => {
    if (!state || state.kind === "list") {
      const params = new URLSearchParams();
      if (state && state.state) params.set("state", state.state);
      if (state && state.q) params.set("q", state.q);
      const qs = params.toString();
      return qs ? `/?${qs}` : "/";
    }
    if (state.kind === "doc") {
      return `/doc/${encPath(state.path)}${state.search || ""}${state.hash || ""}`;
    }
    let url = `/pr/${state.n}`;
    if (state.file) url += `/blob/${encPath(state.file)}`;
    const params = new URLSearchParams();
    if (state.mode && state.mode !== "reading") params.set("mode", state.mode);
    if (state.commit) params.set("commit", state.commit);
    if (params.toString()) url += `?${params.toString()}`;
    if (state.line) {
      url += `#L${state.line}${state.endLine && state.endLine > state.line ? `-L${state.endLine}` : ""}`;
    } else if (state.heading) {
      url += `#${encodeURIComponent(state.heading)}`;
    }
    return url;
  };

  const href = () => location.pathname + location.search + location.hash;
  const write = (method, state) => {
    const next = build(state);
    if (next === href()) return next;
    history[method](state, "", next);
    return next;
  };

  window.AppRoute = {
    parse,
    build,
    parseAnchor,
    encPath,
    decPath,
    push: (state) => write("pushState", state),
    replace: (state) => write("replaceState", state),
    current: href,
    onPop: (cb) => window.addEventListener("popstate", () => cb(parse())),
  };
})();
