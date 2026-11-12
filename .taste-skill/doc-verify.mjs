/* 文档链接渲染 + 宽表增强的浏览器回归 */
import { Browser, sleep } from '/home/dsun/.agents/skills/design-taste-frontend/scripts/lib/cdp.mjs';

const BASE = 'http://127.0.0.1:8787';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const waitFor = (page, sel, tries = 80) => page.eval(async ([s, n]) => {
  for (let i = 0; i < n; i += 1) {
    if (document.querySelector(s)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}, [sel, tries]);
const pause = (page, ms = 500) => page.eval((t) => new Promise((r) => setTimeout(r, t)), ms);
const openFile = async (page, needle) => {
  const ok = await page.eval((n) => {
    const hit = Array.from(document.querySelectorAll('#wbFiles [data-path]')).find((el) => el.dataset.path.includes(n));
    if (!hit) return false;
    hit.click();
    return true;
  }, needle);
  await pause(page, 700);
  return ok;
};
const activePath = (page) => page.eval(() => document.querySelector('#wbFiles [data-path].is-active')?.dataset.path || '');

const browser = await Browser.launch({ width: 1440, height: 900 });
const page = await browser.newPage({ width: 1440, height: 900 });

/* ---------- 列表 → 工作台 ---------- */
await page.goto(`${BASE}/auth/login`, { settleMs: 1200 });
check('列表渲染', await waitFor(page, '.item'));
await page.eval(() => document.querySelector('.item[data-number="16"]').click());
check('工作台打开', await waitFor(page, '#wbFiles [data-path]'));
const fileCount = await page.eval(() => document.querySelectorAll('#wbFiles [data-path]').length);
check('文件列表完整', fileCount >= 10, `${fileCount} 个文件`);

/* ---------- 顶栏原始 PR 链接 ---------- */
const prLink = await page.eval(async () => {
  const wrap = document.getElementById('wbOrigWrap');
  const link = document.getElementById('wbOrig');
  const copy = document.getElementById('wbOrigCopy');
  let copied = '';
  navigator.clipboard.writeText = async (v) => { copied = v; };
  copy.click();
  await new Promise((r) => setTimeout(r, 250));
  return {
    visible: !wrap.hidden,
    href: link.href,
    text: link.textContent,
    target: link.getAttribute('target'),
    copied,
    toast: document.getElementById('dtoast').textContent,
  };
});
check('顶栏露出原始 PR 链接', prLink.visible && /github\.com\/.*\/pull\/16$/.test(prLink.href), JSON.stringify(prLink));
check('复制按钮写入剪贴板并提示', prLink.copied === prLink.href && prLink.toast.includes('已复制'), prLink.toast);

/* ---------- Markdown：PR 内链接原地切换文件 ---------- */
await openFile(page, 'docs/区域银行智能研发解决方案/README.md');
const links = await page.eval(() => Array.from(document.querySelectorAll('#wbContent a[href]'))
  .map((a) => a.getAttribute('href')));
check('索引文档解析出链接', links.length > 5, `${links.length} 条`);
check('相对链接未被改写成站点根绝对路径', links.every((h) => !h.startsWith('/08-') && !h.startsWith('/07-')),
  JSON.stringify(links.slice(0, 2)));

const before = await activePath(page);
const jumped = await page.eval(async () => {
  const link = Array.from(document.querySelectorAll('#wbContent a[href]'))
    .find((a) => decodeURIComponent(a.getAttribute('href')).includes('市场洞察与方案优化.md'));
  if (!link) return { ok: false, reason: 'link missing' };
  /* 深链上线后：同页切文件会 push 新地址，判据改成「不整页刷新 + 地址跟着文件走」 */
  window.__noReload = Math.random();
  const url = location.pathname;
  link.click();
  await new Promise((r) => setTimeout(r, 1200));
  return {
    ok: window.__noReload !== undefined,
    moved: location.pathname !== url,
    target: decodeURIComponent(location.pathname),
    href: link.getAttribute('href'),
    ref: !!document.querySelector('.refdoc-bar'),
  };
});
const after = await activePath(page);
check('点击 PR 内链接同页切换文件并更新地址', jumped.ok && jumped.moved && jumped.target.includes('市场洞察与方案优化.md')
  && after !== before && !jumped.ref,
  `${before.split('/').pop()} → ${after.split('/').pop()}`);

/* 目标文档的正文确实渲染出来（不是 JSON、不是错误页） */
const rendered = await page.eval(() => ({
  blocks: document.querySelectorAll('#wbContent .md-block').length,
  tables: document.querySelectorAll('#wbContent .table-shell').length,
  text: (document.getElementById('wbContent').textContent || '').slice(0, 60),
}));
check('切换后正文正常渲染', rendered.blocks > 3, JSON.stringify(rendered));
await page.screenshot({ path: '.taste-skill/doc/01-md-link.png' });

/* ---------- 引用文档视图（PR 之外的链接） ---------- */
await openFile(page, 'docs/区域银行智能研发解决方案/README.md');
/* 演示模式只收录 PR 内文件，这里桩掉 /api/doc 以验证引用视图本身 */
await page.eval(() => {
  const canned = '# 引用文档示例\n\n## 第一节\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n## 第二节\n\n正文内容\n';
  window.__origFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/doc')) {
      return { ok: true, status: 200, json: async () => ({ path: 'docs/01-总体方案/demo.md', ref: 'abcdef1234', text: canned, truncated: false }) };
    }
    return window.__origFetch(input, init);
  };
});
const refView = await page.eval(async () => {
  const link = Array.from(document.querySelectorAll('#wbContent a[href]'))
    .find((a) => decodeURIComponent(a.getAttribute('href')).includes('01-总体方案'));
  if (!link) return { ok: false, reason: 'no external doc link' };
  link.click();
  await new Promise((r) => setTimeout(r, 900));
  const bar = document.querySelector('.refdoc-bar');
  return {
    ok: !!bar,
    path: bar ? bar.querySelector('.refdoc-path').textContent : '',
    tag: bar ? bar.querySelector('.refdoc-tag').textContent : '',
    open: bar ? !!bar.querySelector('.refdoc-open') : false,
    article: !!document.querySelector('#wbContent article.md-block.refdoc'),
    tables: document.querySelectorAll('#wbContent .table-shell').length,
    chapters: document.querySelectorAll('#wbChapters [data-ref-anchor]').length,
    url: location.href,
  };
});
check('引用文档视图打开', refView.ok && refView.article, JSON.stringify(refView));
check('引用文档带只读标识与新页签入口', refView.tag.includes('只读') && refView.open);
check('引用文档内表格同样套外壳', refView.tables >= 1, String(refView.tables));
check('引用文档章节进入导航栏', refView.chapters >= 2, String(refView.chapters));
await page.screenshot({ path: '.taste-skill/doc/02-refdoc.png' });

