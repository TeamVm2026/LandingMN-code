
import { test, expect, type Page } from '@playwright/test';
import { PAGE_ROUTES } from '../src/i18n/routes';
import { TURNSTILE_TOKEN_FIELD } from '../src/lib/lead-contract';

const TURNSTILE_HOST = 'challenges.cloudflare.com';

const TEST_SITEKEYS = {

  pass: '1x00000000000000000000AA',

  fail: '2x00000000000000000000AB',

  challenge: '3x00000000000000000000FF',
} as const;

const SITEKEY = (process.env.PUBLIC_TURNSTILE_SITEKEY ?? '').trim();
const IS_TEST_SITEKEY = (Object.values(TEST_SITEKEYS) as string[]).includes(SITEKEY);

const NAME_FIELD = '#lead-name';
const FORM = 'form[data-lead-form]';
const TURNSTILE_CONTAINER = '[data-turnstile]';

const TOKEN_INPUT = `input[name="${TURNSTILE_TOKEN_FIELD}"]`;

test.skip(
  () => !IS_TEST_SITEKEY,
  `PUBLIC_TURNSTILE_SITEKEY (${SITEKEY || 'не задан'}) не является ТЕСТОВЫМ ключом Cloudflare — ` +
    'без тестового ключа утверждения о виджете либо ложно-зелёные (ключа нет вовсе), ' +
    'либо ложно-красные (боевой ключ на localhost даёт 110200)',
);

function collectRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  return urls;
}

function tokenValue(page: Page): Promise<string | null> {
  return page.evaluate((selector) => {
    const input = document.querySelector<HTMLInputElement>(selector);
    return input ? input.value : null;
  }, TOKEN_INPUT);
}

