
import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';

const LOCALES: Locale[] = ['mn', 'ru', 'en'];

const MAX_EMPTY_SHARE = 0.4;

const MAX_BTN_TOP_DELTA = 4;

const MIN_BTN_WIDTH = 190;

const WIDTHS = [860, 912, 1024, 1049, 1050, 1055, 1060, 1100, 1200, 1440, 1920] as const;

const HEIGHTS = [1366, 900] as const;

type Probe = {
  emptyShare: number;
  gapAbove: number;
  heroHeight: number;
  btnCount: number;
  btnTopDelta: number;
  minBtnWidth: number;
  lines: string[];
  cuts: string[];
  scrollWidth: number;
  clientWidth: number;
};

async function probeHero(page: import('@playwright/test').Page): Promise<Probe> {
  return page.evaluate(() => {
    const hero = document.querySelector('.hero');
    const h1 = document.querySelector('.hero-h1');
    if (!hero || !h1) throw new Error('первый экран или его заголовок не найдены');
    const buttons = [...document.querySelectorAll('.hero .contact-actions--hero .contact-btn')];

    const heroRect = hero.getBoundingClientRect();
    const h1Rect = h1.getBoundingClientRect();

    const walker = document.createTreeWalker(h1, NodeFilter.SHOW_TEXT);
    const chars: { ch: string; top: number | null }[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const data = (node as Text).data;
      for (let i = 0; i < data.length; i += 1) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
        chars.push({ ch: data[i], top: rects.length ? rects[0].top : null });
      }
    }
    let lastTop: number | null = null;
    for (const c of chars) {
      if (c.top === null) c.top = lastTop;
      else lastTop = c.top;
    }

    const lines: { top: number; text: string }[] = [];
    for (const c of chars) {
      if (c.top === null) continue;
      const line = lines.find((l) => Math.abs(l.top - c.top!) <= 6);
      if (line) line.text += c.ch;
      else lines.push({ top: c.top, text: c.ch });
    }
    lines.sort((a, b) => a.top - b.top);

    const cuts: string[] = [];
    for (let i = 0; i < lines.length - 1; i += 1) {
      const cur = lines[i].text;
      const next = lines[i + 1].text;
      const endsWord = cur.length > 0 && !/\s/.test(cur[cur.length - 1]);
      const startsWord = next.length > 0 && !/\s/.test(next[0]);
      if (endsWord && startsWord) cuts.push(`${cur}|${next}`);
    }

    const tops = buttons.map((b) => b.getBoundingClientRect().top);
    const widths = buttons.map((b) => b.getBoundingClientRect().width);

    return {
      emptyShare: (h1Rect.top - heroRect.top) / heroRect.height,
      gapAbove: Math.round(h1Rect.top - heroRect.top),
      heroHeight: Math.round(heroRect.height),
      btnCount: buttons.length,
      btnTopDelta: tops.length === 2 ? Math.abs(tops[0] - tops[1]) : Number.POSITIVE_INFINITY,
      minBtnWidth: widths.length ? Math.min(...widths) : 0,
      lines: lines.map((l) => l.text),
      cuts,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
}

test.describe('Первый экран цел на планшетах и в узких полосах десктопа', () => {
  for (const height of HEIGHTS) {
    for (const width of WIDTHS) {
      test(`${width}×${height}: связка в композиции, кнопки в ряд, слово цело`, async ({ page }) => {
        for (const locale of LOCALES) {
          await page.setViewportSize({ width, height });
          await page.goto(PAGE_ROUTES.home[locale]);
          const probe = await probeHero(page);
          const at = `${locale} ${width}×${height}`;

          expect(
            probe.emptyShare,
            `${at}: над заголовком ${probe.gapAbove}px пустоты при высоте первого экрана ` +
              `${probe.heroHeight}px = ${(probe.emptyShare * 100).toFixed(1)}% — связка уехала вниз`,
          ).toBeLessThanOrEqual(MAX_EMPTY_SHARE);

          expect(probe.btnCount, `${at}: кнопок связи в первом экране не две`).toBe(2);
          expect(
            probe.btnTopDelta,
            `${at}: верхние кромки кнопок расходятся на ${probe.btnTopDelta.toFixed(1)}px — ` +
              'пара сложилась в столбик (решение заказчика 29.08.2026: в одну линию)',
          ).toBeLessThanOrEqual(MAX_BTN_TOP_DELTA);

          expect(
            probe.cuts,
            `${at}: строка заголовка кончается посреди слова. Строки: ` +
              `${probe.lines.map((l) => JSON.stringify(l)).join(' ')}`,
          ).toEqual([]);

          expect(
            probe.scrollWidth,
            `${at}: документ шире окна (${probe.scrollWidth} против ${probe.clientWidth})`,
          ).toBeLessThanOrEqual(probe.clientWidth + 1);

          expect(
            probe.minBtnWidth,
            `${at}: узкая кнопка связи ${probe.minBtnWidth.toFixed(1)}px`,
          ).toBeGreaterThanOrEqual(MIN_BTN_WIDTH);
        }
      });
    }
  }
});

const MAX_HOT_SHARE = 3;

function relLum(r: number, g: number, b: number): number {
  const f = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

test.describe('Подписи под цифрами не сидят на огнях города', () => {
  for (const [width, height] of [
    [860, 1366],
    [1024, 900],
    [1024, 768],
  ] as const) {
    test(`${width}×${height}: фон под подписями держит контраст`, async ({ page }) => {
      for (const locale of LOCALES) {
        await page.setViewportSize({ width, height });
        await page.goto(PAGE_ROUTES.home[locale]);
        await page.evaluate(() => document.fonts.ready);

        const boxes = await page.evaluate(() =>
          [...document.querySelectorAll('.hero-stat-label')].map((el) => {
            const r = el.getBoundingClientRect();
            const rgb = getComputedStyle(el).color.match(/\d+/g)!.map(Number);
            return {
              rgb,
              x: Math.max(0, Math.round(r.left)),
              y: Math.max(0, Math.round(r.top)),
              w: Math.round(r.width),
              h: Math.round(r.height),
            };
          }),
        );
        expect(boxes.length, `${locale} ${width}×${height}: подписей под цифрами не найдено`).toBe(2);

        await page.addStyleTag({ content: '.hero-copy { visibility: hidden !important; }' });

        await page.evaluate(
          () =>
            Promise.all(
              [...document.images]
                .filter((i) => {
                  if (i.complete) return false;
                  const r = i.getBoundingClientRect();
                  return r.bottom > 0 && r.top < window.innerHeight;
                })
                .map(
                  (i) =>
                    new Promise<void>((res) => {
                      const done = (): void => res();
                      i.addEventListener('load', done, { once: true });
                      i.addEventListener('error', done, { once: true });
                      setTimeout(done, 3000);
                    }),
                ),
            ).then(() => undefined),
        );
        await page.evaluate(
          () =>
            new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
        );

        let shot = await page.screenshot();
        for (let i = 0; i < 25; i += 1) {
          const next = await page.screenshot();
          if (next.length === shot.length && next.every((v, k) => v === shot[k])) break;
          shot = next;
        }
        await page.evaluate(() => {
          document.querySelectorAll('style').forEach((s) => {
            if (s.textContent?.includes('.hero-copy')) s.remove();
          });
        });

        const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
        let hot = 0;
        let total = 0;
        for (const box of boxes) {
          const limit = (relLum(box.rgb[0], box.rgb[1], box.rgb[2]) + 0.05) / 4.5 - 0.05;
          for (let y = box.y; y < Math.min(box.y + box.h, info.height); y += 1) {
            for (let x = box.x; x < Math.min(box.x + box.w, info.width); x += 1) {
              const i = (y * info.width + x) * info.channels;
              if (relLum(data[i], data[i + 1], data[i + 2]) > limit) hot += 1;
              total += 1;
            }
          }
        }
        const share = total ? (hot / total) * 100 : 0;
        expect(
          share,
          `${locale} ${width}×${height}: ${share.toFixed(2)}% фона под подписями светлее порога ` +
            'читаемости — связка села на огни города, подъём над силуэтом потерян',
        ).toBeLessThanOrEqual(MAX_HOT_SHARE);
      }
    });
  }
});

const MAX_CENTER_OFF = 2;

const CENTER_WIDTHS = [
  360, 390, 430, 500, 560, 600, 640, 700, 760, 768, 820, 859, 860, 900, 912,
  1000, 1024, 1049,
] as const;

type CenterProbe = {

  mid: number;

  reserve: number;
  h1: number | null;
  buttons: number | null;
  stats: number | null;
};

async function probeCenters(page: import('@playwright/test').Page): Promise<CenterProbe> {
  return page.evaluate(() => {
    const de = document.documentElement.getBoundingClientRect();
    const mid = (de.left + de.right) / 2;

    const textLineCenters = (el: Element): number[] => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const rects: DOMRect[] = [];
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const data = (node as Text).data;
        for (let i = 0; i < data.length; i += 1) {
          if (/\s/.test(data[i])) continue;
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const r = [...range.getClientRects()].filter((x) => x.width > 0 || x.height > 0);
          if (r.length) rects.push(r[0]);
        }
      }
      const lines: { top: number; left: number; right: number }[] = [];
      for (const r of rects) {
        const line = lines.find((l) => Math.abs(l.top - r.top) <= 6);
        if (line) {
          line.left = Math.min(line.left, r.left);
          line.right = Math.max(line.right, r.right);
        } else lines.push({ top: r.top, left: r.left, right: r.right });
      }
      return lines.map((l) => (l.left + l.right) / 2);
    };

    const textCenter = (sel: string): number | null => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = textLineCenters(el);
      if (!cs.length) return null;
      return cs.reduce((a, b) => a + b, 0) / cs.length;
    };

    const kidsCenter = (sel: string, kid: string): number | null => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const kids = [...el.querySelectorAll(kid)];
      if (!kids.length) return null;
      let left = Infinity;
      let right = -Infinity;
      for (const k of kids) {
        const r = k.getBoundingClientRect();
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
      }
      return (left + right) / 2;
    };

    return {
      mid,
      reserve: Math.round(document.documentElement.clientWidth - de.width),
      h1: textCenter('.hero-h1'),
      buttons: kidsCenter('.hero .contact-actions--hero', '.contact-btn'),
      stats: kidsCenter('.hero-stats', '.hero-stat'),
    };
  });
}

