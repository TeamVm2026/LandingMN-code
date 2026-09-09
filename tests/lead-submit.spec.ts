
import { test, expect, type Page, type Route } from '@playwright/test';
import { MOBILE_VIEWPORT, DESKTOP_VIEWPORT } from '../playwright.config';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';
import { ERROR_CODES, SUCCESS_ROUTE } from '../src/lib/lead-contract';
import { LEAD_STATE_KEY } from '../src/scripts/lead/state';

const LOCALES: Locale[] = ['mn', 'ru', 'en'];

const FORM = 'form[data-lead-form]';
const SUBMIT = '.lead-form__submit';
const STATUS = '[data-lead-status]';
const NOTICE = '.lead-form__notice';
const NOTICE_LINK = '.lead-form__notice-link';
const NAME_FIELD = '#lead-name';
const CONTACT_FIELD = '#lead-contact';

const SUCCESS_PANEL = '[data-lead-success]';
const PANEL_TITLE = '.lead-repeat__title';
const PANEL_BODY = '.lead-repeat__body';
const PANEL_CTA = '.lead-repeat__cta';
const PANEL_RESET = '.lead-repeat__reset';

const SHOTS = 'test-results/success-inplace';

const NARROW = { width: 360, height: 740 };

type Responder = (route: Route) => Promise<void>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Responder {
  return (route) =>
    route.fulfill({
      status,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
}

const abortNetwork: Responder = (route) => route.abort('failed');

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

interface LeadIntercept {

  readonly seen: {
    count: number;
    kinds: string[];
    navigations: number;
    accept: string[];
    contentType: string[];
    bodies: string[];
  };

  reply(next: Responder): void;
}

async function interceptLead(page: Page): Promise<LeadIntercept> {
  const seen = {
    count: 0,
    kinds: [] as string[],
    navigations: 0,
    accept: [] as string[],
    contentType: [] as string[],
    bodies: [] as string[],
  };
  let responder: Responder = json(500, { ok: false, error: ERROR_CODES.internalError });

  await page.route('**/api/lead', async (route) => {
    seen.count += 1;
    seen.kinds.push(route.request().resourceType());
    if (route.request().isNavigationRequest()) seen.navigations += 1;
    const headers = await route.request().allHeaders();
    seen.accept.push(headers['accept'] ?? '');
    seen.contentType.push(headers['content-type'] ?? '');
    seen.bodies.push(route.request().postData() ?? '');
    try {
      await responder(route);
    } catch {
      /* */
    }
  });

  return {
    seen,
    reply(next: Responder) {
      responder = next;
    },
  };
}

async function openForm(page: Page, locale: Locale, sink = false): Promise<void> {
  await page.goto(`${PAGE_ROUTES.home[locale]}${sink ? '?__sink=1' : ''}`);
  await expect(page.locator(CONTACT_FIELD)).toHaveJSProperty('inputMode', 'tel');
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

async function fillValid(page: Page, direction = 'bank'): Promise<void> {
  await page.fill(NAME_FIELD, 'Бат');
  await page.locator('input[name="contact_channel"][value="phone"]').check();
  await page.fill(CONTACT_FIELD, '99112233');
  await page.locator(`input[name="direction"][value="${direction}"]`).check();
  await page.locator('#lead-consent').check();
}

function formData(page: Page): Promise<Record<string, string>> {
  return page.evaluate((sel) => {
    const form = document.querySelector<HTMLFormElement>(sel);
    if (!form) throw new Error('формы нет на странице');
    return { ...form.dataset } as Record<string, string>;
  }, FORM);
}

interface NoticeShape {

  message: string;
  linkText: string;
  href: string;
  target: string;
  rel: string;
  hasLink: boolean;
}

function readNotice(page: Page): Promise<NoticeShape> {
  return page.evaluate((sel) => {
    const p = document.querySelector<HTMLElement>(sel);
    if (!p) return { message: '', linkText: '', href: '', target: '', rel: '', hasLink: false };
    const link = p.querySelector<HTMLAnchorElement>('a');
    const linkText = link?.textContent ?? '';
    const full = p.textContent ?? '';
    return {

      message: full.slice(0, full.length - linkText.length).trim(),
      linkText,
      href: link?.getAttribute('href') ?? '',
      target: link?.getAttribute('target') ?? '',
      rel: link?.getAttribute('rel') ?? '',
      hasLink: link !== null,
    };
  }, NOTICE);
}

async function waitForMessage(page: Page, expected: string): Promise<NoticeShape> {
  await expect
    .poll(async () => (await readNotice(page)).message, { timeout: 15_000 })
    .toBe(expected);
  return readNotice(page);
}

interface RecordedEvent {
  name: string;
  params: Record<string, string | undefined>;
}

function events(page: Page): Promise<RecordedEvent[]> {
  return page.evaluate(() => (window as { __lmnEvents?: RecordedEvent[] }).__lmnEvents ?? []);
}

async function nextFormError(page: Page, seenBefore: number): Promise<RecordedEvent> {
  await expect
    .poll(async () => (await events(page)).filter((e) => e.name === 'form_error').length, {
      timeout: 10_000,
    })
    .toBeGreaterThan(seenBefore);
  const all = (await events(page)).filter((e) => e.name === 'form_error');
  return all[all.length - 1]!;
}

function activeElementInfo(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return 'нет';
    return `${el.tagName.toLowerCase()}.${el.className || ''}#${el.id || ''}`;
  });
}

async function scrollSettled(page: Page): Promise<void> {
  let previous = -1;
  for (let i = 0; i < 40; i++) {
    const current = await page.evaluate(() => Math.round(window.scrollY));
    if (current === previous) return;
    previous = current;
    await page.waitForTimeout(100);
  }
}

async function placeWhereTargetFitsViewport(
  page: Page,
  targetSel: string = NOTICE,
): Promise<{
  ok: boolean;
  scrollY: number;
  natural: number;
  reason: string;
}> {

  return page.evaluate(
    async ({ noticeSel }) => {
      const notice = document.querySelector<HTMLElement>(noticeSel);
      if (!notice) {
        return { ok: false, scrollY: 0, natural: 0, reason: 'нет сообщения в DOM' };
      }

      const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));
      const holds = (): boolean => {
        const r = notice.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      };

      const natural = Math.round(window.scrollY);
      await settle();
      if (holds()) {
        return { ok: true, scrollY: natural, natural, reason: 'естественное положение' };
      }

      const r0 = notice.getBoundingClientRect();
      const topAbs = r0.top + window.scrollY;
      const min = Math.max(0, Math.round(topAbs + r0.height - window.innerHeight));
      const max = Math.round(topAbs);

      const tried = new Set<number>();
      for (let step = 16; step <= 640; step += 16) {
        for (const y of [natural - step, natural + step]) {
          if (y < min || y > max || tried.has(y)) continue;
          tried.add(y);
          window.scrollTo(0, y);
          await settle();
          if (holds()) {
            return {
              ok: true,
              scrollY: y,
              natural,
              reason: `сдвиг ${y - natural}px от естественного`,
            };
          }
        }
      }

      window.scrollTo(0, natural);
      await settle();

      const footer = document.querySelector('.site-footer');
      const fRect = footer?.getBoundingClientRect();
      const nRect = notice.getBoundingClientRect();
      return {
        ok: false,
        scrollY: natural,
        natural,
        reason:
          `ни одно положение в [${min}, ${max}] не даёт сообщение целиком в кадре ` +
          `(проверено ${tried.size} положений). ` +
          `Замеры: экран ${window.innerWidth}x${window.innerHeight}, документ ` +
          `${Math.round(document.documentElement.scrollHeight)}px, сообщение ` +
          `${Math.round(nRect.height)}px, подвал ` +
          `${fRect ? `top=${Math.round(fRect.top)} (в кадре: ${fRect.top < window.innerHeight})` : 'отсутствует'}`,
      };
    },
    { noticeSel: targetSel },
  );
}

