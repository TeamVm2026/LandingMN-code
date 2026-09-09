
import { test, expect } from '@playwright/test';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';
import sharp from 'sharp';

const LOCALES: Locale[] = ['mn', 'ru', 'en'];

const FOCUSABLE = [

  '.contact-btn--telegram',
  '.contact-btn--telegram',
  '.contact-btn--messenger',

  '.direction-card > summary',
  '.btn-primary',
  '.main-nav a',
  'a.lang-item',
  '#lead-name',
  '#lead-contact',
  '.faq-summary',
  '.site-footer__icon',
  '.site-footer__privacy',
];

test.describe('Кольцо фокуса видно на КАЖДОМ интерактивном элементе', () => {
  for (const locale of LOCALES) {
    test(`все элементы показывают кольцо в :focus-visible (${locale})`, async ({ page }) => {
      await page.goto(PAGE_ROUTES.home[locale]);

      for (const selector of FOCUSABLE) {
        const result = await page.evaluate((sel) => {
          const el = document.querySelector<HTMLElement>(sel);
          if (!el) return { missing: true as const };

          el.focus({ focusVisible: true } as FocusOptions);

          let node: HTMLElement | null = el;
          for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
            const cs = getComputedStyle(node);
            const hasOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2;
            const hasShadowRing = /rgb\(255,\s*219,\s*99\)/.test(cs.boxShadow);
            if (hasOutline || hasShadowRing) {
              return { missing: false as const, found: true as const, on: depth === 0 ? sel : node.className.toString() };
            }
          }

          const own = getComputedStyle(el);
          return {
            missing: false as const,
            found: false as const,
            detail: `outline ${own.outlineWidth} ${own.outlineStyle}, box-shadow ${own.boxShadow}`,
          };
        }, selector);

        expect(result.missing, `${selector} отсутствует на странице`).toBe(false);
        if (result.missing) continue;

        expect(
          result.found,
          `${selector}: нет видимого индикатора фокуса ни на элементе, ни на его обёртках (${'detail' in result ? result.detail : ''})`,
        ).toBe(true);
      }
    });
  }
});

test.describe('prefers-reduced-transparency снимает размытие полностью', () => {
  test('ни один элемент не остаётся с backdrop-filter при включённой настройке', async ({
    page,
    context,
  }) => {

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    });

    await page.goto(PAGE_ROUTES.home.mn);

    await page.evaluate(() => window.scrollTo(0, 1600));
    await page.waitForTimeout(400);

    const stillBlurred = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('*')]
        .filter((el) => {
          const bf = getComputedStyle(el).backdropFilter;
          return bf && bf !== 'none';
        })
        .map((el) => el.className.toString().split(' ')[0] || el.tagName),
    );

    expect(
      stillBlurred,
      `размытие осталось на: ${stillBlurred.join(', ')} — скорее всего фолбэк снова проиграл по специфичности`,
    ).toEqual([]);

    const contrast = await page.evaluate(() => {
      const lum = (c: string) => {
        const [r, g, b] = c.match(/\d+/g)!.map(Number);
        const f = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };

      return ['.btn-primary', '.contact-btn--telegram', '.contact-btn--messenger']
        .map((sel) => {
          const el = document.querySelector<HTMLElement>(sel);
          if (!el) return null;
          const cs = getComputedStyle(el);
          const a = lum(cs.color);
          const b = lum(cs.backgroundColor);
          return { sel, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
        })
        .filter(Boolean) as { sel: string; ratio: number }[];
    });

    for (const c of contrast) {
      expect(
        c.ratio,
        `${c.sel}: при «уменьшить прозрачность» контраст надписи ${c.ratio.toFixed(2)}:1 — текст нечитаем`,
      ).toBeGreaterThanOrEqual(4.5);
    }

    await page
      .locator('details[data-track-direction="affiliate"] > summary')
      .scrollIntoViewIfNeeded();

    await page.locator('details[data-track-direction="affiliate"] > summary').click();
    await page.waitForTimeout(300);
    await expect(
      page.locator('details[data-track-direction="affiliate"] .direction-steps'),
    ).toBeVisible();
    const blurredWithCardOpen = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('*')]
        .filter((el) => {
          const bf = getComputedStyle(el).backdropFilter;
          return bf && bf !== 'none';
        })
        .map((el) => el.className.toString().split(' ')[0] || el.tagName),
    );
    expect(
      blurredWithCardOpen,
      `размытие осталось при раскрытой карточке на: ${blurredWithCardOpen.join(', ')}`,
    ).toEqual([]);
  });
});