test.describe('Заголовок, кнопки и цифры не уезжают от центра (08.09.2026)', () => {
  for (const width of CENTER_WIDTHS) {

    const height = width < 500 ? 844 : width < 860 ? 1024 : 1366;
    test(`${width}×${height}: связка стоит по центру окна`, async ({ page }) => {
      for (const locale of LOCALES) {
        await page.setViewportSize({ width, height });
        await page.goto(PAGE_ROUTES.home[locale]);
        await page.evaluate(() => document.fonts.ready);
        const c = await probeCenters(page);
        const at = `${locale} ${width}×${height} (резерв полосы ${c.reserve}px)`;

        expect(c.h1, `${at}: заголовок не найден`).not.toBeNull();
        expect(c.buttons, `${at}: пара кнопок связи не найдена`).not.toBeNull();
        expect(c.stats, `${at}: пара цифр не найдена`).not.toBeNull();

        expect(
          Math.abs((c.buttons as number) - (c.h1 as number)),
          `${at}: центр пары кнопок разошёлся с центром заголовка на ` +
            `${((c.buttons as number) - (c.h1 as number)).toFixed(1)}px — ` +
            'ведущее действие уехало из-под надписи (решение заказчика 08.09.2026)',
        ).toBeLessThanOrEqual(MAX_CENTER_OFF);

        expect(
          Math.abs((c.h1 as number) - c.mid),
          `${at}: центр отрисованного заголовка отклонён от центра области на ` +
            `${((c.h1 as number) - c.mid).toFixed(1)}px`,
        ).toBeLessThanOrEqual(MAX_CENTER_OFF);

        expect(
          Math.abs((c.stats as number) - c.mid),
          `${at}: центр пары цифр отклонён от центра области на ` +
            `${((c.stats as number) - c.mid).toFixed(1)}px`,
        ).toBeLessThanOrEqual(MAX_CENTER_OFF);
      }
    });
  }
});
