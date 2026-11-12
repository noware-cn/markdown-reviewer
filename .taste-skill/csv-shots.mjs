/* CSV 评审视图人工核对：截图 + 关键交互 */
import { Browser, sleep } from '/home/dsun/.agents/skills/design-taste-frontend/scripts/lib/cdp.mjs';
import { mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8787';
const OUT = '.taste-skill/csv';
mkdirSync(OUT, { recursive: true });

const log = (...args) => console.log(...args);
const waitFor = (page, sel) => page.eval(async (s) => {
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector(s)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}, sel);

const openWorkbench = async (page) => {
  await page.goto(`${BASE}/auth/login`, { settleMs: 1200 });
  await waitFor(page, '.item');
  await page.eval(() => { document.querySelector('.item')?.click(); return true; });
  await waitFor(page, '.csv-table');
  await sleep(400);
};

const browser = await Browser.launch({ width: 1440, height: 900 });

const page = await browser.newPage({ width: 1440, height: 900 });
await openWorkbench(page);
const reading = await page.eval(() => ({
  file: document.getElementById('wbFiles').querySelector('.fitem.active')?.dataset.path,
  stat: document.querySelector('.csv-stat')?.textContent,
  delta: document.querySelector('.csv-delta')?.textContent,
  rows: document.querySelectorAll('.csv-table tbody .csv-row').length,
  added: document.querySelectorAll('.csv-table .is-added').length,
  modified: document.querySelectorAll('.csv-table tbody .is-modified').length,
  removed: document.querySelectorAll('.csv-table tbody .is-removed').length,
  changedCells: [...document.querySelectorAll('.csv-table td.is-changed')].map((el) => el.textContent),
  anchors: [...document.querySelectorAll('.csv-table .line-anchor')].map((el) => el.dataset.line),
  chapters: document.getElementById('wbChapters').textContent.replace(/\s+/g, ' ').trim(),
  contentWidth: Math.round(document.querySelector('.wb-content').getBoundingClientRect().width),
  tableScrolls: (() => {
    const wrap = document.querySelector('.csv-wrap');
    return wrap ? { client: wrap.clientWidth, scroll: wrap.scrollWidth } : null;
  })(),
  pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
  quotes: [...document.querySelectorAll('.csv-table tbody tr:first-child td')].map((el) => el.textContent),
}));
log('reading', JSON.stringify(reading, null, 2));
await page.screenshot({ path: `${OUT}/desktop-reading.jpg` });

/* 行号锚点 → 抽屉 */
await page.eval(() => { document.querySelector('.csv-table tbody .line-anchor')?.click(); return true; });
await sleep(300);
const composer = await page.eval(() => ({
  open: document.querySelector('.wb-body').classList.contains('drawer-open'),
  anchor: document.querySelector('.composer .canchor')?.textContent,
  focused: document.activeElement?.id,
}));
log('composer', JSON.stringify(composer));
await page.screenshot({ path: `${OUT}/desktop-composer.jpg` });
await page.eval(() => { document.querySelector('[data-act="cancel"]')?.click(); return true; });
await sleep(200);

/* 前后对照 */
await page.eval(() => { document.querySelector('.wb-mode[data-mode="sidebyside"]')?.click(); return true; });
await sleep(400);
const side = await page.eval(() => ({
  baseRows: document.querySelectorAll('.sb-base .csv-row').length,
  basePartial: document.querySelectorAll('.sb-base .csv-row.is-partial').length,
  baseRemoved: document.querySelectorAll('.sb-base .csv-row.is-removed').length,
  headModified: document.querySelectorAll('.sb-head .csv-row.is-modified').length,
  headAdded: document.querySelectorAll('.sb-head .csv-row.is-added').length,
  headAnchors: document.querySelectorAll('.sb-head .line-anchor').length,
}));
log('sidebyside', JSON.stringify(side));
await page.screenshot({ path: `${OUT}/desktop-sidebyside.jpg` });

/* 源码 Diff 仍然可用 */
await page.eval(() => { document.querySelector('.wb-mode[data-mode="unified"]')?.click(); return true; });
await sleep(300);
const unified = await page.eval(() => ({
  lines: document.querySelectorAll('#wbContent .dline').length,
  add: document.querySelectorAll('#wbContent .dline.add').length,
}));
log('unified', JSON.stringify(unified));
await page.screenshot({ path: `${OUT}/desktop-unified.jpg` });

/* 关闭标记 */
await page.eval(() => { document.querySelector('.wb-mode[data-mode="reading"]')?.click(); return true; });
await sleep(300);
await page.eval(() => { const c = document.getElementById('wbMarks'); c.checked = false; c.dispatchEvent(new Event('change')); return true; });
await sleep(300);
const marksOff = await page.eval(() => {
  const row = document.querySelector('.csv-table tbody .is-modified > td');
  const cell = document.querySelector('.csv-table td.is-changed');
  return {
    rowBg: row ? getComputedStyle(row).backgroundColor : null,
    cellBg: cell ? getComputedStyle(cell).backgroundColor : null,
  };
});
log('marksOff', JSON.stringify(marksOff));
await page.screenshot({ path: `${OUT}/desktop-marks-off.jpg` });

const mobile = await browser.newPage({ width: 390, height: 844, mobile: true });
await openWorkbench(mobile);
const mobileState = await mobile.eval(() => ({
  pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
  content: Math.round(document.querySelector('.wb-content').getBoundingClientRect().width),
  rows: document.querySelectorAll('.csv-table tbody .csv-row').length,
  wrap: (() => { const w = document.querySelector('.csv-wrap'); return { client: w.clientWidth, scroll: w.scrollWidth }; })(),
}));
log('mobile', JSON.stringify(mobileState));
await mobile.screenshot({ path: `${OUT}/mobile-reading.jpg` });

for (const p of [page, mobile]) await p.close();
await browser.close();
