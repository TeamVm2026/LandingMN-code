
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import path from 'node:path';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';

const LOCALES: Locale[] = ['mn', 'ru', 'en'];

const projectRoot = path.resolve(import.meta.dirname, '..');

function expectedResponseSegments(locale: Locale): { promise: string; hours: string } {
  const dict = JSON.parse(readFileSync(path.join(projectRoot, 'src', 'i18n', `${locale}.json`), 'utf-8'));
  return { promise: dict.hero.response_time as string, hours: dict.hero.response_hours as string };
}

const flat = (value: string): string => value.replace(/\s+/g, ' ').trim();

test.describe('Hero block (Block 1) -- LAND-02', () => {

  test('H1 renders non-empty text with a split brand mark', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.mn);
    const h1 = page.locator('h1').first();
    await expect(h1).toBeVisible();
    const text = (await h1.innerText()).trim();
    expect(text.length).toBeGreaterThan(0);
    await expect(h1.locator('em')).toHaveCount(1);
    await expect(h1.locator('em .hero-brand-accent')).toHaveCount(1);
  });

  test('hero holds exactly the four permitted text groups, no leftover chips', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.mn);
    await expect(page.locator('.hero-chip, .direction-chip')).toHaveCount(0);

    const groups = await page.locator('.hero-copy > *').count();
    expect(groups).toBe(4);
  });

  test('hero carries a real photographic background with an AVIF source', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.mn);
    const heroPicture = page.locator('.hero .hero-media picture');
    await expect(heroPicture).toHaveCount(1);

    const avif = heroPicture.locator('source[type="image/avif"]');
    await expect(avif).toHaveCount(2);
    expect(await avif.first().getAttribute('media')).toContain('max-width');
    expect(await avif.last().getAttribute('media')).toBeNull();

    const heroImg = heroPicture.locator('img');
    await expect(heroImg).toHaveAttribute('loading', 'eager');
    await expect(heroImg).toHaveAttribute('fetchpriority', 'high');

    await expect(heroImg).toHaveAttribute('width', /\d+/);
    await expect(heroImg).toHaveAttribute('height', /\d+/);
  });

  test('телефон получает вертикальный кроп, десктоп — широкий, лишнего не грузится', async ({
    browser,
  }) => {
    for (const [width, height, expected] of [
      [390, 844, 'portrait'],
      [1440, 900, 'wide'],
    ] as const) {
      const ctx = await browser.newContext({
        viewport: { width, height },
        isMobile: width < 860,
        hasTouch: width < 860,
      });
      const page = await ctx.newPage();

      await page.route('**/*', (route) =>
        /127\.0\.0\.1|localhost/.test(route.request().url()) ? route.continue() : route.abort(),
      );
      const heroFiles: string[] = [];
      page.on('response', (r) => {
        const name = r.url().split('/').pop() ?? '';
        if (name.startsWith('client-night-panorama')) heroFiles.push(name);
      });
      await page.goto(PAGE_ROUTES.home.mn, { waitUntil: 'networkidle' });

      const current = await page.evaluate(
        () => document.querySelector<HTMLImageElement>('.hero-media img')!.currentSrc,
      );
      const isPortrait = current.includes('-portrait');
      expect(isPortrait, `на ${width}px показан не тот кадр: ${current}`).toBe(
        expected === 'portrait',
      );

      expect(
        heroFiles.length,
        `на ${width}px загружено кадров первого экрана: ${heroFiles.join(', ')}`,
      ).toBe(1);
      await ctx.close();
    }
  });

  test('оба канала связи — подписанные кнопки с rel=noopener noreferrer', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.mn);
    const actions = page.locator('.hero .contact-actions').first();

    const telegram = actions.locator('.contact-btn--telegram');
    await expect(telegram).toBeVisible();
    const tgHref = await telegram.getAttribute('href');
    expect(tgHref!.startsWith('https://t.me/')).toBe(true);
    expect(await telegram.getAttribute('rel')).toBe('noopener noreferrer');
    expect(await telegram.getAttribute('target')).toBe('_blank');

    expect((await telegram.innerText()).trim().length).toBeGreaterThan(2);

    const messenger = actions.locator('.contact-btn--messenger');
    await expect(messenger).toBeVisible();
    expect(await messenger.getAttribute('rel')).toBe('noopener noreferrer');
    expect(await messenger.getAttribute('target')).toBe('_blank');
    expect((await messenger.innerText()).trim().length).toBeGreaterThan(2);

    for (const btn of [telegram, messenger]) {
      const box = await btn.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('вторичного призыва в первом экране нет, путь к направлениям цел (28.08.2026)', async ({
    page,
  }) => {
    await page.goto(PAGE_ROUTES.home.mn);

    await expect(page.locator('a.hero-jump')).toHaveCount(0);
    await expect(page.locator('.hero a[href="#programs"]')).toHaveCount(0);

    await expect(page.locator('#programs')).toHaveCount(1);

    for (const locale of LOCALES) {
      const dict = JSON.parse(
        readFileSync(path.join(projectRoot, 'src', 'i18n', `${locale}.json`), 'utf-8'),
      );
      expect(dict.hero.cta_secondary, `hero.cta_secondary остался в ${locale}`).toBeUndefined();
      expect(dict.hero.lead, `hero.lead остался в ${locale}`).toBeUndefined();
    }

    const visibleProgramLinks = async () =>
      page.locator('a[href="#programs"]:visible').count();

    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await visibleProgramLinks(),
      'на 390 появился видимый путь к #programs — цена удаления изменилась, перепиши тест',
    ).toBe(0);

    await page.setViewportSize({ width: 1440, height: 900 });
    expect(
      await visibleProgramLinks(),
      'на 1440 пропал пункт навигации к #programs',
    ).toBeGreaterThan(0);
  });

  test('response-time status matches the expected copy, carries a time range, and appears once', async ({ page }) => {
    for (const locale of LOCALES) {
      await page.goto(PAGE_ROUTES.home[locale]);
      const microline = page.locator('.hero-status-text');
      await expect(microline).toHaveCount(1);
      await expect(microline).toBeVisible();
      const text = flat(await microline.innerText());

      expect(text).toMatch(/\d{1,2}:\d{2}/);
      const { promise, hours } = expectedResponseSegments(locale);

      expect(text).toBe(flat(`${promise} · ${hours}`));

      expect(promise.length, `hero.response_time пуст в ${locale}`).toBeGreaterThan(0);
      expect(hours, `hero.response_hours в ${locale} не несёт диапазона`).toMatch(/\d{1,2}:\d{2}/);
    }
  });

  test('#hero-sentinel на месте: на нём держатся наезд --hero-overlap и краска стыка', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.mn);
    await expect(page.locator('#hero-sentinel')).toHaveCount(1);
  });
});

