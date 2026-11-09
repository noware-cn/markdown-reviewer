/* 独立文档页：/doc/<路径> 与历史裸路径（….md / …csv）共用同一套渲染。 */
(function () {
  const esc = window.DiffModel.esc;
  const stateEl = document.getElementById("docState");
  const pageEl = document.getElementById("docPage");
  const crumbEl = document.getElementById("docCrumb");
  const refEl = document.getElementById("docRef");
  const encPath = (path) => String(path).split("/").map(encodeURIComponent).join("/");
  let current = "";
  let currentRef = "";

  const requestedPath = () => {
    const raw = location.pathname.startsWith("/doc/") ? location.pathname.slice(5) : location.pathname.slice(1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };

  const showError = (message, candidates) => {
    pageEl.hidden = true;
    stateEl.hidden = false;
    stateEl.innerHTML = `<div class="doc-state-box"><p class="doc-state-msg">${esc(message)}</p>`
      + (candidates && candidates.length
        ? `<p class="doc-state-head">可能是：</p><ul class="doc-cands">`
          + candidates.map((path) => `<li><a href="/doc/${encPath(path)}">${esc(path)}</a></li>`).join("")
          + `</ul>`
        : "")
      + `<p class="doc-state-foot"><a href="/">回到 PR 列表</a></p></div>`;
  };

  const csvTable = (text) => {
    const parsed = window.DiffModel.csvParse(text);
    if (!parsed.rows.length) return `<div class="dempty">（空 CSV 文件）</div>`;
    const [head, ...rest] = parsed.rows;
    const labels = head.cells;
    const cells = (row, tag) => row.cells.map((cell, i) => `<${tag} data-col="${i}" data-label="${esc(labels[i] ?? "")}">${esc(cell)}</${tag}>`).join("");
    return `<div class="table-shell is-csv"><div class="tscroll" tabindex="0" role="region" aria-label="CSV 数据表，可横向滚动"><table class="csv-table">`
      + `<thead><tr>${cells(head, "th")}</tr></thead>`
      + `<tbody>${rest.map((row) => `<tr>${cells(row, "td")}</tr>`).join("")}</tbody></table></div></div>`;
  };

  async function main() {
    const requested = requestedPath();
    document.title = `${requested.split("/").pop()} · noware-cn/workspace`;
    crumbEl.textContent = `正在读取 ${requested}`;
    const params = new URLSearchParams(location.search);
    currentRef = params.get("ref") || "";
    const query = `path=${encodeURIComponent(requested)}${currentRef ? `&ref=${encodeURIComponent(currentRef)}` : ""}`;

    let response;
    try {
      response = await fetch(`/api/doc?${query}`, { headers: { Accept: "application/json" } });
    } catch {
      showError("网络请求失败，请稍后重试。");
      return;
    }
    if (response.status === 401) {
      location.href = "/auth/login";
      return;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showError(payload.message || `打不开该文档（${response.status}）`, payload.candidates);
      return;
    }

    current = payload.path || requested;
    currentRef = payload.ref || currentRef;
    document.title = `${current.split("/").pop()} · noware-cn/workspace`;
    crumbEl.textContent = payload.requested && payload.requested !== current
      ? `${payload.requested} → ${current}`
      : current;
    refEl.textContent = currentRef ? `@${String(currentRef).slice(0, 7)}` : "";
    stateEl.hidden = true;
    pageEl.hidden = false;
    pageEl.innerHTML = /\.csv$/i.test(current)
      ? csvTable(payload.text || "")
      : window.DiffModel.renderMarkdown(payload.text || "");
    if (payload.truncated) {
      pageEl.insertAdjacentHTML("afterbegin", `<div class="error-box">文件超过 400 KB，以下内容已截断。</div>`);
    }
  }

  /* 站内跳转仍留在文档页；外链交给浏览器新页签。 */
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (!link) return;
    const href = link.getAttribute("href");
    if (!href || href.startsWith("#")) return;
    const resolved = window.DiffModel.resolveDocLink(href, current, { host: location.host });
    if (resolved.kind !== "repo") {
      if (resolved.kind === "external" || /^https?:\/\//i.test(href)) {
        link.target = "_blank";
        link.rel = "noopener";
      }
      return;
    }
    event.preventDefault();
    if (!resolved.isDoc) {
      location.href = `https://github.com/noware-cn/workspace/blob/${encodeURIComponent(currentRef || "main")}/${encPath(resolved.path)}`;
      return;
    }
    const suffix = currentRef ? `?ref=${encodeURIComponent(currentRef)}` : "";
    location.href = `/doc/${encPath(resolved.path)}${suffix}${resolved.anchor ? `#${resolved.anchor}` : ""}`;
  });

  main();
})();