test.describe('Кнопки — один материал и настоящее нажатие', () => {
  test('кнопки: блик — общий материал страницы, кольцо одно, связь — синим канала, форма — золотом', async ({ page }) => {

    await page.goto(PAGE_ROUTES.home.ru);

    const SELECTORS = [
      '.contact-btn--telegram',
      '.contact-btn--messenger',
      '.btn-primary',
    ];

    const ETALON = '.contact-actions--neutral .contact-btn';

    const styles = await page.evaluate(
      ([sels, etalon]: readonly [string[], string]) =>
        [...sels, etalon].map((sel) => {
          const el = document.querySelector<HTMLElement>(sel);
          if (!el) return { sel, missing: true as const };
          const cs = getComputedStyle(el);
          const after = getComputedStyle(el, '::after');
          const before = getComputedStyle(el, '::before');
          return {
            sel,
            missing: false as const,
            bgImage: cs.backgroundImage,
            bgColor: cs.backgroundColor,
            color: cs.color,
            radius: cs.borderTopLeftRadius,

            h: el.getBoundingClientRect().height,
            shadow: cs.boxShadow,
            borderW: parseFloat(cs.borderTopWidth),
            borderS: cs.borderTopStyle,

            kromka:
              after.content !== 'none'
              && after.opacity !== '0'
              && after.backgroundImage !== 'none'
                ? after.backgroundImage
                : null,
            vnutr:
              before.content !== 'none' && before.opacity !== '0'
                ? before.backgroundImage
                : null,
          };
        }),
      [SELECTORS, ETALON] as const,
    );

    const bezPustyh = (bg: string) => bg.replace(/(,\s*none)+$/, '');

    const etalon = styles.find((x) => x.sel === ETALON)!;
    expect(etalon.missing, 'эталонная стеклянная поверхность не найдена').toBe(false);

    if (!etalon.missing) {
      expect(etalon.bgImage, 'у эталонной поверхности пропал блик материала').not.toBe('none');
      expect(etalon.kromka, 'у эталонной поверхности пропала кромка материала').not.toBeNull();
    }

    const STEKLO = ['.contact-btn--telegram', '.contact-btn--messenger', '.btn-primary'];

    for (const s of styles) {
      if (s.sel === ETALON) continue;
      expect(s.missing, `${s.sel} не найден`).toBe(false);
      if (s.missing || etalon.missing) continue;

      const outerShadows = (s.shadow ?? 'none')
        .split(/,(?![^()]*\))/)
        .map((x) => x.trim())
        .filter((x) => x && x !== 'none' && !x.includes('inset'));
      expect(
        outerShadows,
        `${s.sel}: вернулась ПАДАЮЩАЯ тень — это «вид из 2007» (${s.shadow})`,
      ).toEqual([]);

      expect(
        parseFloat(s.radius),
        `${s.sel}: радиус ${s.radius} выбивается из системы — пилюля у всех кнопок`,
      ).toBeGreaterThanOrEqual(s.h / 2);

      if (STEKLO.includes(s.sel)) {

        expect(
          s.bgImage,
          `${s.sel}: блик кнопки не совпал с бликом эталонной поверхности — это второй рецепт материала на странице (${s.bgImage})`,
        ).toBe(bezPustyh(etalon.bgImage));
        expect(
          s.kromka,
          `${s.sel}: кромка кнопки не совпала с кромкой эталонной поверхности (${s.kromka})`,
        ).toBe(etalon.kromka === null ? null : bezPustyh(etalon.kromka));
        expect(
          s.vnutr,
          `${s.sel}: внутренняя грань кнопки не совпала с гранью эталонной поверхности`,
        ).toBe(etalon.vnutr === null ? null : bezPustyh(etalon.vnutr));

        const kolec = (s.borderW > 0 && s.borderS !== 'none' ? 1 : 0) + (s.kromka ? 1 : 0);
        expect(
          kolec,
          `${s.sel}: колец у кнопки ${kolec} (обводка ${s.borderW}px ${s.borderS}, кромка ${s.kromka ? 'есть' : 'нет'}) — обязано быть ровно одно`,
        ).toBe(1);
      } else {

        expect(s.bgImage, `${s.sel}: вернулся градиент в заливке (${s.bgImage})`).toBe('none');
      }
    }

    const GOLD = 'rgb(241, 198, 50)';
    const CHANNEL = ['.contact-btn--telegram'];
    const NEUTRAL = ['.contact-btn--messenger'];

    const goldButtons = styles.filter(
      (s) =>
        !s.missing
        && s.sel !== ETALON
        && !NEUTRAL.includes(s.sel)
        && !CHANNEL.includes(s.sel),
    );

    expect(goldButtons.length, 'ни одной золотой кнопки в выборке').toBeGreaterThan(0);

    const GOLD_RGB = [241, 198, 50] as const;
    for (const p of goldButtons) {
      const parts = (p.bgColor?.match(/[\d.]+/g) ?? []).map(Number);
      expect(
        parts.slice(0, 3),
        `${p.sel}: тон кнопки формы не золотой (${p.bgColor})`,
      ).toEqual([...GOLD_RGB]);

    }

    for (const sel of CHANNEL) {
      const s = styles.find((x) => x.sel === sel)!;
      expect(s.missing, `${sel} не найден`).toBe(false);
      if (s.missing) continue;
      expect(s.bgColor, `${sel}: кнопка канала снова залита золотом`).not.toBe(GOLD);
      const [r, g, b] = (s.bgColor.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
      expect(
        b,
        `${sel}: заливка ${s.bgColor} не читается как фирменный синий канала (b=${b}, r=${r})`,
      ).toBeGreaterThan(r + 100);
      expect(b, `${sel}: синий канал не доминирует (${s.bgColor})`).toBeGreaterThan(g);
    }

    for (const sel of NEUTRAL) {
      const s = styles.find((x) => x.sel === sel)!;
      expect(s.bgColor, `${sel}: нейтральная кнопка снова залита золотом`).not.toBe(GOLD);
      expect(s.bgColor, `${sel}: нейтральная кнопка взяла синий канала`).not.toBe(
        styles.find((x) => x.sel === CHANNEL[0])!.bgColor,
      );

      const neutralParts = (s.bgColor?.match(/[\d.]+/g) ?? []).map(Number);
      const goldParts = (goldButtons[0]!.bgColor?.match(/[\d.]+/g) ?? []).map(Number);
      expect(
        neutralParts.slice(0, 3),
        `${sel}: нейтральная кнопка взяла тон золотой (${s.bgColor})`,
      ).not.toEqual(goldParts.slice(0, 3));
    }

  });

  test('нажатие уменьшает кнопку и отпускает её обратно', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.ru);
    const button = page.locator('.contact-btn--telegram').first();
    const box = (await button.boundingBox())!;

    const scaleOf = () =>
      page.evaluate(() => {
        const t = getComputedStyle(document.querySelector<HTMLElement>('.contact-btn--telegram')!)
          .transform;
        if (t === 'none') return 1;
        return parseFloat(t.slice(t.indexOf('(') + 1).split(',')[0]);
      });

    expect(await scaleOf()).toBeCloseTo(1, 2);

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(160);
    const pressed = await scaleOf();
    expect(pressed, 'кнопка не реагирует на нажатие').toBeLessThan(1);

    await page.mouse.up();

    await page.waitForTimeout(500);
    expect(await scaleOf(), 'кнопка залипла уменьшенной').toBeCloseTo(1, 2);
  });

  test('наведение не сдвигает кнопку с места', async ({ page }) => {

    await page.goto(PAGE_ROUTES.home.ru);
    const button = page.locator('.contact-btn--messenger').first();
    const before = (await button.boundingBox())!;
    await button.hover();
    await page.waitForTimeout(300);
    const after = (await button.boundingBox())!;
    expect(Math.round(after.y), 'кнопка подпрыгивает при наведении').toBe(Math.round(before.y));
    expect(Math.round(after.x)).toBe(Math.round(before.x));
  });
});