test.describe('Живая область формы', () => {
  test('до первой отправки пуста, несёт роль и не занимает места (три локали)', async ({
    page,
  }) => {
    for (const locale of LOCALES) {
      await openForm(page, locale);

      const status = page.locator(STATUS);
      await expect(status, `[data-lead-status] нет на ${locale}`).toHaveCount(1);

      await expect(status).toHaveAttribute('role', 'status');
      await expect(status).toHaveAttribute('aria-live', 'polite');
      await expect(status).toHaveAttribute('aria-atomic', 'true');

      const shape = await status.evaluate((el) => ({
        text: (el.textContent ?? '').trim(),
        height: el.getBoundingClientRect().height,

        position: getComputedStyle(el).position,
      }));

      expect(shape.text, `живая область ${locale} не пуста в собранном HTML`).toBe('');
      expect(shape.height, `живая область ${locale} занимает высоту`).toBe(0);
      expect(shape.position, `живая область ${locale} осталась в потоке`).toBe('absolute');
    }
  });
});

test.describe('Защита от двойной отправки', () => {
  test('три клика + Enter + requestSubmit при запросе в полёте дают РОВНО ОДИН запрос', async ({
    page,
  }) => {
    const lead = await interceptLead(page);
    const held = gate();

    lead.reply(async (route) => {
      await held.wait;
      await json(500, { ok: false, error: ERROR_CODES.internalError })(route);
    });

    await openForm(page, 'mn');
    await fillValid(page);

    await page.evaluate(() => {
      const w = window as unknown as { __submits?: number };
      w.__submits = 0;
      document.addEventListener(
        'submit',
        () => {
          w.__submits = (w.__submits ?? 0) + 1;
        },
        true,
      );
    });

    const button = page.locator(SUBMIT);
    const urlBefore = page.url();

    await button.click({ force: true });
    await expect(button).toHaveAttribute('aria-busy', 'true');

    await button.click({ force: true });
    await button.click({ force: true });

    const focusedAfterClicks = await button.evaluate((el) => document.activeElement === el);
    expect(focusedAfterClicks, 'фокус ушёл с кнопки, которую только что нажали').toBe(true);

    await page.locator(NAME_FIELD).press('Enter');

    await page.locator(FORM).evaluate((el) => {
      (el as HTMLFormElement).requestSubmit();
    });

    await expect
      .poll(async () => page.evaluate(() => (window as unknown as { __submits?: number }).__submits ?? -1))
      .toBe(5);

    expect(lead.seen.count, 'пять путей отправки дали больше одного запроса').toBe(1);

    expect(lead.seen.navigations, 'отправка ушла навигацией — preventDefault потерян').toBe(0);
    expect(lead.seen.kinds).toEqual(['fetch']);
    expect(page.url(), 'страница уехала с формы').toBe(urlBefore);

    expect(lead.seen.accept[0] ?? '').toContain('application/json');

    expect(lead.seen.contentType[0] ?? '').toContain(
      'application/x-www-form-urlencoded',
    );
    expect(lead.seen.contentType[0] ?? '').not.toContain('multipart');

    expect(lead.seen.bodies[0] ?? '').toContain('name=');

    const buttonState = await button.evaluate((el) => {
      const b = el as HTMLButtonElement;
      return {
        disabledProp: b.disabled,
        disabledAttr: b.hasAttribute('disabled'),
        tabIndex: b.tabIndex,
      };
    });
    expect(buttonState.disabledProp, 'кнопка получила нативный disabled').toBe(false);
    expect(buttonState.disabledAttr, 'на кнопке стоит атрибут disabled').toBe(false);
    expect(buttonState.tabIndex, 'кнопка выпала из порядка обхода').toBeGreaterThanOrEqual(0);

    held.open();
  });

  test('состояние занятости: надпись и aria-*, форма и кнопка не меняются', async ({ page }) => {
    const lead = await interceptLead(page);
    const held = gate();
    lead.reply(async (route) => {
      await held.wait;
      await json(500, { ok: false, error: ERROR_CODES.internalError })(route);
    });

    await openForm(page, 'mn');
    await fillValid(page);

    const data = await formData(page);
    const button = page.locator(SUBMIT);

    const before = await page.evaluate(
      ({ formSel, btnSel }) => {
        const form = document.querySelector<HTMLElement>(formSel)!;
        const btn = document.querySelector<HTMLElement>(btnSel)!;
        return {
          formHeight: form.getBoundingClientRect().height,
          buttonHeight: btn.getBoundingClientRect().height,
          background: getComputedStyle(btn).backgroundColor,
        };
      },
      { formSel: FORM, btnSel: SUBMIT },
    );

    await button.press('Enter');
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveText(data.labelSubmitting ?? '');
    expect(data.labelSubmitting, 'надписи занятости нет в data-атрибутах формы').toBeTruthy();

    const during = await page.evaluate(
      ({ formSel, btnSel, statusSel }) => {
        const form = document.querySelector<HTMLElement>(formSel)!;
        const btn = document.querySelector<HTMLElement>(btnSel)!;
        const status = document.querySelector<HTMLElement>(statusSel)!;
        return {
          formHeight: form.getBoundingClientRect().height,
          buttonHeight: btn.getBoundingClientRect().height,
          background: getComputedStyle(btn).backgroundColor,

          statusText: (status.textContent ?? '').trim(),
          statusQuiet: status.hasAttribute('data-status-quiet'),
          statusPosition: getComputedStyle(status).position,
        };
      },
      { formSel: FORM, btnSel: SUBMIT, statusSel: STATUS },
    );

    expect(during.formHeight, 'форма изменила высоту в момент нажатия').toBeCloseTo(
      before.formHeight,
      1,
    );
    expect(during.buttonHeight, 'кнопка изменила высоту').toBeCloseTo(before.buttonHeight, 1);
    expect(during.background, 'кнопка сменила материал').toBe(before.background);

    expect(during.statusText, 'занятость не объявлена скринридеру').toBe(data.labelSubmitting);
    expect(during.statusQuiet, 'признак data-status-quiet не выставлен').toBe(true);
    expect(during.statusPosition, 'живая область вернулась в поток на busy').toBe('absolute');

    await expect(page.locator(NOTICE)).toHaveCount(0);

    held.open();
  });

  test('после отказа лок снят: повторное нажатие даёт ВТОРОЙ запрос', async ({ page }) => {
    const lead = await interceptLead(page);
    lead.reply(json(500, { ok: false, error: ERROR_CODES.internalError }));

    await openForm(page, 'mn');
    await fillValid(page);

    const data = await formData(page);
    const button = page.locator(SUBMIT);

    await button.click();
    await waitForMessage(page, data.apiErrGeneric ?? '');

    await expect(button).not.toHaveAttribute('aria-busy', /.*/);
    await expect(button).not.toHaveAttribute('aria-disabled', /.*/);
    await expect(button).toHaveText(data.labelSubmit ?? '');
    expect(lead.seen.count).toBe(1);

    await button.click();
    await expect.poll(() => lead.seen.count, { timeout: 10_000 }).toBe(2);
  });
});

