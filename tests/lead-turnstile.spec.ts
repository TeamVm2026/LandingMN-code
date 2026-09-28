
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

  test('виджет всегда полосой вровень с полями: масштаб только там, где колонка уже 300px', async ({
    browser,
  }) => {
    for (const width of [320, 360, 430]) {
      const context = await browser.newContext({
        viewport: { width, height: 800 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      });
      const page = await context.newPage();
      await page.goto(PAGE_ROUTES.home.mn);
      await page.locator(NAME_FIELD).focus();
      await page.waitForSelector(`${TURNSTILE_CONTAINER} > div`, { state: 'attached', timeout: 20_000 });

      const m = await page.evaluate((selector) => {
        const container = document.querySelector<HTMLElement>(selector)!;
        const mount = container.firstElementChild as HTMLElement;
        return {
          column: container.clientWidth,
          mountWidth: mount.getBoundingClientRect().width,
          transform: mount.style.transform,
          zoom: mount.style.zoom,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      }, TURNSTILE_CONTAINER);
      console.log(
        `[замер] ${width}px: колонка ${m.column}px, обёртка ${m.mountWidth.toFixed(1)}px, transform «${m.transform}», zoom «${m.zoom}»`,
      );

      expect(m.column, 'ширина колонки формы не определена').toBeGreaterThan(0);
      expect(
        Math.abs(m.mountWidth - m.column),
        `${width}px: обёртка виджета ${m.mountWidth.toFixed(1)}px не вровень с колонкой ${m.column}px`,
      ).toBeLessThanOrEqual(1);

      expect(m.zoom, `${width}px: у обёртки виджета снова zoom`).toBe('');
      if (m.column < 300) {
        const scale = Number(/^scale\(([\d.]+)\)$/.exec(m.transform)?.[1]);
        expect(scale, `${width}px: колонка ${m.column}px, а масштаба нет`).toBeCloseTo(m.column / 300, 3);
      } else {
        expect(m.transform, `${width}px: колонка ${m.column}px, а виджет всё равно уменьшен`).toBe('');
      }
      expect(m.overflow, `${width}px: страница получила горизонтальную прокрутку`).toBeLessThanOrEqual(0);
      await context.close();
    }
  });
});

