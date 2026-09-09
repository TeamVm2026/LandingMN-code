
import { test, expect } from '@playwright/test';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { analyticsOriginsInBuild } from './lib/analytics-origins';

const LOCALES: Locale[] = ['mn', 'ru', 'en'];

test.describe('How-to-start steps -- LAND-05', () => {
  test('exactly 3 spine steps, each with non-empty body, and a concrete timeframe present', async ({
    page,
  }) => {
    await page.goto(PAGE_ROUTES.home.mn);
    const cards = page.locator('.spine-step');
    await expect(cards).toHaveCount(3);

    await expect(page.locator('ol.spine')).toHaveCount(1);

    const bodies: string[] = [];
    for (let i = 0; i < 3; i++) {
      const title = (await cards.nth(i).locator('.spine-title').innerText()).trim();
      const body = (await cards.nth(i).locator('.spine-text').innerText()).trim();
      expect(title.length).toBeGreaterThan(0);
      expect(body.length).toBeGreaterThan(0);
      bodies.push(body);
    }

    const hasConcreteTimeframe = bodies.some((b) => /\d{1,2}:\d{2}/.test(b));
    expect(hasConcreteTimeframe).toBe(true);
  });

  test('пара кнопок связи стоит РОВНО в первом шаге и ни в одном другом', async ({ page }) => {
    for (const locale of LOCALES) {
      await page.goto(PAGE_ROUTES.home[locale]);
      const steps = page.locator('.spine-step');
      await expect(steps).toHaveCount(3);

      await expect(page.locator('.how-to-start .contact-actions')).toHaveCount(1);
      await expect(steps.nth(0).locator('.contact-actions')).toHaveCount(1);
      await expect(steps.nth(1).locator('.contact-actions')).toHaveCount(0);
      await expect(steps.nth(2).locator('.contact-actions')).toHaveCount(0);

      const pair = steps
        .nth(0)
        .locator('.contact-actions a[data-track="messenger_click"]');
      await expect(pair).toHaveCount(2);
      const placements = await pair.evaluateAll((els) =>
        els.map((el) => (el as HTMLElement).dataset.trackPlacement ?? ''),
      );
      expect(placements, `${locale}: место пары шага 1 не steps`).toEqual([
        'steps',
        'steps',
      ]);
    }
  });
});

test.describe('Trust facts -- LAND-06', () => {
  test('блока «Коротко о программе» на странице нет, счётчиков тоже', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.mn);

    await expect(page.locator('.trust-facts')).toHaveCount(0);
    await expect(page.locator('.trust-fact')).toHaveCount(0);
    await expect(page.locator('#trust-title')).toHaveCount(0);

    await expect(page.locator('.trust-faq .trust-faq-accordion')).toHaveCount(1);

    const counterLike = page.locator('[class*="counter" i], [class*="odometer" i], [data-counter]');
    await expect(counterLike).toHaveCount(0);
  });
});

test.describe('Footer -- LAND-08', () => {
  for (const locale of LOCALES) {

    test(`social icons, no WhatsApp, один бейдж 18+, юридическая строка, privacy link (${locale})`, async ({
      page,
    }) => {
      await page.goto(PAGE_ROUTES.home[locale]);

      const socialIcons = page.locator('.site-footer__social .site-footer__icon');
      await expect(socialIcons).toHaveCount(1);

      const telegramIcon = page.locator('.site-footer__icon', { hasText: 'Telegram' });
      await expect(telegramIcon).toHaveCount(1);
      await expect(telegramIcon).toBeVisible();

      await expect(page.locator('.site-footer .site-footer__icon', { hasText: 'Messenger' })).toHaveCount(0);
      expect(
        await page.locator('.site-footer').evaluate((el) => el.innerHTML.includes('m.me')),
        'адрес Messenger вернулся в подвал',
      ).toBe(false);

      await expect(page.locator('.site-footer .site-footer__icon')).toHaveCount(3);

      const brandChannelLinks = page.locator('.site-footer__channels a.site-footer__icon');
      await expect(brandChannelLinks).toHaveCount(2);

      const expectedBrandChannelUrls = {
        facebook: 'https://facebook.com/worldcuplivemongoliaa',
        instagram: 'https://www.instagram.com/melbet_mongolia_official',
      };
      const facebookChannelLink = page.locator('.site-footer__channels a.site-footer__icon', {
        hasText: 'Facebook',
      });
      const instagramChannelLink = page.locator('.site-footer__channels a.site-footer__icon', {
        hasText: 'Instagram',
      });
      await expect(facebookChannelLink).toHaveCount(1);
      await expect(instagramChannelLink).toHaveCount(1);
      expect(await facebookChannelLink.getAttribute('href')).toBe(expectedBrandChannelUrls.facebook);
      expect(await instagramChannelLink.getAttribute('href')).toBe(expectedBrandChannelUrls.instagram);

      for (const link of [facebookChannelLink, instagramChannelLink]) {
        const href = await link.getAttribute('href');
        expect(href).not.toContain('utm_source=qr');
      }

      const telegramContactText = (await telegramIcon.innerText()).trim();
      const brandChannelTexts = await brandChannelLinks.allInnerTexts();
      for (const text of brandChannelTexts) {
        expect(text.trim()).not.toBe(telegramContactText);
      }

      const whatsappCount = await page.locator('body').evaluate((body) => {
        const html = body.innerHTML;
        const matches = html.match(/WhatsApp|whatsapp/gi);
        return matches ? matches.length : 0;
      });
      expect(whatsappCount).toBe(0);

      const ageBadge = page.locator('.site-footer__badge');
      await expect(ageBadge).toHaveCount(1);
      expect((await ageBadge.innerText()).trim()).toContain('18');

      const ageMentions = await page.locator('.site-footer').evaluate((footer) => {
        const matches = (footer as HTMLElement).innerText.match(/18\s*\+/g);
        return matches ? matches.length : 0;
      });
      expect(ageMentions).toBe(1);

      const legalParagraphs = page.locator('.site-footer__legal p');
      const legalCount = await legalParagraphs.count();
      expect(legalCount).toBeGreaterThanOrEqual(1);
      let hasLegalText = false;
      for (let i = 0; i < legalCount; i++) {
        const text = (await legalParagraphs.nth(i).innerText()).trim();
        if (text.length > 0) hasLegalText = true;
      }
      expect(hasLegalText).toBe(true);

      const privacyLink = page.locator('.site-footer__privacy');
      await expect(privacyLink).toHaveCount(1);
      expect(await privacyLink.getAttribute('href')).toBe(PAGE_ROUTES.privacy[locale]);
    });
  }
});

