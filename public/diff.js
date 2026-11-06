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
  };

  const esc = window.DiffModel.esc;

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

  /* ---------- 文件列表 ---------- */
  function renderFiles() {
    const box = document.getElementById("wbFiles");
    if (!box) return;
    const filter = D.filter.toLowerCase();
    box.innerHTML = D.files
      .filter((f) => !filter || f.path.toLowerCase().includes(filter))
      .map((f) => {
        const mark = f.status === "added" ? "A" : f.status === "removed" ? "D" : f.status === "renamed" ? "R" : "M";
        const draftCount = D.drafts.filter((d) => d.path === f.path).length;
        const commentCount = D.commentsByPath ? (D.commentsByPath.get(f.path) || []).length : 0;
        const reviewed = draftCount > 0 || commentCount > 0;
        return `<div class="fitem${D.file === f.path ? " active" : ""}${reviewed ? " reviewed" : ""}" data-path="${esc(f.path)}" title="${reviewed ? "已有意见" : "未审阅"}">`
          + `<span class="fmark ${mark}">${mark}</span>`
          + `<span class="fname" title="${esc(f.path)}">${esc(f.path.split("/").pop())}</span>`
          + `<span class="fnum"><em>+${f.additions}</em> −${f.deletions}</span>`
          + (reviewed ? `<span class="fdot" title="草稿 ${draftCount} · 已有评论 ${commentCount}"></span>` : "")
          + (draftCount ? `<span class="wb-badge" style="position:static">${draftCount}</span>` : "")
          + `</div>`;
      }).join("") || `<div class="dempty">没有匹配的文件</div>`;
  }

  /* ---------- 章节树 ---------- */
  function renderChapters() {
    const box = document.getElementById("wbChapters");
    if (!box) return;
    const file = curFile();
    const textState = file && D.texts[file.path];
    if (!textState || !textState.headLoaded) { box.innerHTML = `<div class="dempty">加载正文后显示章节…</div>`; return; }
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
  function modelFor(file) {
    if (!file) return null;
    const head = textOf(file.path, "head");
    const base = textOf(file.path, "base");
    const key = file.path + "|" + (D.meta?.headSha || "");
    const hit = modelCache.get(key);
    if (hit && hit.head === head && hit.base === base && hit.patch === (file.patch || "")) return hit.value;
    const value = window.DiffModel.buildModel(head, base, file.patch || "");
    modelCache.set(key, { head, base, patch: file.patch || "", value });
    return value;
  }

  /* ---------- 阅读改动渲染 ---------- */
  function readingHTML(file) {
    const textState = D.texts[file.path];
    const errMsg = (textState && textState.error) || D.err;
    if (!textState || !textState.headLoaded) {
      if (errMsg) return `<div class="error-box">${esc(errMsg)} <button type="button" class="retry" data-retry="1">重试</button></div>`;
      return `<div class="dempty">正在加载正文…</div>`;
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
        + baseBlocks.map((b) => `<div class="md-block" data-base-line="${b.startLine}">${b.html}</div>`).join("");
    }

    const model = modelFor(file);
    // added file: mark all blocks added
    if (file.status === "added") {
      return model.headBlocks.map((b) => blockHtml(b, { forceAdded: true })).join("");
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
    if (opts.forceAdded || b.changeState === "added") { cls += " is-added"; tag = `<span class="diff-tag add">新增</span>`; }
    else if (b.changeState === "modified-new") {
      cls += " is-modified-new";
      tag = `<span class="diff-tag mod">修改</span>`;
    }
    else if (b.changeState === "partial") {
      cls += " is-modified-new";
      tag = `<span class="diff-tag mod">修改</span>`;
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
    // 列表：给每个 <li> 绑定源码行号（按 raw 顺序，跳过围栏内的假标记行；嵌套项也有行号）
    if ((b.type === "ul" || b.type === "ol") && b.raw) {
      const itemLines = window.DiffModel.listItemLines(b.raw, b.startLine);
      const liCount = (bodyHtml.match(/<li\\b[^>]*>/g) || []).length;
      // 映射数量不一致时整体放弃行号映射，绝不把后续 <li> 错配到别的源码行。
      if (itemLines.length === liCount) {
        let liIdx = 0;
        bodyHtml = bodyHtml.replace(/<li\\b([^>]*)>/g, (_match, attrs) => {
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
        return tag + inserts.map((item) => `<li class="list-deleted-item">${insertionHtml(item.change, file)}</li>`).join("");
      }
      const mapped = /\bdata-line="(\d+)"/.exec(attrs || "");
      stack.push(mapped ? Number(mapped[1]) : null);
      return tag;
    });
    return { html, unplaced };
  }

  function insertionHtml(ch, file) {
    return `<div class="del-block" data-old-line="${ch.oldStart}" data-change="${ch.id}">`
      + `<div class="del-head">删除（Base L${ch.oldStart}${ch.oldEnd > ch.oldStart ? "–" + ch.oldEnd : ""}）</div>`
      + `<div class="del-body"><pre>${esc(ch.oldText)}</pre></div>`
      + `<div class="del-jump" data-jump-source="${esc(file.path)}">在源码 Diff 中查看 →</div></div>`;
  }

  function sideBySideHTML(file) {
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
      parts.push(`<div class="composer"><div class="canchor">${esc(a.path.split("/").pop())} · L${a.start}${a.end > a.start ? "–" + a.end : ""} · side=RIGHT</div>`
        + `<textarea id="wbcText" data-key="${esc(a.path + ":" + a.start + ":" + a.end)}" placeholder="写下判断依据或要求补充的内容。">${esc(a.body || "")}</textarea>`
        + `<div class="crow"><button class="btn" type="button" data-act="save">存为草稿</button><button class="btn ghost" type="button" data-act="cancel">取消</button></div></div>`);
    }
    // drafts
    if (D.drafts.length) {
      parts.push(`<div style="font-size:12px;color:var(--ink-3);margin:10px 0 4px;">本地草稿（${D.drafts.length}）</div>`);
      parts.push(D.drafts.map((d, idx) => {
        const outdated = !d.headSha || d.headSha !== D.meta?.headSha;
        return `<div class="ddraft"><div class="dloc">${esc(d.path.split("/").pop())} · L${d.start}${d.end > d.start ? "–" + d.end : ""}${outdated ? " · 版本已变化" : ""}</div>`
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
    target.style.outline = "2px solid #c8102e";
    setTimeout(() => { target.style.outline = ""; }, 1500);
    document.getElementById("navCount").textContent = `${D.navIdx + 1}/${els.length}`;
  }
  function updateNavFloat() {
    const el = document.getElementById("navFloat");
    if (!el) return;
    const wb = document.getElementById("workbench");
    el.hidden = wb.hidden || !D.file;
    if (!el.hidden) {
      const n = changeElements().length;
      document.getElementById("navCount").textContent = D.navIdx >= 0 ? `${D.navIdx + 1}/${n}` : `0/${n}`;
    }
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
    document.querySelectorAll(".wb-mode").forEach((b) => b.classList.toggle("on", b.dataset.mode === D.mode));
    document.getElementById("wbMarks").checked = D.marks;
    document.getElementById("wbDraftCount").textContent = String(D.drafts.length);

    renderFiles();
    renderChapters();

    const doc = document.getElementById("wbDoc");
    doc.classList.toggle("marks-off", !D.marks);
    const file = curFile();
    const content = document.getElementById("wbContent");
    if (!file) { content.innerHTML = `<div class="dempty">该 PR 没有变更文件。</div>`; }
    else if (D.mode === "unified") content.innerHTML = unifiedHTML(file);
    else if (D.mode === "split") content.innerHTML = splitHTML(file);
    else if (D.mode === "sidebyside") content.innerHTML = sideBySideHTML(file);
    else content.innerHTML = readingHTML(file);

    document.getElementById("wbDrawerBody").innerHTML = drawerHTML();
    // 恢复当前视图的滚动位置，记录本次 key
    const key = `${D.file}:${D.mode}`;
    D.lastViewKey = key;
    const saved = D.scrollPos[key];
    const docEl = document.getElementById("wbDoc");
    requestAnimationFrame(() => { docEl.scrollTop = saved ?? 0; });
    updateNavFloat();
  }

  /* ---------- 选择文字反查行号 ---------- */
  function locateFromSelection(sel) {
    const elementOf = (n) => (n && n.nodeType === 1 ? n : n?.parentElement);
    const lineOf = (n) => {
      const el = elementOf(n);
      if (!el?.closest) return null;
      const codeLine = el.closest(".code-line[data-line]");
      if (codeLine) {
        const line = Number(codeLine.dataset.line);
        return Number.isInteger(line) && line > 0 ? line : null;
      }
      const block = el.closest(".md-block[data-line][data-end-line]");
      if (block && Number(block.dataset.line) === Number(block.dataset.endLine)) {
        const line = Number(block.dataset.line);
        return Number.isInteger(line) && line > 0 ? line : null;
      }
      return null;
    };
    const s = lineOf(sel?.anchorNode);
    const e = lineOf(sel?.focusNode);
    if (s && e) return { start: Math.min(s, e), end: Math.max(s, e) };
    return null;
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
    });

    // 章节跳转（绑在 wbNav 上，因为章节元素在导航栏内）
    document.getElementById("wbChapters").addEventListener("click", (e) => {
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
        D.drafts.push({ id: newDraftId(), path: a.path, start: a.start, end: a.end, body: text, headSha: D.meta.headSha });
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
      if (e.target.closest("#dselchip") || e.target.closest(".composer")) return;
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (!text || text.length < 2) { document.getElementById("dselchip").hidden = true; return; }
      const rng = locateFromSelection(sel);
      if (!rng) { document.getElementById("dselchip").hidden = true; return; }
      // 校验选区行号在 diff hunk 内，否则不显示评论按钮
      const cl = modelFor(curFile())?.parsed?.commentableHeadLines;
      if (cl && (!cl.has(rng.start) || !cl.has(rng.end))) { document.getElementById("dselchip").hidden = true; return; }
      const chip = document.getElementById("dselchip");
      chip.dataset.start = String(rng.start);
      chip.dataset.end = String(rng.end);
      chip.style.left = Math.min(e.clientX + 8, window.innerWidth - 190) + "px";
      chip.style.top = (e.clientY + 10) + "px";
      chip.hidden = false;
      chip.textContent = "评论所选 L" + rng.start + (rng.end > rng.start ? "–" + rng.end : "");
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
      if (e.key === "n") { e.preventDefault(); gotoChange(1); }
      else if (e.key === "p") { e.preventDefault(); gotoChange(-1); }
      else if (e.key === "1") { D.active = null; D.mode = "reading"; render(); }
      else if (e.key === "2") { D.active = null; D.mode = "sidebyside"; render(); }
      else if (e.key === "3") { D.active = null; D.mode = "unified"; render(); }
      else if (e.key === "4") { D.active = null; D.mode = "split"; render(); }
    });
    document.getElementById("dselchip").addEventListener("click", () => {
      const chip = document.getElementById("dselchip");
      D.active = { path: D.file, start: Number(chip.dataset.start), end: Number(chip.dataset.end), quote: "" };
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
    renderFiles();
    renderChapters();
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
    const summary = myDrafts.length
      ? `${eventLabel}（附 ${myDrafts.length} 条行级意见）`
      : eventLabel;
    if (!confirm(`确认提交 Review：${summary}？\n\n将以你的名义写入 GitHub，提交后不可撤回。`)) return;
    const btn = document.getElementById("wbSubmit");
    btn.disabled = true;
    btn.textContent = "提交中…";
    try {
      const payload = {
        commit_id: myHeadSha,
        event: myEvent,
        comments: myDrafts.map((d) => ({
          path: d.path, body: d.body, line: d.end, side: "RIGHT",
          start_line: d.start < d.end ? d.start : undefined,
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
        toast("已提交（但页面已刷新）");
        return;
      }
      toast(`已写入 GitHub：review #${data.review.id}（${data.review.comments} 条）`);
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
    document.getElementById("wbFiles").addEventListener("click", (e) => {
      const item = e.target.closest(".fitem");
      if (item) selectFile(item.dataset.path);
    });
  }

  let bound = false;
  window.DiffView = {
    mount: async (number) => {
      if (!bound) { bind(); bindTopbar(); bound = true; }
      document.getElementById("workbench").hidden = false;
      document.body.classList.add("wb-mode-on");
      document.getElementById("wbLoading").hidden = false;
      await load(number, false, false);
    },
    refresh: (number, force) => load(number, true, !!force),
    unmount: () => {
      document.getElementById("workbench").hidden = true;
      document.body.classList.remove("wb-mode-on");
    },
  };
})();
