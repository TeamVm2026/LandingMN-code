
import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT } from '../playwright.config';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';
import { buildContactHref } from '../src/lib/start-link';
import { decodeStart, DIRECTIONS, LOCALES } from '../src/lib/start-codec';
import { envValue } from '../scripts/lib/env-value';

const LOCALES_UNDER_TEST: Locale[] = ['mn', 'ru', 'en'];

const TG_CONTACT_URL = envValue('PUBLIC_TG_CONTACT_URL');
const TG_BOT_URL = envValue('PUBLIC_TG_BOT_URL');

const TELEGRAM_CTA = '.contact-btn--telegram';

const FALLBACK_HREF_ATTRS = ['data-repeat-href', 'data-api-fallback-href'] as const;

test.describe('Ссылки работают без JS', () => {
  test.use({ javaScriptEnabled: false });

  for (const locale of LOCALES_UNDER_TEST) {
    test(`каждая Telegram-кнопка имеет рабочий href при выключенном JS (${locale})`, async ({ page }) => {
      await page.goto(PAGE_ROUTES.home[locale]);

      const hrefs = await page.locator(TELEGRAM_CTA).evaluateAll((els) =>
        els.map((el) => el.getAttribute('href')),
      );

      expect(hrefs.length, 'на странице не нашлось ни одной конверсионной кнопки').toBeGreaterThan(0);

      for (const href of hrefs) {
        expect(href, 'у кнопки нет атрибута href — значит адрес дописывается скриптом').toBeTruthy();

        const url = new URL(href!);
        expect(url.protocol).toBe('https:');
        expect(['t.me', 'telegram.me']).toContain(url.hostname);
      }
    });
  }
});

test.describe('Пока адрес бота пуст, поведение не изменилось ни на байт', () => {
  test.skip(TG_BOT_URL !== '', 'PUBLIC_TG_BOT_URL заполнен — проверка относится к состоянию до Фазы 6');

  for (const locale of LOCALES_UNDER_TEST) {
    test(`href равен PUBLIC_TG_CONTACT_URL и не несёт ?start= (${locale})`, async ({ page }) => {
      await page.goto(PAGE_ROUTES.home[locale]);

      const hrefs = await page.locator(TELEGRAM_CTA).evaluateAll((els) =>
        els.map((el) => el.getAttribute('href')),
      );
      expect(hrefs.length).toBeGreaterThan(0);

      for (const href of hrefs) {

        expect(href, `${href} несёт ?start=, хотя бота ещё нет`).not.toContain('start=');
        expect(href).toBe(TG_CONTACT_URL);
      }
    });
  }
});

