/* PR #16 真实数据核对：列表可进入、两份 CSV 渲染、单元格未被逗号拆断 */
import { Browser, sleep } from '/home/dsun/.agents/skills/design-taste-frontend/scripts/lib/cdp.mjs';
import { mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8787';
const OUT = '.taste-skill/pr16';
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);

const waitFor = (page, fn, ms = 8000) => page.eval(async (source, budget) => {
  const test = eval(source);
  for (let i = 0; i < budget / 100; i += 1) {
    const hit = test();
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}, `(${fn.toString()})()`, ms);

const browser = await Browser.launch({ width: 1440, height: 900 });
const page = await browser.newPage({ width: 1440, height: 900 });

await page.goto(`${BASE}/auth/login`, { settleMs: 1500 });
await waitFor(page, () => document.querySelector('.item'));

/* 列表里应出现 #16 */
const listRow = await page.eval(() => {
  const rows = [...document.querySelectorAll('.item')];
  const hit = rows.find((el) => el.textContent.includes('中标台账'));
  return hit ? { index: rows.indexOf(hit), text: hit.textContent.replace(/\s+/g, ' ').trim() } : null;
});
log('list', JSON.stringify(listRow));

await page.eval(() => {
  const hit = [...document.querySelectorAll('.item')].find((el) => el.textContent.includes('中标台账'));
  hit.click();
  return true;
});
await waitFor(page, () => document.querySelector('.wb-body'));
await waitFor(page, () => document.querySelector('.fitem'));

/* 文件列表默认是树状视图；本脚本按平铺视图断言，先切一次 */
await page.eval(() => {
  const btn = document.querySelector('.wb-viewseg [data-view="flat"]');
  if (btn) btn.click();
  return true;
});

const nav = await page.eval(() => ({
  files: [...document.querySelectorAll('.fitem')].map((el) => el.dataset.path),
  csvChips: [...document.querySelectorAll('.fitem')].filter((el) => /\.csv$/.test(el.dataset.path)).map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
  meta: document.querySelector('.wb-meta, .wb-sub, .wb-title')?.textContent?.replace(/\s+/g, ' ').trim(),
}));
log('nav', JSON.stringify(nav, null, 1));

const openCsv = async (name) => {
  await page.eval((target) => {
    const el = [...document.querySelectorAll('.fitem')].find((x) => x.dataset.path.includes(target));
    el.click();
    return true;
  }, name);
  await waitFor(page, () => document.querySelector('.csv-table'));
  await sleep(700);
};

await openCsv('中标台账.csv');
const ledger = await page.eval(() => {
  const table = document.querySelector('.csv-table');
  const head = [...table.querySelectorAll('thead th')].map((el) => el.textContent.trim());
  const body = [...table.querySelectorAll('tbody .csv-row')];
  const first = body[0] ? [...body[0].querySelectorAll('td')].map((el) => el.textContent) : [];
  const wrap = document.querySelector('.csv-wrap');
  return {
    stat: document.querySelector('.csv-stat')?.textContent,
    delta: document.querySelector('.csv-delta')?.textContent,
    cols: head.length,
    head,
    rows: body.length,
    added: table.querySelectorAll('.csv-row.is-added').length,
    firstLineCells: first,
    anchors: [...table.querySelectorAll('.line-anchor')].slice(0, 3).map((el) => el.dataset.line),
    hScroll: wrap ? { client: wrap.clientWidth, scroll: wrap.scrollWidth } : null,
    pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    chapters: document.getElementById('wbChapters').textContent.replace(/\s+/g, ' ').trim().slice(0, 120),
  };
});
ledger.quoteCell = ledger.firstLineCells[18];
delete ledger.firstLineCells;
log('ledger', JSON.stringify(ledger, null, 1));
await page.screenshot({ path: `${OUT}/ledger-reading.jpg` });

/* 引用字段里的逗号必须留在同一格里 */
const quoted = await page.eval(() => {
  const rows = [...document.querySelectorAll('.csv-table tbody .csv-row')];
  const row = rows.find((el) => el.textContent.includes('RB-0001'));
  const cells = [...row.querySelectorAll('td')].slice(1).map((el) => el.textContent);
  return { cellCount: cells.length, amount: cells[7], quote: cells[18], note: cells[19] };
});
log('quoted', JSON.stringify(quoted, null, 1));

await openCsv('来源清单.csv');
const sources = await page.eval(() => {
  const table = document.querySelector('.csv-table');
  const body = [...table.querySelectorAll('tbody .csv-row')];
  return {
    stat: document.querySelector('.csv-stat')?.textContent,
    cols: table.querySelectorAll('thead th').length,
    rows: body.length,
    head: [...table.querySelectorAll('thead th')].map((el) => el.textContent.trim()),
    urlCell: body[0] ? [...body[0].querySelectorAll('td')][2]?.textContent : null,
  };
});
log('sources', JSON.stringify(sources, null, 1));
await page.screenshot({ path: `${OUT}/sources-reading.jpg` });

/* 前后对照 */
await openCsv('中标台账.csv');
await page.eval(() => { document.querySelector('[data-mode="sidebyside"]').click(); return true; });
await sleep(700);
const side = await page.eval(() => ({
  tables: document.querySelectorAll('.sb2 .csv-table').length,
  baseRows: document.querySelectorAll('.sb2 .sb-col:first-child .csv-row').length,
  headRows: document.querySelectorAll('.sb2 .sb-col:last-child .csv-row').length,
  overflow: document.documentElement.scrollWidth - window.innerWidth,
}));
log('sidebyside', JSON.stringify(side));
await page.screenshot({ path: `${OUT}/ledger-sidebyside.jpg` });

await browser.close();