const backAgain = await page.eval(async () => {
  document.querySelector('.refdoc-back').click();
  await new Promise((r) => setTimeout(r, 700));
  return { bar: !!document.querySelector('.refdoc-bar'), active: document.querySelector('#wbFiles [data-path].is-active')?.dataset.path || '' };
});
check('返回后回到原来的 PR 文件', !backAgain.bar && backAgain.active.includes('README.md'), JSON.stringify(backAgain));
await page.eval(() => { window.fetch = window.__origFetch; });

/* ---------- CSV 宽表 ---------- */
await openFile(page, 'docs/市场调查/区域银行智能研发/来源清单.csv');
check('CSV 表格外壳', await waitFor(page, '#wbContent .table-shell.is-csv .tscroll table.csv-table'));
const shellInfo = await page.eval(() => {
  const shell = document.querySelector('#wbContent .table-shell.is-csv');
  if (!shell) return null;
  const th = shell.querySelector('thead th');
  const ln = shell.querySelector('thead .csv-ln');
  const scroll = shell.querySelector('.tscroll');
  return {
    stickyHead: getComputedStyle(th).position,
    stickyLn: ln ? getComputedStyle(ln).position : null,
    lnW: shell.style.getPropertyValue('--ln-w'),
    hasOverflow: shell.classList.contains('has-overflow'),
    realOverflow: scroll.scrollWidth > scroll.clientWidth + 4,
    rightShadow: getComputedStyle(shell.querySelector('.tshadow.r')).opacity,
    maxH: getComputedStyle(scroll).maxHeight,
    tools: Array.from(shell.querySelectorAll('.tbtn')).map((b) => b.textContent.trim()),
    width: Math.round(shell.getBoundingClientRect().width),
  };
});
check('表头与行号列粘性', shellInfo && shellInfo.stickyHead === 'sticky' && shellInfo.stickyLn === 'sticky',
  shellInfo && `${shellInfo.stickyHead}/${shellInfo.stickyLn}`);
check('行号列宽度写入 CSS 变量', shellInfo && !!shellInfo.lnW, shellInfo && shellInfo.lnW);
check('横向溢出检出 + 边缘渐隐', shellInfo && (shellInfo.hasOverflow === shellInfo.realOverflow) && Number(shellInfo.rightShadow) > 0,
  shellInfo && `overflow=${shellInfo.hasOverflow} shadow=${shellInfo.rightShadow}`);