test.describe('Адрес бота задан — каждая кнопка несёт метку', () => {
  test.skip(TG_BOT_URL === '', 'PUBLIC_TG_BOT_URL пуст — бот ещё не включён, работает набор выше');

  for (const locale of LOCALES_UNDER_TEST) {
    test(`каждая конверсионная кнопка ведёт на бота с разбираемой меткой (${locale})`, async ({
      page,
    }) => {
      await page.goto(PAGE_ROUTES.home[locale]);

      const buttons = await page.locator(TELEGRAM_CTA).evaluateAll((els) =>
        els.map((el) => ({
          href: el.getAttribute('href'),

          program: el.getAttribute('data-program') ?? 'none',
          placement: el.getAttribute('data-track-placement') ?? '(без placement)',
        })),
      );

      expect(buttons.length, 'на странице не нашлось ни одной конверсионной кнопки').toBeGreaterThan(0);

      for (const { href, program, placement } of buttons) {
        const where = `${placement}/${program}`;

        expect(href, `${where}: у кнопки нет href`).toBeTruthy();
        expect(
          href!.startsWith(`${TG_BOT_URL}?start=`),
          `${where}: ссылка ведёт не на бота или потеряла метку — ${href}`,
        ).toBe(true);

        const raw = new URL(href!).searchParams.get('start');
        expect(raw, `${where}: у ссылки нет параметра start`).toBeTruthy();

        const decoded = decodeStart(raw!);
        expect(decoded, `${where}: метка «${raw}» не разбирается собственным кодеком`).not.toBeNull();
        expect(decoded!.locale, `${where}: локаль метки разошлась с локалью страницы`).toBe(locale);
        expect(decoded!.direction, `${where}: направление метки разошлось с data-program`).toBe(
          program,
        );

        expect(decoded!.source, `${where}: сборка дописала источник`).toBe('');
        expect(decoded!.campaign, `${where}: сборка дописала кампанию`).toBe('');
      }
    });

    test(`ссылки на живого менеджера метку НЕ несут (${locale})`, async ({ page }) => {

      for (const route of [PAGE_ROUTES.home[locale], PAGE_ROUTES.privacy[locale]]) {
        await page.goto(route);

        const strays = await page
          .locator(`a[href*="t.me"]:not(${TELEGRAM_CTA.split(', ').join('):not(')})`)
          .evaluateAll((els) => els.map((el) => el.getAttribute('href')));

        expect(strays.length, `${route}: не нашлось ни одной ссылки на менеджера`).toBeGreaterThan(0);

        for (const href of strays) {
          expect(href, `${route}: ссылка на человека несёт метку — ${href}`).not.toContain('start=');
          expect(href, `${route}: ссылка на человека ведёт не на менеджера`).toBe(TG_CONTACT_URL);
        }
      }
    });

    test(`запасные пути формы несут метку с направлением none (${locale})`, async ({ page }) => {
      await page.goto(PAGE_ROUTES.home[locale]);

      for (const attr of FALLBACK_HREF_ATTRS) {
        const href = await page.locator(`[${attr}]`).first().getAttribute(attr);
        expect(href, `${attr} отсутствует на форме`).toBeTruthy();

        expect(
          href!.startsWith(`${TG_BOT_URL}?start=`),
          `${attr}: запасной путь ведёт не на бота — ${href}`,
        ).toBe(true);

        const decoded = decodeStart(new URL(href!).searchParams.get('start') ?? '');
        expect(decoded, `${attr}: метка не разбирается кодеком`).not.toBeNull();
        expect(decoded!.locale, `${attr}: не та локаль`).toBe(locale);

        expect(decoded!.direction, `${attr}: направление обязано быть none`).toBe('none');
      }
    });
  }

  test('метки трёх локалей различаются между собой', async ({ page }) => {

    const seen = new Set<string>();

    for (const locale of LOCALES_UNDER_TEST) {
      await page.goto(PAGE_ROUTES.home[locale]);
      const href = await page.locator('.contact-btn--telegram').first().getAttribute('href');
      const raw = new URL(href!).searchParams.get('start') ?? '';
      seen.add(raw);
    }

    expect(seen.size, `три локали отдали неразличимые метки: ${[...seen].join(', ')}`).toBe(3);
  });
});

test.describe('Паритет локалей', () => {
  test('число кнопок и набор направлений совпадают на mn/ru/en', async ({ page }) => {

    const snapshots: Record<string, { count: number; programs: string[] }> = {};

    for (const locale of LOCALES_UNDER_TEST) {
      await page.goto(PAGE_ROUTES.home[locale]);
      const programs = await page.locator('.contact-btn--telegram').evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-program') ?? 'none'),
      );
      snapshots[locale] = { count: programs.length, programs: [...programs].sort() };
    }

    const reference = snapshots.mn!;
    expect(reference.count, 'на монгольской странице нет кнопок связи').toBeGreaterThan(0);

    for (const locale of ['ru', 'en'] as const) {
      expect(snapshots[locale]!.count, `${locale}: другое число Telegram-кнопок`).toBe(reference.count);
      expect(snapshots[locale]!.programs, `${locale}: другой набор направлений`).toEqual(
        reference.programs,
      );
    }
  });
});

