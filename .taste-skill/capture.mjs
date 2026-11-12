import { Browser, sleep } from '/home/dsun/.agents/skills/design-taste-frontend/scripts/lib/cdp.mjs';
import { mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8787';
const OUT = '.taste-skill/before';
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_PATH;

const rect = (el) => {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
};

const measure = () => {
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const body = document.body;
  const cs = getComputedStyle(document.body);
  const sizes = {};
  const colors = {};
  const radii = {};
  const shadows = {};
  for (const el of document.querySelectorAll('*')) {
    const s = getComputedStyle(el);
    if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
    if (el.childElementCount === 0 && el.textContent.trim()) {
      sizes[s.fontSize] = (sizes[s.fontSize] || 0) + 1;
      colors[s.color] = (colors[s.color] || 0) + 1;
    }
    if (s.borderRadius && s.borderRadius !== '0px') radii[s.borderRadius] = (radii[s.borderRadius] || 0) + 1;
    if (s.boxShadow && s.boxShadow !== 'none') shadows[el.className || el.tagName] = s.boxShadow;
  }
  const topbar = document.querySelector('.wb-topbar');
  const topkids = topbar ? [...topbar.children].filter((e) => e.offsetWidth).map((e) => ({ id: e.id || e.className, ...rect(e) })) : [];
  return {
    viewport: { w: innerWidth, h: innerHeight },
    overflow: { scrollW: document.documentElement.scrollWidth, bodyScrollW: body.scrollWidth },
    background: cs.backgroundColor,
    font: cs.fontFamily,
    sizes, colors, radii, shadows,
    topbar: topbar ? { ...rect(topbar), children: topkids, overflow: topkids.reduce((a, c) => Math.max(a, c.x + c.w), 0) > innerWidth } : null,
    list: {
      layout: document.querySelector('.layout') ? rect(document.querySelector('.layout')) : null,
      sidebar: document.querySelector('.sidebar') ? rect(document.querySelector('.sidebar')) : null,
      detail: document.querySelector('.detail') ? rect(document.querySelector('.detail')) : null,
      title: document.querySelector('.brand-text')?.textContent,
      brandSubColor: document.querySelector('.brand-sub') ? getComputedStyle(document.querySelector('.brand-sub')).color : null,
      itemSubColor: document.querySelector('.item-sub') ? getComputedStyle(document.querySelector('.item-sub')).color : null,
    },
    workbench: document.querySelector('#workbench') && !document.querySelector('#workbench').hidden ? {
      nav: document.querySelector('.wb-nav') ? rect(document.querySelector('.wb-nav')) : null,
      doc: document.querySelector('.wb-doc') ? rect(document.querySelector('.wb-doc')) : null,
      content: document.querySelector('.wb-content') ? rect(document.querySelector('.wb-content')) : null,
      contentFont: document.querySelector('.wb-content') ? getComputedStyle(document.querySelector('.wb-content')).fontSize : null,
      contentLine: document.querySelector('.wb-content') ? getComputedStyle(document.querySelector('.wb-content')).lineHeight : null,
      drawer: document.querySelector('.wb-body.drawer-open .wb-drawer') ? rect(document.querySelector('.wb-drawer')) : null,
      h1: document.querySelector('.wb-content h1') ? { text: document.querySelector('.wb-content h1').textContent.trim(), ...rect(document.querySelector('.wb-content h1')), font: getComputedStyle(document.querySelector('.wb-content h1')).fontSize } : null,
      paragraphs: [...document.querySelectorAll('.wb-content p')].slice(0, 3).map((p) => ({ ...rect(p), chars: p.textContent.length, font: getComputedStyle(p).fontSize })),
      modes: [...document.querySelectorAll('.wb-mode')].map((b) => ({ text: b.textContent.trim(), ...rect(b) })),
    } : null,
  };
};

const browser = await Browser.launch({ width: 1440, height: 900 });
const run = async (width, height, mobile) => {
  const page = await browser.newPage({ width, height, mobile });
  await page.goto(`${BASE}/auth/login`, { settleMs: 1200 });
  await page.eval(async () => {
    for (let i = 0; i < 60; i += 1) {
      if (document.querySelector('.item')) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  });
  await sleep(300);
  await page.screenshot({ path: `${OUT}/${width}-list.jpg`, fullPage: false });
  const list = await page.eval(measure);
  // open first PR
  await page.eval(() => { document.querySelector('.item')?.click(); return true; });
  await page.eval(async () => {
    for (let i = 0; i < 100; i += 1) {
      if (document.querySelector('#wbContent .md-block')) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  });
  await sleep(400);
  await page.screenshot({ path: `${OUT}/${width}-workbench.jpg`, fullPage: false });
  const workbench = await page.eval(measure);
  // open drawer
  await page.eval(() => { document.getElementById('wbDrawerBtn')?.click(); return true; });
  await sleep(250);
  await page.screenshot({ path: `${OUT}/${width}-drawer.jpg`, fullPage: false });
  const drawer = await page.eval(measure);
  // scroll document
  await page.eval(() => { document.getElementById('wbDoc').scrollTop = 800; return true; });
  await sleep(200);
  await page.screenshot({ path: `${OUT}/${width}-workbench-scrolled.jpg`, fullPage: false });
  await page.close();
  return { list, workbench, drawer };
};

const desktop = await run(1440, 900, false);
const tablet = await run(768, 900, false);
const mobile = await run(390, 844, true);
console.log(JSON.stringify({ desktop, tablet, mobile }, null, 2));
await browser.close();
