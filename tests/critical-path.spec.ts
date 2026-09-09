
import { test, expect, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';
import { FIELDS, SUCCESS_ROUTE } from '../src/lib/lead-contract';
import { MOBILE_VIEWPORT } from '../playwright.config';

const projectRoot = path.resolve(import.meta.dirname, '..');

interface Dict {
  hero: { h1: string };
  cards: Record<string, { name: string }>;
}
function dict(locale: Locale): Dict {
  return JSON.parse(
    readFileSync(path.join(projectRoot, 'src', 'i18n', `${locale}.json`), 'utf-8'),
  ) as Dict;
}

const flat = (value: string): string => value.replace(/\s+/g, ' ').trim();

const LANG_RU = '.lang-switch a[hreflang="ru"]';
const LANG_MN = '.lang-switch a[hreflang="mn"]';
const CARD_BANK = 'details[data-track-direction="bank"] > summary';
const OPEN_BANK = 'details[data-track-direction="bank"][open]';
const BANK_DETAILS = 'details[data-track-direction="bank"]';

const FORM_SECTION = '#lead-form';
const NAME_FIELD = '#lead-name';
const CONTACT_FIELD = '#lead-contact';
const CONSENT_FIELD = '#lead-consent';
const SUBMIT = '.lead-form__submit';
const SUCCESS_PANEL = '[data-lead-success]';
const THANKS_CTA = 'main a.thanks-cta';

interface Seen {
  count: number;
  navigations: number;
  methods: string[];
  contentType: string[];
  bodies: string[];
}

async function interceptLead(page: Page, reply: (route: Route) => Promise<void>): Promise<Seen> {
  const seen: Seen = { count: 0, navigations: 0, methods: [], contentType: [], bodies: [] };
  await page.route('**/api/lead', async (route) => {
    seen.count += 1;
    seen.methods.push(route.request().method());
    if (route.request().isNavigationRequest()) seen.navigations += 1;
    const headers = await route.request().allHeaders();
    seen.contentType.push(headers['content-type'] ?? '');
    seen.bodies.push(route.request().postData() ?? '');
    try {
      await reply(route);
    } catch {
      /* */
    }
  });
  return seen;
}

async function fillValid(page: Page): Promise<void> {
  await page.fill(NAME_FIELD, 'Бат');
  await page.locator('input[name="contact_channel"][value="phone"]').check();
  await page.fill(CONTACT_FIELD, '99112233');

  await page.waitForTimeout(1000);
  await page.locator('input[name="direction"][value="bank"]').check();
  await page.locator(CONSENT_FIELD).check();
}

function expectContractPayload(body: string, contentType: string, locale: Locale): void {
  expect(
    contentType,
    'тело заявки ушло не в urlencoded — настоящий приёмник ответил бы 422',
  ).toContain('application/x-www-form-urlencoded');
  const payload = new URLSearchParams(body);
  for (const field of Object.values(FIELDS)) {
    expect(payload.has(field), `в теле заявки нет поля контракта «${field}»`).toBe(true);
  }

  expect(
    payload.get(FIELDS.lang),
    'язык в заявке не тот, на который человек переключился: маршрут локали и полезная нагрузка разошлись',
  ).toBe(locale);
  expect(payload.get(FIELDS.direction), 'направление в заявке не выбранное').toBe('bank');
}

test.describe('Критический путь с JS', () => {
  test('mn → RU → карточка Bank Transfer → мок-сабмит → подтверждение на месте', async ({
    page,
  }) => {

    const seen = await interceptLead(page, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true }),
      }),
    );

    await page.addInitScript(() => {
      (window as unknown as { __cpToken?: string }).__cpToken =
        `${Math.random().toString(36).slice(2)}:${performance.timeOrigin}`;
    });
    const token = (): Promise<string | undefined> =>
      page.evaluate(() => (window as unknown as { __cpToken?: string }).__cpToken);

    await page.goto(PAGE_ROUTES.home.mn);
    await expect(page.locator(CONTACT_FIELD)).toHaveJSProperty('inputMode', 'tel');
    const mn = dict('mn');
    const ru = dict('ru');
    expect(
      ru.hero.h1,
      'словари mn и ru совпали в ключе hero.h1 — на таком ключе смену языка проверить нельзя',
    ).not.toBe(mn.hero.h1);
    expect(flat(await page.locator('h1').first().innerText())).toBe(flat(mn.hero.h1));

    await page.locator(LANG_RU).click();
    await page.waitForURL((url) => url.pathname === PAGE_ROUTES.home.ru, { timeout: 15_000 });
    expect(new URL(page.url()).pathname, 'переключатель увёл не на маршрут ru из PAGE_ROUTES').toBe(
      PAGE_ROUTES.home.ru,
    );

    expect(
      flat(await page.locator('h1').first().innerText()),
      'адрес стал /ru/, а текст остался прежним: маршрут и словарь разошлись',
    ).toBe(flat(ru.hero.h1));
    expect(await page.locator('html').getAttribute('lang')).toBe('ru');

    await expect(page.locator(CONTACT_FIELD)).toHaveJSProperty('inputMode', 'tel');
    const tokenOnRu = await token();
    expect(
      tokenOnRu,
      'маркер документа не поставился — сравнивать после отправки будет нечего',
    ).toBeTruthy();

    const card = page.locator(BANK_DETAILS);
    await expect(card).toHaveJSProperty('open', false);

    await page.locator(CARD_BANK).evaluate((el) => (el as HTMLElement).click());
    await expect(card).toHaveJSProperty('open', true);
    expect(
      flat(await card.locator('.direction-name').innerText()),
      'имя карточки не равно cards.bank.name из ru-словаря',
    ).toBe(flat(ru.cards.bank.name));

    await expect(card.locator('.direction-steps')).toBeVisible();

    await page.locator(CARD_BANK).evaluate((el) => (el as HTMLElement).click());
    await expect(card).toHaveJSProperty('open', false);
    await page.locator(FORM_SECTION).scrollIntoViewIfNeeded();
    await expect(page.locator(FORM_SECTION)).toBeVisible();

    await fillValid(page);
    const urlBefore = page.url();

    await page.locator(SUBMIT).click();

    await expect(page.locator(SUCCESS_PANEL)).toBeVisible({ timeout: 15_000 });
    expect(seen.count, 'на 200 ушёл не ровно один запрос').toBe(1);
    expect(seen.navigations, 'отправка ушла навигацией — preventDefault потерян').toBe(0);
    expect(page.url(), 'адрес изменился — человек уехал со страницы').toBe(urlBefore);
    expect(
      await token(),
      'маркер документа сменился — была навигация или перезагрузка, а не подмена узлов',
    ).toBe(tokenOnRu);

    await expect(page.locator(NAME_FIELD)).toBeHidden();
    expectContractPayload(seen.bodies[0] ?? '', seen.contentType[0] ?? '', 'ru');

    const thanks = await page.goto(SUCCESS_ROUTE.ru);
    expect(thanks?.status(), `${SUCCESS_ROUTE.ru} не отдаёт 200`).toBe(200);
    expect(page.url()).toContain('/thanks/');
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator(THANKS_CTA)).toHaveCount(1);
  });
});

