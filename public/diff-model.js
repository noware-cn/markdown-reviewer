/* diff-model.js — 统一差异模型：源码 patch + Markdown 块级映射
 *
 * 输入：GitHub pull files 的 patch 字符串 + base/head 两份 Markdown 原文。
 * 输出：
 *   - headBlocks：Head 文档的块序列（每块带行号、类型、所属章节、变更状态）
 *   - baseBlocks：Base 文档的块序列
 *   - changes：DocumentChange 列表（added/deleted/modified），modified 携带新旧内容
 *   - headInsertions：需要在 Head 文档特定位置插入的"未配对删除块"（按 afterNewLine 排序）
 *
 * 三种阅读模式共用本模型：
 *   - 阅读改动：headBlocks 顺序渲染 + headInsertions 插入 + modified 块挂旧内容
 *   - 前后对照（P1）：分别渲染 headBlocks / baseBlocks
 *   - 源码 Diff：直接用 patch rows（unified/split），不依赖本模型
 */
(function () {
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- 1. patch 解析：保留 hunk 上下文，建立 old↔new 行号映射 ---------- */
  function parsePatch(patch) {
    const ops = [];
    const hunks = [];
    let cur = null;
    let oldNo = 0;
    let newNo = 0;
    const lines = String(patch || "").split("\n");
    for (const line of lines) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (h) {
        oldNo = Number(h[1]);
        newNo = Number(h[2]);
        cur = { header: line, ops: [] };
        hunks.push(cur);
        continue;
      }
      if (!cur) continue;
      let op;
      if (line.startsWith("+")) {
        op = { t: "add", old: null, new: newNo, text: line.slice(1) };
        newNo += 1;
      } else if (line.startsWith("-")) {
        op = { t: "del", old: oldNo, new: null, text: line.slice(1) };
        oldNo += 1;
      } else {
        // context line (space) or trailing empty string at EOF
        op = { t: "ctx", old: oldNo, new: newNo, text: line.startsWith(" ") ? line.slice(1) : line };
        oldNo += 1;
        newNo += 1;
      }
      ops.push(op);
      cur.ops.push(op);
    }
    const oldToNew = new Map();
    const newToOld = new Map();
    const addedLines = new Set();
    const deletedLines = new Set();
    for (const op of ops) {
      if (op.t === "ctx") { oldToNew.set(op.old, op.new); newToOld.set(op.new, op.old); }
      else if (op.t === "add") addedLines.add(op.new);
      else if (op.t === "del") deletedLines.add(op.old);
    }
    return { ops, hunks, oldToNew, newToOld, addedLines, deletedLines };
  }

  /* ---------- 2. Markdown 分块：保留起止行号、类型、章节路径 ---------- */
  const plainText = (raw) =>
    raw.replace(/`/g, "").replace(/\*\*/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/^#+\s*/, "").trim();

  function inlineMd(raw) {
    let s = esc(raw);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }

  function mdBlocks(text) {
    const lines = String(text || "").split(/\r?\n/);
    const blocks = [];
    const hstack = []; // heading path
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i += 1; continue; }
      const start = i + 1;

      // code fence
      if (/^```/.test(line)) {
        const body = [];
        i += 1;
        while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i += 1; }
        i += 1;
        blocks.push(mkBlock(start, i, "code", body.join("\n"), hstack));
        continue;
      }
      // heading
      const hd = /^(#{1,6})\s+(.*)$/.exec(line);
      if (hd) {
        const level = hd[1].length;
        const title = plainText(hd[2]);
        while (hstack.length && hstack[hstack.length - 1].level >= level) hstack.pop();
        hstack.push({ level, title });
        i += 1;
        blocks.push(mkBlock(start, start, "h" + level, hd[2], hstack, { title, level }));
        continue;
      }
      // list
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\.\s+/.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
          i += 1;
        }
        blocks.push(mkBlock(start, i, ordered ? "ol" : "ul", items.join("\n"), hstack));
        continue;
      }
      // blockquote
      if (/^\s*>/.test(line)) {
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, "")); i += 1; }
        blocks.push(mkBlock(start, i, "quote", body.join("\n"), hstack));
        continue;
      }
      // table
      if (/^\s*\|.*\|\s*$/.test(line)) {
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i].trim()); i += 1; }
        blocks.push(mkBlock(start, i, "table", rows.join("\n"), hstack));
        continue;
      }
      // hr
      if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
        blocks.push(mkBlock(start, start, "hr", line.trim(), hstack));
        i += 1;
        continue;
      }
      // paragraph (default)
      const para = [];
      while (i < lines.length && lines[i].trim() &&
        !/^(#{1,6}\s|```|\s*>|\s*([-*+]|\d+\.)\s|\s*\||^(-{3,}|\*{3,})$)/.test(lines[i])) {
        para.push(lines[i]);
        i += 1;
      }
      blocks.push(mkBlock(start, i, "para", para.join("\n"), hstack));
    }
    return blocks;
  }

  function mkBlock(start, end, type, raw, hstack, extra) {
    const sectionPath = hstack.map((h) => h.title);
    return Object.assign({
      startLine: start,
      endLine: end,
      type,
      raw,
      sectionPath,
      section: sectionPath[sectionPath.length - 1] || "",
      html: renderBlockHtml(type, raw, extra),
    }, extra || {});
  }

  function renderBlockHtml(type, raw, extra) {
    if (type === "h1" || type === "h2" || type === "h3" || type === "h4") {
      const lvl = Math.min(Number(type[1]) + 1, 4);
      return `<h${lvl}>${inlineMd(raw)}</h${lvl}>`;
    }
    if (type === "code") return `<pre><code>${esc(raw)}</code></pre>`;
    if (type === "ul" || type === "ol") {
      const items = raw.split("\n").map((t) => `<li>${inlineMd(t)}</li>`).join("");
      return `<${type}>${items}</${type}>`;
    }
    if (type === "quote") return `<blockquote>${raw.split("\n").map((t) => `<p>${inlineMd(t)}</p>`).join("")}</blockquote>`;
    if (type === "table") {
      const rows = raw.split("\n");
      const cells = (row) => row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(rows[0] || "");
      const body = rows.slice(1).filter((r) => !/^\|[\s:|-]+\|$/.test(r)).map(cells);
      return `<table class="mdtable"><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join("")}</tr></thead>`
        + `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    }
    if (type === "hr") return "<hr>";
    return `<p>${raw.split("\n").map(inlineMd).join(" ")}</p>`;
  }

  /* ---------- 3. 文本相似度（中文按字二元组） ---------- */
  function normText(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }
  function bigrams(s) {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
    if (s.length === 1) out.add(s);
    return out;
  }
  function similarity(a, b) {
    const na = normText(a);
    const nb = normText(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const A = bigrams(na);
    const B = bigrams(nb);
    let inter = 0;
    for (const g of A) if (B.has(g)) inter += 1;
    return inter / Math.max(A.size, B.size);
  }

  /* ---------- 4. 构建 DocumentChange ---------- */
  function buildModel(headText, baseText, patch) {
    const parsed = parsePatch(patch);
    const headBlocks = mdBlocks(headText);
    const baseBlocks = mdBlocks(baseText);
    let cid = 0;

    // 4.1 在每个 block 上标注行级覆盖
    for (const b of headBlocks) {
      let hit = 0;
      for (let l = b.startLine; l <= b.endLine; l += 1) if (parsed.addedLines.has(l)) hit += 1;
      b.addedHits = hit;
      b.changeState = hit === 0 ? "normal" : (hit >= (b.endLine - b.startLine + 1) ? "added" : "partial");
    }
    for (const b of baseBlocks) {
      let hit = 0;
      for (let l = b.startLine; l <= b.endLine; l += 1) if (parsed.deletedLines.has(l)) hit += 1;
      b.deletedHits = hit;
      b.changeState = hit === 0 ? "normal" : (hit >= (b.endLine - b.startLine + 1) ? "removed" : "partial");
    }

    // 4.2 扫描每个 hunk，切分出 del-run / add-run / ctx
    const changes = [];
    const headInsertions = []; // {afterNewLine, change}
    const MODIFIED_THRESHOLD = 0.18;

    for (const hunk of parsed.hunks) {
      // segment: walk ops, group consecutive del and add
      const segs = [];
      let run = null;
      for (const op of hunk.ops) {
        if (op.t === "ctx") {
          if (run) { segs.push(run); run = null; }
          segs.push({ t: "ctx", op });
        } else {
          if (!run || run.t !== op.t) {
            if (run) segs.push(run);
            run = { t: op.t, ops: [] };
          }
          run.ops.push(op);
        }
      }
      if (run) segs.push(run);

      // pair adjacent del-run → add-run
      for (let i = 0; i < segs.length; i += 1) {
        const seg = segs[i];
        if (seg.t === "del") {
          const next = segs[i + 1];
          const delText = seg.ops.map((o) => o.text).join("\n");
          const delStartOld = seg.ops[0].old;
          const delEndOld = seg.ops[seg.ops.length - 1].old;
          let paired = false;
          if (next && next.t === "add") {
            const addText = next.ops.map((o) => o.text).join("\n");
            const sim = similarity(delText, addText);
            if (sim >= MODIFIED_THRESHOLD) {
              const addStartNew = next.ops[0].new;
              const addEndNew = next.ops[next.ops.length - 1].new;
              changes.push({
                id: "c" + (cid++),
                type: "modified",
                oldStart: delStartOld, oldEnd: delEndOld,
                newStart: addStartNew, newEnd: addEndNew,
                oldText: delText, newText: addText,
                similarity: sim,
              });
              paired = true;
              i += 1; // consume add-run
            }
          }
          if (!paired) {
            // 找 anchor：hunk 内最近的前一个 ctx op 的 new 行号；否则用后一个 ctx 的 new-1
            let anchorNew = null;
            for (let j = i - 1; j >= 0; j -= 1) {
              if (segs[j].t === "ctx") { anchorNew = segs[j].op.new; break; }
            }
            if (anchorNew === null) {
              for (let j = i + 1; j < segs.length; j += 1) {
                if (segs[j].t === "ctx") { anchorNew = segs[j].op.new - 1; break; }
              }
            }
            const ch = {
              id: "c" + (cid++),
              type: "deleted",
              oldStart: delStartOld, oldEnd: delEndOld,
              newStart: undefined, newEnd: undefined,
              oldText: delText,
              anchorNew,
            };
            changes.push(ch);
            if (anchorNew !== null) headInsertions.push({ afterNewLine: anchorNew, change: ch });
          }
        } else if (seg.t === "add") {
          // 独立新增 run（未被 modified 配对消费）
          const addStartNew = seg.ops[0].new;
          const addEndNew = seg.ops[seg.ops.length - 1].new;
          changes.push({
            id: "c" + (cid++),
            type: "added",
            oldStart: undefined, oldEnd: undefined,
            newStart: addStartNew, newEnd: addEndNew,
            newText: seg.ops.map((o) => o.text).join("\n"),
          });
        }
      }
    }

    // 4.3 把 modified 变化反标到 head 块上（块落在 newStart..newEnd 内 → modified-new）
    const modifiedChanges = changes.filter((c) => c.type === "modified");
    for (const b of headBlocks) {
      const m = modifiedChanges.find((c) => b.startLine <= c.newEnd && b.endLine >= c.newStart);
      if (m) {
        b.changeState = "modified-new";
        b.pairedChange = m;
      }
    }

    // 4.4 按 anchor 排序插入点
    headInsertions.sort((a, b) => a.afterNewLine - b.afterNewLine);

    return { parsed, headBlocks, baseBlocks, changes, headInsertions };
  }

  window.DiffModel = { parsePatch, mdBlocks, buildModel, similarity, esc };
})();