const ALLOWED_ORIGINS = analyticsOriginsInBuild(path.join(import.meta.dirname, '..', 'dist'));

test.describe('Security Domain -- zero third-party network requests (all 3 locales)', () => {
  for (const locale of LOCALES) {
    test(`no cross-origin request fires on page load (${locale})`, async ({ page, baseURL }) => {
      const unexpected: string[] = [];

      const ownOrigin = new URL(baseURL ?? 'http://localhost:4321').origin;

      await page.route('**/*', async (route) => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.origin === ownOrigin) {
          await route.continue();
          return;
        }
        if (ALLOWED_ORIGINS.includes(requestUrl.origin)) {

          await route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
          return;
        }
        unexpected.push(requestUrl.href);
        await route.continue();
      });

      await page.goto(PAGE_ROUTES.home[locale]);
      await page.waitForLoadState('networkidle');

      expect(unexpected).toEqual([]);
    });
  }
});

test.describe('hreflang regression -- now that the full page is assembled', () => {
  for (const locale of LOCALES) {
    test(`exactly 4 alternate links (3 locales + x-default) on the landing page (${locale})`, async ({
      page,
    }) => {
      await page.goto(PAGE_ROUTES.home[locale]);
      const alternates = page.locator('link[rel="alternate"]');
      await expect(alternates).toHaveCount(4);

      const xDefault = page.locator('link[rel="alternate"][hreflang="x-default"]');
      await expect(xDefault).toHaveCount(1);

      const canonical = page.locator('link[rel="canonical"]');
      await expect(canonical).toHaveCount(1);
    });
  }
});