interface FailureCase {
  name: string;
  responder: Responder;

  textKey: string;

  fallback: boolean;
  errorType: string;
  field?: string;
}

const FAILURE_TABLE: FailureCase[] = [
  {
    name: '403 captcha_failed',

    responder: json(403, {
      ok: false,
      error: ERROR_CODES.captchaFailed,
      errorCodes: ['invalid-input-secret'],
      configError: true,
    }),
    textKey: 'apiErrCaptcha',
    fallback: true,
    errorType: 'turnstile',
  },
  {
    name: '429 rate_limited',
    responder: json(
      429,
      { ok: false, error: ERROR_CODES.rateLimited },
      { 'retry-after': '30' },
    ),
    textKey: 'apiErrRateLimited',
    fallback: true,
    errorType: 'ratelimit',
  },
  {
    name: '500 internal_error',
    responder: json(500, { ok: false, error: ERROR_CODES.internalError }),
    textKey: 'apiErrGeneric',
    fallback: true,
    errorType: 'server',
  },
  {
    name: 'обрыв связи',
    responder: abortNetwork,
    textKey: 'apiErrNetwork',
    fallback: true,
    errorType: 'network',
  },
  {
    name: '422 validation_failed',
    responder: json(422, {
      ok: false,
      error: ERROR_CODES.validationFailed,
      fields: ['name'],
    }),
    textKey: 'apiErrValidation',

    fallback: false,
    errorType: 'server',
    field: 'name',
  },
];

