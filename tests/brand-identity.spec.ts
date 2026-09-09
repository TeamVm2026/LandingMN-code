
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';

const LOCALES: Locale[] = ['mn', 'ru', 'en'];
const distDir = path.resolve(import.meta.dirname, '..', 'dist');

const TILE = { r: 0x18, g: 0x18, b: 0x18 };
const GOLD = { r: 0xf9, g: 0xbb, b: 0x08 };
const LIGHT = { r: 0xf9, g: 0xf9, b: 0xf8 };

const ASTRO_GOLD = { r: 0xf1, g: 0xc6, b: 0x32 };

type RGB = { r: number; g: number; b: number };

async function colourShare(file: string, want: RGB, tolerance = 10): Promise<number> {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let hits = 0;
  const total = info.width * info.height;
  for (let i = 0; i < data.length; i += 4) {
    if (
      Math.abs(data[i] - want.r) <= tolerance &&
      Math.abs(data[i + 1] - want.g) <= tolerance &&
      Math.abs(data[i + 2] - want.b) <= tolerance
    ) {
      hits++;
    }
  }
  return hits / total;
}

test.describe('Значок вкладки несёт знак MELBET, а не чужой логотип', () => {

  const SET: { file: string; size: number }[] = [
    { file: 'favicon-16x16.png', size: 16 },
    { file: 'favicon-32x32.png', size: 32 },
    { file: 'apple-touch-icon.png', size: 180 },
    { file: 'android-chrome-192x192.png', size: 192 },
    { file: 'android-chrome-512x512.png', size: 512 },
  ];

  test('все файлы набора существуют в сборке и имеют объявленный размер', async () => {
    for (const { file, size } of SET) {
      const p = path.join(distDir, file);
      expect(existsSync(p), `${file} отсутствует в dist/`).toBe(true);
      const meta = await sharp(p).metadata();
      expect(meta.width, `${file}: ширина не ${size}`).toBe(size);
      expect(meta.height, `${file}: высота не ${size}`).toBe(size);
    }
  });

  test('в каждом растре есть плитка, светлая «M» и золотая «B» пакета бренда', async () => {
    for (const { file } of SET) {
      const p = path.join(distDir, file);

      expect(await colourShare(p, TILE), `${file}: нет плитки #181818`).toBeGreaterThan(0.4);

      expect(await colourShare(p, GOLD), `${file}: нет золотой «B» #F9BB08`).toBeGreaterThan(0.01);
      expect(await colourShare(p, LIGHT), `${file}: нет светлой «M» #F9F9F8`).toBeGreaterThan(0.01);
    }
  });

  test('логотип Astro не вернулся ни в один файл набора', async () => {
    for (const { file } of SET) {
      const share = await colourShare(path.join(distDir, file), ASTRO_GOLD, 4);
      expect(
        share,
        `${file}: найдено золото логотипа Astro (#f1c632) — генератор снова размножает чужой знак`,
      ).toBeLessThan(0.005);
    }
  });

  test('favicon.svg — знак бренда, а не контур Astro, и без мёртвого prefers-color-scheme', () => {
    const svg = readFileSync(path.join(distDir, 'favicon.svg'), 'utf8');
    expect(svg, 'favicon.svg потерял плитку бренда').toContain('#181818');
    expect(svg, 'favicon.svg потерял золото бренда').toContain('#F9BB08');
    expect(svg, 'favicon.svg потерял светлую букву бренда').toContain('#F9F9F8');

    expect(svg, 'в favicon.svg вернулся prefers-color-scheme — плитка потеряна').not.toContain(
      'prefers-color-scheme',
    );

    expect(svg, 'плитка не растянута на весь холст').toMatch(/<rect[^>]*width="268"/);
  });

  test('favicon.ico — настоящий ICO-контейнер с записями 16 и 32', () => {

    const raw = new Uint8Array(readFileSync(path.join(distDir, 'favicon.ico')));
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

    expect(
      [...raw.slice(0, 4)],
      'favicon.ico не начинается с заголовка ICO (00 00 01 00)',
    ).toEqual([0, 0, 1, 0]);

    const count = view.getUint16(4, true);
    expect(count, 'в favicon.ico не две записи').toBe(2);

    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const o = 6 + i * 16;
      const w = raw[o] === 0 ? 256 : raw[o];
      const len = view.getUint32(o + 8, true);
      const off = view.getUint32(o + 12, true);
      expect(off + len, `запись ${i} выходит за конец файла`).toBeLessThanOrEqual(raw.byteLength);
      expect(view.getUint32(off, true), `запись ${i}: не BITMAPINFOHEADER`).toBe(40);

      expect(view.getInt32(off + 8, true), `запись ${i}: высота DIB не удвоена`).toBe(w * 2);
      sizes.push(w);
    }
    expect(sizes.sort((a, b) => a - b)).toEqual([16, 32]);
  });

  test('разметка ссылается на весь набор, и каждая ссылка ведёт в существующий файл', async ({
    page,
  }) => {
    for (const locale of LOCALES) {
      await page.goto(PAGE_ROUTES.home[locale]);
      const hrefs = await page.evaluate(() =>
        [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')].map(
          (el) => el.getAttribute('href') ?? '',
        ),
      );
      expect(hrefs, `${locale}: в <head> меньше четырёх ссылок на значок`).toHaveLength(4);
      for (const href of hrefs) {
        expect(href.startsWith('/'), `${locale}: ссылка на значок не абсолютная: ${href}`).toBe(
          true,
        );
        expect(
          existsSync(path.join(distDir, href.slice(1))),
          `${locale}: значок ${href} отсутствует в dist/`,
        ).toBe(true);
      }
    }
  });
});