test.describe('Раскладки, которые уже ломались молча', () => {

  const FIRST_SCREEN_VIEWPORTS = [
    { width: 360, height: 740 },
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ];

  for (const vp of FIRST_SCREEN_VIEWPORTS) {
    for (const locale of LOCALES) {
      test(`ни одно действие первого экрана не перекрыто (${vp.width}px, ${locale})`, async ({
        page,
      }) => {
        await page.setViewportSize(vp);
        await page.goto(PAGE_ROUTES.home[locale]);

        await page.waitForTimeout(600);

        const covered = await page.evaluate(() => {
          const out: string[] = [];
          const actions = document.querySelectorAll<HTMLElement>(
            '.hero a, .hero button, .site-header a, .site-header button',
          );
          for (const el of actions) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;

            if (rect.top < 0 || rect.bottom > window.innerHeight) continue;
            const hit = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            );

            if (!hit || !(el.contains(hit) || hit.contains(el))) {
              out.push(
                `${el.className.toString() || el.tagName} перекрыт ${hit?.className.toString() || hit?.tagName || 'ничем'}`,
              );
            }
          }
          return out;
        });

        expect(covered, 'действия первого экрана перекрыты посторонним слоем').toEqual([]);
      });
    }
  }

  test('форма на десктопе: все поля начинаются с одной вертикали', async ({ page }) => {

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(PAGE_ROUTES.home.ru);
    await page.locator('form[data-lead-form]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    const xs = await page.evaluate(() =>
      [
        '#lead-name',
        '.field--contact .chip-group',
        '.field__contact-group',
        '.field--direction .chip-group',
        '.consent',
        '.lead-form__submit',
      ].map((sel) => {
        const el = document.querySelector<HTMLElement>(sel);
        return { sel, x: el ? Math.round(el.getBoundingClientRect().x) : null };
      }),
    );

    for (const item of xs) expect(item.x, `${item.sel} не найден`).not.toBeNull();
    const distinct = new Set(xs.map((i) => i.x));
    expect(
      distinct.size,
      `контролы формы стоят по разным вертикалям: ${xs.map((i) => `${i.sel}=${i.x}`).join(', ')}`,
    ).toBe(1);

    const widths = await page.evaluate(() => {
      const w = (sel: string) => {
        const el = document.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().width) : null;
      };
      return { submit: w('.lead-form__submit'), field: w('#lead-name') };
    });
    expect(widths.submit, 'кнопка отправки не найдена').not.toBeNull();
    expect(widths.field, 'поле имени не найдено').not.toBeNull();
    expect(
      Math.abs((widths.submit as number) - (widths.field as number)),
      `кнопка отправки разошлась по ширине с полями: ${widths.submit} против ${widths.field}`,
    ).toBeLessThanOrEqual(1);
  });
});

