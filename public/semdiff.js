/* 语义 diff 引擎：块解析 → 对齐 → 行内差异 → 粒度分类。
   纯函数，不触碰 DOM/网络；渲染层只消费这里的结果。 */
(function (global) {
  "use strict";

  const KIND_OF = {
    heading: "heading", paragraph: "paragraph", blockquote: "quote",
    list: "list", list_item: "listItem", table: "table", code: "code",
    html: "html", hr: "hr", space: null,
  };

  const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
  const UNIT = /[万亿兆元家个人次天年月日%％]/;
  const WORD = /[A-Za-z0-9_@#./\\+-]/;

  /* ---------- token ---------- */
  /* 中文按字、拉丁按词、数字与紧邻单位/符号合成一个 token；拼接必须逐字节还原原文 */
  function tokenize(text) {
    const out = [];
    const s = String(text || "");
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "¥" || ch === "$") {
        let j = i + 1;
        while (j < s.length && /[0-9,]/.test(s[j])) j += 1;
        if (j > i + 1) { out.push(s.slice(i, j)); i = j; continue; }
        out.push(ch); i += 1; continue;
      }
      if (/[0-9]/.test(ch)) {
        let j = i + 1;
        while (j < s.length && /[0-9.,]/.test(s[j])) j += 1;
        while (j < s.length && UNIT.test(s[j])) j += 1;
        out.push(s.slice(i, j)); i = j; continue;
      }
      if (WORD.test(ch) && !CJK.test(ch)) {
        let j = i + 1;
        while (j < s.length && WORD.test(s[j]) && !CJK.test(s[j])) j += 1;
        out.push(s.slice(i, j)); i = j; continue;
      }
      out.push(ch); i += 1;
    }
    return out;
  }

  /* ---------- 块解析 ---------- */
  const textOfInline = (tok) => {
    if (!tok) return "";
    if (typeof tok === "string") return tok;
    if (Array.isArray(tok)) return tok.map(textOfInline).join("");
    const own = tok.text != null ? String(tok.text) : "";
    const kids = tok.tokens ? textOfInline(tok.tokens) : "";
    if (!own && kids) return kids;
    if (own && kids && kids.length > own.length) return kids;
    return own || kids;
  };

  const countLines = (raw) => String(raw || "").split("\n").length;

  function parseBlocks(source, side) {
    const src = String(source || "");
    if (!src.trim()) return [];
    const blocks = [];
    const lineAt = (off) => src.slice(0, Math.max(0, off)).split("\n").length;
    let pos = 0;
    const push = (b) => { blocks.push(b); return b; };
    const id = (kind, startLine) => `${side}:${kind}:${startLine}`;

    const walk = (tokens, parent) => {
      for (const tok of tokens || []) {
        const raw = tok.raw != null ? String(tok.raw) : "";
        /* 行号由真实的源码偏移推出来：marked 的 raw 可能带尾随空行，累加行数会漂移 */
        const start = lineAt(pos);
        const kind = KIND_OF[tok.type];
        if (kind === "list") {
          const lid = id("list", start);
          const kids = [];
          for (const item of tok.items || []) {
            const iraw = String(item.raw || "");
            const at = raw.indexOf(iraw);
            const istart = lineAt(pos + (at >= 0 ? at : 0));
            kids.push({
              id: id("listItem", istart), side, kind: "listItem", parentId: lid,
              startLine: istart, endLine: istart + countLines(iraw) - 1,
              raw: iraw, text: textOfInline(item.tokens || item.text),
            });
          }
          push({ id: lid, side, kind: "list", parentId: parent, children: kids.map((k) => k.id),
            startLine: start, endLine: start + countLines(raw) - 1, raw, text: "" });
          for (const k of kids) blocks.push(k);
          pos += raw.length;
          continue;
        }
        if (kind === "table") {
          const header = tok.header || [];
          const rows = [header].concat(tok.rows || []);
          rows.forEach((cells, ri) => {
            const rstart = start + (ri === 0 ? 0 : ri + 1);
            blocks.push({
              id: id("tableRow", rstart), side, kind: "tableRow",
              startLine: rstart, endLine: rstart,
              raw: ri === 0 ? String(raw).split("\n")[0] : "",
              text: cells.map((c) => textOfInline(c.tokens || c.text)).join("\t"),
              cells: cells.map((c) => ({ text: textOfInline(c.tokens || c.text) })),
            });
          });
          pos += raw.length;
          continue;
        }
        pos += raw.length;
        if (!kind) continue;
        push({
          id: id(kind, start), side, kind,
          level: tok.depth || undefined,
          parentId: parent,
          startLine: start, endLine: start + countLines(raw) - 1,
          raw, text: textOfInline(tok.tokens || tok.text), lang: tok.lang || undefined,
        });
      }
    };

    const tokens = global.marked && global.marked.lexer
      ? global.marked.lexer(src)
      : fallbackTokens(src);
    walk(tokens, null);
    return blocks.sort((a, b) => a.startLine - b.startLine);
  }

  /* 列表项行号：raw 里第一条匹配行的位置 */
  function startOfItem(listRaw, itemRaw, listStart) {
    const idx = String(listRaw || "").indexOf(String(itemRaw || "").split("\n")[0]);
    if (idx < 0) return listStart;
    return listStart + String(listRaw).slice(0, idx).split("\n").length - 1;
  }

  /* 无 marked 时的降级：按空行切块，只有段落与标题 */
  function fallbackTokens(src) {
    const out = [];
    let line = 0;
    for (const chunk of src.split(/\n{2,}/)) {
      const raw = chunk;
      const head = /^(#{1,6})\s+/.exec(raw);
      out.push(head
        ? { type: "heading", depth: head[1].length, raw, text: raw.replace(/^#+\s+/, "") }
        : { type: "paragraph", raw, text: raw });
      line += countLines(raw) + 1;
    }
    return out;
  }

  /* ---------- 相似度 ---------- */
  const norm = (s) => String(s || "")
    .replace(/[\s\u3000，。、；：！？（）“”‘’《》—…·,.!?;:()[\]{}"'`*_]/g, "")
    .toLowerCase();

  function grams(text) {
    const s = norm(text);
    const set = new Map();
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (CJK.test(ch)) {
        set.set(ch, 1);
        if (i + 1 < s.length && CJK.test(s[i + 1])) set.set(ch + s[i + 1], 1);
      } else {
        let j = i;
        while (j < s.length && !CJK.test(s[j])) j += 1;
        const w = s.slice(i, j).trim();
        if (w) set.set(w, 1);
        i = Math.max(i, j - 1);
      }
    }
    return set;
  }

  function similarity(a, b) {
    const ta = String((a && a.text) || ""), tb = String((b && b.text) || "");
    if (!ta && !tb) return 0;
    if (ta === tb) return 1;
    const ga = grams(ta), gb = grams(tb);
    if (!ga.size || !gb.size) return 0;
    let inter = 0;
    for (const k of ga.keys()) if (gb.has(k)) inter += 1;
    return (2 * inter) / (ga.size + gb.size);
  }

  /* ---------- 对齐 ---------- */
  const sameKind = (a, b) => a.kind === b.kind
    && (a.kind !== "heading" || a.level === b.level);

  function pairsInWindow(base, head, out) {
    const n = base.length, m = head.length;
    if (!n || !m) return;
    if (n * m > 400 * 400) {
      /* 段太长：按顺序等长配对，交给行内差异兜底 */
      const k = Math.min(n, m);
      for (let i = 0; i < k; i += 1) out.push([base[i].id, head[i].id]);
      return;
    }
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i][j] = sameKind(base[i], head[j]) && similarity(base[i], head[j]) >= 0.45
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (sameKind(base[i], head[j]) && similarity(base[i], head[j]) >= 0.45
        && dp[i][j] === dp[i + 1][j + 1] + 1) {
        out.push([base[i].id, head[j].id]);
        i += 1; j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1;
      else j += 1;
    }
  }

  function alignBlocks(base, head) {
    const pairs = [];
    let bi = 0, hi = 0;
    const key = (b) => norm(b.text);
    while (bi < base.length && hi < head.length) {
      /* patience 锚点：唯一且两侧唯一同文块 */
      let found = -1, foundJ = -1;
      const windowB = base.slice(bi, bi + 60), windowH = head.slice(hi, hi + 60);
      const countH = new Map();
      windowH.forEach((h) => { const k = key(h) + "#" + h.kind; countH.set(k, (countH.get(k) || 0) + 1); });
      const countB = new Map();
      windowB.forEach((b) => { const k = key(b) + "#" + b.kind; countB.set(k, (countB.get(k) || 0) + 1); });
      for (let j = 0; j < windowH.length && found < 0; j += 1) {
        const k = key(windowH[j]) + "#" + windowH[j].kind;
        if (!key(windowH[j]) || countH.get(k) !== 1 || countB.get(k) !== 1) continue;
        const i = windowB.findIndex((b) => key(b) + "#" + b.kind === k);
        if (i >= 0) { found = bi + i; foundJ = hi + j; }
      }
      if (found >= 0) {
        pairsInWindow(base.slice(bi, found), head.slice(hi, foundJ), pairs);
        pairs.push([base[found].id, head[foundJ].id]);
        bi = found + 1; hi = foundJ + 1;
      } else {
        pairsInWindow(base.slice(bi), head.slice(hi), pairs);
        bi = base.length; hi = head.length;
      }
    }
    const state = {};
    const baseLineOf = {};
    for (const b of base) state[b.id] = "removed";
    for (const h of head) state[h.id] = "added";
    const byId = new Map(base.map((b) => [b.id, b]));
    const byHead = new Map(head.map((h) => [h.id, h]));
    for (const [bid, hid] of pairs) {
      state[bid] = "normal"; state[hid] = "normal";
      const b = byId.get(bid), h = byHead.get(hid);
      baseLineOf[hid] = b ? b.startLine : 0;
      if (b && h && norm(b.text) !== norm(h.text)) state[hid] = "modified";
    }
    return { pairs, state, baseLineOf };
  }

  /* ---------- 行内差异 ---------- */
  const SEP = "\u0001";

  /* token 级 LCS：先掐掉公共前后缀，剩余部分 DP；过大时退化为整段替换 */
  function lcsOps(a, b) {
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s += 1;
    const A = a.slice(p, a.length - s), B = b.slice(p, b.length - s);
    const head = a.slice(0, p), tail = a.slice(a.length - s);
    if (!A.length && !B.length) return [[0, head.concat(tail)]];

    let mid;
    if (A.length * B.length > 4e6) {
      mid = [[-1, A], [1, B]];
    } else {
      const dp = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
      for (let i = A.length - 1; i >= 0; i -= 1) {
        for (let j = B.length - 1; j >= 0; j -= 1) {
          dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      mid = [];
      let i = 0, j = 0;
      while (i < A.length && j < B.length) {
        if (A[i] === B[j]) { mid.push([0, [A[i]]]); i += 1; j += 1; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { mid.push([-1, [A[i]]]); i += 1; }
        else { mid.push([1, [B[j]]]); j += 1; }
      }
      while (i < A.length) { mid.push([-1, [A[i]]]); i += 1; }
      while (j < B.length) { mid.push([1, [B[j]]]); j += 1; }
    }
    return [[0, head]].concat(mid, [[0, tail]]);
  }

  /* 合并相邻同类 op，并产出 head 侧字符区间（del 为零宽锚点 + 原文） */
  function diffBlock(baseText, headText) {
    const a = tokenize(baseText), b = tokenize(headText);
    if (a.join("") === b.join("")) return [];
    if (b.length > 5000 || a.length > 5000) return [];
    const ops = [];
    for (const [op, toks] of lcsOps(a, b)) {
      if (!toks.length) continue;
      const last = ops[ops.length - 1];
      if (last && last.op === op) last.toks = last.toks.concat(toks);
      else ops.push({ op, toks });
    }
    const ranges = [];
    let pos = 0;
    for (const { op, toks } of ops) {
      const len = toks.join("").length;
      if (op === 0) pos += len;
      else if (op === 1) {
        ranges.push({ op: "ins", start: pos, end: pos + len, text: toks.join("") });
        pos += len;
      } else {
        ranges.push({ op: "del", start: pos, end: pos, delText: toks.join("") });
      }
    }
    const headAll = b.join("");
    const total = Math.max(1, headAll.length);
    /* 只按插入字符计比例：删除内容另在「原文」面板呈现，不应把整段顶成块级 */
    const changed = ranges.reduce((n, r) => n + (r.op === "ins" ? r.end - r.start : 0), 0);
    /* 改动过半：行内高亮只会碎成一地，交给块级记号 */
    if (changed / total > 0.6) return [];
    /* 相邻插入之间只隔几个未改字时合并成一段，避免「这里新增了…一句…话」的碎片 */
    const merged = [];
    for (const r of ranges) {
      const prev = merged[merged.length - 1];
      if (r.op === "ins" && prev && prev.op === "ins" && r.start - prev.end <= 4) {
        prev.end = r.end;
      } else merged.push(Object.assign({}, r));
    }
    for (const r of merged) {
      if (r.op !== "ins") continue;
      while (r.start < r.end && /\s/.test(headAll[r.start] || "")) r.start += 1;
      while (r.end > r.start && /\s/.test(headAll[r.end - 1] || "")) r.end -= 1;
      /* 句末标点跟着句子一起标，避免出现「新增了一句话」后面孤零零一个句号 */
      while (r.end < headAll.length && /[，。；：、！？,.;:!?]/.test(headAll[r.end])) r.end += 1;
      r.text = headAll.slice(r.start, r.end);
    }
    return merged.filter((r) => r.op !== "ins" || r.end > r.start);
  }

  /* ---------- 粒度 ---------- */
  function classify(baseBlock, headBlock, ranges) {
    const head = String((headBlock && headBlock.text) || "");
    if (!headBlock || !ranges || !ranges.length) return { tier: "node", r: 1 };
    const changed = ranges.reduce((n, r) => n + (r.op === "ins" ? (r.end - r.start) : 0), 0);
    const total = Math.max(1, head.length);
    const r = changed / total;
    if (r <= 0.15) return { tier: "inline", r };
    if (r <= 0.6) return { tier: "sentence", r };
    return { tier: "block", r };
  }

  /* ---------- 文档装配 ---------- */
  function diffDocument(baseText, headText) {
    const base = parseBlocks(baseText, "base");
    const head = parseBlocks(headText, "head");
    const align = alignBlocks(base, head);
    const byId = new Map(base.map((b) => [b.id, b]));
    const paired = new Map(align.pairs.map(([b, h]) => [h, b]));
    const out = [];
    const usedBase = new Set();
    for (const h of head) {
      const bid = paired.get(h.id);
      if (!bid) {
        out.push({ block: h, state: "added", inline: [], tier: "node" });
        continue;
      }
      const b = byId.get(bid);
      usedBase.add(bid);
      const ranges = diffBlock(b.text, h.text);
      out.push({
        block: h, state: ranges.length ? "modified" : "normal",
        inline: ranges.map((r) => Object.assign({ unit: h.id }, r)),
        tier: classify(b, h, ranges).tier,
        baseText: b.text, pair: { blockId: b.id, line: b.startLine },
      });
    }
    /* 删除块插回其配对位置之后 */
    const removed = base.filter((b) => !usedBase.has(b.id));
    for (const b of removed) {
      const item = { block: b, state: "removed", inline: [], tier: "node" };
      let after = 0;
      out.forEach((d, i) => { if (d.pair && d.pair.line < b.startLine) after = i + 1; });
      out.splice(after, 0, item);
    }
    return out;
  }

  /* ---------- 代码块行级比较 ---------- */
  function diffCodeLines(baseText, headText) {
    const A = String(baseText || "").replace(/\r/g, "").replace(/[ \t]+$/gm, "").split("\n");
    const B = String(headText || "").replace(/\r/g, "").replace(/[ \t]+$/gm, "").split("\n");
    if (A.length === 1 && A[0] === "") A.length = 0;
    if (B.length === 1 && B[0] === "") B.length = 0;
    if (A.length * B.length > 5000 * 5000) return [];
    const dp = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
    for (let i = A.length - 1; i >= 0; i -= 1) {
      for (let j = B.length - 1; j >= 0; j -= 1) {
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < A.length && j < B.length) {
      if (A[i] === B[j]) { i += 1; j += 1; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: "del", line: i + 1 }); i += 1; }
      else { out.push({ op: "add", line: j + 1 }); j += 1; }
    }
    while (i < A.length) { out.push({ op: "del", line: i + 1 }); i += 1; }
    while (j < B.length) { out.push({ op: "add", line: j + 1 }); j += 1; }
    return out;
  }

  /* ---------- 高亮拆行 ---------- */
  function splitHighlightedLines(html) {
    const src = String(html || "");
    const lines = [];
    const stack = [];
    let buf = "";
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "<") {
        const close = src.indexOf(">", i);
        if (close < 0) { buf += src.slice(i); break; }
        const tag = src.slice(i, close + 1);
        if (/^<\//.test(tag)) stack.pop(); else if (!/\/>$/.test(tag)) stack.push(tag);
        buf += tag;
        i = close + 1;
        continue;
      }
      if (ch === "\n") {
        buf += stack.map(() => "</span>").reverse().join("");
        lines.push(buf);
        buf = stack.join("");
        i += 1;
        continue;
      }
      buf += ch;
      i += 1;
    }
    buf += stack.map(() => "</span>").reverse().join("");
    lines.push(buf);
    return lines;
  }

  /* ---------- 字符串层投影 ---------- */
  /* 在渲染后的 HTML 里按原文顺序放置 ins/del；标签内不插入，匹配失败则该区间跳过 */
  function projectInline(html, ranges) {
    let out = String(html || "");
    const list = (ranges || []).slice().sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const r of list) {
      const text = r.op === "ins" ? (r.text || "") : "";
      if (!text) continue;
      const hit = findText(out, text, cursor);
      if (!hit) continue;
      const open = `<ins class="md-ins">`;
      const close = `</ins>`;
      out = out.slice(0, hit.start) + open + out.slice(hit.start, hit.end) + close + out.slice(hit.end);
      cursor = hit.end + open.length + close.length;
    }
    return out;
  }

  /* 跳过标签、按渲染文本查找（实体与空白宽松匹配） */
  function findText(html, needle, from) {
    const probe = String(needle).replace(/\s+/g, "");
    if (!probe) return null;
    let i = from || 0;
    let visible = "";
    const map = [];
    while (i < html.length) {
      if (html[i] === "<") {
        const close = html.indexOf(">", i);
        if (close < 0) return null;
        i = close + 1;
        continue;
      }
      if (html[i] === "&") {
        const semi = html.indexOf(";", i);
        if (semi > i && semi - i <= 8) {
          const ent = html.slice(i, semi + 1);
          const ch = ent.length > 4 ? " " : ent;
          visible += ch.replace(/&[a-z]+;/i, (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" }[m] || " "));
          map.push({ htmlStart: i, htmlEnd: semi + 1 });
          i = semi + 1;
          continue;
        }
      }
      visible += html[i];
      map.push({ htmlStart: i, htmlEnd: i + 1 });
      i += 1;
    }
    const flat = visible.replace(/\s+/g, "");
    const at = flat.indexOf(probe);
    if (at < 0) return null;
    const startIdx = flatIndexToChar(map, at, visible);
    const endIdx = flatIndexToChar(map, at + probe.length - 1, visible, true);
    if (startIdx < 0 || endIdx < 0) return null;
    return { start: map[startIdx].htmlStart, end: map[endIdx].htmlEnd };
  }

  function flatIndexToChar(map, target, visible, last) {
    let flat = 0;
    for (let i = 0; i < map.length; i += 1) {
      const seg = visible[i] || "";
      const add = /\s/.test(seg) ? 0 : 1;
      if (add && flat === target) return i;
      flat += add;
    }
    return -1;
  }

  /* 渲染后的 HTML → 纯文本（投影与回退比较都用它） */
  function plainText(html) {
    return String(html || "")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ").trim();
  }

  global.SemDiff = {
    plainText,
    tokenize, parseBlocks, similarity, alignBlocks, diffBlock, classify,
    diffDocument, diffCodeLines, splitHighlightedLines, projectInline, findText,
  };
})(typeof window !== "undefined" ? window : globalThis);
