/* CSV 表格版式量测：列对齐、行高、配色 */
import { Browser, sleep } from '/home/dsun/.agents/skills/design-taste-frontend/scripts/lib/cdp.mjs';

const BASE = 'http://127.0.0.1:8787';
const browser = await Browser.launch({ width: 1440, height: 900 });
const page = await browser.newPage({ width: 1440, height: 900 });
await page.goto(`${BASE}/auth/login`, { settleMs: 1200 });
await page.eval(() => { document.querySelector('.item')?.click(); return true; });
await page.eval(async () => {
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.csv-table')) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
});
await sleep(500);

const out = await page.eval(() => {
  const table = document.querySelector('.csv-table');
  const ths = [...table.querySelectorAll('thead th')];
  const firstTds = [...table.querySelectorAll('tbody tr:nth-child(2) td')];
  const row = document.querySelector('.csv-table tbody .is-modified');
  const cell = table.querySelector('td.is-changed');
  const anchor = table.querySelector('.line-anchor');
  const num = table.querySelector('.csv-num');
  const bar = document.querySelector('.csv-bar');
  const px = (v) => v;
  return {
    display: getComputedStyle(table).display,
    tableWidth: Math.round(table.getBoundingClientRect().width),
    colAlign: ths.map((th, i) => ({
      i,
      thLeft: Math.round(th.getBoundingClientRect().left) - Math.round(table.getBoundingClientRect().left),
      thW: Math.round(th.getBoundingClientRect().width),
      tdLeft: firstTds[i] ? Math.round(firstTds[i].getBoundingClientRect().left) - Math.round(table.getBoundingClientRect().left) : null,
      tdW: firstTds[i] ? Math.round(firstTds[i].getBoundingClientRect().width) : null,
      header: th.textContent.slice(0, 8),
    })),
    rowHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
    rowBg: row ? getComputedStyle(row.firstElementChild).backgroundColor : null,
    cellBg: cell ? getComputedStyle(cell).backgroundColor : null,
    gutterColor: num ? getComputedStyle(num).color : null,
    anchorBox: anchor ? (() => { const r = anchor.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), opacity: getComputedStyle(anchor).opacity, pos: getComputedStyle(anchor).position }; })() : null,
    barFont: bar ? getComputedStyle(bar).fontSize : null,
    theadThHeight: ths[0] ? Math.round(ths[0].getBoundingClientRect().height) : null,
    stuckHeaderTop: ths[0] ? Math.round(ths[0].getBoundingClientRect().top) : null,
    wrapRadius: getComputedStyle(document.querySelector('.csv-wrap')).borderRadius,
    tableBottomGap: Math.round(document.querySelector('.wb-content').getBoundingClientRect().bottom - document.querySelector('.csv-wrap').getBoundingClientRect().bottom),
  };
});
console.log(JSON.stringify(out, null, 2));
await page.close();
await browser.close();