test.describe('Пара шага «Как начать»: обе кнопки серые, первый экран синий', () => {
  const read = async (page: import('@playwright/test').Page) =>
    page.evaluate(() => {
      const grab = (sel: string) => {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const after = getComputedStyle(el, '::after');
        const r = el.getBoundingClientRect();
        return {
          bg: cs.backgroundColor,
          border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
          blur: cs.backdropFilter,
          color: cs.color,

          kromka:
            after.content !== 'none'
            && after.opacity !== '0'
            && after.backgroundImage !== 'none'
              ? after.backgroundImage
              : null,
          kolec:
            (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' ? 1 : 0)
            + (after.content !== 'none'
            && after.opacity !== '0'
            && after.backgroundImage !== 'none'
              ? 1
              : 0),
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      };
      return {
        stepsTg: grab('.how-to-start .contact-btn--telegram'),
        stepsFb: grab('.how-to-start .contact-btn--messenger'),
        heroTg: grab('.hero .contact-btn--telegram'),

      };
    });

  const blueDominates = (css: string) => {
    const [r, g, b] = (css.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
    return b > r + 100 && b > g;
  };

  for (const locale of LOCALES) {
    test(`${locale}: пара шага — один материал на двоих, синего в ней нет`, async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 900 });
      await page.goto(PAGE_ROUTES.home[locale]);
      await page.locator('.how-to-start').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);

      const m = await read(page);
      expect(m.stepsTg, 'кнопка Telegram шага «Как начать» не найдена').not.toBeNull();
      expect(m.stepsFb, 'кнопка Facebook шага «Как начать» не найдена').not.toBeNull();
      expect(m.heroTg, 'кнопка Telegram первого экрана не найдена').not.toBeNull();

      expect(
        m.stepsTg!.bg,
        `заливки пары шага разошлись: ${m.stepsTg!.bg} против ${m.stepsFb!.bg}`,
      ).toBe(m.stepsFb!.bg);
      expect(m.stepsTg!.border, 'рамки пары шага разошлись').toBe(m.stepsFb!.border);
      expect(m.stepsTg!.blur, 'размытие подложки у пары шага разошлось').toBe(m.stepsFb!.blur);
      expect(m.stepsTg!.color, 'цвет надписей пары шага разошёлся').toBe(m.stepsFb!.color);

      expect(m.stepsTg!.bg, 'заливка кнопки шага пуста').not.toBe('rgba(0, 0, 0, 0)');
      expect(
        blueDominates(m.stepsTg!.bg),
        `кнопка шага снова залита фирменным синим канала (${m.stepsTg!.bg}) — амендмент Д-31 отменён молча`,
      ).toBe(false);

      expect(
        m.stepsTg!.kolec,
        `у серой кнопки шага колец ${m.stepsTg!.kolec} (обводка ${m.stepsTg!.border}, кромка ${m.stepsTg!.kromka ? 'есть' : 'нет'}) — обязано быть ровно одно`,
      ).toBe(1);

      expect(
        m.stepsTg!.kromka,
        'кромка материала разошлась у пары шага: кольцо носится разными способами',
      ).toBe(m.stepsFb!.kromka);

      expect(
        blueDominates(m.heroTg!.bg),
        `кнопка первого экрана потеряла фирменный синий канала (${m.heroTg!.bg}) — Д-01 задет`,
      ).toBe(true);
      expect(
        m.stepsTg!.bg,
        'пара шага и пара первого экрана слились в один материал',
      ).not.toBe(m.heroTg!.bg);

      expect(m.stepsTg!.y, 'пара шага сложилась в столбик на 360').toBe(m.stepsFb!.y);
      expect(m.stepsTg!.h, 'тап-цель кнопки шага меньше 44px').toBeGreaterThanOrEqual(44);
      expect(m.stepsFb!.h, 'тап-цель кнопки шага меньше 44px').toBeGreaterThanOrEqual(44);
    });
  }

  test('фолбэк «уменьшить прозрачность» накрывает и перекрашенную кнопку', async ({
    page,
    context,
  }) => {

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    });
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto(PAGE_ROUTES.home.ru);
    await page.locator('.how-to-start').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    const m = await read(page);
    expect(m.stepsTg!.blur, 'размытие осталось у кнопки шага при «уменьшить прозрачность»').toBe(
      'none',
    );
    expect(m.stepsTg!.bg, 'плотный фолбэк пары шага разошёлся между кнопками').toBe(m.stepsFb!.bg);
    expect(
      blueDominates(m.stepsTg!.bg),
      `фолбэк вернул кнопке шага синий канала (${m.stepsTg!.bg})`,
    ).toBe(false);
    expect(m.stepsTg!.bg, 'плотный фолбэк остался полупрозрачным').not.toContain('rgba');
  });

  for (const locale of LOCALES) {
    test(`${locale}: контраст подписи к ХУДШЕМУ пикселю фона под кнопкой не ниже 4,5`, async ({
      page,
    }) => {

      await page.setViewportSize({ width: 360, height: 900 });
      await page.goto(PAGE_ROUTES.home[locale]);
      await page.locator('.how-to-start').scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);

      const boxes = await page.locator('.how-to-start .contact-btn').evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return {
            name: e.className.includes('telegram') ? 'Telegram' : 'Facebook',
            x: Math.round(r.x + 6),
            y: Math.round(r.y + 6),
            w: Math.round(r.width - 12),
            h: Math.round(r.height - 12),
          };
        }),
      );
      expect(boxes.length, 'пара шага «Как начать» не найдена').toBe(2);

      const text = await page
        .locator('.how-to-start .contact-btn--telegram')
        .evaluate((el) => getComputedStyle(el).color);

      const alpha = await page.evaluate(() => {
        const v = getComputedStyle(document.documentElement)
          .getPropertyValue('--btn-secondary-bg-hover')
          .trim();
        const m2 = v.match(/([\d.]+)\s*\)\s*$/);
        return m2 ? Number(m2[1]) : 0;
      });
      expect(alpha, 'не удалось прочитать альфу --btn-secondary-bg-hover').toBeGreaterThan(0);

      await page.addStyleTag({ content: '.spine-actions{visibility:hidden!important}' });
      await page.waitForTimeout(200);

      for (const b of boxes) {
        const shot = await page.screenshot({ clip: { x: b.x, y: b.y, width: b.w, height: b.h } });

        const { data, info } = await sharp(shot)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const f = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        const rel = (r: number, g: number, bl: number) =>
          0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
        const [tr, tg, tb] = text.match(/\d+/g)!.map(Number);
        const lt = rel(tr, tg, tb);
        let min = Infinity;
        let px = '';
        for (let i = 0; i < data.length; i += info.channels) {
          const plate = [data[i], data[i + 1], data[i + 2]].map(
            (v) => alpha * 255 + (1 - alpha) * v,
          );
          const lp = rel(plate[0], plate[1], plate[2]);
          const ratio = (Math.max(lt, lp) + 0.05) / (Math.min(lt, lp) + 0.05);
          if (ratio < min) {
            min = ratio;
            px = `фон rgb(${data[i]},${data[i + 1]},${data[i + 2]}) на плашке rgb(${plate
              .map(Math.round)
              .join(',')})`;
          }
        }

        expect(
          min,
          `${b.name} (${locale}): подпись на худшем пикселе фона даёт ${min.toFixed(2)}:1, ${px}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

test.describe('Крупные стеклянные панели: блик ровный по всей высоте, а не только у токена в CSS', () => {
  async function glossSpread(page: import('@playwright/test').Page, sel: string) {
    const geo = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const rect = el.getBoundingClientRect();

      const visible = (r: DOMRect) => r.width > 0 && r.height > 0;
      const kids = (Array.from(el.children) as HTMLElement[])
        .map((k) => k.getBoundingClientRect())
        .filter(visible);
      const first = kids[0];
      const last = kids[kids.length - 1];
      return {
        x: rect.x,
        y: rect.y,
        w: rect.width,
        h: rect.height,
        topGutter: first ? Math.max(0, first.top - rect.top) : 0,
        bottomGutter: last ? Math.max(0, rect.bottom - last.bottom) : 0,
      };
    }, sel);
    if (!geo) return null;

    await page.evaluate(() => {
      const st = document.createElement('style');
      st.id = 'zamer-bez-sceny';
      st.textContent = '.scene-layer { visibility: hidden !important; }';
      document.head.appendChild(st);
    });
    await page.waitForTimeout(150);

    const band = (gutter: number) => Math.max(2, Math.floor(gutter / 3));
    const topH = band(geo.topGutter);
    const botH = band(geo.bottomGutter);
    const xInset = Math.min(40, geo.w / 4);
    const clipX = Math.round(geo.x + xInset);
    const clipW = Math.max(10, Math.round(geo.w - 2 * xInset));

    const topShot = await page.screenshot({
      clip: { x: clipX, y: Math.round(geo.y + geo.topGutter / 3), width: clipW, height: topH },
    });
    const botShot = await page.screenshot({
      clip: {
        x: clipX,
        y: Math.round(geo.y + geo.h - geo.bottomGutter / 3 - botH),
        width: clipW,
        height: botH,
      },
    });
    const mean = async (buf: Buffer) => {
      const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n += 1;
      }
      return [r / n, g / n, b / n];
    };
    const [tr, tg, tb] = await mean(topShot);
    const [br, bg, bb] = await mean(botShot);

    await page.evaluate(() => {
      document.getElementById('zamer-bez-sceny')?.remove();
    });
    return {
      top: [tr, tg, tb] as const,
      bottom: [br, bg, bb] as const,
      spread: [Math.abs(tr - br), Math.abs(tg - bg), Math.abs(tb - bb)] as const,
    };
  }

  const MAX_SPREAD_FORM = 10;
  const MAX_SPREAD_FAQ = 22;

  const MAX_SPREAD_FAQ_ITEM = 170;

  const MAX_SPREAD_CARD = 72;

  test('панель заявки (десктоп): верх и низ пластины — один и тот же блик', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.ru);
    await page.locator('#lead-form').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const r = await glossSpread(page, '.lead-form__form');
    expect(r, '.lead-form__form не найдена').not.toBeNull();
    expect(
      Math.max(...r!.spread),
      `панель заявки: верх rgb(${r!.top.map((v) => v.toFixed(1))}), низ rgb(${r!.bottom.map((v) => v.toFixed(1))}), разрыв ${r!.spread.map((v) => v.toFixed(1))}`,
    ).toBeLessThan(MAX_SPREAD_FORM);
  });

  test('панель вопросов (телефон, <1050px): верх и низ пластины — один и тот же блик', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.ru);
    await page.locator('#faq-title').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const r = await glossSpread(page, '.faq-accordion');
    expect(r, '.faq-accordion не найдена').not.toBeNull();
    expect(
      Math.max(...r!.spread),
      `панель вопросов: верх rgb(${r!.top.map((v) => v.toFixed(1))}), низ rgb(${r!.bottom.map((v) => v.toFixed(1))}), разрыв ${r!.spread.map((v) => v.toFixed(1))}`,
    ).toBeLessThan(MAX_SPREAD_FAQ);
  });

  test('пункт вопроса (десктоп, ≥1050px): верх и низ пластины — один и тот же блик', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.ru);
    await page.locator('#faq-title').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const r = await glossSpread(page, '.faq-item');
    expect(r, '.faq-item не найден').not.toBeNull();
    expect(
      Math.max(...r!.spread),
      `пункт вопроса (десктоп): верх rgb(${r!.top.map((v) => v.toFixed(1))}), низ rgb(${r!.bottom.map((v) => v.toFixed(1))}), разрыв ${r!.spread.map((v) => v.toFixed(1))}`,
    ).toBeLessThan(MAX_SPREAD_FAQ_ITEM);
  });

  test('карточка направления (десктоп, ≥1050px): верх и низ пластины — один и тот же блик', async ({
    page,
  }) => {

    await page.setViewportSize({ width: 1440, height: 2000 });
    await page.goto(PAGE_ROUTES.home.ru);

    await page.locator('#direction-bank > summary').click();
    await page.waitForTimeout(400);
    await page.locator('#direction-bank').scrollIntoViewIfNeeded();

    await page.evaluate(() => window.scrollBy({ top: 40, behavior: 'instant' }));
    await page.waitForTimeout(300);
    const r = await glossSpread(page, '#direction-bank');
    expect(r, '.direction-card не найдена').not.toBeNull();
    expect(
      Math.max(...r!.spread),
      `карточка направления: верх rgb(${r!.top.map((v) => v.toFixed(1))}), низ rgb(${r!.bottom.map((v) => v.toFixed(1))}), разрыв ${r!.spread.map((v) => v.toFixed(1))}`,
    ).toBeLessThan(MAX_SPREAD_CARD);
  });

  test('карточка направления (десктоп, ≥1050px): клик мышью переключает состояние и меняет пиксели', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 2000 });
    await page.goto(PAGE_ROUTES.home.ru);
    const card = page.locator('#direction-bank');
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    const box = await card.boundingBox();
    expect(box, '#direction-bank не найдена').not.toBeNull();
    const clip = {
      x: Math.round(box!.x),
      y: Math.round(box!.y),
      width: Math.round(box!.width),
      height: Math.round(box!.height),
    };
    const before = await page.screenshot({ clip });

    await page.locator('#direction-bank .direction-summary-copy').click();
    await page.waitForTimeout(300);
    await expect(card, 'клик мышью не переключил атрибут open').toHaveJSProperty('open', true);

    const after = await page.screenshot({ clip });
    const beforeRaw = await sharp(before).ensureAlpha().raw().toBuffer();
    const afterRaw = await sharp(after).ensureAlpha().raw().toBuffer();
    expect(
      beforeRaw.length === afterRaw.length && Buffer.compare(beforeRaw, afterRaw) === 0,
      'клик мышью по заголовку карточки НЕ изменил ни одного пикселя',
    ).toBe(false);

    await page.evaluate(() => {
      const el = document.querySelector<HTMLDetailsElement>('#direction-bank');
      if (el) el.open = false;
    });
  });

  test('карточка направления (десктоп, ≥1050px): клавиатура тоже переключает состояние и меняет пиксели', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 2000 });
    await page.goto(PAGE_ROUTES.home.ru);
    const card = page.locator('#direction-bank');
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    const box = await card.boundingBox();
    expect(box, '#direction-bank не найдена').not.toBeNull();
    const clip = {
      x: Math.round(box!.x),
      y: Math.round(box!.y),
      width: Math.round(box!.width),
      height: Math.round(box!.height),
    };

    await page.locator('#direction-bank summary').focus();
    const before = await page.screenshot({ clip });

    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await expect(
      card,
      'клавиатурный Enter не переключил атрибут open',
    ).toHaveJSProperty('open', true);

    const after = await page.screenshot({ clip });
    const beforeRaw = await sharp(before).ensureAlpha().raw().toBuffer();
    const afterRaw = await sharp(after).ensureAlpha().raw().toBuffer();
    expect(
      beforeRaw.length === afterRaw.length && Buffer.compare(beforeRaw, afterRaw) === 0,
      'клавиатурный Enter НЕ изменил ни одного пикселя карточки',
    ).toBe(false);

    await page.evaluate(() => {
      const el = document.querySelector<HTMLDetailsElement>('#direction-bank');
      if (el) el.open = false;
    });
  });

  test('карточка направления (десктоп, ≥1050px): наведение подсвечивает кромку стекла, курсор остаётся pointer, фокус-кольцо остаётся видимым', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 2000 });
    await page.goto(PAGE_ROUTES.home.ru);
    const card = page.locator('#direction-bank');
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    const readGlassState = () =>
      page.evaluate(() => {
        const summary = document.querySelector<HTMLElement>('#direction-bank .direction-summary');
        const cardEl = document.querySelector<HTMLElement>('#direction-bank');
        const shadow = cardEl ? getComputedStyle(cardEl).boxShadow : '';

        const parts = shadow.split(/,(?![^()]*\))/).map((p) => p.trim()).filter(Boolean);
        const fill = parts.at(-1) ?? '';
        const alphaMatch = fill.match(/rgba?\(\s*255,\s*255,\s*255,\s*([\d.]+)\s*\)/);
        return {
          cursor: summary ? getComputedStyle(summary).cursor : null,
          beforeOpacity: cardEl ? getComputedStyle(cardEl, '::before').opacity : null,
          shadowCount: parts.length,
          fillAlpha: alphaMatch ? Number(alphaMatch[1]) : 0,
        };
      });

    const rest = await readGlassState();
    expect(rest.cursor, 'курсор в покое обязан быть pointer — вся карточка кликабельна').toBe('pointer');
    expect(
      rest.beforeOpacity,
      'блик карточки (::before) в покое обязан идти в ПОЛНУЮ силу — приглушения нет ни у одной поверхности ранга A',
    ).toBe('1');
    expect(rest.shadowCount, 'в покое: пара верхней грани + заливка отклика').toBe(3);
    expect(rest.fillAlpha, 'в покое заливка отклика обязана быть прозрачной').toBe(0);

    const target = page.locator('#direction-bank .direction-summary-copy');
    const box = await target.boundingBox();
    expect(box, '.direction-summary-copy не найдена').not.toBeNull();

    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.waitForTimeout(200);

    const hovered = await readGlassState();
    expect(hovered.cursor, 'курсор на наведении обязан остаться pointer').toBe('pointer');
    expect(
      hovered.beforeOpacity,
      'наведение не имеет права трогать блик — он и так в полную силу',
    ).toBe('1');
    expect(
      hovered.shadowCount,
      'длина списка теней на наведении обязана совпадать с покоем, иначе переход поедет ободком',
    ).toBe(rest.shadowCount);
    expect(
      hovered.fillAlpha,
      'наведение не дало материального отклика: заливка в box-shadow карточки не посветлела',
    ).toBeGreaterThan(rest.fillAlpha);

    await page.evaluate(() => {
      const summary = document.querySelector<HTMLElement>('#direction-bank summary');

      summary?.focus({ focusVisible: true } as FocusOptions);
    });
    const outlineStyle = await page.evaluate(() => {
      const cardEl = document.querySelector<HTMLElement>('#direction-bank');
      return cardEl ? getComputedStyle(cardEl).outlineStyle : null;
    });
    expect(outlineStyle, 'фокус-кольцо (WCAG 2.4.7) пропало').not.toBe('none');
  });
});