test.describe('Метка собирается настоящим кодеком', () => {

  test('страница объявляет ровно ожидаемый набор направлений статикой', async ({ page }) => {
    for (const locale of LOCALES_UNDER_TEST) {
      await page.goto(PAGE_ROUTES.home[locale]);
      const programs = await page.locator(TELEGRAM_CTA).evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-program') ?? 'none'),
      );
      expect(programs.length, `${locale}: конверсионных кнопок не нашлось`).toBeGreaterThan(0);
      const declared = [...new Set(programs)].sort();
      expect(
        declared,
        `${locale}: статический набор направлений страницы разошёлся с Д-12 — ` +
          'ожидалось ровно {none}; появление affiliate/bank/teamcash в статике ' +
          'означает возврат кнопок в карточки и обязано быть решением, а не случайностью',
      ).toEqual(['none']);
    }
  });

  test('payload с направлением и локалью разбирается обратно', async () => {

    const directions = ['affiliate', 'bank', 'teamcash', 'none'] as const;

    const botUrl = 'https://t.me/melbet_mn_bot';

    for (const locale of LOCALES_UNDER_TEST) {
      for (const direction of directions) {
        const href = buildContactHref({
          botUrl,
          fallbackUrl: TG_CONTACT_URL,
          direction,
          locale,
        });

        expect(href.startsWith(`${botUrl}?start=`), `неожиданный вид ссылки: ${href}`).toBe(true);

        const payload = decodeURIComponent(new URL(href).searchParams.get('start') ?? '');
        const decoded = decodeStart(payload);

        expect(decoded, `метка «${payload}» не разбирается собственным кодеком`).not.toBeNull();
        expect(decoded!.direction, `метка ${payload}: не то направление`).toBe(direction);
        expect(decoded!.locale, `метка ${payload}: не та локаль`).toBe(locale);

        expect(decoded!.source).toBe('');
        expect(decoded!.campaign).toBe('');

        expect(payload).toContain(`_${DIRECTIONS[direction]}_${LOCALES[locale]}`);
      }
    }
  });

  test('пустой адрес бота возвращает прежнюю ссылку байт в байт', async () => {
    const href = buildContactHref({
      botUrl: '',
      fallbackUrl: TG_CONTACT_URL,
      direction: 'affiliate',
      locale: 'mn',
    });
    expect(href).toBe(TG_CONTACT_URL);
  });

  test('адрес бота не на t.me валит сборку, а не уезжает тихо в рекламу', () => {

    for (const bad of ['https://example.com/bot', 'javascript:alert(1)', 'не адрес']) {
      expect(
        () => buildContactHref({ botUrl: bad, fallbackUrl: TG_CONTACT_URL, direction: 'none', locale: 'mn' }),
        `«${bad}» принят как адрес бота`,
      ).toThrow();
    }
  });
});

