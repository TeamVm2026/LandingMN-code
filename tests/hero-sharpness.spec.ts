
import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';

const LOCALES: Locale[] = ['mn', 'ru', 'en'];

const VIEWPORTS = [
  { w: 390, h: 844, dpr: 1 },
  { w: 390, h: 844, dpr: 3 },
  { w: 768, h: 1024, dpr: 1 },
  { w: 1024, h: 1366, dpr: 1 },
  { w: 1353, h: 1070, dpr: 1 },
  { w: 1440, h: 900, dpr: 1 },
  { w: 1920, h: 1080, dpr: 1 },
] as const;

const PORTRAIT_BREAKPOINT = 859;

const MAX_SCALE_DESKTOP = 1.0;
const MAX_SCALE_PHONE = 1.15;

const COOL_TOLERANCE = 1;

const ABOVE_BAND = 8;

type Geometry = {
  src: string;
  boxW: number;
  boxH: number;
  surfTop: number;
  textX: number;
  textRight: number;
  textTop: number;
  textBottom: number;
  docW: number;
};

async function readGeometry(page: import('@playwright/test').Page): Promise<Geometry> {
  return page.evaluate(() => {
    const img = document.querySelector<HTMLImageElement>('.hero-media img');
    const media = document.querySelector('.hero-media');
    const surface = document.querySelector('.page-surface');
    const heading = document.querySelector('#direction-cards-title');
    if (!img || !media || !surface || !heading) throw new Error('первый экран, поверхность или заголовок не найдены');
    const box = media.getBoundingClientRect();
    const surf = surface.getBoundingClientRect();

    const range = document.createRange();
    range.selectNodeContents(heading);
    const text = range.getBoundingClientRect();
    return {
      src: img.currentSrc,
      boxW: box.width,
      boxH: box.height,
      surfTop: surf.y + window.scrollY,
      textX: text.x,
      textRight: text.x + text.width,
      textTop: text.y + window.scrollY,
      textBottom: text.y + text.height + window.scrollY,
      docW: document.documentElement.clientWidth,
    };
  });
}

const fileCache = new Map<string, { width: number; height: number }>();

test.describe('Кадр первого экрана не растягивается', () => {
  for (const { w, h, dpr } of VIEWPORTS) {
    for (const locale of LOCALES) {
      test(`${w}×${h} dpr${dpr} ${locale}: увеличение в пределах потолка`, async ({ browser }) => {
        const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
        const page = await context.newPage();
        try {
          await page.goto(PAGE_ROUTES.home[locale]);
          await page.waitForLoadState('networkidle');
          const geo = await readGeometry(page);

          let real = fileCache.get(geo.src);
          if (!real) {
            const response = await page.request.get(geo.src);
            expect(response.ok(), `кадр ${geo.src} не скачался`).toBe(true);
            const meta = await sharp(await response.body()).metadata();
            real = { width: meta.width ?? 0, height: meta.height ?? 0 };
            fileCache.set(geo.src, real);
          }
          expect(real.width, 'у выбранного файла не прочитались размеры').toBeGreaterThan(0);

          const scale = Math.max((geo.boxW * dpr) / real.width, (geo.boxH * dpr) / real.height);
          const ceiling = w <= PORTRAIT_BREAKPOINT ? MAX_SCALE_PHONE : MAX_SCALE_DESKTOP;
          expect(
            scale,
            `кадр ${geo.src.split('/').pop()} ${real.width}×${real.height} в коробке ` +
              `${Math.round(geo.boxW * dpr)}×${Math.round(geo.boxH * dpr)} растянут в ${scale.toFixed(2)} раза ` +
              `при потолке ${ceiling}. Проверь sizes у <source> в Hero.astro: при object-fit: cover ` +
              'потребность задаёт ВЫСОТА коробки, а не ширина.',
          ).toBeLessThanOrEqual(ceiling);
        } finally {
          await context.close();
        }
      });
    }
  }
});

