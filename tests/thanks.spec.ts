
import { test, expect, type Page } from '@playwright/test';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';

const LOCALES: Locale[] = ['mn', 'ru', 'en'];
const THANKS = PAGE_ROUTES.thanks;

async function primaryFill(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'var(--btn-primary-bg)';
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });
}

async function goldActions(page: Page, fill: string) {
  return page.evaluate((gold) => {
    const all = [...document.querySelectorAll<HTMLElement>('a, button')].filter(
      (el) => el.offsetParent !== null && getComputedStyle(el).backgroundColor === gold,
    );
    return {
      inMain: all.filter((el) => el.closest('main')).map((el) => el.textContent?.trim() ?? ''),
      outsideMain: all
        .filter((el) => !el.closest('main'))
        .map((el) => ({
          text: el.textContent?.trim() ?? '',
          inSiteHeader: Boolean(el.closest('header.site-header')),
        })),
    };
  }, fill);
}

test.describe('Страница /thanks/ — принятая заявка заканчивается подтверждением, а не 404', () => {
  for (const locale of LOCALES) {
    test(`[${locale}] отвечает 200, несёт один h1 и не индексируется`, async ({ page }) => {
      const response = await page.goto(THANKS[locale]);

      expect(response?.status(), `${THANKS[locale]} не отдаёт 200`).toBe(200);

      await expect(page.locator('h1')).toHaveCount(1);

      const robots = await page.locator('meta[name="robots"]').getAttribute('content');
      expect(robots, `${THANKS[locale]} без noindex`).toContain('noindex');

      await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
      await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(0);
    });

    test(`[${locale}] одно золотое действие в теле страницы, и оно ведёт к менеджеру`, async ({
      page,
    }) => {
      await page.goto(THANKS[locale]);

      const fill = await primaryFill(page);
      const actions = await goldActions(page, fill);

      expect(
        actions.inMain,
        `в <main> ${THANKS[locale]} золотых действий не одно: ${JSON.stringify(actions.inMain)}`,
      ).toHaveLength(1);

      for (const action of actions.outsideMain) {
        expect(
          action.inSiteHeader,
          `золотое действие «${action.text}» вне <main> и вне постоянной шапки`,
        ).toBe(true);
      }

      const href = await page.locator('main a.thanks-cta').getAttribute('href');
      expect(href, 'у действия нет адреса').toBeTruthy();
      expect(href!, `действие ведёт в пустой Telegram: ${href}`).toMatch(
        /^https:\/\/t\.me\/[^/?#]+/,
      );
    });

    test(`[${locale}] капсула времени ответа на месте и несёт диапазон часов`, async ({ page }) => {
      await page.goto(THANKS[locale]);

      const capsule = page.locator('main .hero-status-text');
      await expect(capsule).toHaveCount(1);
      await expect(capsule).toBeVisible();

      const text = ((await capsule.textContent()) ?? '').replace(/\s+/g, ' ').trim();
      expect(text.length, 'капсула времени ответа пуста').toBeGreaterThan(0);

      expect(text, `в капсуле нет диапазона часов: ${text}`).toContain('15:00–23:00');

      expect(text, `в капсуле остался разделитель: ${text}`).not.toContain('·');
      expect(text, `в капсуле остался разделитель: ${text}`).not.toContain('•');

      await expect(capsule.locator('> span')).toHaveCount(2);

      const range = capsule.locator('.nowrap');
      await expect(range).toHaveCount(1);
      const rects = await range.evaluate((el) => el.getClientRects().length);
      expect(rects, 'диапазон часов разорван переносом строки').toBe(1);
    });

    test(`[${locale}] ни липкой панели, ни второй двери в Messenger`, async ({ page }) => {
      await page.goto(THANKS[locale]);

      await expect(page.locator('.sticky-cta')).toHaveCount(0);

      await expect(
        page.locator('a[data-track="messenger_click"][data-track-channel="messenger"]'),
      ).toHaveCount(0);
    });

    test(`[${locale}] переключатель языка оставляет человека на подтверждении`, async ({ page }) => {
      await page.goto(THANKS[locale]);

      const hrefs = await page
        .locator('a.lang-item')
        .evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute('href')!));

      expect(hrefs).toHaveLength(LOCALES.length - 1);

      const others = LOCALES.filter((l) => l !== locale).map((l) => THANKS[l]);
      expect(hrefs.sort(), `переключатель уводит не на подтверждение: ${hrefs}`).toEqual(
        others.sort(),
      );
    });
  }

  test('три локали не разошлись: одинаковое число заголовков, ссылок и разделов', async ({
    page,
  }) => {

    const shapes: Record<string, string> = {};
    for (const locale of LOCALES) {
      await page.goto(THANKS[locale]);
      shapes[locale] = JSON.stringify({
        main: await page.locator('main').count(),
        h1: await page.locator('h1').count(),
        h2: await page.locator('h2').count(),
        h3: await page.locator('h3').count(),
        links: await page.locator('a').count(),
        goldCta: await page.locator('main a.thanks-cta').count(),
        capsule: await page.locator('main .hero-status').count(),
        homeLink: await page.locator('main a.thanks-home').count(),
      });
    }
    expect(shapes.ru, 'ru разошлась с mn').toBe(shapes.mn);
    expect(shapes.en, 'en разошлась с mn').toBe(shapes.mn);
  });
});

test.describe('Страница /thanks/ на 360px — самая узкая ширина проекта', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  for (const locale of LOCALES) {
    test(`[${locale}] надпись действия не переносится, заголовок не длиннее трёх строк`, async ({
      page,
    }) => {
      await page.goto(THANKS[locale]);

      const lines = await page.locator('main a.thanks-cta').evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getClientRects().length;
      });
      expect(lines, 'надпись действия переносится на вторую строку').toBe(1);

      const titleLines = await page.locator('h1').evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getClientRects().length;
      });
      expect(titleLines, 'заголовок длиннее трёх строк').toBeLessThanOrEqual(3);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'страница уезжает за край экрана').toBeLessThanOrEqual(0);
    });
  }
});