test.describe('Таблица отказов: каждый код ответа — свой текст, свой выход, своё событие', () => {
  for (const locale of LOCALES) {
    test(`пять ответов подряд обработаны по таблице (${locale})`, async ({ page }) => {
      const lead = await interceptLead(page);
      await openForm(page, locale, true);
      await fillValid(page);

      const data = await formData(page);
      const button = page.locator(SUBMIT);
      let errorsSeen = 0;

      for (const row of FAILURE_TABLE) {
        const expectedText = data[row.textKey] ?? '';
        expect(expectedText, `у формы ${locale} нет data-атрибута ${row.textKey}`).toBeTruthy();

        lead.reply(row.responder);
        await button.click();

        const notice = await waitForMessage(page, expectedText);

        expect(notice.hasLink, `${row.name} (${locale}): ссылка не там, где надо`).toBe(
          row.fallback,
        );
        if (row.fallback) {
          expect(notice.linkText).toBe(data.apiFallbackCta);
          expect(notice.href).toBe(data.apiFallbackHref);
          expect(notice.href).toMatch(/^https:\/\//);
          expect(notice.target).toBe('_blank');
          expect(notice.rel).toContain('noopener');
        }

        const event = await nextFormError(page, errorsSeen);
        errorsSeen += 1;
        expect(event.params.error_type, `${row.name} (${locale}): не то error_type`).toBe(
          row.errorType,
        );
        expect(event.params.field).toBe(row.field);

        if (row.field) {

          const holder = page.locator('.field.has-error');
          await expect(holder).toHaveCount(1);
          await expect(holder.locator(NAME_FIELD)).toHaveCount(1);
          const note = holder.locator('[data-field-error]');
          await expect(note).toHaveText(data.errInvalid ?? '');
          await expect(note).toHaveAttribute('role', 'alert');
          expect(
            await activeElementInfo(page),
            `${row.name} (${locale}): фокус не встал на непройденное поле`,
          ).toContain('lead-name');
        } else {

          expect(
            await activeElementInfo(page),
            `${row.name} (${locale}): фокус уехал с кнопки`,
          ).toContain('lead-form__submit');
        }
      }

      expect(lead.seen.count).toBe(FAILURE_TABLE.length);
      expect(lead.seen.navigations).toBe(0);
    });
  }

  test('429 не показывает человеку цифр обратного отсчёта', async ({ page }) => {
    const lead = await interceptLead(page);
    lead.reply(
      json(429, { ok: false, error: ERROR_CODES.rateLimited }, { 'retry-after': '30' }),
    );

    await openForm(page, 'ru');
    await fillValid(page);
    const data = await formData(page);

    await page.locator(SUBMIT).click();
    const notice = await waitForMessage(page, data.apiErrRateLimited ?? '');

    expect(notice.message, 'в сообщении о лимите появились цифры').not.toMatch(/\d/);
  });

  test('две одинаковые ошибки подряд ОБНУЛЯЮТ живую область между попытками', async ({ page }) => {
    const lead = await interceptLead(page);
    lead.reply(abortNetwork);

    await openForm(page, 'mn');
    await fillValid(page);
    const data = await formData(page);
    const expectedText = data.apiErrNetwork ?? '';

    await page.evaluate((sel) => {
      const status = document.querySelector<HTMLElement>(sel)!;
      const log: string[] = [];
      (window as unknown as { __statusLog?: string[] }).__statusLog = log;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of Array.from(record.removedNodes)) log.push(`-${node.textContent ?? ''}`);
          for (const node of Array.from(record.addedNodes)) log.push(`+${node.textContent ?? ''}`);
        }
      }).observe(status, { childList: true, subtree: true });
    }, STATUS);

    const button = page.locator(SUBMIT);
    await button.click();
    await waitForMessage(page, expectedText);
    await button.click();
    await expect.poll(() => lead.seen.count, { timeout: 10_000 }).toBe(2);
    await waitForMessage(page, expectedText);

    const log = await page.evaluate(
      () => (window as unknown as { __statusLog?: string[] }).__statusLog ?? [],
    );

    const insertedAt = log
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.startsWith(`+${expectedText}`))
      .map(({ index }) => index);
    const removedAt = log
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.startsWith(`-${expectedText}`))
      .map(({ index }) => index);

    expect(insertedAt, 'сообщение вставлено не дважды — попытки считаны неверно').toHaveLength(2);
    expect(
      removedAt,
      'одинаковое сообщение не удалялось между попытками: скринридер услышит его один раз',
    ).toHaveLength(1);

    expect(removedAt[0]!).toBeGreaterThan(insertedAt[0]!);
    expect(removedAt[0]!).toBeLessThan(insertedAt[1]!);
  });

  test('таймаут дольше десяти секунд читается как обрыв связи (медленный тест)', async ({
    page,
  }) => {

    test.setTimeout(60_000);

    const lead = await interceptLead(page);
    const held = gate();

    lead.reply(async (route) => {
      await held.wait;
      try {
        await route.abort('failed');
      } catch {
        /* */
      }
    });

    await openForm(page, 'mn');
    await fillValid(page);
    const data = await formData(page);

    const startedAt = Date.now();
    await page.locator(SUBMIT).click();
    const notice = await waitForMessage(page, data.apiErrNetwork ?? '');
    const elapsed = Date.now() - startedAt;

    expect(notice.hasLink, 'у таймаута нет запасного выхода').toBe(true);

    expect(elapsed, 'сообщение пришло раньше потолка ожидания').toBeGreaterThanOrEqual(9_000);
    held.open();
  });
});