test.describe('Обещания направлений расходятся по существу -- D-02 (аудит Д-1)', () => {

  function normalizePromise(value: string): string {
    return value
      .toLowerCase()
      .replace(/[—–\-.,:;!?()«»"']/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  for (const locale of LOCALES) {
    test(`[${locale}] обещания Bank Transfer и TeamCash не сводятся друг к другу`, async () => {

      const dict = JSON.parse(
        readFileSync(path.join(import.meta.dirname, '..', 'src', 'i18n', `${locale}.json`), 'utf8'),
      ) as { cards: { bank: { audience: string }; teamcash: { audience: string } } };

      const bank = dict.cards.bank.audience;
      const teamcash = dict.cards.teamcash.audience;

      expect(bank.trim().length, `cards.bank.audience пуст в ${locale}`).toBeGreaterThan(0);
      expect(teamcash.trim().length, `cards.teamcash.audience пуст в ${locale}`).toBeGreaterThan(0);

      const a = normalizePromise(bank);
      const b = normalizePromise(teamcash);
      const pair = `\n  bank:     «${bank}»\n  teamcash: «${teamcash}»`;

      expect(a, `обещания направлений совпали дословно (${locale}):${pair}`).not.toBe(b);
      expect(
        a.includes(b) || b.includes(a),
        `одно обещание целиком содержится в другом (${locale}):${pair}`,
      ).toBe(false);

      const wordsA = new Set(a.split(' ').filter(Boolean));
      const wordsB = new Set(b.split(' ').filter(Boolean));
      const shared = [...wordsA].filter((w) => wordsB.has(w));
      const union = new Set([...wordsA, ...wordsB]);
      const ratio = shared.length / union.size;

      expect(
        ratio,
        `обещания направлений слишком похожи (${locale}): общих слов ` +
          `${shared.length} из ${union.size} = ${(ratio * 100).toFixed(1)}%, ` +
          `общие — ${JSON.stringify(shared)}${pair}`,
      ).toBeLessThan(0.5);
    });
  }

});

test.describe('Собранный документ — уникальность id (план 10-05)', () => {
  for (const locale of LOCALES) {
    test(`[${locale}] на главной нет ни одного дублирующегося id`, async ({ page }) => {
      await page.goto(PAGE_ROUTES.home[locale]);

      const ids = await page.evaluate(() =>
        [...document.querySelectorAll('[id]')].map((el) => el.id).filter((id) => id.length > 0),
      );

      expect(ids.length, 'в документе не нашлось ни одного id — выборка пуста').toBeGreaterThan(5);

      const seen = new Set<string>();
      const dupes = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) dupes.add(id);
        seen.add(id);
      }
      expect(
        [...dupes].sort(),
        `дублирующиеся id в собранном документе (${locale}) — типичная причина: ` +
          'идентификаторы clip0_/paint0_ из экспортированных SVG',
      ).toEqual([]);
    });
  }
});

test.describe('Инвентарь путей связи по местам и страницам', () => {

  const EXPECTED: { page: string; url: (l: Locale) => string; placements: string[] }[] = [
    {
      page: 'главная',
      url: (l) => PAGE_ROUTES.home[l],

      placements: ['hero', 'hero', 'steps', 'steps'],
    },
    { page: '/privacy/', url: (l) => PAGE_ROUTES.privacy[l], placements: [] },
    { page: '/thanks/', url: (l) => PAGE_ROUTES.thanks[l], placements: [] },
    { page: '/404', url: (l) => PAGE_ROUTES.notFound[l], placements: [] },
  ];

  for (const locale of LOCALES) {
    for (const { page: name, url, placements } of EXPECTED) {
      test(`${name} (${locale}): состав отслеживаемых точек связи`, async ({ page }) => {
        await page.goto(url(locale));

        const actual = await page
          .locator('a[data-track="messenger_click"]')
          .evaluateAll((els) =>
            els.map((el) => (el as HTMLElement).dataset.trackPlacement ?? '?').sort(),
          );

        expect(
          actual,
          `${name} (${locale}): состав точек связи разошёлся с объявленным. ` +
            'Появление места означает возврат кнопки, пропажа — её потерю; ' +
            'и то и другое обязано быть решением, а не случайностью',
        ).toEqual([...placements].sort());

        await expect(page.locator('.site-header')).toHaveCount(1);
        await expect(page.locator('h1')).toHaveCount(1);
      });
    }
  }

  test('на страницах политики и 404 остаётся ноль ОТСЛЕЖИВАЕМЫХ точек связи, и это решение', async ({
    page,
  }) => {

    for (const locale of LOCALES) {
      for (const url of [PAGE_ROUTES.privacy[locale], PAGE_ROUTES.notFound[locale]]) {
        await page.goto(url);
        await expect(page.locator('a[data-track="messenger_click"]')).toHaveCount(0);

        await expect(page.locator('.site-footer__social a')).toHaveCount(1);
        for (const href of await page
          .locator('.site-footer__social a')
          .evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).href))) {
          expect(href, `иконка подвала получила метку ?start=: ${href}`).not.toContain('start=');

          expect(href, `иконка подвала перестала вести к менеджеру: ${href}`).toContain(
            'Example_Manager',
          );
        }
      }
    }
  });
});

test.describe('Д-17: три колонки на десктопе, столбик на телефоне', () => {
  test('1440: три шага лежат в одной строке', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.mn);

    const boxes = await page
      .locator('.spine-step')
      .evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), left: Math.round(r.left) };
        }),
      );
    expect(boxes.length).toBe(3);

    for (let i = 1; i < boxes.length; i++) {
      expect(
        Math.abs(boxes[i]!.top - boxes[0]!.top),
        `шаг ${i + 1} не в одной строке с первым`,
      ).toBeLessThanOrEqual(2);
      expect(boxes[i]!.left, `шаг ${i + 1} стоит левее предыдущего`).toBeGreaterThan(
        boxes[i - 1]!.left,
      );
    }

    await expect(page.locator('.how-to-start .contact-actions')).toHaveCount(1);
  });

  for (const width of [390, 360]) {
    test(`${width}: три шага идут столбиком`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(PAGE_ROUTES.home.mn);

      const boxes = await page
        .locator('.spine-step')
        .evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { top: Math.round(r.top), left: Math.round(r.left) };
          }),
        );
      expect(boxes.length).toBe(3);
      for (let i = 1; i < boxes.length; i++) {
        expect(boxes[i]!.left, `на ${width} шаги разъехались по колонкам`).toBe(boxes[0]!.left);
        expect(boxes[i]!.top, `на ${width} шаг ${i + 1} не ниже предыдущего`).toBeGreaterThan(
          boxes[i - 1]!.top,
        );
      }
    });
  }
});