test.describe('Подхвата направления нет — Д-13 отменён 07.09.2026', () => {
  test.skip(TG_BOT_URL === '', 'PUBLIC_TG_BOT_URL пуст — метки ?start= нет, подхватывать нечего');

  const directionOf = (raw: string | null): string => {
    expect(raw, 'у ссылки нет метки ?start=').toBeTruthy();
    const decoded = decodeStart(raw!);
    expect(decoded, `метка «${raw}» не разбирается собственным кодеком`).not.toBeNull();
    return decoded!.direction;
  };

  const snapshot = (page: import('@playwright/test').Page) =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="t.me"]')).map((el) => ({
        href: el.href,
        program: el.dataset.program ?? null,
      })),
    );

  for (const locale of LOCALES_UNDER_TEST) {

    for (const [width, height, label] of [
      [390, 844, 'телефон'],
      [1440, 900, 'десктоп'],
    ] as const) {
      test(`раскрытие карточек не трогает ни один якорь (${locale}, ${label} ${width})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await page.goto(PAGE_ROUTES.home[locale]);

        await expect(page.locator('#lead-contact')).toHaveJSProperty('inputMode', 'tel');

        await expect(page.locator('.sticky-cta')).toHaveCount(0);

        const summaries = {
          bank: page.locator('details[data-track-direction="bank"] > summary'),
          teamcash: page.locator('details[data-track-direction="teamcash"] > summary'),
        };
        const klik = (loc: import('@playwright/test').Locator) =>
          loc.evaluate((el) => (el as HTMLElement).click());

        const before = await snapshot(page);

        const withStart = before.filter((l) => l.href.includes('?start='));
        expect(
          withStart.length,
          'на странице нет ни одной ссылки с меткой — подхватывать было бы нечего в любом случае',
        ).toBeGreaterThan(0);
        for (const l of withStart) {
          expect(
            directionOf(new URL(l.href).searchParams.get('start')),
            'статика несёт направление — метка собрана неправильно ещё на сборке',
          ).toBe('none');
          expect(l.program, 'у статики есть data-program').toBeNull();
        }

        await klik(summaries.bank);
        await expect(page.locator('details[data-track-direction="bank"][open]')).toHaveCount(1);
        await page.waitForTimeout(400);
        expect(await snapshot(page), 'раскрытие bank переписало якорь').toEqual(before);

        await klik(summaries.teamcash);
        await page.waitForTimeout(400);
        expect(await snapshot(page), 'раскрытие teamcash переписало якорь').toEqual(before);

        await klik(summaries.teamcash);
        await page.waitForTimeout(400);
        expect(await snapshot(page), 'закрытие teamcash переписало якорь').toEqual(before);

        await klik(summaries.bank);
        await page.waitForTimeout(400);
        expect(await snapshot(page), 'закрытие всех карточек переписало якорь').toEqual(before);
      });
    }
  }

  test('messenger_click несёт direction=none и метку без направления', async ({ page, context }) => {

    await context.route('**/t.me/**', (route) => route.fulfill({ status: 200, body: 'ok' }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${PAGE_ROUTES.home.mn}?__sink=1`);
    await expect(page.locator('#lead-contact')).toHaveJSProperty('inputMode', 'tel');

    await page.locator('details[data-track-direction="bank"] > summary').click();
    await expect(page.locator('details[data-track-direction="bank"][open]')).toHaveCount(1);
    await page.waitForTimeout(400);

    const tg = page.locator('.spine-actions a.contact-btn--telegram').first();
    await tg.scrollIntoViewIfNeeded();
    await tg.click();

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            ((window as unknown as { __lmnEvents?: { name: string }[] }).__lmnEvents ?? []).filter(
              (e) => e.name === 'messenger_click',
            ).length,
        ),
      )
      .toBeGreaterThan(0);
    const event = await page.evaluate(
      () =>
        ((
          window as unknown as {
            __lmnEvents?: { name: string; params: Record<string, string | undefined> }[];
          }
        ).__lmnEvents ?? []).find((e) => e.name === 'messenger_click')!,
    );

    expect(
      event.params.direction,
      'событие несёт направление — подхват вернулся вопреки решению 07.09.2026',
    ).toBe('none');
    const decodedPayload = decodeStart(event.params.start_payload ?? '');
    expect(decodedPayload, 'start_payload события не разбирается кодеком').not.toBeNull();
    expect(
      decodedPayload!.direction,
      `событие противоречит само себе: direction=${event.params.direction}, start_payload несёт ${decodedPayload!.direction}`,
    ).toBe('none');
  });

  test.describe('без JS страница работает — и метка та же, что с JS', () => {

    test.use({ javaScriptEnabled: false, viewport: MOBILE_VIEWPORT });

    test('карточка раскрывается, ссылки рабочие, метка 1__x_* (mn)', async ({ page }) => {
      await page.goto(PAGE_ROUTES.home.mn, { waitUntil: 'domcontentloaded' });

      await page.locator('details[data-track-direction="bank"] > summary').click();
      await expect(page.locator('details[data-track-direction="bank"][open]')).toHaveCount(1);

      const hrefs = await page
        .locator('.hero-actions a.contact-btn--telegram, .spine-actions a.contact-btn--telegram')
        .evaluateAll((els) => els.map((el) => el.getAttribute('href')));
      expect(hrefs.length, 'ни одной постоянной точки связи не нашлось').toBeGreaterThan(0);

      for (const href of hrefs) {
        expect(href, 'у точки связи нет href — ссылка держится на JS').toBeTruthy();
        const decoded = decodeStart(new URL(href!).searchParams.get('start') ?? '');
        expect(decoded, 'метка не разбирается кодеком').not.toBeNull();
        expect(decoded!.direction, 'метка не имеет права нести направление').toBe('none');
      }
    });
  });
});