test.describe('Turnstile: цена до фокуса и появление после (любой тестовый ключ)', () => {
  test('до первого фокуса запроса к challenges.cloudflare.com нет ни одного', async ({ page }) => {
    const urls = collectRequests(page);

    await page.goto(PAGE_ROUTES.home.mn);
    await page.waitForLoadState('networkidle');

    expect(urls.filter((url) => /\/_astro\/.*\.js(\?|$)/.test(url)).length).toBeGreaterThan(0);

    expect(urls.filter((url) => url.includes(TURNSTILE_HOST))).toEqual([]);
  });

  test('после фокуса в поле имени запрос к challenges.cloudflare.com появляется', async ({
    page,
  }) => {
    await page.goto(PAGE_ROUTES.home.mn);
    await page.waitForLoadState('networkidle');

    const apiRequest = page.waitForRequest((request) => request.url().includes(TURNSTILE_HOST));
    await page.locator(NAME_FIELD).focus();
    const request = await apiRequest;

    expect(request.url()).toContain('/turnstile/v0/api.js');
    expect(request.url()).toContain('render=explicit');
  });

  test('в консоли нет исключения turnstile.ready() про async/defer', async ({ page }) => {

    const suspicious: string[] = [];
    const watch = (text: string): void => {
      if (text.includes('Remove async/defer')) suspicious.push(text);
    };
    page.on('console', (message) => watch(message.text()));
    page.on('pageerror', (error) => watch(error.message));

    await page.goto(PAGE_ROUTES.home.mn);
    await page.waitForLoadState('networkidle');
    await page.locator(NAME_FIELD).focus();

    await expect.poll(() => tokenValue(page), { timeout: 20_000 }).not.toBeNull();

    expect(suspicious).toEqual([]);
  });

  test('контейнер виджета шире минимума size: flexible (300px) на экране 360px', async ({
    page,
    browser,
  }) => {

    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(PAGE_ROUTES.home.mn);
    const plain = await page.locator(TURNSTILE_CONTAINER).evaluate((el) => el.clientWidth);

    const mobileContext = await browser.newContext({
      viewport: { width: 360, height: 800 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(PAGE_ROUTES.home.mn);
    const mobile = await mobilePage.locator(TURNSTILE_CONTAINER).evaluate((el) => el.clientWidth);
    await mobileContext.close();

    console.log(
      `[замер] ширина ${TURNSTILE_CONTAINER} на 360px: обычный контекст ${plain}px, мобильная эмуляция ${mobile}px (порог flexible 300px)`,
    );

    const expectedSize = (width: number): 'flexible' | 'compact' =>
      width >= 300 ? 'flexible' : 'compact';

    expect(plain, 'ширина контейнера в обычном контексте не определена').toBeGreaterThan(0);
    expect(mobile, 'ширина контейнера в мобильной эмуляции не определена').toBeGreaterThan(0);

    for (const [name, width] of [
      ['обычный контекст', plain],
      ['мобильная эмуляция', mobile],
    ] as const) {
      const size = expectedSize(width);
      if (size === 'compact') {

        expect(
          width,
          `${name}: ${width}px не вмещает даже compact (150px) — форма схлопнулась`,
        ).toBeGreaterThanOrEqual(150);
      } else {
        expect(width, `${name}: ${width}px объявлен как flexible`).toBeGreaterThanOrEqual(300);
      }
    }
  });
});

test.describe('Turnstile: ключ, который всегда проходит', () => {
  test.skip(
    () => SITEKEY !== TEST_SITEKEYS.pass,
    `нужен sitekey ${TEST_SITEKEYS.pass} (собирается отдельным прогоном: один ключ на одну сборку)`,
  );

  test('токен приезжает в скрытое поле, и поле лежит ВНУТРИ <form>', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.mn);
    await page.waitForLoadState('networkidle');
    await page.locator(NAME_FIELD).focus();

    await expect.poll(() => tokenValue(page), { timeout: 20_000 }).toBeTruthy();

    const placement = await page.evaluate(
      ({ tokenSelector, formSelector }) => {
        const input = document.querySelector<HTMLInputElement>(tokenSelector);
        const form = document.querySelector<HTMLFormElement>(formSelector);
        if (!input || !form) return null;
        return {
          insideForm: input.closest('form') === form,

          formDataKeys: [...new FormData(form).keys()],
        };
      },
      { tokenSelector: TOKEN_INPUT, formSelector: FORM },
    );

    expect(placement).not.toBeNull();
    expect(placement!.insideForm).toBe(true);
    expect(placement!.formDataKeys).toContain(TURNSTILE_TOKEN_FIELD);
  });

  test('контейнер остаётся нулевой высоты — сдвига на успешном пути нет', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.mn);
    await page.waitForLoadState('networkidle');

    const container = page.locator(TURNSTILE_CONTAINER);
    const before = await container.evaluate((el) => el.getBoundingClientRect().height);

    await page.locator(NAME_FIELD).focus();
    await expect.poll(() => tokenValue(page), { timeout: 20_000 }).toBeTruthy();

    const after = await container.evaluate((el) => el.getBoundingClientRect().height);
    expect(before).toBe(0);
    expect(after).toBe(0);
  });
});

test.describe('Turnstile: ключ, который всегда отказывает', () => {
  test.skip(
    () => SITEKEY !== TEST_SITEKEYS.fail,
    `нужен sitekey ${TEST_SITEKEYS.fail} (собирается отдельным прогоном: один ключ на одну сборку)`,
  );

  test('поле токена существует и ПУСТО, а кнопка отправки не заблокирована', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.mn);
    await page.waitForLoadState('networkidle');
    await page.locator(NAME_FIELD).focus();

    await expect.poll(() => tokenValue(page), { timeout: 20_000 }).not.toBeNull();
    expect(await tokenValue(page)).toBe('');

    const submit = page.locator(`${FORM} button[type="submit"]`);
    await expect(submit).toBeEnabled();
    await expect(submit).not.toHaveAttribute('aria-disabled', 'true');
  });
});
