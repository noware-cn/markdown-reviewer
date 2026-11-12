/* 表格壳的滚动行为与浮层边界：粘性是否真的粘住、工具条是否溢出、页面是否横向溢出 */
import { Browser } from '/home/dsun/.agents/skills/design-taste-frontend/scripts/lib/cdp.mjs';

const BASE = 'http://127.0.0.1:8787';
const out = [];
const check = (name, ok, detail = '') => {
  out.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const wait = (page, sel) => page.eval(async (s) => {
  for (let i = 0; i < 80; i += 1) {
    if (document.querySelector(s)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}, sel);

const browser = await Browser.launch({ width: 1440, height: 900 });
const page = await browser.newPage({ width: 1440, height: 900 });
await page.goto(`${BASE}/auth/login`, { settleMs: 1200 });
await page.eval(() => document.querySelector('.item[data-number="16"]').click());
await wait(page, '#wbFiles [data-path]');
await page.eval(() => Array.from(document.querySelectorAll('#wbFiles [data-path]')).find((e) => e.dataset.path.includes('中标台账.csv')).click());
await wait(page, '#wbContent .table-shell.is-csv .tscroll table');

const vertical = await page.eval(async () => {
  const shell = document.querySelector('#wbContent .table-shell.is-csv');
  const scroll = shell.querySelector('.tscroll');
  const th = shell.querySelector('thead th');
  const row = shell.querySelector('tbody tr');
  const shellTop = scroll.getBoundingClientRect().top;
  const rowBefore = row.getBoundingClientRect().top;
  scroll.scrollTop = 200;
  await new Promise((r) => setTimeout(r, 250));
  return {
    headerTop: Math.round(th.getBoundingClientRect().top),
    /* 布局可能在等待期间回流（路径栏出现等），容器位置要取同一时刻 */
    shellTop: Math.round(scroll.getBoundingClientRect().top),
    rowMoved: Math.round(rowBefore - row.getBoundingClientRect().top),
    scrollable: scroll.scrollHeight > scroll.clientHeight,
  };
});

check('纵向滚动时表头钉在容器顶部',
  vertical.scrollable && Math.abs(vertical.headerTop - vertical.shellTop) <= 2 && vertical.rowMoved > 150,
  JSON.stringify(vertical));

const lnSticky = await page.eval(async () => {
  const shell = document.querySelector('#wbContent .table-shell.is-csv');
  const scroll = shell.querySelector('.tscroll');
  const ln = shell.querySelector('tbody .csv-ln');
  const before = ln.getBoundingClientRect().left;
  scroll.scrollLeft = 320;
  await new Promise((r) => setTimeout(r, 250));
  return { before: Math.round(before), after: Math.round(ln.getBoundingClientRect().left), shellLeft: Math.round(shell.getBoundingClientRect().left) };
});
check('横向滚动时行号列钉在左侧', lnSticky.after === lnSticky.before && lnSticky.after - lnSticky.shellLeft <= 2, JSON.stringify(lnSticky));

const shadows = await page.eval(() => {
  const shell = document.querySelector('#wbContent .table-shell.is-csv');
  const scroll = shell.querySelector('.tscroll');
  const read = () => ({
    l: Number(getComputedStyle(shell.querySelector('.tshadow.l')).opacity),
    r: Number(getComputedStyle(shell.querySelector('.tshadow.r')).opacity),
  });
  const mid = read();
  scroll.scrollLeft = scroll.scrollWidth;
  return new Promise((r) => setTimeout(() => r({ mid, end: read() }), 300));
});
check('滚动到尽头后右侧渐隐消失', shadows.mid.r === 1 && shadows.end.r === 0, JSON.stringify(shadows));

/* 工具条在手机宽度是否被裁 */
const mobile = await browser.newPage({ width: 390, height: 844, mobile: true });
await mobile.goto(`${BASE}/auth/login`, { settleMs: 1200 });
await mobile.eval(() => document.querySelector('.item[data-number="16"]').click());
await wait(mobile, '#wbFiles [data-path]');
await mobile.eval(() => Array.from(document.querySelectorAll('#wbFiles [data-path]')).find((e) => e.dataset.path.includes('中标台账.csv')).click());
await wait(mobile, '#wbContent .table-shell.is-csv');
const mobileBar = await mobile.eval(() => {
  const bar = document.querySelector('#wbContent .tbar');
  const r = bar.getBoundingClientRect();
  return {
    clipped: bar.scrollWidth > bar.clientWidth + 2,
    lines: Math.round(r.height),
    pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    buttons: Array.from(bar.querySelectorAll('.tbtn')).map((b) => b.getBoundingClientRect().width | 0),
  };
});
check('手机端工具条不被裁切', !mobileBar.clipped, JSON.stringify(mobileBar));
check('手机端页面无横向溢出', mobileBar.pageOverflow <= 0, String(mobileBar.pageOverflow));

/* 文档页两种宽度 */
for (const [label, width, height] of [['桌面', 1440, 900], ['手机', 390, 844]]) {
  const p2 = await browser.newPage({ width, height, mobile: width < 500 });
  const rel = 'docs/市场调查/区域银行智能研发/来源清单.csv';
  await p2.goto(`${BASE}/${rel.split('/').map(encodeURIComponent).join('/')}`, { settleMs: 1400 });
  const info = await p2.eval(() => ({
    pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    shell: !!document.querySelector('#docPage .table-shell.is-csv'),
    cardMode: getComputedStyle(document.querySelector('#docPage .table-shell.is-csv thead')).display,
  }));
  check(`文档页 ${label}：无横向溢出且表格有壳`, info.pageOverflow <= 0 && info.shell, JSON.stringify(info));
  await p2.close();
}

const failed = out.filter((r) => !r.ok);
console.log(`\n${out.length - failed.length}/${out.length} 通过`);
await browser.close();
process.exit(failed.length ? 1 : 0);