test.describe('Критический путь без JS', () => {

  test.use({ javaScriptEnabled: false, viewport: MOBILE_VIEWPORT });

  test('en → MN → карточка Bank Transfer → нативный сабмит → 303 → /thanks/', async ({ page }) => {

    test.setTimeout(60_000);

    const seen = await interceptLead(page, (route) =>
      route.fulfill({ status: 303, headers: { location: SUCCESS_ROUTE.mn }, body: '' }),
    );

    await page.goto(PAGE_ROUTES.home.en, { waitUntil: 'domcontentloaded' });
    const en = dict('en');
    const mn = dict('mn');
    expect(
      en.hero.h1,
      'словари en и mn совпали в ключе hero.h1 — на таком ключе смену языка проверить нельзя',
    ).not.toBe(mn.hero.h1);
    expect(flat(await page.locator('h1').first().innerText())).toBe(flat(en.hero.h1));

    await page.locator(LANG_MN).click();
    await page.waitForURL((url) => url.pathname === PAGE_ROUTES.home.mn, {
      timeout: 15_000,
      waitUntil: 'commit',
    });
    expect(
      flat(await page.locator('h1').first().innerText()),
      'без JS переход состоялся, а язык не сменился',
    ).toBe(flat(mn.hero.h1));
    expect(await page.locator('html').getAttribute('lang')).toBe('mn');

    const summary = page.locator(CARD_BANK);
    const summaryText = flat(await summary.innerText());
    expect(
      summaryText.length,
      'карточка направления пуста без JS — содержимое доступно только скриптом',
    ).toBeGreaterThan(0);
    expect(summaryText, 'в карточке нет имени направления из mn-словаря').toContain(
      flat(mn.cards.bank.name),
    );

    await expect(page.locator(OPEN_BANK)).toHaveCount(0);
    await summary.click();
    await expect(
      page.locator(OPEN_BANK),
      'карточка не раскрылась при отключённом JS: нативный details перестал работать (измерение в шапке ветви устарело)',
    ).toHaveCount(1);

    await expect(page.locator(`${BANK_DETAILS} .direction-steps`)).toBeVisible();

    await summary.click();
    await expect(page.locator(OPEN_BANK)).toHaveCount(0);

    await fillValid(page);
    await page.locator(SUBMIT).click();

    await expect
      .poll(() => seen.count, { timeout: 15_000, message: 'форма без JS не отправилась вовсе: запроса на /api/lead не было (нативная валидация отвергла поля либо клик не дошёл до кнопки)' })
      .toBe(1);

    await page.waitForURL((url) => url.pathname === SUCCESS_ROUTE.mn, {
      timeout: 15_000,
      waitUntil: 'commit',
    });

    expect(seen.count, 'без JS ушёл не ровно один запрос').toBe(1);
    expect(seen.methods[0], 'форма без JS ушла не методом POST').toBe('POST');

    expect(seen.navigations, 'отправка без JS ушла не навигацией — ветвь проверена не та').toBe(1);
    expectContractPayload(seen.bodies[0] ?? '', seen.contentType[0] ?? '', 'mn');

    expect(page.url(), 'браузер приземлился не на подтверждении').toContain('/thanks/');
    await expect(page.locator('h1')).toHaveCount(1);

    await expect(page.locator(THANKS_CTA)).toHaveCount(1);
    const href = await page.locator(THANKS_CTA).getAttribute('href');
    expect(href ?? '', `действие подтверждения ведёт в пустой Telegram: ${href}`).toMatch(
      /^https:\/\/t\.me\/[^/?#]+/,
    );
  });
});