check('纵向有上限，表头保持可见', shellInfo && shellInfo.maxH !== 'none', shellInfo && shellInfo.maxH);
check('工具条（新增文件不含行过滤）', shellInfo
  && ['列', '紧凑', '全屏'].every((t) => shellInfo.tools.some((label) => label.startsWith(t)))
  && !shellInfo.tools.some((label) => label.startsWith('仅看变化行')), shellInfo && shellInfo.tools.join('|'));
await page.screenshot({ path: '.taste-skill/doc/03-csv.png' });

await page.eval(() => document.querySelector('#wbContent [data-tbl="full"]').click());
await pause(page, 400);
const full = await page.eval(() => {
  const shell = document.querySelector('#wbContent .table-shell.is-full');
  if (!shell) return null;
  const r = shell.getBoundingClientRect();
  return { gaps: [Math.round(r.left), Math.round(r.top), Math.round(window.innerWidth - r.right)], btn: document.querySelector('#wbContent [data-tbl="full"]').textContent.trim() };
});
check('全屏铺满视口', full && full.gaps.every((n) => n <= 14), JSON.stringify(full));
await page.screenshot({ path: '.taste-skill/doc/04-full.png' });
await page.eval(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
await pause(page, 300);
check('Esc 退出全屏', await page.eval(() => !document.querySelector('.table-shell.is-full') && !document.body.classList.contains('tbl-full-on')));

await page.eval(() => document.querySelector('#wbContent [data-tbl="cols"]').click());
await pause(page, 250);
const panel = await page.eval(() => {
  const p = document.querySelector('#wbContent .colpanel');
  return p ? { hidden: p.hidden, items: p.querySelectorAll('[data-col-toggle]').length, count: p.querySelector('.colpanel-count')?.textContent } : null;
});
check('列面板展开并列出列', panel && !panel.hidden && panel.items > 0, JSON.stringify(panel));
await page.screenshot({ path: '.taste-skill/doc/05-cols.png' });

const hid = await page.eval(async () => {
  const box = document.querySelector('#wbContent .colpanel [data-col-toggle]');
  box.checked = false;
  box.dispatchEvent(new Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const shell = document.querySelector('#wbContent .table-shell.is-csv');
  return {
    hiddenCells: shell.querySelectorAll('[data-col="0"][hidden]').length,
    label: document.querySelector('#wbContent [data-tbl="cols"]').textContent,
  };
});
check('隐藏一列后整列消失', hid.hiddenCells > 0, JSON.stringify(hid));

const pinned = await page.eval(async () => {
  const pin = document.querySelector('#wbContent .colpanel [data-col-pin]');
  pin.click();
  await new Promise((r) => setTimeout(r, 200));
  const cell = document.querySelector('#wbContent .table-shell.is-csv tbody .is-pinned');
  return cell ? getComputedStyle(cell).position : null;
});
check('固定列生效', pinned === 'sticky', String(pinned));

const reset = await page.eval(async () => {
  document.querySelector('#wbContent [data-col-reset]')?.click();
  await new Promise((r) => setTimeout(r, 250));
  return document.querySelectorAll('#wbContent .table-shell.is-csv [data-col][hidden]').length;
});
check('全部显示复位', reset === 0, String(reset));

const density = await page.eval(async () => {
  const btn = document.querySelector('#wbContent [data-tbl="density"]');
  btn.click();
  await new Promise((r) => setTimeout(r, 200));
  return { on: document.querySelector('#wbContent .table-shell').classList.contains('is-compact'), pressed: btn.getAttribute('aria-pressed') };
});
check('紧凑密度切换', density.on && density.pressed === 'true', JSON.stringify(density));

const only = await page.eval(() => {
  /* 这个 CSV 是新增文件：没有行过滤按钮，且整表可见 */
  const btn = document.querySelector('#wbContent [data-tbl="only"]');
  const rows = document.querySelectorAll('#wbContent .table-shell tbody tr').length;
  const visible = document.querySelectorAll('#wbContent .table-shell tbody tr:not([hidden])').length;
  return { noButton: !btn, rows, visible };
});
check('新增文件不提供“仅看变化行”且整表可见', only.noButton && only.visible === only.rows, JSON.stringify(only));

const pop = await page.eval(async () => {
  const cell = document.querySelector('#wbContent .table-shell td.is-clip');
  if (!cell) return { found: false };
  cell.click();
  await new Promise((r) => setTimeout(r, 200));
  const el = document.getElementById('tblCellPop');
  return { found: true, shown: !!el, text: el ? el.textContent.length : 0 };
});
check('长单元格浮层', pop.found ? pop.shown && pop.text > 80 : true, JSON.stringify(pop));
await page.eval(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
check('Esc 关闭浮层', await page.eval(() => !document.getElementById('tblCellPop')));

/* ---------- 独立文档页 ---------- */
const docRel = 'docs/市场调查/区域银行智能研发/口径与判断.md';
const docUrl = `${BASE}/${docRel.split('/').map(encodeURIComponent).join('/')}`;
const head = await page.eval(async (url) => {
  const res = await fetch(url, { headers: { Accept: 'text/html' } });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, html: type.includes('text/html') };
}, docUrl);
check('裸 .md 路径返回 HTML 而非 JSON', head.html, JSON.stringify(head));

await page.goto(docUrl, { settleMs: 1600 });
const docPage = await page.eval(() => ({
  main: !!document.querySelector('.doc-main'),
  visible: document.getElementById('docPage')?.hidden === false,
  h1: document.querySelector('#docPage h1')?.textContent || '',
  tables: document.querySelectorAll('#docPage .table-shell').length,
  crumb: document.getElementById('docCrumb')?.textContent || '',
}));
check('文档页渲染正文', docPage.main && docPage.visible && docPage.h1.length > 0, JSON.stringify(docPage));
await page.screenshot({ path: '.taste-skill/doc/06-doc.png' });

const docNav = await page.eval(async () => {
  const link = Array.from(document.querySelectorAll('#docPage a[href]'))
    .find((a) => /\.md$/.test(a.getAttribute('href')) && !/^https?:/i.test(a.getAttribute('href')));
  if (!link) return { found: false };
  const href = link.getAttribute('href');
  link.click();
  await new Promise((r) => setTimeout(r, 1200));
  return { found: true, href, path: location.pathname, title: document.getElementById('docPage')?.hidden === false };
});
check('文档页内跳转仍留在文档页', docNav.found ? docNav.path.startsWith('/doc/') || docNav.title : true, JSON.stringify(docNav));

const missing = await page.eval(async (url) => {
  const res = await fetch(url, { headers: { Accept: 'text/html' } });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, html: type.includes('text/html') };
}, `${BASE}/docs/不存在/foo.md`);
check('未知文档路径给 HTML（不是 JSON）', missing.html, JSON.stringify(missing));
await page.goto(`${BASE}/docs/不存在/foo.md`, { settleMs: 1200 });
check('未知文档页面给出可读提示', await page.eval(() => {
  const box = document.querySelector('.doc-state-box');
  return !!box && box.querySelector('.doc-state-msg')?.textContent.length > 4;
}));

const api404 = await page.eval(async (url) => {
  const res = await fetch(url);
  return { status: res.status, json: (res.headers.get('content-type') || '').includes('application/json') };
}, `${BASE}/api/nope`);
check('/api 404 仍是 JSON', api404.json && api404.status === 404, JSON.stringify(api404));



/* ---------- 手机：CSV 卡片 ---------- */
const mobile = await browser.newPage({ width: 390, height: 844, mobile: true });
await mobile.goto(`${BASE}/auth/login`, { settleMs: 1200 });
await mobile.eval(() => document.querySelector('.item[data-number="16"]').click());
await waitFor(mobile, '#wbFiles [data-path]');
await openFile(mobile, 'docs/市场调查/区域银行智能研发/来源清单.csv');
const card = await mobile.eval(() => {
  const shell = document.querySelector('#wbContent .table-shell.is-csv');
  if (!shell) return null;
  const td = shell.querySelector('tbody td[data-label]');
  const thead = shell.querySelector('thead');
  const scroll = shell.querySelector('.tscroll');
  return {
    headDisplay: thead ? getComputedStyle(thead).display : 'none',
    label: td ? getComputedStyle(td, '::before').content : '',
    tdDisplay: td ? getComputedStyle(td).display : '',
    noHScroll: scroll.scrollWidth <= scroll.clientWidth + 2,
  };
});
check('手机端 CSV 转卡片', card && card.headDisplay === 'none' && card.tdDisplay === 'grid' && card.noHScroll, JSON.stringify(card));
check('卡片带字段名标签', card && /"[^"]+"/.test(card.label || ''), card && card.label);
await mobile.screenshot({ path: '.taste-skill/doc/07-mobile.png' });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log(failed.map((f) => `- ${f.name} ${f.detail}`).join('\n'));
await browser.close();
process.exit(failed.length ? 1 : 0);