test.describe('Hero block -- I18N-04 (no horizontal scroll at 360px)', () => {
  for (const locale of LOCALES) {
    test(`no horizontal scroll at 360px viewport (${locale})`, async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 800 });
      await page.goto(PAGE_ROUTES.home[locale]);
      const noOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      );
      expect(noOverflow).toBe(true);
    });
  }
});

test.describe('Строка времени ответа: разделитель не может оторваться', () => {
  const SIZES = [
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 1440, height: 900 },
  ];

  for (const size of SIZES) {
    for (const locale of LOCALES) {
      test(`[${locale}] ${size.width}×${size.height}: первый экран — разделитель на месте и внутри строки`, async ({
        page,
      }) => {
        await page.setViewportSize(size);
        await page.goto(PAGE_ROUTES.home[locale]);

        const line = page.locator('.hero .hero-status-text');
        await expect(line).toBeVisible();

        await expect(line.locator('> span')).toHaveCount(3);

        const sep = line.locator('.hero-status-sep');
        await expect(sep).toHaveCount(1);

        const text = flat(await line.innerText());
        expect(text, `разделитель пропал из строки: ${text}`).toContain('·');

        const { hours } = expectedResponseSegments(locale);
        expect(text, `строка не совпала с hero.response_hours: ${text}`).toContain(flat(hours));

        const geom = await line.evaluate((el) => {
          const sepEl = el.querySelector('.hero-status-sep')!;
          const sepRects = [...sepEl.getClientRects()];
          const range = document.createRange();
          range.selectNodeContents(el);
          const lineRects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
          const sr = sepRects[0];
          const own = lineRects.filter((r) => Math.abs(r.top - sr.top) < r.height * 0.75);
          return {
            sepRectCount: sepRects.length,
            sepLeft: sr.left,
            sepRight: sr.right,
            lineLeft: Math.min(...own.map((r) => r.left)),
            lineRight: Math.max(...own.map((r) => r.right)),
          };
        });
        expect(geom.sepRectCount, 'сам разделитель разорван переносом').toBe(1);
        expect(
          geom.sepLeft - geom.lineLeft,
          `разделитель ОТКРЫВАЕТ строку (левее него краски нет): ${JSON.stringify(geom)}`,
        ).toBeGreaterThan(1);
        expect(
          geom.lineRight - geom.sepRight,
          `разделитель ВИСНЕТ в конце строки (правее него краски нет): ${JSON.stringify(geom)}`,
        ).toBeGreaterThan(1);

        const range = line.locator('.nowrap');
        await expect(range).toHaveCount(1);
        await expect(range).toHaveText(/\d{1,2}:\d{2}\s*[–—-]\s*\d{1,2}:\d{2}/);
        const rects = await range.evaluate((el) => el.getClientRects().length);
        expect(rects, 'диапазон часов разорван переносом строки').toBe(1);
      });

      test(`[${locale}] ${size.width}×${size.height}: /thanks/ разделителя НЕ получил`, async ({
        page,
      }) => {
        await page.setViewportSize(size);
        await page.goto(PAGE_ROUTES.thanks[locale]);

        const line = page.locator('main .hero-status-text');
        await expect(line).toBeVisible();

        await expect(line.locator('.hero-status-sep')).toHaveCount(0);
        const text = flat(await line.innerText());
        expect(text, `на /thanks/ появился разделитель: ${text}`).not.toContain('·');
        expect(text, `на /thanks/ появился разделитель: ${text}`).not.toContain('•');

        const range = line.locator('.nowrap');
        await expect(range).toHaveCount(1);
        const rects = await range.evaluate((el) => el.getClientRects().length);
        expect(rects, 'диапазон часов на /thanks/ разорван переносом').toBe(1);
      });
    }
  }
});

test.describe('Цифры первого экрана (Д-08): видны, из словаря, без прокрутки', () => {

  function expectedStats(locale: Locale): {
    partners: { value: string; label: string };
    share: { value: string; label: string };
  } {
    const dict = JSON.parse(
      readFileSync(path.join(projectRoot, 'src', 'i18n', `${locale}.json`), 'utf-8'),
    );
    return { partners: dict.hero.stat_partners, share: dict.hero.stat_share };
  }

  for (const size of [
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    for (const locale of LOCALES) {
      test(`[${locale}] ${size.width}×${size.height}: обе цифры в первом экране, значения из словаря`, async ({
        page,
      }) => {
        await page.setViewportSize(size);
        await page.goto(PAGE_ROUTES.home[locale]);

        const stats = page.locator('.hero-stats .hero-stat');
        await expect(stats).toHaveCount(2);

        const expected = expectedStats(locale);
        for (const [i, fact] of [expected.partners, expected.share].entries()) {
          const value = stats.nth(i).locator('.hero-stat-value');
          const label = stats.nth(i).locator('.hero-stat-label');
          await expect(value).toBeVisible();
          await expect(label).toBeVisible();

          expect(fact.value.trim().length, `hero.stat value пуст в ${locale}`).toBeGreaterThan(0);
          expect(fact.label.trim().length, `hero.stat label пуст в ${locale}`).toBeGreaterThan(0);
          await expect(value).toHaveText(fact.value);
          await expect(label).toHaveText(fact.label);

          expect(fact.value, `в величине «${fact.value}» (${locale}) обычный пробел`).not.toMatch(/ /);
        }

        const box = await page.locator('.hero-stats').boundingBox();
        expect(box, 'блок цифр не отрисован').not.toBeNull();
        expect(
          box!.y + box!.height,
          `блок цифр ушёл за сгиб ${size.width}×${size.height} (${locale})`,
        ).toBeLessThanOrEqual(size.height);
        expect(box!.y).toBeGreaterThanOrEqual(0);

        const noOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        );
        expect(noOverflow, `горизонтальная прокрутка на ${size.width}px (${locale})`).toBe(true);
      });
    }
  }

  test('на 360 в mn капсула и ведущая кнопка остаются в первом экране вместе с цифрами', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(PAGE_ROUTES.home.mn);
    for (const selector of ['.hero .contact-btn--telegram', '.hero-status', '.hero-stats']) {
      const box = await page.locator(selector).first().boundingBox();
      expect(box, `${selector} не отрисован`).not.toBeNull();
      expect(box!.y, `${selector} начинается выше окна`).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height, `${selector} ушёл за сгиб на 360×800 mn`).toBeLessThanOrEqual(800);
    }
  });

  test('пара цифр стоит в один ряд на 360 во всех трёх локалях', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    for (const locale of LOCALES) {
      await page.goto(PAGE_ROUTES.home[locale]);
      const tops = await page
        .locator('.hero-stats .hero-stat')
        .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
      expect(tops.length).toBe(2);
      expect(tops[0], `пара цифр перенеслась в столбик (${locale})`).toBe(tops[1]);
    }
  });
});