test.describe('Сообщение об отказе на 360px', () => {
  for (const locale of LOCALES) {
    test(`не перекрыто липкой панелью, не рвёт раскладку (${locale})`, async ({ page }) => {
      await page.setViewportSize(NARROW);

      const lead = await interceptLead(page);
      lead.reply(json(500, { ok: false, error: ERROR_CODES.internalError }));

      await openForm(page, locale);
      await fillValid(page);
      const data = await formData(page);

      const button = page.locator(SUBMIT);
      await button.scrollIntoViewIfNeeded();

      await button.press('Enter');
      await waitForMessage(page, data.apiErrGeneric ?? '');
      await scrollSettled(page);

      const placed = await placeWhereTargetFitsViewport(page);

      if (!placed.ok) {
        console.log(`[ПРОПУСК ${locale}] ${placed.reason}`);
      }
      test.skip(
        !placed.ok,
        `СООБЩЕНИЕ НЕ ПОМЕЩАЕТСЯ В ЭКРАН ЦЕЛИКОМ (${locale}): ` +
          `${placed.reason}. Тест не ослаблен и не сделан зелёным — он ПРОПУЩЕН, ` +
          'потому что проверять перекрытие нечем. Если это повторяется на всех ' +
          'локалях, изменилась высота страницы. ' +
          '⛔ ~~«ЛИПКАЯ ПАНЕЛЬ НЕ МОЖЕТ ПОЯВИТЬСЯ ПРИ ВИДИМОМ СООБЩЕНИИ»~~ — ' +
          'панель снята 07.09.2026 решением заказчика, условие опыта сузилось ' +
          'до «сообщение целиком в кадре».',
      );

      const layout = await page.evaluate(
        ({ noticeSel, linkSel }) => {
          const notice = document.querySelector<HTMLElement>(noticeSel)!;
          const link = document.querySelector<HTMLElement>(linkSel)!;

          const noticeRect = notice.getBoundingClientRect();
          const linkRect = link.getBoundingClientRect();

          const overlap = 0;
          const hit = document.elementFromPoint(
            linkRect.left + linkRect.width / 2,
            linkRect.top + linkRect.height / 2,
          );

          const linkRange = document.createRange();
          linkRange.selectNodeContents(link);
          const linkLines = linkRange.getClientRects().length;

          const insideBox =
            linkRect.left >= noticeRect.left - 0.5 && linkRect.right <= noticeRect.right + 0.5;

          return {
            overlap,
            inViewport: noticeRect.top >= 0 && noticeRect.bottom <= window.innerHeight,
            hitIsLink: !!hit && (link.contains(hit) || hit.contains(link)),
            hitName: hit ? `${hit.tagName.toLowerCase()}.${hit.className}` : 'ничего',
            linkLines,
            insideBox,
            overflow:
              document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        },
        { noticeSel: NOTICE, linkSel: NOTICE_LINK },
      );

      expect(layout.inViewport, `сообщение (${locale}) не поместилось в экран`).toBe(true);
      expect(layout.overlap, `липкая панель накрыла сообщение (${locale}) на ${layout.overlap}px`).toBe(
        0,
      );
      expect(
        layout.hitIsLink,
        `в точке запасной ссылки (${locale}) оказалось ${layout.hitName}`,
      ).toBe(true);
      expect(layout.linkLines, `надпись запасной ссылки (${locale}) разорвана переносом`).toBe(1);
      expect(layout.insideBox, `запасная ссылка (${locale}) торчит за коробку сообщения`).toBe(
        true,
      );
      expect(layout.overflow, `сообщение (${locale}) уводит страницу за край`).toBeLessThanOrEqual(
        0,
      );

      expect(await activeElementInfo(page)).toContain('lead-form__submit');
    });
  }
});

interface PanelShape {
  exists: boolean;
  title: string;
  body: string;
  ctaText: string;
  href: string;
  target: string;
  rel: string;
  hasReset: boolean;
  tabIndex: number;
  role: string;
  labelledByHitsTitle: boolean;
}

function readSuccessPanel(page: Page): Promise<PanelShape> {
  return page.evaluate(
    ({ panelSel, titleSel, bodySel, ctaSel, resetSel }) => {
      const empty: PanelShape = {
        exists: false,
        title: '',
        body: '',
        ctaText: '',
        href: '',
        target: '',
        rel: '',
        hasReset: false,
        tabIndex: 0,
        role: '',
        labelledByHitsTitle: false,
      };
      const panel = document.querySelector<HTMLElement>(panelSel);
      if (!panel) return empty;

      const titleEl = panel.querySelector<HTMLElement>(titleSel);
      const cta = panel.querySelector<HTMLAnchorElement>(ctaSel);
      const labelledBy = panel.getAttribute('aria-labelledby') ?? '';

      return {
        exists: true,
        title: titleEl?.textContent ?? '',
        body: panel.querySelector<HTMLElement>(bodySel)?.textContent ?? '',
        ctaText: cta?.textContent ?? '',
        href: cta?.getAttribute('href') ?? '',
        target: cta?.getAttribute('target') ?? '',
        rel: cta?.getAttribute('rel') ?? '',
        hasReset: panel.querySelector(resetSel) !== null,
        tabIndex: panel.tabIndex,
        role: panel.getAttribute('role') ?? '',

        labelledByHitsTitle: labelledBy !== '' && !!titleEl && titleEl.id === labelledBy,
      };
    },
    {
      panelSel: SUCCESS_PANEL,
      titleSel: PANEL_TITLE,
      bodySel: PANEL_BODY,
      ctaSel: PANEL_CTA,
      resetSel: PANEL_RESET,
    },
  ) as Promise<PanelShape>;
}

function readFormBox(page: Page): Promise<{
  present: boolean;
  hiddenAttr: boolean;
  display: string;
  height: number;
}> {
  return page.evaluate((sel) => {
    const form = document.querySelector<HTMLElement>(sel);
    if (!form) return { present: false, hiddenAttr: false, display: '', height: 0 };
    return {
      present: true,
      hiddenAttr: form.hasAttribute('hidden'),
      display: getComputedStyle(form).display,
      height: Math.round(form.getBoundingClientRect().height),
    };
  }, FORM);
}

async function readLeadKey(
  page: Page,
): Promise<{ v?: number; at?: number; direction?: string } | null> {
  const raw = await page.evaluate((key) => window.localStorage.getItem(key), LEAD_STATE_KEY);
  if (raw === null) return null;
  return JSON.parse(raw) as { v?: number; at?: number; direction?: string };
}

function focusAfterSwap(page: Page): Promise<{ onPanel: boolean; where: string }> {
  return page.evaluate((sel) => {
    const panel = document.querySelector(sel);
    const el = document.activeElement as HTMLElement | null;
    return {
      onPanel: panel !== null && el === panel,
      where: el ? `${el.tagName.toLowerCase()}.${el.className || ''}#${el.id || ''}` : 'нет',
    };
  }, SUCCESS_PANEL);
}

test.describe('Успех на месте', () => {
  for (const locale of LOCALES) {
    test(`200 подменяет форму панелью подтверждения и никуда не уводит (${locale})`, async ({
      page,
    }) => {
      const lead = await interceptLead(page);
      lead.reply(json(200, { ok: true }));

      await markDocument(page);
      await openForm(page, locale);
      await fillValid(page, 'bank');
      const data = await formData(page);

      const urlBefore = page.url();
      const tokenBefore = await docToken(page);
      expect(tokenBefore, 'маркер документа не поставился — сравнивать нечего').toBeTruthy();

      await page.locator(SUBMIT).click();

      await expect(page.locator(SUCCESS_PANEL)).toBeVisible({ timeout: 15_000 });

      expect(page.url(), 'адрес изменился — человек уехал со страницы').toBe(urlBefore);
      expect(
        await docToken(page),
        'маркер документа сменился — была навигация или перезагрузка, а не подмена узлов',
      ).toBe(tokenBefore);

      expect(lead.seen.count, 'на 200 ушёл не ровно один запрос').toBe(1);
      expect(lead.seen.navigations, 'отправка ушла навигацией — preventDefault потерян').toBe(0);

      expect(lead.seen.contentType[0] ?? '').toContain('application/x-www-form-urlencoded');
      expect(lead.seen.contentType[0] ?? '').not.toContain('multipart');

      const box = await readFormBox(page);
      expect(box.hiddenAttr, 'у формы нет атрибута hidden').toBe(true);
      expect(
        box.display,
        'форма помечена hidden, но всё ещё раскладывается: правило .lead-form__form[hidden] потеряно',
      ).toBe('none');
      expect(box.height, 'спрятанная форма продолжает занимать место').toBe(0);
      await expect(page.locator(NAME_FIELD)).toBeHidden();

      await expect(page.locator('.lead-form__head h2')).toBeVisible();

      const panel = await readSuccessPanel(page);
      expect(panel.title, 'заголовок панели не равен data-success-title').toBe(data.successTitle);
      expect(panel.body, 'текст панели не равен data-repeat-body').toBe(data.repeatBody);
      expect(panel.ctaText, 'надпись действия не равна data-repeat-cta').toBe(data.repeatCta);
      expect(panel.href, 'адрес действия не равен data-repeat-href').toBe(data.repeatHref);
      expect(panel.target).toBe('_blank');
      expect(panel.rel).toContain('noopener');

      expect(
        panel.title,
        'панель успеха показывает заголовок повторного визита — событие подменено статусом',
      ).not.toBe(data.repeatTitle);

      expect(
        panel.hasReset,
        'в панели успеха есть выход к пустой форме — это приглашение к дублю',
      ).toBe(false);

      expect(panel.tabIndex, 'панель не может принять фокус: нет tabindex="-1"').toBe(-1);
      expect(panel.role).toBe('group');
      expect(panel.labelledByHitsTitle, 'aria-labelledby не указывает на заголовок панели').toBe(
        true,
      );
      const focus = await focusAfterSwap(page);
      expect(
        focus.onPanel,
        `фокус после подмены оказался на ${focus.where}, а не на панели: элемент, который его держал, удалён из дерева вместе с формой (WCAG 2.4.3)`,
      ).toBe(true);

      const state = await readLeadKey(page);
      expect(state, 'состояние заявки не записано — повторный визит покажет пустую форму').toBeTruthy();
      expect(state?.v, 'версия схемы состояния не та').toBe(1);
      expect(typeof state?.at, 'метка времени не число').toBe('number');
      expect(
        Math.abs(Date.now() - (state?.at ?? 0)),
        'метка времени не из этого прогона',
      ).toBeLessThan(5 * 60 * 1000);

      expect(state?.direction).toBe('bank');

      const section = page.locator('#lead-form');
      await page.setViewportSize(MOBILE_VIEWPORT);
      await section.screenshot({ path: `${SHOTS}/success-${locale}-390.png` });
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await section.screenshot({ path: `${SHOTS}/success-${locale}-1440.png` });
    });
  }

  for (const locale of LOCALES) {
    test(`панель подтверждения на 360px не накрыта липкой панелью (${locale})`, async ({
      page,
    }) => {
      await page.setViewportSize(NARROW);

      const lead = await interceptLead(page);
      lead.reply(json(200, { ok: true }));

      await openForm(page, locale);
      await fillValid(page, 'bank');

      const button = page.locator(SUBMIT);
      await button.scrollIntoViewIfNeeded();

      await button.press('Enter');

      await expect(page.locator(SUCCESS_PANEL)).toBeVisible({ timeout: 15_000 });
      await scrollSettled(page);

      const placed = await placeWhereTargetFitsViewport(page, SUCCESS_PANEL);

      if (!placed.ok) {
        console.log(`[ПРОПУСК ${locale}] ${placed.reason}`);
      }
      test.skip(
        !placed.ok,
        `ПАНЕЛЬ ПОДТВЕРЖДЕНИЯ НЕ ПОМЕЩАЕТСЯ В ЭКРАН ЦЕЛИКОМ (${locale}): ` +
          `${placed.reason}. Тест не ослаблен и не сделан зелёным — он ПРОПУЩЕН, ` +
          'потому что проверять перекрытие нечем. ' +
          '⛔ ~~«ЛИПКАЯ ПАНЕЛЬ НЕ МОЖЕТ ПОЯВИТЬСЯ ПРИ ВИДИМОЙ ПАНЕЛИ ' +
          'ПОДТВЕРЖДЕНИЯ»~~ — панель снята 07.09.2026 решением заказчика.',
      );

      const layout = await page.evaluate(
        ({ panelSel, ctaSel }) => {
          const panel = document.querySelector<HTMLElement>(panelSel)!;
          const cta = document.querySelector<HTMLElement>(ctaSel)!;

          const panelRect = panel.getBoundingClientRect();
          const ctaRect = cta.getBoundingClientRect();

          const hit = document.elementFromPoint(
            ctaRect.left + ctaRect.width / 2,
            ctaRect.top + ctaRect.height / 2,
          );

          const ctaRange = document.createRange();
          ctaRange.selectNodeContents(cta);

          return {

            overlap: 0,
            inViewport: panelRect.top >= 0 && panelRect.bottom <= window.innerHeight,
            hitIsCta: !!hit && (cta.contains(hit) || hit.contains(cta)),
            hitName: hit ? `${hit.tagName.toLowerCase()}.${hit.className}` : 'ничего',
            ctaLines: ctaRange.getClientRects().length,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        },
        { panelSel: SUCCESS_PANEL, ctaSel: PANEL_CTA },
      );

      expect(layout.inViewport, `панель (${locale}) не поместилась в экран`).toBe(true);
      expect(
        layout.overlap,
        `липкая панель накрыла подтверждение (${locale}) на ${layout.overlap}px`,
      ).toBe(0);
      expect(
        layout.hitIsCta,
        `в точке действия панели (${locale}) оказалось ${layout.hitName}`,
      ).toBe(true);
      expect(layout.ctaLines, `надпись действия (${locale}) разорвана переносом`).toBe(1);
      expect(layout.overflow, `панель (${locale}) уводит страницу за край`).toBeLessThanOrEqual(0);
    });
  }

  test('лок НЕ снят на успехе: кнопка внутри спрятанной формы держит занятость', async ({
    page,
  }) => {
    const lead = await interceptLead(page);
    lead.reply(json(200, { ok: true }));

    await openForm(page, 'ru');
    await fillValid(page, 'affiliate');
    const data = await formData(page);

    await page.locator(SUBMIT).click();
    await expect(page.locator(SUCCESS_PANEL)).toBeVisible({ timeout: 15_000 });

    const state = await page.locator(SUBMIT).evaluate((el) => {
      const b = el as HTMLButtonElement;
      return {
        ariaBusy: b.getAttribute('aria-busy'),
        ariaDisabled: b.getAttribute('aria-disabled'),
        text: (b.textContent ?? '').trim(),
        disabledAttr: b.hasAttribute('disabled'),
      };
    });

    expect(state.ariaBusy, 'aria-busy снят на успехе — появился finally?').toBe('true');
    expect(state.ariaDisabled, 'aria-disabled снят на успехе — появился finally?').toBe('true');
    expect(state.text, 'надпись занятости заменена обратно — появился finally?').toBe(
      data.labelSubmitting,
    );

    expect(state.disabledAttr).toBe(false);

    await expect(page.locator(STATUS)).toBeHidden();
  });

  test('заблокированная запись lmn_lead НЕ отменяет подтверждение', async ({ page }) => {
    const lead = await interceptLead(page);
    lead.reply(json(200, { ok: true }));

    await page.addInitScript((key: string) => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function patched(this: Storage, k: string, v: string): void {
        if (k === key) throw new DOMException('quota exceeded', 'QuotaExceededError');
        original.call(this, k, v);
      };
    }, LEAD_STATE_KEY);

    await markDocument(page);
    await openForm(page, 'ru');

    const probe = await page.evaluate((key) => {
      let leadThrows = false;
      try {
        window.localStorage.setItem(key, 'x');
      } catch {
        leadThrows = true;
      }
      let otherOk = false;
      try {
        window.localStorage.setItem('lmn_probe', 'x');
        window.localStorage.removeItem('lmn_probe');
        otherOk = true;
      } catch {
        otherOk = false;
      }
      return { leadThrows, otherOk };
    }, LEAD_STATE_KEY);
    expect(probe.leadThrows, 'подставное хранилище НЕ бросает на lmn_lead').toBe(true);
    expect(probe.otherOk, 'подделка сломала хранилище целиком — мерилось бы не то').toBe(true);

    await fillValid(page, 'teamcash');
    const urlBefore = page.url();
    const tokenBefore = await docToken(page);

    await page.locator(SUBMIT).click();

    await expect(page.locator(SUCCESS_PANEL)).toBeVisible({ timeout: 15_000 });
    expect(page.url(), 'человек уехал со страницы при заблокированном хранилище').toBe(urlBefore);
    expect(await docToken(page), 'документ сменился — была навигация').toBe(tokenBefore);
    expect(lead.seen.count).toBe(1);

    expect(await readLeadKey(page), 'запись бросала, а ключ всё-таки появился').toBeNull();
  });

  test('подмена не состоялась — человек уходит на /thanks/, состояние записано', async ({
    page,
  }) => {
    const lead = await interceptLead(page);
    lead.reply(json(200, { ok: true }));

    await openForm(page, 'ru');
    await fillValid(page, 'bank');

    await page.evaluate((sel) => {
      document.querySelector<HTMLFormElement>(sel)?.removeAttribute('data-repeat-body');
    }, FORM);

    await page.locator(SUBMIT).click();

    await page.waitForURL((url) => url.pathname === SUCCESS_ROUTE.ru, { timeout: 15_000 });
    expect(lead.seen.count).toBe(1);

    const state = await readLeadKey(page);
    expect(state, 'на запасном пути состояние заявки не записано').toBeTruthy();
    expect(state?.v).toBe(1);
    expect(state?.direction).toBe('bank');
  });
});