test.describe('Фотография первого экрана не доходит до заголовка «Выберите направление»', () => {
  for (const { w, h, dpr } of VIEWPORTS) {
    for (const locale of LOCALES) {
      test(`${w}×${h} dpr${dpr} ${locale}: фон на высоте заголовка холодный`, async ({ browser }) => {
        const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
        const page = await context.newPage();
        try {
          await page.goto(PAGE_ROUTES.home[locale]);
          await page.waitForLoadState('networkidle');
          const geo = await readGeometry(page);

          await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, Math.round(geo.surfTop - 220)));
          await page.waitForTimeout(600);
          const scrollY = await page.evaluate(() => window.scrollY);
          const shot = await page.screenshot();
          const { data, info } = await sharp(shot).removeAlpha().raw().toBuffer({ resolveWithObject: true });

          const toY = (pageY: number) => Math.round((pageY - scrollY) * dpr);
          const toX = (pageX: number) => Math.round(pageX * dpr);
          const pad = Math.round(10 * dpr);

          const strips: [number, number][] = [
            [pad, Math.max(pad + 1, toX(geo.textX) - pad)],
            [Math.min(info.width - pad - 1, toX(geo.textRight) + pad), Math.round(geo.docW * dpr) - pad],
          ];
          const bands: [string, number, number][] = [
            ['на высоте заголовка', toY(geo.textTop), toY(geo.textBottom)],
            ['над заголовком', Math.max(toY(geo.surfTop), toY(geo.textTop) - Math.round(ABOVE_BAND * dpr)), toY(geo.textTop)],
          ];

          for (const [bandName, y0, y1] of bands) {

            let warmest = -999;
            let worstAt = '';
            let worstPixel: number[] = [];
            for (const [x0, x1] of strips) {
              for (let y = Math.max(0, y0); y < Math.min(info.height, y1); y += 1) {
                for (let x = Math.max(0, x0); x < Math.min(info.width, x1); x += 1) {
                  const o = (y * info.width + x) * info.channels;
                  const px = [data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0];
                  const warmth = px[0]! - px[2]!;
                  if (warmth > warmest) {
                    warmest = warmth;
                    worstAt = `x=${Math.round(x / dpr)} отступ=+${Math.round(y / dpr - (geo.surfTop - scrollY))}`;
                    worstPixel = px;
                  }
                }
              }
            }
            expect(
              warmest,
              `${bandName}: самый тёплый пиксель ${worstPixel.join(',')} (${worstAt}), R − B = ${warmest} ` +
                `при допуске ${COOL_TOLERANCE}. Холодной сцене такое не свойственно — значит до заголовка ` +
                'доходит фотография первого экрана (её огни воды дают R > B). Проверь `--hero-overlap` ' +
                'в tokens.css §1.1 и растворение низа кадра у `.hero-media` в Hero.astro.',
            ).toBeLessThanOrEqual(COOL_TOLERANCE);
          }
        } finally {
          await context.close();
        }
      });
    }
  }
});

test.describe('Первый экран не наезжает на секцию направлений', () => {
  for (const { w, h, dpr } of VIEWPORTS) {
    test(`${w}×${h} dpr${dpr}: кромка кадра совпадает с верхом поверхности`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: w, height: h },
        deviceScaleFactor: dpr,
      });
      const page = await context.newPage();
      try {
        await page.goto(PAGE_ROUTES.home.mn);
        await page.waitForLoadState('networkidle');
        const geo = await page.evaluate(() => {
          const media = document.querySelector('.hero-media')!.getBoundingClientRect();
          const surface = document.querySelector('.page-surface')!.getBoundingClientRect();
          return {
            mediaBottom: Math.round(media.bottom + window.scrollY),
            surfaceTop: Math.round(surface.top + window.scrollY),
            overlap: getComputedStyle(document.documentElement)
              .getPropertyValue('--hero-overlap')
              .trim(),
          };
        });
        expect(
          geo.mediaBottom - geo.surfaceTop,
          `кадр первого экрана заходит под секцию направлений на ${geo.mediaBottom - geo.surfaceTop}px ` +
            `(--hero-overlap = "${geo.overlap}"). Утверждённые 06.09.2026 кадры сняты с нулевым наездом, ` +
            'и вся геометрия семи облачных слоёв подобрана под него.',
        ).toBeLessThanOrEqual(1);
      } finally {
        await context.close();
      }
    });
  }
});