test.describe('Д-16: цифры по бокам заголовка первого экрана', () => {
  for (const locale of LOCALES) {
    test(`1440 (${locale}): одна цифра слева от h1, вторая справа`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(PAGE_ROUTES.home[locale]);

      const box = async (selector: string) =>
        page.locator(selector).evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cx: r.left + r.width / 2 };
        });

      const h1 = await box('.hero-h1');
      const first = await box('.hero-stat:nth-of-type(1)');
      const second = await box('.hero-stat:nth-of-type(2)');

      expect(
        first.right,
        `первая цифра (правая кромка ${Math.round(first.right)}) заезжает на заголовок ` +
          `(левая кромка ${Math.round(h1.left)})`,
      ).toBeLessThanOrEqual(h1.left);
      expect(
        second.left,
        `вторая цифра (левая кромка ${Math.round(second.left)}) заезжает на заголовок ` +
          `(правая кромка ${Math.round(h1.right)})`,
      ).toBeGreaterThanOrEqual(h1.right);

      for (const [name, stat] of [
        ['первая', first],
        ['вторая', second],
      ] as const) {
        expect(
          stat.top,
          `${name} цифра стоит НИЖЕ заголовка (top ${Math.round(stat.top)} против низа h1 ${Math.round(h1.bottom)})`,
        ).toBeLessThan(h1.bottom);
      }

      const actions = await box('.hero-actions');
      const status = await box('.hero-status');
      expect(actions.top, 'кнопки уехали выше заголовка').toBeGreaterThanOrEqual(h1.bottom);
      expect(status.top, 'капсула времени ответа стоит выше кнопок').toBeGreaterThanOrEqual(
        actions.top,
      );

      expect(Math.abs(actions.cx - h1.cx), 'кнопки не по центру под заголовком').toBeLessThan(24);
      expect(Math.abs(status.cx - h1.cx), 'капсула не по центру под заголовком').toBeLessThan(24);
    });

    for (const width of [390, 360]) {
      test(`${width} (${locale}): раскладка первого экрана осталась вертикальной`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(PAGE_ROUTES.home[locale]);

        const h1Bottom = await page
          .locator('.hero-h1')
          .evaluate((el) => el.getBoundingClientRect().bottom);
        const statsTop = await page
          .locator('.hero-stats')
          .evaluate((el) => el.getBoundingClientRect().top);
        const actionsTop = await page
          .locator('.hero-actions')
          .evaluate((el) => el.getBoundingClientRect().top);

        expect(statsTop, `на ${width} цифры уехали к заголовку`).toBeGreaterThan(h1Bottom);
        expect(statsTop, `на ${width} цифры встали выше кнопок`).toBeGreaterThan(actionsTop);
      });
    }
  }
});

async function brightestRowLuma(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let best = 0;
  for (let y = 0; y < info.height; y += 2) {
    let sum = 0;
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * ch;
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    const avg = sum / info.width;
    if (avg > best) best = avg;
  }
  return best;
}