test.describe('Turnstile: видимая проверка (ключ принудительного челленджа)', () => {

  test.skip(
    () => SITEKEY !== TEST_SITEKEYS.challenge && SITEKEY !== TEST_SITEKEYS.pass,
    `нужен тестовый sitekey ${TEST_SITEKEYS.pass} или ${TEST_SITEKEYS.challenge}`,
  );

  async function openChallenge(page: Page): Promise<void> {
    let swapped = 0;
    if (SITEKEY === TEST_SITEKEYS.pass) {
      await page.route('**/_astro/*.js', async (route) => {
        const response = await route.fetch();
        const body = await response.text();
        if (body.includes(TEST_SITEKEYS.pass)) swapped++;
        await route.fulfill({ response, body: body.split(TEST_SITEKEYS.pass).join(TEST_SITEKEYS.challenge) });
      });
    }
    await page.goto(PAGE_ROUTES.home.mn);
    await page.locator(NAME_FIELD).focus();
    await expect
      .poll(() => page.locator(TURNSTILE_CONTAINER).evaluate((el) => el.getBoundingClientRect().height), {
        timeout: 30_000,
        message: 'проверка Cloudflare так и не показалась',
      })
      .toBeGreaterThan(0);
    if (SITEKEY === TEST_SITEKEYS.pass) {
      expect(swapped, 'ключ «всегда проходит» не найден ни в одном чанке — подмена не сработала').toBeGreaterThan(0);
    }

    await page.waitForTimeout(1500);
  }

  async function measure(page: Page) {
    const frames = page.frames().filter((frame) => frame.url().includes(TURNSTILE_HOST));
    for (const frame of frames) {
      const element = await frame.frameElement();
      const box = await element.boundingBox();
      if (!box || box.height <= 1) continue;
      const layout = await element.evaluate((el) => ({
        width: (el as HTMLElement).offsetWidth,
        height: (el as HTMLElement).offsetHeight,
      }));
      const inner = await frame.evaluate(() => ({ dpr: devicePixelRatio, width: innerWidth, height: innerHeight }));
      const outer = await page.evaluate((selector) => {
        const container = document.querySelector<HTMLElement>(selector)!;
        const rect = container.getBoundingClientRect();
        return {
          dpr: devicePixelRatio,
          column: container.clientWidth,
          containerTop: rect.top,
          containerHeight: rect.height,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      }, TURNSTILE_CONTAINER);
      return { box, layout, inner, ...outer };
    }
    throw new Error('видимого iframe Cloudflare на странице нет');
  }

  test('чужой документ не уменьшается, виджет вровень с полями, контейнер ровно по виджету', async ({ browser }) => {

    let referenceDpr: number | null = null;
    for (const width of [430, 320, 360]) {
      const context = await browser.newContext({
        viewport: { width, height: 800 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      });
      const page = await context.newPage();
      await openChallenge(page);
      const m = await measure(page);
      console.log(
        `[замер] ${width}px: колонка ${m.column}, iframe ${m.box.width.toFixed(1)}×${m.box.height.toFixed(1)} ` +
          `(в раскладке ${m.layout.width}×${m.layout.height}), внутри ${m.inner.width}×${m.inner.height} ` +
          `при dpr ${m.inner.dpr} (страница ${m.dpr}), контейнер ${m.containerHeight.toFixed(1)}`,
      );

      referenceDpr ??= m.inner.dpr;
      expect(m.inner.dpr, `${width}px: масштаб обёртки утёк в документ Cloudflare`).toBeCloseTo(referenceDpr, 3);

      expect(
        { width: m.inner.width, height: m.inner.height },
        `${width}px: окно документа Cloudflare не совпадает с коробкой iframe`,
      ).toEqual({ width: m.layout.width, height: m.layout.height });

      expect(
        Math.abs(m.box.width - m.column),
        `${width}px: виджет ${m.box.width.toFixed(1)}px при колонке ${m.column}px`,
      ).toBeLessThanOrEqual(1);

      expect(
        Math.abs(m.containerHeight - m.box.height),
        `${width}px: контейнер ${m.containerHeight.toFixed(1)}px при видимом виджете ${m.box.height.toFixed(1)}px`,
      ).toBeLessThanOrEqual(0.5);
      expect(Math.abs(m.box.y - m.containerTop), `${width}px: виджет сдвинут внутри контейнера`).toBeLessThanOrEqual(0.5);
      expect(m.overflow, `${width}px: страница получила горизонтальную прокрутку`).toBeLessThanOrEqual(0);
      await context.close();
    }
  });

  test('на самой узкой колонке галочка нажимается сквозь уменьшение, и токен приезжает', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 320, height: 800 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    const page = await context.newPage();
    await openChallenge(page);
    const m = await measure(page);
    const scale = m.box.width / m.layout.width;
    expect(scale, 'на 320 виджет обязан быть уменьшен — иначе тест не про то').toBeLessThan(0.95);

    await page.mouse.click(m.box.x + 28 * scale, m.box.y + m.box.height / 2);
    await expect.poll(() => tokenValue(page), { timeout: 20_000 }).toBeTruthy();
    await context.close();
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
    () => SITEKEY !== TEST_SITEKEYS.fail && SITEKEY !== TEST_SITEKEYS.pass,
    `нужен тестовый sitekey ${TEST_SITEKEYS.pass} или ${TEST_SITEKEYS.fail}`,
  );

  let swapped = 0;

  test.beforeEach(async ({ page }) => {
    swapped = 0;
    if (SITEKEY !== TEST_SITEKEYS.pass) return;
    await page.route('**/_astro/*.js', async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      if (body.includes(TEST_SITEKEYS.pass)) swapped++;
      await route.fulfill({ response, body: body.split(TEST_SITEKEYS.pass).join(TEST_SITEKEYS.fail) });
    });
  });

  test('поле токена существует и ПУСТО, а кнопка отправки не заблокирована', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.mn);
    await page.waitForLoadState('networkidle');

    const failed = page.waitForEvent('console', {
      predicate: (m) => /Turnstile\] Error: 600010/.test(m.text()),
      timeout: 30_000,
    });
    await page.locator(NAME_FIELD).focus();
    await failed;

    if (SITEKEY === TEST_SITEKEYS.pass) {
      expect(swapped, 'ключ «всегда проходит» не найден ни в одном чанке — подмена не сработала').toBeGreaterThan(0);
    }

    await expect.poll(() => tokenValue(page), { timeout: 20_000 }).not.toBeNull();
    expect(await tokenValue(page)).toBe('');

    const submit = page.locator(`${FORM} button[type="submit"]`);
    await expect(submit).toBeEnabled();
    await expect(submit).not.toHaveAttribute('aria-disabled', 'true');
  });
});
