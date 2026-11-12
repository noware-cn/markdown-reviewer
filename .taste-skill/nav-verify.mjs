/* 左侧面板（VS Code 风格）+ 路径栏 + 表格外观回归 */
import { Browser } from '/home/dsun/.agents/skills/design-taste-frontend/scripts/lib/cdp.mjs';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8787';
const SHOTS = '/home/dsun/workspace/markdown-reviewer/.taste-skill/nav';
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail === undefined ? '' : JSON.stringify(detail)}`);
};

const browser = await Browser.launch({ width: 1440, height: 900 });

async function openPr(width = 1440, height = 900) {
  const page = await browser.newPage({ width, height });
  await page.goto(`${BASE}/auth/login`, { settleMs: 1200 });
  await page.eval((w) => localStorage.removeItem('wb.nav.view'), width);
  await page.eval(() => document.querySelector('.item[data-number="16"]').click());
  await page.eval(() => new Promise(async (r) => {
    for (let i = 0; i < 80; i += 1) {
      if (document.querySelector('#wbFiles .trow')) return r();
      await new Promise((x) => setTimeout(x, 100));
    }
  }));
  return page;
}

const page = await openPr();

/* 1. 树状视图 */
const tree = await page.eval(() => ({
  dirs: Array.from(document.querySelectorAll('#wbFiles .tdir')).map((d) => d.dataset.dir),
  files: document.querySelectorAll('#wbFiles .tfile').length,
  nested: document.querySelectorAll('#wbFiles .tnest').length,
  meta: document.getElementById('wbFilesMeta').textContent,
}));
check('树状视图：目录节点 + 文件节点', tree.dirs.length > 0 && tree.files === 10, { dirs: tree.dirs, files: tree.files });
check('单链目录合并成一行', tree.dirs.includes('docs/区域银行智能研发解决方案'), tree.dirs.slice(0, 3));
check('分区头显示文件数', /10 个文件/.test(tree.meta), tree.meta);

/* 2. 分区折叠 */
const collapse = await page.eval(() => {
  const head = document.getElementById('wbFilesHead');
  head.click();
  const after = {
    collapsed: document.getElementById('wbFilesView').classList.contains('is-collapsed'),
    expanded: head.getAttribute('aria-expanded'),
    visible: document.querySelector('#wbFiles .trow').getBoundingClientRect().height,
  };
  head.click();
  after.restored = !document.getElementById('wbFilesView').classList.contains('is-collapsed');
  return after;
});
check('分区头可折叠/展开', collapse.collapsed && collapse.expanded === 'false' && collapse.restored, collapse);

/* 3. 纵向拖动：改两块高度 */
const dragY = await page.eval(() => {
  const sash = document.getElementById('wbSashY');
  const view = document.getElementById('wbFilesView');
  const before = Math.round(view.getBoundingClientRect().height);
  const r = sash.getBoundingClientRect();
  sash.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 10, clientY: r.top + 3, bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 10, clientY: r.top + 120, bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 10, clientY: r.top + 120, bubbles: true }));
  const after = Math.round(view.getBoundingClientRect().height);
  return { before, after, varValue: getComputedStyle(view).getPropertyValue('--files-h').trim() };
});
check('上下分隔条拖动改变高度', dragY.after > dragY.before + 80, dragY);

const resetY = await page.eval(() => {
  const sash = document.getElementById('wbSashY');
  sash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  return { varValue: getComputedStyle(document.getElementById('wbFilesView')).getPropertyValue('--files-h').trim() };
});
check('双击分隔条复位', resetY.varValue === '', resetY);

/* 4. 横向拖动：改左栏宽度 */
const dragX = await page.eval(() => {
  const sash = document.getElementById('wbSashX');
  const nav = document.getElementById('wbNav');
  const r = sash.getBoundingClientRect();
  const before = Math.round(nav.getBoundingClientRect().width);
  sash.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 2, clientY: r.top + 40, bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 120, clientY: r.top + 40, bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 120, clientY: r.top + 40, bubbles: true }));
  const after = Math.round(nav.getBoundingClientRect().width);
  const docLeft = Math.round(document.getElementById('wbDoc').getBoundingClientRect().left);
  return { before, after, docLeft };
});
check('左栏宽度可拖（正文跟着让位）', dragX.after > dragX.before + 90, dragX);

await page.screenshot(`${SHOTS}/01-tree-wide.png`);

/* 5. 刷新后保持（工作台要重新打开） */
await page.eval(() => location.reload());
await page.eval(() => new Promise((r) => setTimeout(r, 1500)));
await page.eval(() => new Promise(async (r) => {
  for (let i = 0; i < 80; i += 1) {
    const item = document.querySelector('.item[data-number="16"]');
    if (item) { item.click(); return r(); }
    await new Promise((x) => setTimeout(x, 100));
  }
}));
await page.eval(() => new Promise(async (r) => {
  for (let i = 0; i < 80; i += 1) {
    if (document.querySelector('#wbFiles .trow')) return r();
    await new Promise((x) => setTimeout(x, 100));
  }
}));
const persist = await page.eval(() => Math.round(document.getElementById('wbNav').getBoundingClientRect().width));
check('宽度刷新后保持', Math.abs(persist - dragX.after) <= 2, { persist, expect: dragX.after });

/* 6. 平铺视图 */
const flat = await page.eval(() => {
  document.querySelector('.wb-viewseg [data-view="flat"]').click();
  return {
    pressed: document.querySelector('.wb-viewseg [data-view="flat"]').getAttribute('aria-pressed'),
    nodes: document.querySelectorAll('#wbFiles .fitem').length,
    dirs: document.querySelectorAll('#wbFiles .tdir').length,
    stored: localStorage.getItem('wb.nav.view'),
  };
});
check('切换到平铺视图', flat.pressed === 'true' && flat.nodes === 10 && flat.dirs === 0, flat);

const back = await page.eval(() => {
  document.querySelector('.wb-viewseg [data-view="tree"]').click();
  return document.querySelectorAll('#wbFiles .tdir').length;
});
check('切回树状视图', back > 0, { dirs: back });

/* 7. 筛选自动展开 */
const filtered = await page.eval(() => {
  const input = document.getElementById('wbFilter');
  input.value = '客户需求';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const rows = Array.from(document.querySelectorAll('#wbFiles .trow'));
  return {
    dirs: rows.filter((r) => r.classList.contains('tdir')).map((r) => r.dataset.dir),
    files: rows.filter((r) => r.classList.contains('tfile')).length,
    meta: document.getElementById('wbFilesMeta').textContent,
  };
});
check('筛选自动展开命中路径', filtered.files > 0 && filtered.dirs.some((d) => d.includes('08-客户需求')), filtered);

await page.eval(() => {
  const input = document.getElementById('wbFilter');
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

/* 8. 键盘：↓ 选中目录，→ 折叠，← 展开 */
const keys = await page.eval(() => {
  const box = document.getElementById('wbFiles');
  const rows = box.querySelectorAll('.trow');
  rows[0].focus();
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  const first = document.activeElement.dataset.dir;
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  const folded = document.activeElement.classList.contains('is-folded');
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  const unfolded = !document.activeElement.classList.contains('is-folded');
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  const next = document.activeElement.dataset.dir || document.activeElement.dataset.path;
  return { first, folded, unfolded, next };
});
check('键盘 ←/→ 折叠展开目录', keys.folded && keys.unfolded, keys);

/* 9. 打开文件：路径栏 + 选中态 */
const opened = await page.eval(() => {
  const row = Array.from(document.querySelectorAll('#wbFiles .tfile')).find((r) => r.dataset.path.endsWith('市场洞察与方案优化.md'));
  row.click();
  return new Promise((r) => setTimeout(() => r({
    active: document.querySelector('#wbFiles .trow.is-active')?.dataset.path || '',
    barHidden: document.getElementById('wbFilepath').hidden,
    dir: document.getElementById('wbFilepathDir').textContent,
    name: document.getElementById('wbFilepathName').textContent,
    mark: document.getElementById('wbFilepathMark').textContent,
    sticky: getComputedStyle(document.getElementById('wbFilepath')).position,
  }), 1200));
});
check('正文顶部显示仓库相对路径', opened.barHidden === false
  && opened.dir === 'docs/区域银行智能研发解决方案/08-客户需求与市场洞察/' && opened.name === '市场洞察与方案优化.md', opened);
check('路径栏 sticky 且带状态标记', opened.sticky === 'sticky' && opened.mark === 'A', { sticky: opened.sticky, mark: opened.mark });

/* 10. 表格新外观 */
const table = await page.eval(() => {
  const t = document.querySelector('#wbContent .table-shell:not(.is-csv) table');
  if (!t) return null;
  const th = t.querySelector('thead th');
  const td = t.querySelector('tbody td');
  const second = td.nextElementSibling;
  return {
    headBg: getComputedStyle(th).backgroundColor,
    headWeight: getComputedStyle(th).fontWeight,
    cellBorderLeft: getComputedStyle(second).borderLeftWidth,
    cellBorderBottom: getComputedStyle(td).borderBottomWidth,
    cols: t.querySelectorAll('thead th').length,
    aligned: new Set(Array.from(t.querySelectorAll('tbody tr')[0].children).map((c) => Math.round(c.getBoundingClientRect().top))).size,
  };
});
check('表格：表头有底色、列间有细线', table && table.headBg !== 'rgba(0, 0, 0, 0)'
  && table.cellBorderLeft === '1px' && table.aligned === 1, table);

await page.screenshot(`${SHOTS}/02-file-open.png`);

/* 11. 滚动后路径栏仍在顶部 */
const stickyAfterScroll = await page.eval(() => {
  const doc = document.getElementById('wbDoc');
  doc.scrollTop = 600;
  const r = document.getElementById('wbFilepath').getBoundingClientRect();
  const d = doc.getBoundingClientRect();
  return { barTop: Math.round(r.top), docTop: Math.round(d.top), offset: Math.round(r.top - d.top) };
});
check('滚动后路径栏吸附在正文顶部', Math.abs(stickyAfterScroll.offset) <= 2, stickyAfterScroll);

/* 12. 手机端：导航收起、分隔条隐藏 */
const mobile = await browser.newPage({ width: 390, height: 844 });
await mobile.goto(`${BASE}/auth/login`, { settleMs: 1200 });
await mobile.eval(() => new Promise(async (r) => {
  for (let i = 0; i < 80; i += 1) {
    const item = document.querySelector('.item[data-number="16"]');
    if (item) { item.click(); return r(); }
    await new Promise((x) => setTimeout(x, 100));
  }
}));
await mobile.eval(() => new Promise(async (r) => {
  for (let i = 0; i < 80; i += 1) {
    if (document.querySelector('#wbFiles .trow')) return r();
    await new Promise((x) => setTimeout(x, 100));
  }
}));
const narrow = await mobile.eval(() => ({
  collapsed: document.getElementById('wbBody').classList.contains('nav-collapsed'),
  sashDisplay: getComputedStyle(document.getElementById('wbSashX')).display,
}));
check('手机端导航收起且宽度分隔条隐藏', narrow.collapsed && narrow.sashDisplay === 'none', narrow);
await mobile.screenshot(`${SHOTS}/03-mobile.png`);

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} 通过`);
await browser.close();
