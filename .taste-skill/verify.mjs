/* 交互回归：样式改写后确认列表、工作台、模式、抽屉、导航仍然可用 */
import { Browser, sleep } from '/home/dsun/.agents/skills/design-taste-frontend/scripts/lib/cdp.mjs';

const BASE = 'http://127.0.0.1:8787';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const waitFor = async (page, selector, tries = 100) => page.eval(async (sel) => {
  for (let i = 0; i < 100; i += 1) {
    if (document.querySelector(sel)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}, selector);

const browser = await Browser.launch({ width: 1440, height: 900 });

/* ---------- 桌面 ---------- */
const page = await browser.newPage({ width: 1440, height: 900 });
await page.goto(`${BASE}/auth/login`, { settleMs: 1200 });
check('列表行渲染', await waitFor(page, '.item'));

const initial = await page.eval(() => ({
  items: document.querySelectorAll('.item').length,
  meta: document.getElementById('listMeta').textContent,
  h1: document.getElementById('listTitle').textContent,
  head: !!document.querySelector('.list-head'),
}));
/* PR 数量随 mock 数据增长，改成「列表条数与页脚统计自洽」而不是写死 24 */
const initialCount = Number((String(initial.meta).match(/共 (\d+) 条/) || [])[1]);
check('PR 条数与页脚统计一致', initialCount > 0 && initial.items === initialCount && initial.h1 === 'Pull Requests' && initial.head, JSON.stringify(initial));

/* 搜索过滤 */
const filtered = await page.eval(() => {
  const input = document.getElementById('search');
  input.value = 'zzzz-no-match';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const empty = document.querySelectorAll('.item').length === 0 && !!document.querySelector('.list-empty');
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return { empty, restored: document.querySelectorAll('.item').length };
});
check('搜索过滤与空状态', filtered.empty && filtered.restored === initialCount, JSON.stringify(filtered));

/* 状态筛选 */
const chips = await page.eval(() => {
  const chip = [...document.querySelectorAll('.chip')].find((c) => c.dataset.state === 'merged');
  chip.click();
  const state = {
    active: chip.classList.contains('active'),
    aria: chip.getAttribute('aria-pressed'),
    count: document.querySelectorAll('.item').length,
    allMerged: [...document.querySelectorAll('.badge')].every((b) => b.classList.contains('merged')),
  };
  [...document.querySelectorAll('.chip')].find((c) => c.dataset.state === 'all').click();
  return state;
});
check('状态筛选', chips.active && chips.aria === 'true' && chips.count > 0 && chips.allMerged, JSON.stringify(chips));

/* 进入工作台 */
await page.eval(() => { document.querySelector('.item').click(); return true; });
check('进入工作台并渲染文档', await waitFor(page, '#wbContent .md-block'));

/* 文件列表默认是树状视图；本脚本按平铺视图断言，先切一次 */
await page.eval(() => {
  const btn = document.querySelector('.wb-viewseg [data-view="flat"]');
  if (btn) btn.click();
  return true;
});
const wb = await page.eval(() => ({
  listHidden: getComputedStyle(document.getElementById('listTopbar')).display === 'none',
  title: document.getElementById('wbPrTitle').textContent,
  mode: document.getElementById('wbDoc').dataset.mode,
  navVisible: getComputedStyle(document.querySelector('.wb-nav')).display !== 'none',
  files: document.querySelectorAll('.fitem').length,
  chapters: document.querySelectorAll('.chapter').length,
  marksOn: !document.getElementById('wbDoc').classList.contains('marks-off'),
}));
check('工作台初始状态', wb.listHidden && wb.mode === 'reading' && wb.navVisible && wb.marksOn && wb.files > 0, JSON.stringify(wb));

/* 切到有 patch 的修改文件（mock 前 6 个是新增文件，没有 patch） */
await page.eval(() => {
  /* 末尾文件现在是 CSV，挑最后一个 markdown 文件才能断言行号锚点 */
  const items = [...document.querySelectorAll('.fitem')];
  const md = items.filter((el) => /\.md$/i.test(el.dataset.path || ''));
  (md.length ? md[md.length - 1] : items[items.length - 1]).click();
  return true;
});
await sleep(600);
const selected = await page.eval(() => ({
  file: document.querySelector('.fitem.active')?.textContent.trim(),
  mdblocks: document.querySelectorAll('#wbContent .md-block').length,
  anchors: document.querySelectorAll('#wbContent .line-anchor').length,
}));
check('选中修改文件并出现行号锚点', selected.mdblocks > 0 && selected.anchors > 0, JSON.stringify(selected));

/* 四种视图模式 */
const modes = {};
for (const mode of ['sidebyside', 'unified', 'split', 'reading']) {
  modes[mode] = await page.eval(async (m) => {
    document.querySelector(`.wb-mode[data-mode="${m}"]`).click();
    await new Promise((r) => setTimeout(r, 250));
    const doc = document.getElementById('wbDoc');
    return {
      dataMode: doc.dataset.mode,
      sb2: !!document.querySelector('#wbContent .sb2'),
      dline: !!document.querySelector('#wbContent .dline'),
      split2: !!document.querySelector('#wbContent .split2'),
      mdblock: !!document.querySelector('#wbContent .md-block'),
      on: document.querySelector(`.wb-mode[data-mode="${m}"]`).classList.contains('on'),
      pressed: document.querySelector(`.wb-mode[data-mode="${m}"]`).getAttribute('aria-pressed'),
      width: Math.round(document.querySelector('.wb-content').getBoundingClientRect().width),
      overflowX: doc.scrollWidth > doc.clientWidth + 1,
    };
  }, mode);
}
check('前后对照视图', modes.sidebyside.dataMode === 'sidebyside' && modes.sidebyside.sb2 && modes.sidebyside.on && modes.sidebyside.pressed === 'true', JSON.stringify(modes.sidebyside));
check('统一 Diff 视图', modes.unified.dataMode === 'unified' && modes.unified.dline && !modes.unified.overflowX && modes.unified.pressed === 'true', JSON.stringify(modes.unified));
check('分栏 Diff 视图', modes.split.dataMode === 'split' && modes.split.split2 && !modes.split.overflowX && modes.split.pressed === 'true', JSON.stringify(modes.split));
check('阅读视图列宽回到 780', modes.reading.dataMode === 'reading' && modes.reading.width <= 780, JSON.stringify(modes.reading));

/* 变更标记开关 */
const marks = await page.eval(() => {
  const box = document.getElementById('wbMarks');
  box.checked = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  const off = document.getElementById('wbDoc').classList.contains('marks-off');
  box.checked = true;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  return { off, on: !document.getElementById('wbDoc').classList.contains('marks-off') };
});
check('变更标记开关', marks.off && marks.on, JSON.stringify(marks));

/* 行号评论 -> 抽屉 composer */
const composer = await page.eval(async () => {
  const anchor = document.querySelector('.line-anchor');
  if (!anchor) return { anchor: false };
  anchor.click();
  await new Promise((r) => setTimeout(r, 200));
  const ta = document.getElementById('wbcText');
  return {
    anchor: true,
    drawerOpen: document.getElementById('wbBody').classList.contains('drawer-open'),
    composer: !!document.querySelector('.composer'),
    hasTextarea: !!ta,
  };
});
check('行号评论打开抽屉与输入框', composer.anchor && composer.drawerOpen && composer.composer && composer.hasTextarea, JSON.stringify(composer));

const cancel = await page.eval(async () => {
  const btn = document.querySelector('.crow .btn.ghost');
  if (!btn) return { composer: !!document.querySelector('.composer'), missing: true };
  btn.click();
  await new Promise((r) => setTimeout(r, 150));
  return { composer: !!document.querySelector('.composer'), open: document.getElementById('wbBody').classList.contains('drawer-open') };
});
check('取消草稿后输入框消失', !cancel.composer, JSON.stringify(cancel));

/* 返回列表 */
const back = await page.eval(async () => {
  document.getElementById('wbDrawerFold').click();
  document.getElementById('wbBack').click();
  await new Promise((r) => setTimeout(r, 250));
  return {
    wbHidden: document.getElementById('workbench').hidden,
    listShown: getComputedStyle(document.getElementById('listTopbar')).display !== 'none',
    items: document.querySelectorAll('.item').length,
  };
});
check('返回列表', back.wbHidden && back.listShown && back.items === initialCount, JSON.stringify(back));

check('桌面无脚本异常', page.consoleErrors.length === 0, page.consoleErrors.join(' | '));
await page.close();

/* ---------- 手机 ---------- */
const mobile = await browser.newPage({ width: 390, height: 844, mobile: true });
await mobile.goto(`${BASE}/auth/login`, { settleMs: 1200 });
check('手机列表渲染', await waitFor(mobile, '.item'));
await mobile.eval(() => { document.querySelector('.item').click(); return true; });
check('手机进入工作台', await waitFor(mobile, '#wbContent .md-block'));
const mob = await mobile.eval(async () => {
  const nav = document.querySelector('.wb-nav');
  const before = { display: getComputedStyle(nav).display, width: nav.getBoundingClientRect().width };
  document.getElementById('wbNavToggle').click();
  await new Promise((r) => setTimeout(r, 200));
  const open = { display: getComputedStyle(nav).display, width: Math.round(nav.getBoundingClientRect().width) };
  document.getElementById('wbNavToggle').click();
  await new Promise((r) => setTimeout(r, 200));
  const closed = getComputedStyle(nav).display;
  const doc = document.getElementById('wbDoc');
  return {
    before, open, closed,
    contentW: Math.round(document.querySelector('.wb-content').getBoundingClientRect().width),
    overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    drawerOverflow: doc.scrollWidth > doc.clientWidth + 1,
    topbarH: Math.round(document.querySelector('.wb-topbar').getBoundingClientRect().height),
  };
});
check('手机导航默认收起、可展开', mob.before.display === 'none' && mob.open.display !== 'none' && mob.open.width <= 390 * 0.86 + 2 && mob.closed === 'none', JSON.stringify({ before: mob.before, open: mob.open }));
check('手机无横向溢出且正文列宽合理', !mob.overflowX && mob.contentW > 300, JSON.stringify({ contentW: mob.contentW, overflowX: mob.overflowX }));
check('手机顶栏两行以内', mob.topbarH <= 96, String(mob.topbarH));
check('手机无脚本异常', mobile.consoleErrors.length === 0, mobile.consoleErrors.join(' | '));
await mobile.close();

/* ---------- 平板 ---------- */
const tablet = await browser.newPage({ width: 768, height: 900 });
await tablet.goto(`${BASE}/auth/login`, { settleMs: 1200 });
await tablet.eval(() => { document.querySelector('.item').click(); return true; });
check('平板进入工作台', await waitFor(tablet, '#wbContent .md-block'));
const tab = await tablet.eval(() => {
  const bar = document.querySelector('.wb-topbar').getBoundingClientRect();
  const kids = [...document.querySelector('.wb-topbar').children].filter((e) => e.offsetWidth);
  return {
    barH: Math.round(bar.height),
    maxH: Math.max(...kids.map((e) => Math.round(e.getBoundingClientRect().height))),
    overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    navW: Math.round(document.querySelector('.wb-nav').getBoundingClientRect().width),
  };
});
check('平板顶栏不溢出不竖排', !tab.overflowX && tab.maxH <= 34, JSON.stringify(tab));
check('平板无脚本异常', tablet.consoleErrors.length === 0, tablet.consoleErrors.join(' | '));
await tablet.close();

await browser.close();

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  ' + r.detail : ''}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