test.describe('Подвал двумя зонами: слева политика и копирайт, справа 18+ и иконки', () => {
  test('1440: две левые строки по одной вертикали, обе правые зоны прижаты вправо', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.ru);

    const box = async (selector: string) =>
      page.locator(selector).evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, cx: r.left + r.width / 2 };
      });

    const privacy = await box('.site-footer__privacy');
    const copyright = await box('.site-footer__copyright');
    const badge = await box('.site-footer__badge');

    const icons = await box('.site-footer__meta');
    const container = await box('.site-footer__container');

    expect(
      Math.abs(privacy.left - copyright.left),
      'политика и копирайт разъехались по левой вертикали',
    ).toBeLessThan(2);

    expect(copyright.cx, 'копирайт ушёл в правую половину подвала').toBeLessThan(container.cx);

    expect(badge.right, 'плашка возраста не прижата вправо').toBeGreaterThan(container.right - 4);
    expect(icons.right, 'ряд иконок не прижат вправо').toBeGreaterThan(container.right - 4);

    expect(copyright.right, 'копирайт заходит под правую зону').toBeLessThan(icons.left);
  });

  for (const width of [390, 360]) {
    test(`${width}: подвал идёт вертикально и не даёт горизонтальной прокрутки`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(PAGE_ROUTES.home.ru);

      const tops = await page
        .locator('.site-footer__brand, .site-footer__legal, .site-footer__meta')
        .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
      expect(tops.length).toBe(3);
      for (let i = 1; i < tops.length; i++) {
        expect(tops[i], `на ${width} зона ${i + 1} не ниже предыдущей`).toBeGreaterThan(
          tops[i - 1]!,
        );
      }

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `на ${width} появилась горизонтальная прокрутка`).toBeLessThanOrEqual(0);
    });
  }

  test('разделительного глифа нет ни в одном значении трёх словарей', async () => {
    const dictDir = path.join(process.cwd(), 'src', 'i18n');
    const offenders: string[] = [];
    let checked = 0;

    const walk = (node: unknown, trail: string, locale: string): void => {
      if (typeof node === 'string') {
        checked += 1;
        if (/[·•‧∙]/.test(node)) offenders.push(`${locale}:${trail} = ${node}`);
        return;
      }
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          walk(value, trail ? `${trail}.${key}` : key, locale);
        }
      }
    };

    for (const locale of LOCALES) {
      walk(JSON.parse(readFileSync(path.join(dictDir, `${locale}.json`), 'utf8')), '', locale);
    }

    expect(checked, 'обход словарей не нашёл ни одного значения').toBeGreaterThan(100);
    expect(offenders, `разделительный глиф вернулся в словарь: ${offenders.join(' | ')}`).toEqual(
      [],
    );
  });

  test('разделитель нарисован оформлением и виден на странице', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.ru);

    const content = await page
      .locator('.site-footer__legal-note')
      .evaluate((el) => getComputedStyle(el, '::before').content);
    expect(content, 'разделитель подвала перестал рисоваться').toContain('·');

    const text = await page.locator('.site-footer__copyright').innerText();
    expect(text, 'разделитель вернулся текстовым узлом в разметку').not.toContain('·');
  });
});

test.describe('Порядок обхода табом совпадает с порядком разметки (1440)', () => {
  for (const [name, selector] of [
    ['подвал', '.site-footer a'],
    ['как начать', '.how-to-start a'],
    ['первый экран', '.hero a'],
  ] as const) {
    test(`${name}: визуальный порядок ссылок не противоречит разметке`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(PAGE_ROUTES.home.ru);

      const boxes = await page.locator(selector).evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), left: Math.round(r.left), text: (el.textContent ?? '').trim().slice(0, 30) };
        }),
      );
      expect(boxes.length, `${name}: ссылок не нашлось`).toBeGreaterThan(0);

      for (let i = 1; i < boxes.length; i++) {
        const prev = boxes[i - 1]!;
        const cur = boxes[i]!;
        const wentBack = cur.top < prev.top - 2 && cur.left < prev.left - 2;
        expect(
          wentBack,
          `${name}: «${cur.text}» стоит выше И левее предыдущей «${prev.text}» — ` +
            'сетка переставила элементы местами относительно разметки',
        ).toBe(false);
      }
    });
  }
});

