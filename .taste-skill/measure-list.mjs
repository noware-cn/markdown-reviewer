import { Browser } from '/home/dsun/.agents/skills/design-taste-frontend/scripts/lib/cdp.mjs';
const browser = await Browser.launch({ width: 1440, height: 900 });
const page = await browser.newPage({ width: 1440, height: 900 });
await page.goto('http://127.0.0.1:8787/auth/login', { settleMs: 1400 });
const out = await page.eval(async () => {
  for (let i = 0; i < 60; i += 1) {
    if (document.querySelector('.item')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const head = document.querySelector('.list-head');
  const cells = [...head.children].map((s) => ({ text: s.textContent, ...r(s) }));
  const items = [...document.querySelectorAll('.item')].slice(0, 3);
  const first = items[0];
  return {
    sheet: r(document.querySelector('.list-sheet')),
    head: r(head),
    headCells: cells,
    rowHeights: items.map((i) => Math.round(i.getBoundingClientRect().height)),
    rowParts: {
      num: r(first.querySelector('.item-num')),
      title: r(first.querySelector('.item-title')),
      author: r(first.querySelector('.item-author')),
      time: r(first.querySelector('.item-time')),
      badge: r(first.querySelector('.badge')),
    },
    rowText: [...first.children].map((c) => c.className + ':' + c.textContent.trim().slice(0, 24)),
    titleLines: [...document.querySelectorAll('.item-title')].map((t) => Math.round(t.getBoundingClientRect().height)),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
