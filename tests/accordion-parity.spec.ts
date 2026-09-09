import { expect, test, chromium, webkit, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PREVIEW_PORT, MOBILE_VIEWPORT } from '../playwright.config.ts';

const KOREN = path.resolve(import.meta.dirname, '..');
const FAJLY = [
  ['src/components/DirectionCards.astro', 'карточка направления', '.direction-body-inner'],
  ['src/components/FaqAccordion.astro', 'вопрос FAQ', '.faq-answer p'],
] as const;

const KLIP = new Set([
  'interpolate-size',
  'block-size',
  'content-visibility',
  'overflow',
  'grid-template-rows',
  'visibility',
  'transition',
]);

function bezKommentariev(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function telo(src: string, zagolovok: string): string {
  const i = src.indexOf(zagolovok);
  expect(i, `не найден блок ${zagolovok}`).toBeGreaterThanOrEqual(0);
  let gl = 0;
  for (let k = i + zagolovok.length - 1; k < src.length; k++) {
    if (src[k] === '{') gl++;
    else if (src[k] === '}') {
      gl--;
      if (gl === 0) return src.slice(i + zagolovok.length, k);
    }
  }
  throw new Error(`не закрыт блок ${zagolovok}`);
}

function bezStartingStyle(src: string): string {
  let out = src;
  for (;;) {
    const i = out.indexOf('@starting-style');
    if (i < 0) return out;
    const nachalo = out.indexOf('{', i);
    if (nachalo < 0) return out;
    let gl = 0;
    let k = nachalo;
    for (; k < out.length; k++) {
      if (out[k] === '{') gl++;
      else if (out[k] === '}') {
        gl--;
        if (gl === 0) break;
      }
    }
    if (k >= out.length) return out;
    out = `${out.slice(0, i)} ${out.slice(k + 1)}`;
  }
}

function svojstva(chast: string): string[] {
  return [...chast.matchAll(/(^|[;{])\s*(-{0,2}[a-zA-Z][a-zA-Z-]*)\s*:/g)].map((m) => m[2]!);
}

function animiruemye(chast: string): string[] {
  const out: string[] = [];
  for (const m of chast.matchAll(/(?:^|[;{])\s*transition\s*:([^;}]*)/g)) {
    for (const kusok of m[1]!.split(',')) {
      const imya = kusok.trim().split(/\s+/)[0];
      if (imya && imya !== 'none') out.push(imya);
    }
  }
  return out;
}

const VETVI = [
  ['@supports selector(::details-content) and (interpolate-size: allow-keywords) {', 'Chromium'],
  ['@supports selector(::details-content) and (not (interpolate-size: allow-keywords)) {', 'WebKit'],
] as const;

test.describe('Парность движков: внутри ветви живёт только механизм клипа (Д-37)', () => {
  for (const [otn, nazv] of FAJLY) {
    for (const [zagolovok, dvizhok] of VETVI) {
      test(`${nazv}: ветвь ${dvizhok} не объявляет ничего сверх клипа`, () => {
        const src = bezStartingStyle(bezKommentariev(readFileSync(path.join(KOREN, otn), 'utf8')));
        const chast = telo(src, zagolovok);

        const lishnie = [...new Set(svojstva(chast))].filter((p) => !KLIP.has(p));
        expect(
          lishnie,
          `${otn}, ветвь ${dvizhok}: объявлены свойства сверх механизма клипа — ` +
            `${lishnie.join(', ')}. Они будут работать только в одном движке. ` +
            'Место таких правил — СНАРУЖИ обеих ветвей (Д-37).',
        ).toEqual([]);

        const lishnieAnim = [...new Set(animiruemye(chast))].filter((p) => !KLIP.has(p));
        expect(
          lishnieAnim,
          `${otn}, ветвь ${dvizhok}: анимируются свойства сверх механизма клипа — ` +
            `${lishnieAnim.join(', ')}`,
        ).toEqual([]);
      });
    }
  }

  test('затухание содержимого обоих аккордеонов объявлено СНАРУЖИ ветвей', () => {

    for (const [otn, nazv, selektor] of FAJLY) {
      const src = bezKommentariev(readFileSync(path.join(KOREN, otn), 'utf8'));
      let snaruzhi = src;
      for (const [zagolovok] of VETVI) snaruzhi = snaruzhi.replace(telo(src, zagolovok), ' ');

      const bloki = [...snaruzhi.matchAll(/([^{}]*?)\{([^{}]*)\}/g)].filter((m) =>
        m[1]!.includes(selektor),
      );
      expect(bloki.length, `${nazv} (${otn}): не найдено ни одного правила ${selektor}`).toBeGreaterThan(0);

      const animPo = (open: boolean): string[] =>
        bloki
          .filter((m) => m[1]!.includes('[open]') === open)
          .flatMap((m) => animiruemye(`{${m[2]!}}`));
      expect(
        animPo(false),
        `${nazv} (${otn}): у ЗАКРЫТОГО ${selektor} вне ветвей не анимируется opacity — ` +
          'сворачивание пройдёт без затухания, ровно как в WebKit до 01.09.2026',
      ).toContain('opacity');
      expect(
        animPo(true),
        `${nazv} (${otn}): у РАСКРЫТОГО ${selektor} вне ветвей не анимируется opacity — ` +
          'раскрытие пройдёт без затухания',
      ).toContain('opacity');

      const znacheniya = bloki.flatMap((m) => [...m[2]!.matchAll(/(?:^|[;{])\s*opacity\s*:\s*([\d.]+)/g)].map((x) => x[1]!));
      expect(
        [...new Set(znacheniya)].sort(),
        `${nazv} (${otn}): у ${selektor} вне ветвей объявлены не оба конца затухания`,
      ).toEqual(['0', '1']);
    }
  });
});

const BASE = `http://localhost:${PREVIEW_PORT}`;

async function hod(page: Page, sel: string, ms = 700): Promise<Array<[number, number]>> {
  const h0 = await page.evaluate(
    (s) => +document.querySelector(s)!.getBoundingClientRect().height.toFixed(1),
    sel,
  );
  const t0 = Date.now();
  await page.evaluate((s) => {
    const el = document.querySelector(s)!;
    (el.querySelector('summary') ?? (el as HTMLElement)).click();
  }, sel);
  const proby: Array<[number, number]> = [[0, h0]];
  while (Date.now() - t0 < ms) {
    proby.push([
      Date.now() - t0,
      await page.evaluate(
        (s) => +document.querySelector(s)!.getBoundingClientRect().height.toFixed(1),
        sel,
      ),
    ]);
    await new Promise((r) => setTimeout(r, 12));
  }
  return proby;
}

function razbor(proby: Array<[number, number]>): { vPuti: number; t90: number } {
  const a = proby[0]![1];
  const b = proby.at(-1)![1];
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const cel = a + (b - a) * 0.9;
  const f = proby.find((x) => (b > a ? x[1] >= cel : x[1] <= cel));
  return { vPuti: proby.filter((x) => x[1] > lo + 2 && x[1] < hi - 2).length, t90: f ? f[0] : -1 };
}

test.describe('Парность движков: ход есть в обоих и различается не в разы (Д-37)', () => {
  test('раскрытие и сворачивание обоих аккордеонов в Chromium и WebKit', async () => {
    test.slow();
    const celi: Array<[string, string]> = [
      ['#direction-teamcash', 'карточка'],
      ['.faq-item', 'вопрос'],
    ];
    const itog = new Map<string, { vPuti: number; t90: number }>();

    for (const [imya, launcher] of [
      ['chromium', chromium],
      ['webkit', webkit],
    ] as const) {
      const browser: Browser = await launcher.launch();
      const ctx = await browser.newContext({ viewport: MOBILE_VIEWPORT, hasTouch: true });
      const page = await ctx.newPage();
      try {
        for (const [sel, nazv] of celi) {
          await page.goto(`${BASE}/ru/`);
          await page.locator(sel).first().scrollIntoViewIfNeeded();
          await page.evaluate((s) => {
            scrollBy(0, document.querySelector(s)!.getBoundingClientRect().top - 80);
          }, sel);
          await page.waitForTimeout(400);
          itog.set(`${imya} ${nazv} раскрытие`, razbor(await hod(page, sel)));
          await page.waitForTimeout(700);
          itog.set(`${imya} ${nazv} сворачивание`, razbor(await hod(page, sel)));
        }
      } finally {
        await ctx.close();
        await browser.close();
      }
    }

    for (const [k, v] of itog) {
      console.log(`  ${k.padEnd(30)} промежуточных ${String(v.vPuti).padEnd(4)} 90 % за ${v.t90} мс`);
    }

    for (const [k, v] of itog) {
      expect(v.t90, `${k}: 90 % пути за ${v.t90} мс — это ступень, а не ход`).toBeGreaterThan(120);
      expect(
        v.vPuti,
        `${k}: ни одна проба не попала ВНУТРЬ пути — ход прошёл ступенью`,
      ).toBeGreaterThanOrEqual(1);
    }

    for (const nazv of ['карточка', 'вопрос']) {
      for (const storona of ['раскрытие', 'сворачивание']) {
        const c = itog.get(`chromium ${nazv} ${storona}`)!.t90;
        const w = itog.get(`webkit ${nazv} ${storona}`)!.t90;
        const otn = Math.max(c, w) / Math.max(1, Math.min(c, w));
        expect(
          otn,
          `${nazv}, ${storona}: движки разъехались — chromium ${c} мс против webkit ${w} мс`,
        ).toBeLessThan(2.5);
      }
    }
  });
});