test.describe('Заголовок вкладки: бренд первым, гео не потеряно', () => {

  const TITLE_BUDGET = 32;

  function dict(locale: Locale): { title: string; description: string; og_title: string } {
    const raw = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'i18n', `${locale}.json`),
      'utf8',
    );
    return JSON.parse(raw).meta;
  }

  test('в каждой локали <title> начинается с бренда и укладывается в бюджет', async ({ page }) => {
    const seen = new Set<string>();
    for (const locale of LOCALES) {
      await page.goto(PAGE_ROUTES.home[locale]);
      const title = await page.title();

      expect(title.startsWith('MELBET'), `${locale}: <title> не начинается с бренда: "${title}"`).toBe(
        true,
      );
      expect(title.length, `${locale}: <title> длиннее ${TITLE_BUDGET} знаков: "${title}"`).toBeLessThanOrEqual(
        TITLE_BUDGET,
      );

      expect(seen.has(title), `${locale}: <title> дублирует другую локаль: "${title}"`).toBe(false);
      seen.add(title);

      expect(title, `${locale}: в <title> вернулся разделитель-глиф`).not.toMatch(/[·—|]/);

      expect(title, `${locale}: <title> разошёлся со словарём`).toBe(dict(locale).title);
    }
    expect(seen.size, 'уникальных заголовков не три').toBe(3);
  });

  test('гео, ушедшее из <title>, осталось в описании и в карточке соцсетей', async ({ page }) => {

    const GEO = /Монгол|Mongolia/;
    for (const locale of LOCALES) {
      const meta = dict(locale);
      expect(meta.description, `${locale}: гео пропало из meta.description`).toMatch(GEO);
      expect(meta.og_title, `${locale}: гео пропало из meta.og_title`).toMatch(GEO);

      await page.goto(PAGE_ROUTES.home[locale]);
      const rendered = await page.evaluate(() => ({
        description:
          document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '',
        ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '',
      }));
      expect(rendered.description, `${locale}: описание в сборке без гео`).toMatch(GEO);
      expect(rendered.ogTitle, `${locale}: og:title в сборке без гео`).toMatch(GEO);

      expect(rendered.ogTitle, `${locale}: og:title подменили коротким title`).not.toBe(meta.title);
    }
  });
});
