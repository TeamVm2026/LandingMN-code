
import { test, expect, type Page } from '@playwright/test';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';
import { isOffCloudflareNoiseMessage } from './lib/console-noise';
import { buildContactHref } from '../src/lib/start-link';
import { LEAD_STATE_KEY } from '../src/scripts/lead/state';
import { envValue } from '../scripts/lib/env-value';

const HOUR_MS = 60 * 60 * 1000;
const LOCALES_UNDER_TEST: Locale[] = ['mn', 'ru', 'en'];

const TG_CONTACT_URL = envValue('PUBLIC_TG_CONTACT_URL');
const TG_BOT_URL = envValue('PUBLIC_TG_BOT_URL');

const PANEL = '[data-lead-repeat]';
const FORM = '[data-lead-form]';

const FIRST_FIELD = '#lead-name';

function leadValue(ageMs = 0, direction = 'bank', v: unknown = 1): string {
  return JSON.stringify({ v, at: Date.now() - ageMs, direction });
}

async function seedLeadKey(page: Page, raw: string): Promise<void> {
  await page.addInitScript(
    ({ key, value }: { key: string; value: string }) => {
      window.localStorage.setItem(key, value);
    },
    { key: LEAD_STATE_KEY, value: raw },
  );
}

async function markDocument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __docToken?: string }).__docToken =
      `${Math.random().toString(36).slice(2)}:${performance.timeOrigin}`;
  });
}

function docToken(page: Page): Promise<string | undefined> {
  return page.evaluate(() => (window as unknown as { __docToken?: string }).__docToken);
}

function watchErrors(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (isOffCloudflareNoiseMessage(msg)) return;
    errors.push(`console: ${msg.text()}`);
  });
  return { errors };
}

test('без ключа: поля формы видны, панели нет', async ({ page }) => {
  const seen = watchErrors(page);
  await page.goto(PAGE_ROUTES.home.mn);

  await expect(page.locator(FIRST_FIELD)).toBeVisible();
  await expect(page.locator(PANEL)).toHaveCount(0);
  expect(seen.errors, seen.errors.join('\n')).toEqual([]);
});

for (const locale of LOCALES_UNDER_TEST) {
  test(`свежий ключ: панель встаёт на место полей, заголовок блока цел (${locale})`, async ({
    page,
  }) => {
    const seen = watchErrors(page);
    await seedLeadKey(page, leadValue(HOUR_MS));
    await page.goto(PAGE_ROUTES.home[locale]);

    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible();

    await expect(page.locator(FIRST_FIELD)).toBeHidden();
    await expect(page.locator(FORM)).toHaveAttribute('hidden', '');

    await expect(page.locator('.lead-form__head h2')).toBeVisible();

    const form = page.locator(FORM);
    const expectTitle = await form.getAttribute('data-repeat-title');
    const expectBody = await form.getAttribute('data-repeat-body');
    const expectCta = await form.getAttribute('data-repeat-cta');
    const expectReset = await form.getAttribute('data-repeat-reset');
    for (const value of [expectTitle, expectBody, expectCta, expectReset]) {
      expect(value?.length ?? 0).toBeGreaterThan(0);
    }
    await expect(panel.locator('.lead-repeat__title')).toHaveText(expectTitle!);
    await expect(panel.locator('.lead-repeat__body')).toHaveText(expectBody!);
    await expect(panel.locator('.lead-repeat__cta')).toHaveText(expectCta!);
    await expect(panel.locator('.lead-repeat__reset')).toHaveText(expectReset!);

    expect(seen.errors, seen.errors.join('\n')).toEqual([]);
  });
}

test('панель не объявляется скринридеру: ни role=status, ни aria-live', async ({ page }) => {
  await seedLeadKey(page, leadValue(HOUR_MS));
  await page.goto(PAGE_ROUTES.home.mn);

  const panel = page.locator(PANEL);
  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveAttribute('role', /.*/);
  await expect(panel).not.toHaveAttribute('aria-live', /.*/);

  expect(await panel.locator('[role="status"], [aria-live]').count()).toBe(0);
});

