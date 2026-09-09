
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';
import { MOBILE_VIEWPORT, DESKTOP_VIEWPORT } from '../playwright.config';

const LOCALES: Locale[] = ['mn', 'ru', 'en'];

const projectRoot = path.resolve(import.meta.dirname, '..');
function dict(locale: Locale): Record<string, Record<string, string>> {
  return JSON.parse(readFileSync(path.join(projectRoot, 'src', 'i18n', `${locale}.json`), 'utf-8'));
}
const contactTelegram = (locale: Locale) => dict(locale).contact.telegram;

const HERO_TELEGRAM = '.hero .contact-btn--telegram';
const HERO_MESSENGER = '.hero .contact-btn--messenger';
const HEADER_CTA = '.site-header a.button';

const GOLD_REFERENCE = '.btn-primary';

async function goldSpots(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate((goldRefSel) => {
    const ref = document.querySelector<HTMLElement>(goldRefSel);
    if (!ref) return ['ЭТАЛОН ЗОЛОТА НЕ НАЙДЕН: ' + goldRefSel];
    const goldRef = getComputedStyle(ref).backgroundColor;

    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return (
        r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
      );
    };

    return Array.from(
      document.querySelectorAll('.site-header a, .site-header button, .hero a, .hero button'),
    )
      .filter(visible)
      .filter((el) => getComputedStyle(el).backgroundColor === goldRef)
      .map((el) => {
        const cls = el.className.toString().trim().split(/\s+/).slice(0, 2).join('.');
        return cls || el.tagName.toLowerCase();
      });

  }, GOLD_REFERENCE);
}

async function boxOf(page: import('@playwright/test').Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 };
  });
}

const chan = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const luminance = ([r, g, b]: number[]) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
const contrastRatio = (a: number[], b: number[]) => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

async function worstLabelContrast(
  page: import('@playwright/test').Page,
  selector: string,
): Promise<{ ratio: number; surface: string }> {
  const box = await boxOf(page, selector);
  const textColor = await page
    .locator(selector)
    .first()
    .evaluate((el) => getComputedStyle(el).color);
  const text = (textColor.match(/\d+/g) ?? []).slice(0, 3).map(Number);

  const buf = await page.screenshot({
    clip: { x: box.x, y: box.y, width: box.w, height: box.h },
  });
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });

  const scale = info.width / box.w;
  const px = (x: number, y: number) => {
    const i = (Math.round(y * scale) * info.width + Math.round(x * scale)) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };

  let worst = Infinity;
  let worstPixel: number[] = [0, 0, 0];
  for (const dy of [4, 6, 8, 10]) {
    for (const y of [dy, box.h - dy]) {
      for (let x = 14; x <= box.w - 14; x += 4) {
        const c = px(x, y);
        const r = contrastRatio(text, c);
        if (r < worst) {
          worst = r;
          worstPixel = c;
        }
      }
    }
  }
  return { ratio: Math.round(worst * 100) / 100, surface: `rgb(${worstPixel.join(',')})` };
}

test.describe('Иерархия призыва: золота на первом экране нет (Д-01)', () => {
  for (const viewport of [DESKTOP_VIEWPORT, MOBILE_VIEWPORT]) {
    for (const locale of LOCALES) {
      test(`${viewport.width}x${viewport.height} (${locale}): ноль золотых заливок в шапке и первом экране`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await page.goto(PAGE_ROUTES.home[locale]);

        const candidates = await page
          .locator('.site-header a, .site-header button, .hero a, .hero button')
          .count();
        expect(candidates, 'выборка нажимаемых элементов пуста').toBeGreaterThan(3);

        await expect(page.locator(GOLD_REFERENCE).first()).toBeAttached();

        const golds = await goldSpots(page);
        expect(
          golds,
          `золотые заливки на первом экране: ${golds.join(', ') || 'нет'}; ` +
            'с 26.08.2026 (Д-01, «Сделать как в макете») их обязано быть НОЛЬ — ' +
            'кнопки связи носят цвета каналов, золото осталось форме заявки',
        ).toEqual([]);
      });
    }
  }
});