test.describe('Ноль горизонтальной прокрутки после четырёх новых раскладок', () => {
  for (const locale of LOCALES) {
    for (const width of [360, 390, 1440]) {
      test(`${locale} на ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: width < 1000 ? 800 : 900 });
        await page.goto(PAGE_ROUTES.home[locale]);

        await page.evaluate(async () => {
          for (let y = 0; y < document.body.scrollHeight; y += 600) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 30));
          }
        });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${locale} на ${width}px даёт горизонтальную прокрутку`).toBeLessThanOrEqual(
          0,
        );
      });
    }
  }
});

test.describe('Подвал как в макете: три голых глифа, но без подписи-обмана', () => {
  const dict = (locale: Locale) =>
    JSON.parse(
      readFileSync(path.join(process.cwd(), 'src', 'i18n', `${locale}.json`), 'utf8'),
    ) as { footer: Record<string, string> };

  for (const locale of LOCALES) {
    test(`${locale}: у иконок подвала нет видимой подписи, но есть доступное имя`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(PAGE_ROUTES.home[locale]);

      const icons = page.locator('.site-footer__icon');
      await expect(icons, 'иконок подвала не три').toHaveCount(3);

      const spans = await icons.locator('span').evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent ?? '').trim() };
        }),
      );
      expect(spans.length, 'подписей у иконок не три').toBe(3);
      for (const s of spans) {
        expect(s.w, `подпись «${s.text}» снова занимает место в раскладке`).toBeLessThanOrEqual(1);
        expect(s.text.length, 'у иконки подвала пропало доступное имя').toBeGreaterThan(0);
      }

      const expected = dict(locale).footer;

      const contact = page.locator('.site-footer__social .site-footer__icon');
      await expect(contact).toHaveCount(1);
      expect(
        (await contact.innerText().catch(() => '')) ||
          (await contact.evaluate((el) => el.textContent?.trim() ?? '')),
        'доступное имя контактной иконки перестало называть менеджера',
      ).toBe(expected.contact_manager);

      const group = page.locator('.site-footer__channels');
      expect(
        await group.getAttribute('aria-label'),
        'заголовок группы каналов исчез вместе с видимым текстом — различимость смыслов потеряна',
      ).toBe(expected.follow_label);
      expect(await group.getAttribute('role'), 'группа каналов потеряла роль').toBe('group');
    });
  }

  test('390: три глифа стоят одним рядом ровным шагом, контакт первым, полоски нет', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.ru);

    const boxes = await page.locator('.site-footer__icon').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) };
      }),
    );
    expect(boxes.length, 'иконок подвала не три').toBe(3);

    const tops = new Set(boxes.map((b) => b.top));
    expect(tops.size, 'три глифа подвала снова разъехались по строкам').toBe(1);

    const contactLeft = await page
      .locator('.site-footer__social .site-footer__icon')
      .evaluate((el) => Math.round(el.getBoundingClientRect().left));
    for (const b of boxes) {
      expect(contactLeft, 'контакт менеджера перестал стоять первым').toBeLessThanOrEqual(b.left);
    }

    for (const b of boxes) {
      expect(b.w, 'тап-цель иконки подвала уже 44px').toBeGreaterThanOrEqual(44);
      expect(b.h, 'тап-цель иконки подвала ниже 44px').toBeGreaterThanOrEqual(44);
    }

    const divider = await page.locator('.site-footer__channels').evaluate((el) => {
      const cs = getComputedStyle(el, '::before');
      return { content: cs.content, w: cs.width, bg: cs.backgroundColor };
    });
    expect(
      divider.content === 'none' || divider.content === 'normal',
      `в подвал вернулась полоска после телеграма (::before content = ${divider.content})`,
    ).toBe(true);

    const gaps = boxes.slice(1).map((b, i) => b.left - (boxes[i]!.left + boxes[i]!.w));
    expect(
      new Set(gaps).size,
      `шаг ряда глифов подвала неровный: ${gaps.join(', ')} px — так выглядит дыра от снятого разделителя`,
    ).toBe(1);

    const colors = await page.locator('.site-footer__icon').evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).color),
    );
    expect(
      colors[0],
      'контактный глиф сравнялся по яркости с каналами бренда',
    ).not.toBe(colors[1]);
  });

  test('390: порядок строк подвала совпал с макетом, знак MELBET снят', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.ru);

    const tops = await page.evaluate(() => {
      const top = (sel: string) => {
        const el = document.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().top) : null;
      };
      return {
        badge: top('.site-footer__badge'),
        privacy: top('.site-footer__privacy'),
        copyright: top('.site-footer__copyright'),
        icons: top('.site-footer__meta'),
        wordmark: document.querySelectorAll('.site-footer__wordmark').length,
      };
    });

    expect(tops.wordmark, 'знак MELBET вернулся в подвал — в макете его нет').toBe(0);
    expect(tops.badge!, 'плашка возраста перестала быть первой строкой подвала').toBeLessThan(
      tops.privacy!,
    );
    expect(tops.privacy!, 'ссылка на политику ушла ниже копирайта').toBeLessThan(tops.copyright!);
    expect(tops.copyright!, 'копирайт ушёл ниже иконок').toBeLessThan(tops.icons!);
  });

  test('над подвалом нет волосяной линии — фон страницы обязан быть непрерывным', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.mn);

    const border = await page.locator('.site-footer').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { w: cs.borderTopWidth, style: cs.borderTopStyle };
    });
    expect(
      border.w === '0px' || border.style === 'none',
      'над подвалом вернулась кромка — заказчик просил единый фон без стыков',
    ).toBe(true);
  });
});

