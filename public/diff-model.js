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
 *
 * .csv 文件不走 Markdown 分块：csvParse / csvModel 把文件解析成行记录，
 * 用同一份 patch 标注每一行的状态（新增 / 修改 / 删除），供表格视图渲染。
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
      // 跳过 "\ No newline at end of file" 标记行，不当作上下文
      if (line.startsWith("\\")) continue;
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
    const commentableHeadLines = new Set(); // head-side lines inside any hunk (add or ctx)
    for (const op of ops) {
      if (op.t === "ctx") { oldToNew.set(op.old, op.new); newToOld.set(op.new, op.old); commentableHeadLines.add(op.new); }
      else if (op.t === "add") { addedLines.add(op.new); commentableHeadLines.add(op.new); }
      else if (op.t === "del") deletedLines.add(op.old);
    }
    return { ops, hunks, oldToNew, newToOld, addedLines, deletedLines, commentableHeadLines };
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

  /* 列表区间：用 marked lexer 一次算完整边界（含续行 / 空行 / 嵌套 / 懒续行）。
     marked 未就绪时退回「连续标记行」分组，保证降级渲染仍是列表。 */
  function listRanges(lines) {
    const index = new Map(); // startLine -> { end, ordered }
    const marker = /^\s*([-*+]|\d+[.)])\s+/;
    if (!window.marked) {
      for (let k = 0; k < lines.length; k += 1) {
        if (!marker.test(lines[k])) continue;
        let end = k + 1;
        while (end < lines.length && marker.test(lines[end])) end += 1;
        index.set(k + 1, { end, ordered: /^\s*\d+[.)]\s+/.test(lines[k]) });
        k = end - 1;
      }
      return index;
    }
    let lineNo = 0;
    for (const tok of window.marked.lexer(lines.join("\n"))) {
      if (tok.type === "list") {
        const raw = tok.raw.replace(/\n+$/, "");
        index.set(lineNo + 1, { end: lineNo + raw.split("\n").length, ordered: !!tok.ordered });
      }
      lineNo += tok.raw.split("\n").length - 1;
    }
    return index;
  }

  function mdBlocks(text) {
    const lines = String(text || "").split(/\r?\n/);
    const blocks = [];
    const hstack = []; // heading path
    const listIndex = listRanges(lines);
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
      // list — 使用 lexer 预先算好的完整区间，保留嵌套 / 续行 / 空行列表
      const listHit = listIndex.get(start);
      if (listHit) {
        const raw = lines.slice(i, listHit.end).join("\n");
        i = listHit.end;
        blocks.push(mkBlock(start, i, listHit.ordered ? "ol" : "ul", raw, hstack));
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
      while (i < lines.length && lines[i].trim()
        && !listIndex.has(i + 1)
        && !/^(#{1,6}\s|```|\s*>|^(-{3,}|\*{3,})$)/.test(lines[i])) {
        para.push(lines[i]);
        i += 1;
      }
      // 兜底：命中了上面某个分支但该分支不接管时（如缩进代码行），保证 i 前进
      if (!para.length) { para.push(lines[i]); i += 1; }
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
    // 使用 marked 做高质量渲染；未加载则降级到内置渲染
    if (window.marked) {
      let src = raw;
      if (type === "code") src = "```\n" + raw + "\n```";
      else if (type === "h1" || type === "h2" || type === "h3" || type === "h4") src = "#".repeat(Number(type[1])) + " " + raw;
      // ul/ol 的 raw 已保留原始列表标记，直接交给 marked
      else if (type === "quote") src = raw.split("\n").map((t) => "> " + t).join("\n");
      try {
        const out = window.marked.parse(src);
        return window.DOMPurify ? window.DOMPurify.sanitize(out) : esc(src);
      } catch (e) { /* fall through */ }
    }
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

  /* 列表项源码区间：直接遍历 marked 的 list/list_item token。
     代码块中的假 marker 不会成为 list_item token，因此不会误映射。 */
  function listItemRanges(raw, startLine) {
    const source = String(raw || "");
    if (!window.marked) return [];
    const out = [];
    const lineAt = (offset) => startLine + source.slice(0, offset).split("\n").length - 1;
    const walk = (tokens, segment, baseOffset) => {
      let cursor = 0;
      for (const token of tokens || []) {
        if (token.type !== "list" || !Array.isArray(token.items)) continue;
        for (const item of token.items) {
          const itemRaw = item.raw || "";
          if (!itemRaw) continue;
          const local = segment.indexOf(itemRaw, cursor);
          if (local < 0) continue;
          const absolute = baseOffset + local;
          const contentEnd = absolute + itemRaw.replace(/\n+$/, "").length;
          out.push({ startLine: lineAt(absolute), endLine: lineAt(Math.max(absolute, contentEnd - 1)) });
          walk(item.tokens, itemRaw, absolute);
          cursor = local + itemRaw.length;
        }
      }
    };
    walk(window.marked.lexer(source), source, 0);
    return out;
  }

  function listItemLines(raw, startLine) {
    return listItemRanges(raw, startLine).map((item) => item.startLine);
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
  /* 把一个 hunk 的 op 序列切成 ctx / del-run / add-run 段，供 Markdown 与 CSV 共用。 */
  function hunkSegments(ops) {
    const segs = [];
    let run = null;
    for (const op of ops) {
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
    return segs;
  }

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
      const segs = hunkSegments(hunk.ops);

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
            // 无论能否定位 anchor 都放入 headInsertions，anchor 为 null 时放在文档开头
            headInsertions.push({ afterNewLine: anchorNew ?? 0, change: ch });
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
      const matches = modifiedChanges.filter((c) => b.startLine <= c.newEnd && b.endLine >= c.newStart);
      if (matches.length) {
        b.changeState = "modified-new";
        b.pairedChanges = matches;
        b.pairedChange = matches[0]; // 向后兼容
      }
    }

    // 4.4 按 anchor 排序插入点
    headInsertions.sort((a, b) => a.afterNewLine - b.afterNewLine);

    return { parsed, headBlocks, baseBlocks, changes, headInsertions };
  }

  /* ---------- 5. CSV：RFC4180 解析 + 行级差异 ---------- */
  const isCsvPath = (path) => /\.csv$/i.test(String(path || ""));

  /* 一条记录可能跨多行（引号内的换行），因此记录带起止行号；
     行号必须与 GitHub patch 的行号一致，评论才能定位。 */
  function csvParse(text) {
    const src = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const rows = [];
    let cells = [];
    let field = "";
    let quoted = false;
    let inQuotes = false;
    let line = 1;
    let rowStart = 1;
    const endField = () => { cells.push(field); field = ""; quoted = false; };
    const endRow = () => {
      endField();
      rows.push({
        cells,
        startLine: rowStart,
        endLine: line,
        state: "normal",
        before: null,
        changedCells: null,
        commentLine: null,
      });
      cells = [];
      line += 1;
      rowStart = line;
    };
    for (let i = 0; i < src.length; i += 1) {
      const c = src[i];
      if (inQuotes) {
        if (c === '"') {
          if (src[i + 1] === '"') { field += '"'; i += 1; }
          else inQuotes = false;
        } else if (c === "\n") {
          line += 1;
          field += "\n";
        } else field += c;
        continue;
      }
      if (c === '"' && !field && !quoted) { inQuotes = true; quoted = true; continue; }
      if (c === ",") { endField(); continue; }
      if (c === "\n") { endRow(); continue; }
      field += c;
    }
    if (field || cells.length || quoted) endRow();
    const columns = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
    return { rows, columns };
  }

  const csvLineIndex = (rows) => {
    const index = new Map();
    for (const row of rows) for (let l = row.startLine; l <= row.endLine; l += 1) index.set(l, row);
    return index;
  };

  /* run 里的行 → 记录（跨行记录只算一次）。 */
  function csvRowsForLines(index, lines) {
    const seen = new Set();
    const out = [];
    for (const line of lines) {
      const row = index.get(line);
      if (row && !seen.has(row)) { seen.add(row); out.push(row); }
    }
    return out.sort((a, b) => a.startLine - b.startLine);
  }

  /* 删除行落点：hunk 内最近的前一个上下文行；没有则用后一个上下文行 - 1。 */
  function csvAnchorLine(segs, idx) {
    for (let j = idx - 1; j >= 0; j -= 1) if (segs[j].t === "ctx") return segs[j].op.new;
    for (let j = idx + 1; j < segs.length; j += 1) if (segs[j].t === "ctx") return segs[j].op.new - 1;
    return 0;
  }

  function csvChangedCells(nextCells, prevCells) {
    const changed = new Set();
    const total = Math.max(nextCells.length, prevCells.length);
    for (let i = 0; i < total; i += 1) if ((nextCells[i] ?? "") !== (prevCells[i] ?? "")) changed.add(i);
    return changed;
  }

  /* 行级差异：把 patch 的 del-run / add-run 按顺序配成"修改行"，
     多出来的行是纯新增 / 纯删除；跨行记录按任意一行命中即算该行发生变化。 */
  function csvModel(headText, baseText, patch) {
    const head = csvParse(headText);
    const base = csvParse(baseText);
    const parsed = parsePatch(patch || "");
    const headAt = csvLineIndex(head.rows);
    const baseAt = csvLineIndex(base.rows);
    const removed = [];

    for (const hunk of parsed.hunks) {
      const segs = hunkSegments(hunk.ops);
      for (let i = 0; i < segs.length; i += 1) {
        const seg = segs[i];
        if (seg.t === "add") {
          for (const row of csvRowsForLines(headAt, seg.ops.map((op) => op.new))) {
            if (row.state === "normal") row.state = "added";
          }
          continue;
        }
        if (seg.t !== "del") continue;
        const delRows = csvRowsForLines(baseAt, seg.ops.map((op) => op.old));
        const next = segs[i + 1];
        const addRows = next && next.t === "add" ? csvRowsForLines(headAt, next.ops.map((op) => op.new)) : [];
        const paired = Math.min(delRows.length, addRows.length);
        for (let k = 0; k < paired; k += 1) {
          const row = addRows[k];
          const before = delRows[k];
          row.state = "modified";
          row.before = before;
          row.changedCells = csvChangedCells(row.cells, before.cells);
          before.state = "partial";
        }
        for (let k = paired; k < addRows.length; k += 1) addRows[k].state = "added";
        // 配对的删除行已经体现在"修改行"里；多出来的删除行紧跟配对行之后
        const afterLine = paired ? addRows[paired - 1].endLine : csvAnchorLine(segs, i);
        for (let k = paired; k < delRows.length; k += 1) {
          delRows[k].state = "removed";
          removed.push({ row: delRows[k], afterLine });
        }
        if (addRows.length) i += 1;
      }
    }

    // 评论锚点：记录内第一条落在 hunk 里的行（GitHub 只允许在 diff 行上评论）
    for (const row of head.rows) {
      for (let l = row.startLine; l <= row.endLine; l += 1) {
        if (parsed.commentableHeadLines.has(l)) { row.commentLine = l; break; }
      }
    }

    const stats = { added: 0, modified: 0, removed: removed.length };
    for (const row of head.rows) {
      if (row.state === "added") stats.added += 1;
      else if (row.state === "modified") stats.modified += 1;
    }

    return {
      head,
      base,
      parsed,
      columns: Math.max(head.columns, base.columns),
      removed: removed.sort((a, b) => a.afterLine - b.afterLine),
      stats,
    };
  }

  /* ---------- 文档链接：把 href 解析成仓库内路径 ---------- */
  const DOC_SUFFIX = /\.(md|markdown|mdx|csv)$/i;

  const safeDecode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  /** GitHub 风格的标题锚点：小写、去标点、空白转连字符。 */
  function slugify(text) {
    return String(text || "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-{2,}/g, "-");
  }

  /**
   * 文档里的一条链接能落到哪里：
   * repo     —— 仓库内文件（相对路径 / 本站路径 / GitHub blob 链接）
   * anchor   —— 本文内锚点
   * external —— 外链，保持浏览器默认行为
   */
  function resolveDocLink(href, basePath, opts) {
    const options = opts || {};
    const raw = String(href || "").trim();
    if (!raw) return { kind: "other" };
    if (/^(mailto:|tel:|javascript:|data:)/i.test(raw)) return { kind: "other" };
    if (raw.startsWith("#")) return { kind: "anchor", anchor: safeDecode(raw.slice(1)) };

    let rest = raw;
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//");
    if (absolute) {
      let parsed;
      try {
        parsed = new URL(raw, "https://placeholder.invalid");
      } catch {
        return { kind: "other" };
      }
      if (options.host && parsed.host === options.host) {
        rest = parsed.pathname + parsed.search + parsed.hash;
      } else if (parsed.host === "github.com" && options.org && options.repo) {
        const prefix = `/${options.org}/${options.repo}/blob/`;
        if (!parsed.pathname.startsWith(prefix)) return { kind: "external", href: raw };
        const tail = parsed.pathname.slice(prefix.length);
        const cut = tail.indexOf("/");
        if (cut <= 0) return { kind: "external", href: raw };
        rest = `/${tail.slice(cut + 1)}${parsed.search}${parsed.hash}`;
      } else {
        return { kind: "external", href: raw };
      }
    }

    const hashAt = rest.indexOf("#");
    const anchor = hashAt >= 0 ? safeDecode(rest.slice(hashAt + 1)) : "";
    let plain = hashAt >= 0 ? rest.slice(0, hashAt) : rest;
    const queryAt = plain.indexOf("?");
    if (queryAt >= 0) plain = plain.slice(0, queryAt);
    if (!plain) return anchor ? { kind: "anchor", anchor } : { kind: "other" };

    const fromRoot = plain.startsWith("/");
    const segments = fromRoot ? [] : String(basePath || "").split("/").slice(0, -1).filter(Boolean);
    for (const segment of plain.replace(/^\/+/, "").split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (!segments.length) return { kind: "other" };
        segments.pop();
        continue;
      }
      segments.push(safeDecode(segment));
    }
    if (!segments.length) return anchor ? { kind: "anchor", anchor } : { kind: "other" };
    const path = segments.join("/");
    return { kind: "repo", path, anchor, isDoc: DOC_SUFFIX.test(path) };
  }

  /** 整篇渲染（引用文档与独立文档页共用）：marked → 清洗 → 标题锚点 → 表格可滚动外壳。 */
  function renderMarkdown(text) {
    const src = String(text || "");
    if (!window.marked) return `<pre class="plain-text">${esc(src)}</pre>`;
    let html = "";
    try {
      html = window.marked.parse(src);
    } catch {
      return `<pre class="plain-text">${esc(src)}</pre>`;
    }
    const clean = window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
    const seen = new Map();
    return clean
      .replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (match, level, inner) => {
        const title = inner.replace(/<[^>]+>/g, "");
        let id = slugify(title);
        if (!id) return match;
        const count = seen.get(id) || 0;
        seen.set(id, count + 1);
        if (count) id = `${id}-${count}`;
        return `<h${level} id="${id}">${inner}</h${level}>`;
      })
      .replace(/<table>/g, `<div class="table-shell"><div class="tscroll"><table>`)
      .replace(/<\/table>/g, `</table></div></div>`);
  }

  window.DiffModel = {
    parsePatch, mdBlocks, buildModel, similarity, esc, listRanges, listItemLines, listItemRanges,
    isCsvPath, csvParse, csvModel, slugify, resolveDocLink, renderMarkdown, DOC_SUFFIX,
  };
})();