test.describe('Разбор 28.08.2026: мобильный первый экран по макету', () => {
  const MOBILE_WIDTHS = [360, 390, 430];

  for (const width of MOBILE_WIDTHS) {
    for (const locale of LOCALES) {
      test(`${width} (${locale}): пара кнопок связи стоит В РЯД, доли равны`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(PAGE_ROUTES.home[locale]);

        const boxes = await page
          .locator('.hero .contact-actions--hero .contact-btn')
          .evaluateAll((els) =>
            els.map((el) => {
              const r = el.getBoundingClientRect();
              return { x: r.x, y: r.y, w: r.width, h: r.height };
            }),
          );
        expect(boxes.length, 'кнопок связи в первом экране не две').toBe(2);

        expect(
          Math.round(boxes[0].y),
          `пара кнопок сложилась в столбик (${locale}, ${width})`,
        ).toBe(Math.round(boxes[1].y));

        expect(
          Math.abs(boxes[0].w - boxes[1].w),
          `доли пары неравны: ${boxes[0].w} против ${boxes[1].w}`,
        ).toBeLessThanOrEqual(2);

        for (const b of boxes) {
          expect(b.h, 'кнопка мельче 44px по высоте').toBeGreaterThanOrEqual(44);
        }

        const overflow = await page
          .locator('.hero .contact-actions--hero .contact-btn')
          .evaluateAll((els) => els.map((el) => el.scrollWidth - el.clientWidth));
        for (const o of overflow) {
          expect(o, `подпись кнопки не помещается: перебор ${o}px`).toBeLessThanOrEqual(1);
        }
      });
    }
  }

  test('подпись второй кнопки первого экрана — «Facebook» во всех трёх локалях', async ({
    page,
  }) => {
    for (const locale of LOCALES) {
      await page.goto(PAGE_ROUTES.home[locale]);
      const label = flat(await page.locator('.hero .contact-btn--messenger').first().innerText());
      expect(label, `подпись второй кнопки в ${locale}`).toBe('Facebook');
    }
  });

  test('пара шага «Как начать» несёт подпись «Facebook», как и первый экран', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.ru);
    const step = flat(
      await page.locator('.spine-actions .contact-btn--messenger').first().innerText(),
    );
    const hero = flat(
      await page.locator('.hero-actions .contact-btn--messenger').first().innerText(),
    );
    expect(step).toBe('Facebook');
    expect(step, 'подписи шага и первого экрана разошлись').toBe(hero);
  });

  for (const width of MOBILE_WIDTHS) {
    for (const locale of LOCALES) {
      test(`${width} (${locale}): пара цифр — две равные доли по центру`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(PAGE_ROUTES.home[locale]);

        const stats = await page.locator('.hero-stats').evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, w: r.width, cx: r.x + r.width / 2 };
        });
        const items = await page.locator('.hero-stats .hero-stat').evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, cx: r.x + r.width / 2 };
          }),
        );
        expect(items.length).toBe(2);

        expect(Math.round(items[0].y), 'цифры на разной высоте').toBe(Math.round(items[1].y));

        expect(
          Math.abs(items[0].w - items[1].w),
          `доли пары цифр неравны: ${items[0].w} против ${items[1].w}`,
        ).toBeLessThanOrEqual(1);

        expect(
          Math.abs((items[0].cx + items[1].cx) / 2 - stats.cx),
          'пара цифр не по центру ряда',
        ).toBeLessThan(2);

        const [valueColor, h1Color] = await Promise.all([
          page
            .locator('.hero-stat-value')
            .first()
            .evaluate((el) => getComputedStyle(el).color),
          page.locator('.hero-h1').evaluate((el) => getComputedStyle(el).color),
        ]);
        expect(valueColor, 'величина цифры перестала быть основным цветом текста').toBe(h1Color);
      });
    }
  }

  for (const width of MOBILE_WIDTHS) {
    for (const locale of LOCALES) {
      test(`${width} (${locale}): строка времени ответа — простой текст сразу под кнопками`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(PAGE_ROUTES.home[locale]);

        const status = page.locator('.hero .hero-status');
        await expect(status).toHaveCount(1);

        await expect(status).toHaveClass(/hero-status--plain/);
        await expect(status.locator('.hero-status-icon')).toHaveCount(0);
        const material = await status.evaluate((el) => {
          const cs = getComputedStyle(el);
          return {
            bg: cs.backgroundColor,
            radius: cs.borderTopLeftRadius,
            filter: cs.backdropFilter,
          };
        });
        expect(material.bg, 'у строки осталась подложка капсулы').toMatch(/, 0\)|transparent/);
        expect(material.radius, 'у строки остался радиус капсулы').toBe('0px');
        expect(material.filter, 'у строки осталось размытие капсулы').toBe('none');

        const actionsBottom = await page
          .locator('.hero-actions')
          .evaluate((el) => el.getBoundingClientRect().bottom);
        const box = await status.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, cx: r.x + r.width / 2 };
        });
        expect(box.top, 'строка встала выше кнопок').toBeGreaterThanOrEqual(actionsBottom - 1);
        expect(
          box.top - actionsBottom,
          `строка оторвалась от кнопок на ${Math.round(box.top - actionsBottom)}px`,
        ).toBeLessThanOrEqual(20);

        const heroCx = await page.locator('.hero-copy').evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.x + r.width / 2;
        });
        expect(Math.abs(box.cx - heroCx), 'строка времени ответа не по центру').toBeLessThan(2);
      });
    }
  }

  test('/thanks/ сохранил капсулу с глифом часов', async ({ page }) => {
    await page.goto(PAGE_ROUTES.thanks.mn);
    const status = page.locator('.hero-status');
    await expect(status).toHaveCount(1);
    await expect(status).toHaveClass(/hero-status--capsule/);
    await expect(status.locator('.hero-status-icon')).toHaveCount(1);
  });

  for (const locale of LOCALES) {
    test(`390 (${locale}): город в кадре виден, шторка не гасит его в фон`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(PAGE_ROUTES.home[locale]);
      await page.waitForTimeout(500);

      await page.locator('.hero-inner').evaluate((el) => {
        (el as HTMLElement).style.visibility = 'hidden';
      });

      const shot = await page.screenshot({ clip: { x: 0, y: 0, width: 390, height: 844 } });
      const brightestRow = await brightestRowLuma(shot);

      expect(
        brightestRow,
        `кадр первого экрана погашен шторкой: самая светлая строка ${brightestRow.toFixed(1)} из 255`,
      ).toBeGreaterThan(22);
    });
  }
});