test.describe('ПК-раскладка по макету', () => {

  const DESKTOP_MATRIX = [1050, 1100, 1279, 1280, 1440, 1600, 1920] as const;

  for (const width of DESKTOP_MATRIX) {
    for (const locale of LOCALES) {
      test(`${width}/${locale}: три карточки направлений — ряд равной высоты (свёрнуто) и общая линия заголовков (раскрыто)`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(PAGE_ROUTES.home[locale]);
        await page.evaluate(() => window.scrollTo(0, 900));
        await page.waitForTimeout(300);

        const cards = await page.locator('.direction-card').evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
          }),
        );
        expect(cards.length, 'карточек направлений не три').toBe(3);

        for (let i = 1; i < cards.length; i++) {
          expect(cards[i]!.y, `на ${width}/${locale} карточка ${i + 1} съехала со строки ряда`).toBe(
            cards[0]!.y,
          );
          expect(
            cards[i]!.x,
            `на ${width}/${locale} карточка ${i + 1} не правее предыдущей`,
          ).toBeGreaterThan(cards[i - 1]!.x);
        }

        const hs = cards.map((c) => c.h);
        expect(
          Math.max(...hs) - Math.min(...hs),
          `на ${width}/${locale} свёрнутые карточки разной высоты: ${hs.join('/')}`,
        ).toBeLessThanOrEqual(1);

        const expectedCollapsedH = width <= 1081 ? 210 : 163;
        expect(
          Math.abs(cards[0]!.h - expectedCollapsedH),
          `на ${width}/${locale} свёрнутая высота ${cards[0]!.h} не совпадает с ожидаемой ${expectedCollapsedH} (полоса ${width <= 1081 ? '1050-1081' : '>=1082'})`,
        ).toBeLessThanOrEqual(1);

        const caretGaps = await page.locator('.direction-card').evaluateAll((els) =>
          els.map((el) => {
            const audience = el.querySelector('.direction-audience')!.getBoundingClientRect();
            const caret = el.querySelector('.direction-caret')!.getBoundingClientRect();
            return Math.round((caret.top - audience.bottom) * 10) / 10;
          }),
        );
        for (const gap of caretGaps) {
          expect(
            Math.abs(gap - 8),
            `на ${width}/${locale} зазор каретки ${gap}px отличается от ожидаемых 8px больше чем на 1px: ${caretGaps.join('/')}`,
          ).toBeLessThanOrEqual(1);
        }

        const state = await page.evaluate(() => ({
          openCount: document.querySelectorAll('details.direction-card[open]').length,
          caretsVisible: [...document.querySelectorAll('.direction-caret')].filter(
            (el) => getComputedStyle(el).display !== 'none',
          ).length,
        }));
        expect(state.openCount, `на ${width}/${locale} карточка раскрыта при первой загрузке`).toBe(0);
        expect(state.caretsVisible, `на ${width}/${locale} каретка скрыта — обещания раскрытия нет`).toBe(
          3,
        );

        const summaries = page.locator('.direction-card > summary');
        const summaryCount = await summaries.count();
        for (let i = 0; i < summaryCount; i++) {
          await summaries.nth(i).click();
        }
        await page.waitForTimeout(700);

        const openHeights = await page
          .locator('.direction-card')
          .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
        expect(
          Math.max(...openHeights) - Math.min(...openHeights),
          `на ${width}/${locale} раскрытые карточки разной высоты: ${openHeights.join('/')}`,
        ).toBeLessThanOrEqual(2);

        const titleTops = await page.locator('.direction-card').evaluateAll((cardEls) =>
          cardEls.map((card) =>
            [...card.querySelectorAll('.direction-section-title')].map((el) =>
              Math.round(el.getBoundingClientRect().y),
            ),
          ),
        );
        const t1 = titleTops.map((pair) => pair[0]!);
        const t2 = titleTops.map((pair) => pair[1]!);
        expect(
          Math.max(...t1) - Math.min(...t1),
          `на ${width}/${locale} заголовок «Что получает партнёр?» не на общей линии: ${t1.join('/')}`,
        ).toBeLessThanOrEqual(2);
        expect(
          Math.max(...t2) - Math.min(...t2),
          `на ${width}/${locale} заголовок «Что необходимо для заработка?» не на общей линии: ${t2.join('/')}`,
        ).toBeLessThanOrEqual(2);
      });
    }
  }

  test('1440: раскрытие ОДНОЙ карточки не растягивает соседние', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.ru);
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.waitForTimeout(300);

    const h0 = await page.evaluate(() => {
      const left = document.querySelector('#direction-affiliate')!.getBoundingClientRect().height;
      const right = document.querySelector('#direction-teamcash')!.getBoundingClientRect().height;
      return { left: Math.round(left), right: Math.round(right) };
    });

    const frames = await page.evaluate(async () => {
      const bank = document.querySelector('#direction-bank summary') as HTMLElement;
      const left = document.querySelector('#direction-affiliate') as HTMLElement;
      const right = document.querySelector('#direction-teamcash') as HTMLElement;
      const points = [0, 100, 200, 300, 450, 700];
      const out: { t: number; left: number; right: number }[] = [];
      const start = performance.now();
      bank.click();
      for (const target of points) {
        await new Promise<void>((resolve) => {
          const tick = () => {
            if (performance.now() - start >= target) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        out.push({
          t: target,
          left: Math.round(left.getBoundingClientRect().height),
          right: Math.round(right.getBoundingClientRect().height),
        });
      }
      return out;
    });

    const uniq = new Set<number>();
    for (const f of frames) {
      uniq.add(f.left);
      uniq.add(f.right);
    }
    expect(
      uniq.size,
      `соседки прошли через несколько разных высот за прогон анимации: ${JSON.stringify(frames)}`,
    ).toBe(1);
    const only = [...uniq][0]!;
    expect(
      Math.abs(only - h0.left),
      `единственная высота соседки (${only}) отличается от её свёрнутой (${h0.left}) больше чем на 1px`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(only - h0.right),
      `единственная высота соседки (${only}) отличается от её свёрнутой (${h0.right}) больше чем на 1px`,
    ).toBeLessThanOrEqual(1);

    const hs = await page
      .locator('.direction-card')
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(hs.length).toBe(3);
    expect(hs[1]!, 'раскрытая карточка не выросла').toBeGreaterThan(600);
    expect(hs[0]!, 'левая соседка растянулась вслед за раскрытой').toBeLessThan(400);
    expect(hs[2]!, 'правая соседка растянулась вслед за раскрытой').toBeLessThan(400);
  });

  test('1440: явное раскрытие всех трёх карточек по клику даёт настоящий open и не прячет каретку', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.ru);
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.waitForTimeout(300);

    const summaries = page.locator('.direction-card > summary');
    const count = await summaries.count();
    for (let i = 0; i < count; i++) {
      await summaries.nth(i).click();
    }
    await page.waitForTimeout(700);

    const m = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('details.direction-card')];
      return {
        openAttr: cards.filter((c) => (c as HTMLDetailsElement).open).length,
        heights: cards.map((c) => Math.round(c.getBoundingClientRect().height)),
        carets: cards.filter(
          (c) => getComputedStyle(c.querySelector('.direction-caret')!).display !== 'none',
        ).length,
      };
    });

    expect(m.openAttr, 'клик не выставил настоящий атрибут open на всех трёх').toBe(3);
    expect(m.carets, 'каретка скрыта на раскрытой карточке').toBe(3);
    expect(m.heights.every((h) => h > 600), `раскрытие не увеличило высоту: ${m.heights.join('/')}`).toBe(
      true,
    );
  });

  test('390: раскрытые карточки — высоты байт-в-байт прежние (мобиль не задет)', async ({ page }) => {
    const expected: Record<Locale, number[]> = {
      mn: [801, 887, 934],
      ru: [762, 825, 871],
      en: [825, 848, 848],
    };
    for (const locale of LOCALES) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(PAGE_ROUTES.home[locale]);

      const summaries = page.locator('.direction-card > summary');
      const count = await summaries.count();
      for (let i = 0; i < count; i++) {
        await summaries.nth(i).click();
      }
      await page.waitForTimeout(700);

      const hs = await page
        .locator('.direction-card')
        .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
      expect(hs, `на 390/${locale} высоты раскрытых карточек изменились: ${hs.join('/')}`).toEqual(
        expected[locale],
      );
    }
  });

  test('overflow: scrollWidth не превышает clientWidth на 390/1050/1280/1440/1920', async ({ page }) => {
    const widths = [390, 1050, 1280, 1440, 1920] as const;
    for (const width of widths) {
      await page.setViewportSize({ width, height: width < 720 ? 844 : 900 });
      await page.goto(PAGE_ROUTES.home.ru);
      const ok = await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      );
      expect(ok, `на ${width} страница переполнилась по горизонтали`).toBe(true);
    }
  });

  test('1440: при prefers-reduced-motion:reduce раскрытие всех трёх мгновенное и равное', async ({
    browser,
    baseURL,
  }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    try {
      await page.goto(new URL(PAGE_ROUTES.home.ru, baseURL).toString());
      expect(
        await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
        'настройка reduce до страницы не доехала — тест мерил бы не то',
      ).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 900));
      await page.waitForTimeout(300);

      const summaries = page.locator('.direction-card > summary');
      const count = await summaries.count();
      for (let i = 0; i < count; i++) {
        await summaries.nth(i).click();
      }

      const immediately = await page
        .locator('.direction-card')
        .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
      expect(
        Math.max(...immediately) - Math.min(...immediately),
        `reduce: раскрытие не мгновенное/не равное сразу после клика: ${immediately.join('/')}`,
      ).toBeLessThanOrEqual(2);

      await page.waitForTimeout(50);
      const settled = await page
        .locator('.direction-card')
        .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
      expect(
        Math.max(...settled) - Math.min(...settled),
        `reduce: раскрытие не равное после устойчивости: ${settled.join('/')}`,
      ).toBeLessThanOrEqual(2);
    } finally {
      await ctx.close();
    }
  });

  test('1440: заголовок «Выберите направление» стоит в ОДНУ строку во всех локалях', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const locale of LOCALES) {
      await page.goto(PAGE_ROUTES.home[locale]);
      const lines = await page.locator('#direction-cards-title').evaluate((el) => {
        const cs = getComputedStyle(el);
        return Math.round(el.getBoundingClientRect().height / parseFloat(cs.lineHeight));
      });
      expect(lines, `на десктопе ${locale} заголовок направлений снова в две строки`).toBe(1);
    }
  });

  test('1440: связка первого экрана стоит выше сгиба и не прижата ко дну', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.ru);

    const m = await page.evaluate(() => {
      window.scrollTo({ top: 0, behavior: 'instant' });
      const R = (s: string) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY };
      };
      const hero = document.querySelector('.hero')!.getBoundingClientRect();
      return {
        h1: R('.hero h1'),
        acts: R('.hero-actions'),
        heroH: hero.height,
        scrollY: window.scrollY,
      };
    });

    expect(
      m.scrollY,
      `страница стоит на ${String(m.scrollY)}px, а не в начале — сравнение с сгибом окна ` +
        'потеряло смысл, и число ниже говорило бы не о вёрстке',
    ).toBe(0);

    expect(m.acts!.bottom, 'кнопки первого экрана ушли за сгиб 900px').toBeLessThan(900);

    expect(
      m.h1!.top / m.heroH,
      'заголовок первого экрана снова прижат ко дну секции',
    ).toBeLessThan(0.55);
  });

  test('1440: панель заявки не шире 760px и стоит по центру полосы', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.ru);

    const m = await page.evaluate(() => {
      const f = document.querySelector('.lead-form__form')!.getBoundingClientRect();
      const c = document.querySelector('.lead-form__container')!.getBoundingClientRect();
      return {
        w: f.width,
        panelCx: f.left + f.width / 2,
        bandCx: c.left + c.width / 2,
      };
    });

    expect(m.w, 'панель заявки снова растянулась на всю меру страницы').toBeLessThanOrEqual(761);
    expect(
      Math.abs(m.panelCx - m.bandCx),
      'панель заявки не по центру полосы',
    ).toBeLessThan(2);
  });
});

test.describe('Стекло: одно семейство материала на всю страницу', () => {
  const SURFACES = [
    ['кнопка шага', '.spine-actions .contact-btn'],
    ['карточка направления', '#direction-affiliate'],
    ['пункт FAQ', '.faq-item'],
    ['панель заявки', '.lead-form__form'],
    ['поле ввода', '.field__input'],
    ['плашка чипа', '.chip-radio'],
  ] as const;

  test('1440: ни одна стеклянная поверхность не подкрашивает собой', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.ru);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(400);

    for (const [name, sel] of SURFACES) {
      const el = page.locator(sel).first();
      await expect(el, `${name} (${sel}) не найдена на странице`).toHaveCount(1);
      const rgb = await el.evaluate((node) => {
        const nums = getComputedStyle(node).backgroundColor.match(/[\d.]+/g) ?? [];
        return nums.slice(0, 3).map(Number);
      });
      const [r, g, b] = rgb as [number, number, number];
      expect(
        Math.max(r, g, b) - Math.min(r, g, b),
        `${name}: заливка rgb(${r},${g},${b}) имеет собственный оттенок — ` +
          'стеклянные поверхности красятся только белой или чёрной плёнкой',
      ).toBeLessThanOrEqual(1);
    }
  });
});