test.describe('Иерархия призыва: пара различима по цвету канала', () => {
  for (const locale of LOCALES) {
    test(`${locale}: заливка Telegram — фирменный синий, отличается от второй кнопки и фона`, async ({
      page,
    }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto(PAGE_ROUTES.home[locale]);

      await expect(page.locator(HERO_TELEGRAM)).toHaveCount(1);
      await expect(page.locator(HERO_MESSENGER)).toHaveCount(1);

      const { tg, fb, heroBg } = await page.evaluate(
        ([tgSel, fbSel]) => ({
          tg: getComputedStyle(document.querySelector(tgSel)!).backgroundColor,
          fb: getComputedStyle(document.querySelector(fbSel)!).backgroundColor,
          heroBg: getComputedStyle(document.querySelector('.hero')!).backgroundColor,
        }),
        [HERO_TELEGRAM, HERO_MESSENGER],
      );

      expect(tg, 'заливка главной кнопки пуста').not.toBe('rgba(0, 0, 0, 0)');
      expect(fb, 'заливка второй кнопки пуста').not.toBe('rgba(0, 0, 0, 0)');
      expect(tg, `кнопки пары слились в один материал (${tg})`).not.toBe(fb);
      expect(tg, 'главная кнопка слилась с фоном первого экрана').not.toBe(heroBg);
      expect(fb, 'вторая кнопка слилась с фоном первого экрана').not.toBe(heroBg);

      const [r, g, b] = (tg.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
      expect(
        b,
        `заливка главной кнопки ${tg} не читается как синий канала (b=${b} против r=${r})`,
      ).toBeGreaterThan(r + 100);
      expect(b, `синий канал не доминирует (${tg})`).toBeGreaterThan(g);
    });
  }
});

test.describe('Иерархия призыва: площадь главной не меньше второй и не меньше шапки', () => {
  for (const locale of LOCALES) {
    test(`1440x900 (${locale}): площади и позиция пары`, async ({ page }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto(PAGE_ROUTES.home[locale]);

      await expect(page.locator(HEADER_CTA)).toHaveCount(0);

      const hero = await boxOf(page, HERO_TELEGRAM);
      const second = await boxOf(page, HERO_MESSENGER);
      const heroArea = hero.w * hero.h;
      const secondArea = second.w * second.h;
      const vsSecond = Math.round((heroArea / secondArea - 1) * 1000) / 10;

      expect(
        heroArea,
        `главная ${hero.w}x${hero.h}=${Math.round(heroArea)} против второй ` +
          `${second.w}x${second.h}=${Math.round(secondArea)} (${vsSecond > 0 ? '+' : ''}${vsSecond}%): ` +
          'главная кнопка стала МЕНЬШЕ второй — иерархия пары поехала',
      ).toBeGreaterThanOrEqual(secondArea);

      expect(
        hero.x,
        `главная кнопка (x=${hero.x}) стоит правее второй (x=${second.x})`,
      ).toBeLessThan(second.x);
    });
  }
});

test.describe('Иерархия призыва: главная кнопка первая в табуляции пары', () => {
  for (const locale of LOCALES) {
    test(`${locale}: таб доходит до Telegram раньше, чем до Messenger`, async ({ page }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto(PAGE_ROUTES.home[locale]);

      const order = await page.evaluate(([tgSel, fbSel]) => {
        const tg = document.querySelector(tgSel);
        const fb = document.querySelector(fbSel);
        if (!tg || !fb) return 'КНОПКИ НЕ НАЙДЕНЫ';

        if (tg.hasAttribute('tabindex') || fb.hasAttribute('tabindex')) {
          return 'ПОЯВИЛСЯ tabindex — порядок табуляции больше не равен порядку в документе';
        }
        const pos = tg.compareDocumentPosition(fb);
        return pos & Node.DOCUMENT_POSITION_FOLLOWING ? 'tg-first' : 'fb-first';
      }, [HERO_TELEGRAM, HERO_MESSENGER]);

      expect(order, 'главная кнопка обязана достигаться табом раньше второй').toBe('tg-first');
    });
  }
});

test.describe('Иерархия призыва: подпись главной кнопки — короткая, из макета (Д-10)', () => {
  for (const locale of LOCALES) {
    test(`${locale}: доступное имя главной кнопки равно contact.telegram`, async ({ page }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto(PAGE_ROUTES.home[locale]);

      const expected = contactTelegram(locale);

      expect(expected, 'contact.telegram пуст в словаре').toBeTruthy();

      const button = page.locator(HERO_TELEGRAM).first();
      await expect(button).toHaveAccessibleName(expected);

      const text = (await button.innerText()).trim();
      expect(text, `подпись главной кнопки: «${text}»`).toBe(expected);

    });
  }
});

test.describe('Иерархия призыва: контраст надписей пары не ниже 4.5:1 (CMPL-02)', () => {
  for (const locale of LOCALES) {
    test(`${locale}: обе кнопки читаемы в худшей точке заливки`, async ({ page }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto(PAGE_ROUTES.home[locale]);
      await page.waitForTimeout(300);

      for (const sel of [HERO_TELEGRAM, HERO_MESSENGER]) {
        const { ratio, surface } = await worstLabelContrast(page, sel);
        expect(
          ratio,
          `${sel}: контраст надписи ${ratio}:1 против худшей точки поверхности ${surface} — ` +
            'ниже порога 4.5:1 (замер 27.08.2026 давал 13,42:1 у синей и 13,1:1 у серой)',
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

test.describe('Иерархия призыва: подписи прочих мест берут contact.telegram', () => {
  for (const locale of LOCALES) {

    test(`${locale}: в раскрытой карточке направления кнопок связи нет, подпись живёт на постоянных точках`, async ({ page }) => {

      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto(PAGE_ROUTES.home[locale]);

      const card = page.locator('details[data-track-direction="affiliate"]');
      await page.locator('details[data-track-direction="affiliate"] > summary').click();
      await expect(card).toHaveJSProperty('open', true);

      await expect(
        card.locator('.contact-btn, [data-track="messenger_click"]'),
        'в карточке направления появилась кнопка связи — Д-12 отменён молча',
      ).toHaveCount(0);

      const heroTelegram = page.locator('.hero .contact-btn--telegram').first();
      const text = (await heroTelegram.innerText()).trim();
      expect(text, 'подпись пары первого экрана уехала').toBe(contactTelegram(locale));
    });
  }
});

test.describe('Шапка чистая: ноль ссылок связи, логотип и языки на месте (Д-15)', () => {
  const PAGES: { name: string; url: (l: Locale) => string }[] = [
    { name: 'главная', url: (l) => PAGE_ROUTES.home[l] },
    { name: '/privacy/', url: (l) => PAGE_ROUTES.privacy[l] },
    { name: '/thanks/', url: (l) => PAGE_ROUTES.thanks[l] },
  ];

  for (const locale of LOCALES) {
    for (const { name, url } of PAGES) {
      for (const [w, h] of [
        [1440, 900],
        [390, 844],
      ] as const) {
        test(`${name} (${locale}) на ${w}: в шапке ноль ссылок связи`, async ({ page }) => {
          await page.setViewportSize({ width: w, height: h });
          await page.goto(url(locale));

          await expect(page.locator('.site-header [data-track="messenger_click"]')).toHaveCount(0);
          await expect(page.locator('.site-header a[href*="t.me/"]')).toHaveCount(0);
          await expect(page.locator('.site-header a[href*="m.me/"]')).toHaveCount(0);

          await expect(page.locator(HEADER_CTA)).toHaveCount(0);

          await expect(page.locator('.site-header')).toHaveCount(1);
          await expect(page.locator('.site-header a.brand')).toHaveCount(1);
          const langLinks = page.locator('.site-header .lang-switch a.lang-item');
          await expect(langLinks).toHaveCount(2);
          await expect(page.locator('.site-header .lang-current')).toHaveCount(1);
        });
      }
    }
  }
});