test.describe('Разбор 28.08.2026: шапка слита с кадром, языки без ободка', () => {
  for (const locale of LOCALES) {
    test(`390 (${locale}): у шапки нет ни панели, ни линии, ни размытия`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(PAGE_ROUTES.home[locale]);

      const header = await page.locator('.site-header').evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          borderBottom: cs.borderBottomWidth,
          image: cs.backgroundImage,
          color: cs.backgroundColor,
          filter: cs.backdropFilter,
          position: cs.position,
        };
      });

      expect(header.borderBottom, 'у шапки вернулась волосяная линия снизу').toBe('0px');
      expect(header.filter, 'у шапки вернулось размытие подложки').toBe('none');

      expect(header.image, 'у шапки вернулась шторка-градиент').toBe('none');
      expect(header.color, 'у шапки вернулась сплошная подложка').toMatch(/, 0\)|transparent/);

      expect(header.position, 'шапка перестала быть липкой').toBe('sticky');
    });

    test(`390 (${locale}): переключатель языка — текст с полоской, тап-цель 44px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(PAGE_ROUTES.home[locale]);

      const container = await page.locator('.lang-switch').evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          border: cs.borderTopWidth,
          radius: cs.borderTopLeftRadius,
          bg: cs.backgroundColor,
        };
      });
      expect(container.border, 'у переключателя вернулся ободок').toBe('0px');
      expect(container.radius, 'у переключателя вернулся радиус контрола').toBe('0px');
      expect(container.bg, 'у переключателя вернулась подложка').toMatch(/, 0\)|transparent/);

      const items = await page.locator('.lang-switch .lang-item').evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const sep = getComputedStyle(el, '::before');
          return {
            w: r.width,
            h: r.height,
            bg: cs.backgroundColor,
            radius: cs.borderTopLeftRadius,
            sepWidth: sep.width,
            sepHeight: sep.height,
            current: el.classList.contains('lang-current'),
          };
        }),
      );
      expect(items.length, 'пунктов языка не три').toBe(3);

      for (const it of items) {

        expect(it.w, 'тап-цель пункта языка уже 44px').toBeGreaterThanOrEqual(44);
        expect(it.h, 'тап-цель пункта языка ниже 44px').toBeGreaterThanOrEqual(44);

        expect(it.bg, 'у пункта языка вернулась плашка').toMatch(/, 0\)|transparent/);
        expect(it.radius, 'у пункта языка вернулся радиус').toBe('0px');
      }

      expect(items[0].sepWidth, 'полоска стоит перед первым пунктом').toBe('auto');
      for (const it of items.slice(1)) {
        expect(it.sepWidth, 'полоска между пунктами пропала').toBe('1px');
        expect(parseFloat(it.sepHeight), 'полоска стала перегородкой во всю высоту').toBeLessThan(
          24,
        );
      }

      const current = items.filter((i) => i.current);
      expect(current.length).toBe(1);
      const currentColor = await page
        .locator('.lang-switch .lang-current')
        .evaluate((el) => getComputedStyle(el).color);
      expect(currentColor, 'активный пункт языка перестал быть золотым').toBe('rgb(241, 198, 50)');
    });
  }
});

test.describe('Второй разбор 28.08.2026: восемь пунктов первого экрана', () => {
  const MOBILE = [
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
  ];

  for (const size of MOBILE) {
    for (const locale of LOCALES) {
      test(`${size.width} (${locale}): связка первого экрана уравновешена и выше середины`, async ({
        page,
      }) => {
        await page.setViewportSize(size);
        await page.goto(PAGE_ROUTES.home[locale]);

        const m = await page.evaluate(() => {
          const box = (sel: string) => {
            const el = document.querySelector(sel) as HTMLElement;
            const r = el.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom };
          };
          return {
            vh: window.innerHeight,
            heroTop: (document.querySelector('.hero') as HTMLElement).getBoundingClientRect().top,
            h1: box('.hero-h1'),
            actions: box('.hero-actions'),
            stats: box('.hero-stats'),
            headerH: (document.querySelector('.site-header') as HTMLElement).getBoundingClientRect()
              .height,
          };
        });

        const frac = (v: number) => (v / m.vh) * 100;
        expect(
          frac(m.h1.top),
          `верх заголовка на ${frac(m.h1.top).toFixed(1)}% — связка уехала НИЖЕ ` +
            'принятого 08.09.2026 (замер 25,6…28,2 %, запас — половина строки)',
        ).toBeLessThan(31);
        expect(
          frac(m.h1.top),
          `верх заголовка на ${frac(m.h1.top).toFixed(1)}% — связка вернулась ВВЕРХ, ` +
            'то есть отменено решение заказчика 08.09.2026 «перемести ниже, чтобы ' +
            'чуть центральнее было все»',
        ).toBeGreaterThan(23);
        expect(frac(m.h1.top), 'заголовок заехал под шапку').toBeGreaterThan(frac(m.headerH));
        expect(
          frac(m.actions.top),
          `верх кнопок на ${frac(m.actions.top).toFixed(1)}% — пара кнопок уехала НИЖЕ ` +
            'принятого 08.09.2026 (замер 40,3…41,7 %)',
        ).toBeLessThan(44);
        expect(
          frac(m.actions.top),
          `верх кнопок на ${frac(m.actions.top).toFixed(1)}% — пара кнопок вернулась ВВЕРХ`,
        ).toBeGreaterThan(38);

        expect(
          frac(m.h1.top),
          'верх заголовка перевалил за середину окна',
        ).toBeLessThan(50);

        expect(frac(m.stats.bottom), 'пара цифр уехала за сгиб').toBeLessThan(80);
        expect(
          frac(m.stats.bottom),
          'пара цифр поднялась в полосу городских огней',
        ).toBeGreaterThan(66);

        expect(Math.round(m.heroTop), 'первый экран перестал начинаться от верхней кромки').toBe(0);
      });
    }
  }

  for (const size of MOBILE) {
    test(`${size.width}: пара кнопок первого экрана — пилюля высотой 44px`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto(PAGE_ROUTES.home.ru);
      const btns = await page.locator('.hero .contact-btn').evaluateAll((els) =>
        els.map((el) => {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return { radius: cs.borderTopLeftRadius, h: r.height };
        }),
      );
      expect(btns.length).toBe(2);
      for (const b of btns) {

        expect(
          parseFloat(b.radius),
          `кнопка перестала быть пилюлей: радиус ${b.radius}`,
        ).toBeGreaterThanOrEqual(b.h / 2);

        expect(b.h, 'высота кнопки ниже минимальной тап-цели').toBeGreaterThanOrEqual(44);
        expect(b.h, 'кнопка снова выросла — «слишком круглая» форма вернётся').toBeLessThanOrEqual(
          46,
        );
      }
    });
  }

  test('пилюля кнопок связи доехала до десктопа — одна система форм на всех ширинах', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.ru);
    const b = await page
      .locator('.hero .contact-btn--telegram')
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { radius: parseFloat(getComputedStyle(el).borderTopLeftRadius), h: r.height };
      });
    expect(
      b.radius,
      `на десктопе кнопка связи перестала быть пилюлей: радиус ${b.radius} при высоте ${b.h}`,
    ).toBeGreaterThanOrEqual(b.h / 2);
  });

  test('глифов каналов нет ни в первом экране, ни в шаге', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.ru);
    await expect(page.locator('.hero .contact-btn__icon')).toHaveCount(0);
    await expect(page.locator('.spine-actions .contact-btn__icon')).toHaveCount(0);
  });

  const TAN11 = 0.19438;
  for (const size of MOBILE) {
    for (const locale of LOCALES) {
      test(`${size.width} (${locale}): логотип и заголовок наклонены на 11°`, async ({ page }) => {
        await page.setViewportSize(size);
        await page.goto(PAGE_ROUTES.home[locale]);
        const t = await page.evaluate(() => ({
          brand: getComputedStyle(document.querySelector('.brand') as HTMLElement).transform,
          h1: getComputedStyle(document.querySelector('.hero-h1') as HTMLElement).transform,
        }));
        for (const [name, value] of [
          ['логотип', t.brand],
          ['заголовок', t.h1],
        ] as const) {
          const m = value.match(/matrix\(([^)]+)\)/);
          expect(m, `${name} потерял наклон: transform=${value}`).not.toBeNull();
          const c = (m as RegExpMatchArray)[1].split(',').map((v) => parseFloat(v));

          expect(Math.abs(c[2] + TAN11), `${name} наклонён не на 11°: c=${c[2]}`).toBeLessThan(
            0.005,
          );
        }
      });
    }
  }

  test('на десктопе заголовок и логотип наклонены ОДИНАКОВО', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.ru);
    const t = await page.evaluate(() => {
      const skew = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const m = getComputedStyle(el).transform;
        const nums = m.match(/-?[\d.]+/g);

        return nums && nums.length >= 6 ? Number(nums[2]) : 0;
      };
      return { h1: skew('.hero-h1'), logo: skew('.site-header__logo, .header-logo, .site-header a svg') };
    });
    expect(t.h1, 'заголовок первого экрана не найден').not.toBeNull();
    const h1Skew = t.h1 as number;
    expect(h1Skew, 'заголовок первого экрана на десктопе снова прямой').not.toBe(0);

    if (t.logo !== null && t.logo !== 0) {
      expect(h1Skew, 'угол заголовка не совпал с углом логотипа').toBeCloseTo(t.logo, 2);
    }
  });

  test('кольцо фокуса не появляется от нажатия, но появляется с клавиатуры', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.ru);
    const btn = page.locator('.hero .contact-btn--messenger');
    await btn.click({ noWaitAfter: true }).catch(() => {});
    await page.waitForTimeout(200);
    const afterClick = await btn.evaluate((el) => ({
      fv: el.matches(':focus-visible'),
      outline: getComputedStyle(el).outlineStyle,
    }));
    expect(afterClick.fv, 'после нажатия включилось :focus-visible').toBe(false);
    expect(afterClick.outline, 'после нажатия появилось кольцо фокуса').toBe('none');

    await page.goto(PAGE_ROUTES.home.ru);
    await page.evaluate(() => (document.body as HTMLElement).focus());
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      const hit = await page.evaluate(() =>
        document.activeElement?.classList?.contains('contact-btn--messenger'),
      );
      if (hit) break;
    }
    const afterTab = await btn.evaluate((el) => ({
      fv: el.matches(':focus-visible'),
      outline: `${getComputedStyle(el).outlineWidth} ${getComputedStyle(el).outlineStyle} ${getComputedStyle(el).outlineColor}`,
    }));
    expect(afterTab.fv, 'кольцо фокуса потеряно для клавиатуры').toBe(true);
    expect(afterTab.outline, 'кольцо фокуса перестало быть золотым 2px').toBe(
      '2px solid rgb(255, 219, 99)',
    );
  });

  test('390: кегли первого экрана приведены к макету', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.ru);
    const sizes = await page.evaluate(() => {
      const el = document.querySelector('.hero .hero-status-text') as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = new Set(
        [...range.getClientRects()].filter((r) => r.height > 1).map((r) => Math.round(r.top)),
      ).size;
      return {
        brand: getComputedStyle(document.querySelector('.brand') as HTMLElement).fontSize,
        status: getComputedStyle(el).fontSize,
        statusLines: lines,
      };
    });

    expect(sizes.brand, 'кегль знака вернулся к 24px').toBe('22px');

    expect(
      parseFloat(sizes.status),
      'строка времени вернулась на крупную ступень',
    ).toBeLessThanOrEqual(12);

    expect(sizes.statusLines, 'строка времени в ru занимает не две строки').toBe(2);
  });

  for (const locale of LOCALES) {
    test(`390 (${locale}): полоса городских огней стоит выше пары цифр`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(PAGE_ROUTES.home[locale]);
      await page.waitForTimeout(500);
      const statsTop = await page
        .locator('.hero-stats')
        .evaluate((el) => el.getBoundingClientRect().top);
      await page.locator('.hero-inner').evaluate((el) => {
        (el as HTMLElement).style.visibility = 'hidden';
      });
      const shot = await page.screenshot({ clip: { x: 0, y: 0, width: 390, height: 844 } });
      const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
      let brightestRow = -1;
      let best = 0;
      for (let y = 0; y < info.height; y += 2) {
        let mx = 0;
        for (let x = 0; x < info.width; x += 1) {
          const i = (y * info.width + x) * info.channels;
          const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          if (l > mx) mx = l;
        }
        if (mx > best) {
          best = mx;
          brightestRow = y;
        }
      }
      const scale = info.height / 844;
      expect(best, 'кадр погашен: самой светлой точки в нём нет').toBeGreaterThan(120);
      expect(
        brightestRow / scale,
        `самая светлая точка кадра (${Math.round(brightestRow / scale)}) не выше пары цифр (${Math.round(statsTop)})`,
      ).toBeLessThan(statsTop);
    });
  }
});

test.describe('Первый экран, третий заход: знак бренда и пояс времени', () => {
  const MOBILE_WIDTHS = [360, 390, 430];

  for (const width of MOBILE_WIDTHS) {
    for (const locale of LOCALES) {
      test(`${width} (${locale}): знак в заголовке разбит на MEL и BET теми же цветами, что в шапке`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(PAGE_ROUTES.home[locale]);

        const em = page.locator('.hero-h1 em');
        const accent = page.locator('.hero-h1 em .hero-brand-accent');
        await expect(em).toHaveCount(1);
        await expect(accent).toHaveCount(1);

        expect(await em.innerText(), 'знак бренда в заголовке распался').toBe('MELBET');
        expect(await accent.innerText(), 'золотая половина знака не «BET»').toBe('BET');

        const paint = await page.evaluate(() => {
          const cs = (sel: string) => {
            const el = document.querySelector(sel) as HTMLElement;
            const s = getComputedStyle(el);
            return { color: s.color, bg: s.backgroundImage };
          };
          return {
            heroMel: cs('.hero-h1 em'),
            heroBet: cs('.hero-h1 em .hero-brand-accent'),
            headMel: cs('.brand'),
            headBet: cs('.brand .brand-accent'),
            heroText: getComputedStyle(document.querySelector('.hero-h1') as HTMLElement).color,
          };
        });

        expect(paint.heroMel.color, 'MEL в заголовке не совпал с MEL в шапке').toBe(
          paint.headMel.color,
        );
        expect(paint.heroBet.color, 'BET в заголовке не совпал с BET в шапке').toBe(
          paint.headBet.color,
        );

        expect(paint.heroMel.color, 'MEL перестал быть основным цветом текста').toBe(
          paint.heroText,
        );
        expect(paint.heroBet.color, 'BET не отличается от MEL — «сейчас все одинаковое»').not.toBe(
          paint.heroMel.color,
        );

        expect(paint.heroMel.bg, 'у белой половины знака вернулся фон-градиент').toBe('none');
        expect(paint.heroBet.bg, 'у золотой половины знака вернулся фон-градиент').toBe('none');
      });
    }
  }

  test('390 (ru): наклон не разводит половины знака по вертикали и не рвёт их пробелом', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.ru);

    const geom = await page.evaluate(() => {
      const h1 = document.querySelector('.hero-h1') as HTMLElement;
      const em = h1.querySelector('em') as HTMLElement;
      const accent = em.querySelector('.hero-brand-accent') as HTMLElement;
      const measure = () => {
        const head = document.createRange();
        head.setStart(em.firstChild!, 0);
        head.setEnd(em.firstChild!, (em.firstChild as Text).length);
        const hr = head.getBoundingClientRect();
        const ar = accent.getBoundingClientRect();
        return { headRight: hr.right, accentLeft: ar.left, headTop: hr.top, accentTop: ar.top, height: hr.height };
      };
      const skewed = measure();
      const transform = getComputedStyle(h1).transform;
      h1.style.transform = 'none';
      const flatGeom = measure();
      h1.style.transform = '';
      return { skewed, flat: flatGeom, transform };
    });

    expect(geom.transform, 'наклон заголовка пропал').toMatch(/^matrix\(1, 0, -0\.194/);

    expect(
      Math.abs(geom.flat.accentLeft - geom.flat.headRight),
      `между половинами знака появился зазор: ${JSON.stringify(geom.flat)}`,
    ).toBeLessThan(1.5);
    expect(
      Math.abs(geom.flat.headTop - geom.flat.accentTop),
      `половины знака на разной высоте: ${JSON.stringify(geom.flat)}`,
    ).toBeLessThan(1);

    expect(
      Math.abs(geom.skewed.headTop - geom.skewed.accentTop),
      `наклон развёл половины по высоте: ${JSON.stringify(geom.skewed)}`,
    ).toBeLessThan(1);
    const predicted = geom.skewed.height * 0.19438;
    expect(
      Math.abs(geom.skewed.headRight - geom.skewed.accentLeft - predicted),
      `наложение рамок ${(geom.skewed.headRight - geom.skewed.accentLeft).toFixed(2)} не равно предсказанному наклоном ${predicted.toFixed(2)}: ${JSON.stringify(geom.skewed)}`,
    ).toBeLessThan(1);
  });

  for (const locale of LOCALES) {
    test(`${locale}: первый экран и /thanks/ печатают одну формулировку пояса времени`, async ({
      page,
    }) => {
      const dict = JSON.parse(
        readFileSync(path.join(projectRoot, 'src', 'i18n', `${locale}.json`), 'utf-8'),
      );
      const heroHours = dict.hero.response_hours as string;
      const thanksHours = dict.pages.thanks_hours as string;
      expect(
        flat(heroHours),
        `пояс времени разошёлся между первым экраном и /thanks/ в ${locale}`,
      ).toBe(flat(thanksHours));

      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(PAGE_ROUTES.home[locale]);
      const heroLine = flat(await page.locator('.hero .hero-status-text').innerText());
      await page.goto(PAGE_ROUTES.thanks[locale]);
      const thanksLine = flat(await page.locator('.hero-status-text').innerText());
      expect(heroLine, `на первом экране нет строки часов: ${heroLine}`).toContain(flat(heroHours));
      expect(thanksLine, `на /thanks/ нет строки часов: ${thanksLine}`).toContain(
        flat(thanksHours),
      );
    });
  }
});

test.describe('Регистр подписей под цифрами: заглавная у ПЕРВОГО слова (28.08.2026)', () => {

  const casedWords = (label: string): string[] =>
    label
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .filter((w) => [...w].some((c) => c.toLowerCase() !== c.toUpperCase()));

  const PROPER_NOUNS: string[] = [];

  for (const locale of LOCALES) {
    test(`[${locale}] словарь: у обеих подписей заглавная только в первом слове`, () => {
      const dict = JSON.parse(
        readFileSync(path.join(projectRoot, 'src', 'i18n', `${locale}.json`), 'utf-8'),
      );
      for (const key of ['stat_partners', 'stat_share'] as const) {
        const label = dict.hero[key].label as string;
        const words = casedWords(label);

        expect(label.trim().length, `hero.${key}.label пуст в ${locale}`).toBeGreaterThan(0);

        expect(
          words.length,
          `hero.${key}.label (${locale}) — одно слово, замок на Title Case не вооружён: «${label}»`,
        ).toBeGreaterThan(1);

        const first = words[0];
        expect(first[0], `hero.${key}.label (${locale}) начинается со строчной: «${label}»`).toBe(
          first[0].toUpperCase(),
        );

        expect(
          first[0].toLowerCase() !== first[0].toUpperCase(),
          `первый символ hero.${key}.label (${locale}) не буква: «${label}»`,
        ).toBe(true);

        const capitalisedTail = words
          .slice(1)
          .filter((w) => w[0] === w[0].toUpperCase() && w[0].toLowerCase() !== w[0].toUpperCase())
          .filter((w) => !PROPER_NOUNS.includes(w));
        expect(
          capitalisedTail,
          `hero.${key}.label (${locale}) написан Title Case, а макет показывает регистр предложения: «${label}»`,
        ).toEqual([]);
      }
    });
  }

  for (const locale of LOCALES) {
    test(`[${locale}] на странице регистр тот же, что в словаре — не подделка средствами CSS`, async ({
      page,
    }) => {
      const dict = JSON.parse(
        readFileSync(path.join(projectRoot, 'src', 'i18n', `${locale}.json`), 'utf-8'),
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(PAGE_ROUTES.home[locale]);
      const labels = page.locator('.hero-stats .hero-stat-label');
      await expect(labels).toHaveCount(2);
      const expected = [dict.hero.stat_partners.label, dict.hero.stat_share.label] as string[];
      for (const [i, want] of expected.entries()) {
        const got = flat(await labels.nth(i).innerText());
        expect(got, `подпись ${i + 1} отрисована в другом регистре (${locale})`).toBe(flat(want));
        const tt = await labels.nth(i).evaluate((el) => getComputedStyle(el).textTransform);
        expect(tt, `на подпись ${i + 1} повешен text-transform (${locale})`).toBe('none');
      }
    });
  }

  const EXPECTED_LINES: Record<Locale, [number, number]> = {
    mn: [2, 2],
    ru: [2, 2],
    en: [1, 2],
  };

  for (const width of [360, 390, 430]) {
    for (const locale of LOCALES) {
      test(`${width} (${locale}): подписи занимают ${EXPECTED_LINES[locale].join(' и ')} строк(и)`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(PAGE_ROUTES.home[locale]);

        await page.evaluate(() => document.fonts.ready);

        const probe = await page.locator('.hero-stats .hero-stat-label').evaluateAll((els) => ({
          manropeApplied: document.fonts.check('1em Manrope'),
          boxes: els.map((el) => ({
            width: Math.round(el.getBoundingClientRect().width),
            family: getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, ''),
            size: getComputedStyle(el).fontSize,
          })),
        }));
        console.log(
          `[замер] ${width} (${locale}): Manrope применён=${String(probe.manropeApplied)}; ` +
            probe.boxes
              .map((b) => `коробка ${String(b.width)}px, кегль ${b.size}, семейство ${b.family}`)
              .join(' | '),
        );

        const lines = await page.locator('.hero-stats .hero-stat-label').evaluateAll((els) =>
          els.map((el) => {
            const r = document.createRange();
            r.selectNodeContents(el);
            return new Set(
              [...r.getClientRects()].filter((x) => x.height > 1).map((x) => Math.round(x.top)),
            ).size;
          }),
        );

        expect(
          lines,
          `число строк подписей на ${width} (${locale}); Manrope применён=${String(probe.manropeApplied)}, ` +
            `коробки ${probe.boxes.map((b) => String(b.width) + 'px').join(' и ')}, ` +
            `семейство ${probe.boxes[0]?.family ?? '?'}`,
        ).toEqual(EXPECTED_LINES[locale]);
      });
    }
  }
});

test.describe('Разрыв перед блоком направлений принят 07.09.2026 (Д-41)', () => {
  const MOBILE = [
    { width: 360, height: 844 },
    { width: 390, height: 844 },
    { width: 430, height: 844 },
  ];

  for (const size of MOBILE) {
    for (const locale of LOCALES) {

      test(`${size.width} (${locale}): разрыв перед блоком направлений не превышает принятого 07.09.2026`, async ({
        page,
      }) => {
        await page.setViewportSize(size);
        await page.goto(PAGE_ROUTES.home[locale]);
        await page.evaluate(() => document.fonts.ready);

        const m = await page.evaluate(() => {
          let statsBottom = 0;
          document.querySelectorAll('.hero-stats .hero-stat-label').forEach((el) => {
            const b = el.getBoundingClientRect().bottom + window.scrollY;
            if (b > statsBottom) statsBottom = b;
          });
          const head = document.querySelector('.direction-head h2') as HTMLElement;
          const hero = document.querySelector('.hero') as HTMLElement;
          const sentinel = document.getElementById('hero-sentinel') as HTMLElement;

          let labelLine = 0;
          const firstLabel = document.querySelector('.hero-stats .hero-stat-label');
          if (firstLabel) {
            const r = document.createRange();
            r.selectNodeContents(firstLabel);
            const rects = [...r.getClientRects()].filter((x) => x.height > 1);
            if (rects.length > 0) labelLine = rects[0].height;
          }
          return {
            statsBottom,
            headTop: head.getBoundingClientRect().top + window.scrollY,
            heroBottom: hero.getBoundingClientRect().bottom + window.scrollY,
            sentinelTop: sentinel.getBoundingClientRect().top + window.scrollY,
            labelLine,
            vh: window.innerHeight,
          };
        });

        expect(m.statsBottom, 'подписи под цифрами не найдены').toBeGreaterThan(0);
        expect(m.headTop, 'заголовок направлений не найден').toBeGreaterThan(0);

        const gap = m.headTop - m.statsBottom;

        expect(
          gap,
          `разрыв уехал дальше принятого 07.09.2026: ${gap.toFixed(1)}px между низом ` +
            `подписей и заголовком направлений (строка подписи ${m.labelLine.toFixed(1)}px, ` +
            `принято 359,3px, порог 380px — см. Д-41)`,
        ).toBeLessThan(380);

        expect(
          gap,
          `блок направлений подобрался вплотную к цифрам: ${gap.toFixed(1)}px`,
        ).toBeGreaterThan(80);

        expect(
          Math.round(m.heroBottom),
          'высота первого экрана изменилась — кроп кадра поехал',
        ).toBe(size.height + 74);

        expect(
          Math.round(m.sentinelTop),
          'маркер #hero-sentinel уехал с нижней кромки первого экрана',
        ).toBe(Math.round(m.heroBottom));
      });
    }
  }
});