test('кнопка панели ведёт к менеджеру и открывается в новой вкладке', async ({ page }) => {
  await seedLeadKey(page, leadValue(HOUR_MS));
  await page.goto(PAGE_ROUTES.home.mn);

  const cta = page.locator(`${PANEL} .lead-repeat__cta`);
  await expect(cta).toBeVisible();

  const expected = buildContactHref({
    botUrl: TG_BOT_URL,
    fallbackUrl: TG_CONTACT_URL,
    direction: 'none',
    locale: 'mn',
  });
  await expect(cta).toHaveAttribute('href', expected);
  await expect(cta).toHaveAttribute('target', '_blank');
  await expect(cta).toHaveAttribute('rel', /noopener/);
});

const IGNORED: [string, string][] = [
  ['давность 73 часа', leadValue(73 * HOUR_MS)],
  ['чужая версия v: 2', leadValue(HOUR_MS, 'bank', 2)],
  ['не JSON', 'не json'],
  ['JSON-массив', JSON.stringify([{ v: 1, at: Date.now(), direction: 'bank' }])],
  ['объект без direction', JSON.stringify({ v: 1, at: Date.now() })],
];

for (const [label, raw] of IGNORED) {
  test(`негодный ключ (${label}): панель не появляется, в консоли ноль ошибок`, async ({
    page,
  }) => {
    const seen = watchErrors(page);
    await seedLeadKey(page, raw);
    await page.goto(PAGE_ROUTES.home.mn);

    await expect(page.locator(FIRST_FIELD)).toBeVisible();
    await expect(page.locator(PANEL)).toHaveCount(0);
    expect(seen.errors, seen.errors.join('\n')).toEqual([]);
  });
}

test('сброс: панель исчезает, поля возвращаются, ключ удалён, перезагрузки не было', async ({
  page,
}) => {
  const seen = watchErrors(page);
  await markDocument(page);
  await seedLeadKey(page, leadValue(HOUR_MS));
  await page.goto(PAGE_ROUTES.home.mn);

  await expect(page.locator(PANEL)).toBeVisible();
  const before = await docToken(page);
  expect(before).toBeTruthy();

  await page.locator('.lead-repeat__reset').click();

  await expect(page.locator(PANEL)).toHaveCount(0);
  await expect(page.locator(FIRST_FIELD)).toBeVisible();

  const stored = await page.evaluate((key) => window.localStorage.getItem(key), LEAD_STATE_KEY);
  expect(stored).toBeNull();

  expect(await docToken(page)).toBe(before);

  expect(await page.evaluate(() => document.activeElement?.id)).toBe(
    'lead-direction-affiliate',
  );

  expect(seen.errors, seen.errors.join('\n')).toEqual([]);
});

test('заблокированное хранилище: обычная форма и ноль необработанных исключений', async ({
  page,
}) => {

  const seen = watchErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
  });
  await page.goto(PAGE_ROUTES.home.mn);

  const verdict = await page.evaluate(() => {
    try {
      void window.localStorage;
      return 'no-throw';
    } catch (err) {
      return (err as Error).name;
    }
  });
  expect(verdict, 'хранилище не заблокировано — проверка ничего не доказывает').toBe(
    'SecurityError',
  );

  await expect(page.locator('#lead-contact')).toHaveAttribute('inputmode', /.+/);

  await expect(page.locator(FIRST_FIELD)).toBeVisible();
  await expect(page.locator(PANEL)).toHaveCount(0);
  expect(seen.errors, seen.errors.join('\n')).toEqual([]);
});

test.describe('360px — ни панель, ни форма не дают горизонтальной прокрутки', () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test('форма', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.mn);
    await expect(page.locator(FIRST_FIELD)).toBeVisible();
    const overflow = await page.evaluate(() => {
      const el = document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });

  for (const locale of LOCALES_UNDER_TEST) {
    test(`панель (${locale})`, async ({ page }) => {
      await seedLeadKey(page, leadValue(HOUR_MS));
      await page.goto(PAGE_ROUTES.home[locale]);

      const panel = page.locator(PANEL);
      await expect(panel).toBeVisible();
      const overflow = await page.evaluate(() => {
        const el = document.documentElement;
        return el.scrollWidth - el.clientWidth;
      });
      expect(overflow).toBeLessThanOrEqual(0);

      const ctaHeight = await panel.locator('.lead-repeat__cta').evaluate((el) => {
        return (el as HTMLElement).getBoundingClientRect().height;
      });
      expect(ctaHeight).toBeLessThanOrEqual(56);
    });
  }
});
