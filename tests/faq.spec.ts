
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';
import { DESKTOP_VIEWPORT } from '../playwright.config';

const LOCALES: Locale[] = ['mn', 'ru', 'en'];
const FAQ_ITEMS = 5;

function dict(locale: Locale): Record<string, Record<string, string>> {
  return JSON.parse(
    readFileSync(path.join(import.meta.dirname, '..', 'src', 'i18n', `${locale}.json`), 'utf8'),
  ) as Record<string, Record<string, string>>;
}

test.describe('FAQ accordion (LAND-07)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test(`renders exactly ${FAQ_ITEMS} native <details> FAQ items`, async ({ page }) => {
    const items = page.locator('.faq-accordion details');
    const count = await items.count();
    expect(count).toBe(FAQ_ITEMS);
  });

  test('раскрытие FAQ и карточки направления не блокирует прокрутку — единое правило страницы', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const html = page.locator('html');
    const faqSummary = page.locator('.faq-accordion summary').first();
    const cardSummary = page.locator('details[data-track-direction="bank"] > summary');

    const wheelMoves = async (): Promise<boolean> => {
      const before = await page.evaluate(() => window.scrollY);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(150);
      return (await page.evaluate(() => window.scrollY)) > before;
    };

    await faqSummary.click();
    await expect(page.locator('.faq-accordion details').first()).toHaveJSProperty('open', true);
    await expect(html).not.toHaveClass(/scroll-locked/);
    expect(await wheelMoves(), 'колесо не прокручивает страницу при раскрытом вопросе FAQ').toBe(
      true,
    );

    await page.evaluate(() => window.scrollTo(0, 0));
    await cardSummary.scrollIntoViewIfNeeded();
    await cardSummary.click();
    await expect(page.locator('details[data-track-direction="bank"]')).toHaveJSProperty(
      'open',
      true,
    );
    await expect(html).not.toHaveClass(/scroll-locked/);
    await expect(page.locator('body')).not.toHaveClass(/scroll-locked/);
    expect(
      await wheelMoves(),
      'колесо не прокручивает страницу при раскрытой карточке направления',
    ).toBe(true);

    const overflow = await page.evaluate(() => ({
      html: getComputedStyle(document.documentElement).overflow,
      body: getComputedStyle(document.body).overflow,
    }));
    expect(overflow.html, 'у <html> появился overflow, прячущий прокрутку').not.toBe('hidden');
    expect(overflow.body, 'у <body> появился overflow, прячущий прокрутку').not.toBe('hidden');
  });

  test('click toggles the first FAQ item open, then closed', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const firstDetails = page.locator('.faq-accordion details').first();
    const firstSummary = firstDetails.locator('summary').first();

    await expect(firstDetails).toHaveJSProperty('open', false);

    await firstSummary.click();
    await expect(firstDetails).toHaveJSProperty('open', true);

    await firstSummary.click();
    await expect(firstDetails).toHaveJSProperty('open', false);
  });

  test('keyboard (Tab focus + Enter/Space) toggles the same native details element', async ({
    page,
  }) => {
    const firstDetails = page.locator('.faq-accordion details').first();
    const firstSummary = firstDetails.locator('summary').first();

    await firstSummary.focus();
    await expect(firstSummary).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(firstDetails).toHaveJSProperty('open', true);

    await page.keyboard.press('Enter');
    await expect(firstDetails).toHaveJSProperty('open', false);

    await page.keyboard.press('Space');
    await expect(firstDetails).toHaveJSProperty('open', true);
  });

  test('emits exactly one FAQPage JSON-LD script mirroring the visible content', async ({
    page,
  }) => {
    const scripts = page.locator('script[type="application/ld+json"]');
    const scriptCount = await scripts.count();

    let faqPageCount = 0;
    for (let i = 0; i < scriptCount; i++) {
      const text = (await scripts.nth(i).innerText()).trim();
      if (!text.includes('"@type":"FAQPage"')) continue;
      faqPageCount += 1;

      const schema = JSON.parse(text) as {
        mainEntity: { name: string; acceptedAnswer: { text: string } }[];
      };
      expect(schema.mainEntity.length).toBe(FAQ_ITEMS);

      const firstVisibleQuestion = await page
        .locator('.faq-accordion details')
        .first()
        .locator('summary')
        .innerText();
      expect(firstVisibleQuestion).toContain(schema.mainEntity[0].name);
    }

    expect(faqPageCount).toBe(1);
  });
});

test.describe('FAQ — вопрос о законности СНЯТ (Д-35) и порядок обхода (Д-18)', () => {
  const DOM_ORDER = ['support', 'onboarding', 'bt_capital', 'training', 'currency'];

  for (const locale of LOCALES) {
    test(`вопроса о законности НЕТ ни в разметке, ни в словаре (${locale})`, async ({
      page,
    }) => {
      await page.goto(PAGE_ROUTES.home[locale]);
      const d = dict(locale);

      const keys = await page
        .locator('.faq-accordion details')
        .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.faqKey));
      expect(keys, 'порядок пунктов FAQ в разметке').toEqual(DOM_ORDER);

      expect(d.faq.q_legal, `faq.q_legal обязан быть удалён из ${locale}.json (Д-35)`).toBeUndefined();
      expect(d.faq.a_legal, `faq.a_legal обязан быть удалён из ${locale}.json (Д-35)`).toBeUndefined();

      const legal = page.locator('.faq-accordion details[data-faq-key="legal"]');
      await expect(legal, 'пункт о законности вернулся в разметку (Д-35)').toHaveCount(0);

      const blockText = ((await page.locator('.faq-accordion').textContent()) ?? '').toLowerCase();
      expect(blockText, 'в блоке вопросов появилось слово «крипт»').not.toContain('крипт');
      expect(blockText, 'в блоке вопросов появилось слово «crypto»').not.toContain('crypto');

      const currency =
        (await page
          .locator('.faq-accordion details[data-faq-key="currency"] .faq-answer p')
          .textContent()) ?? '';
      expect(currency, 'из ответа про валюту пропал ₮').toContain('₮');
    });
  }

  test('порядок клавиатурного обхода совпадает с порядком в разметке (1440)', async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/');

    const domKeys = await page
      .locator('.faq-accordion details')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.faqKey));
    expect(domKeys).toEqual(DOM_ORDER);

    await page.locator('.faq-accordion summary').first().focus();
    const visited: (string | undefined)[] = [];
    for (let i = 0; i < domKeys.length; i++) {
      visited.push(
        await page.evaluate(
          () => (document.activeElement?.closest('details') as HTMLElement | null)?.dataset.faqKey,
        ),
      );
      if (i < domKeys.length - 1) await page.keyboard.press('Tab');
    }
    expect(visited, 'таб уводит не по порядку разметки').toEqual(domKeys);

    const tops = await page
      .locator('.faq-accordion details')
      .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    for (let i = 1; i < tops.length; i++) {
      expect(
        tops[i],
        `пункт «${domKeys[i]}» визуально выше более раннего «${domKeys[i - 1]}»`,
      ).toBeGreaterThanOrEqual(tops[i - 1] - 1);
    }
  });

  for (const width of [390, 360]) {
    test(`на ${width}px блок идёт одной колонкой и не даёт горизонтальной прокрутки`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');

      const boxes = await page
        .locator('.faq-accordion details')
        .evaluateAll((els) =>
          els.map((e) => {
            const r = e.getBoundingClientRect();
            return { left: Math.round(r.left), top: Math.round(r.top) };
          }),
        );
      expect(boxes.length).toBe(DOM_ORDER.length);
      for (let i = 1; i < boxes.length; i++) {
        expect(boxes[i].left, `на ${width}px пункты разъехались по колонкам`).toBe(boxes[0].left);
        expect(boxes[i].top, `на ${width}px пункт не ниже предыдущего`).toBeGreaterThan(
          boxes[i - 1].top,
        );
      }

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `на ${width}px появилась горизонтальная прокрутка`).toBeLessThanOrEqual(0);
    });
  }
});

test.describe('Д-18: разброс на десктопе, столбик на телефоне', () => {
  test('1440: пункты разъехались по горизонтали, но идут строго сверху вниз', async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto(PAGE_ROUTES.home.mn);

    const boxes = await page.locator('.faq-accordion details').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width) };
      }),
    );
    expect(boxes.length).toBe(FAQ_ITEMS);

    let shifted = 0;
    for (let i = 1; i < boxes.length; i++) {
      if (Math.abs(boxes[i]!.left - boxes[i - 1]!.left) > 40) shifted += 1;
    }
    expect(
      shifted,
      `пункты не разъехались по горизонтали: левые кромки ${boxes.map((b) => b.left).join(', ')}`,
    ).toBe(FAQ_ITEMS - 1);

    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i]!.top, `пункт ${i + 1} не ниже предыдущего`).toBeGreaterThan(boxes[i - 1]!.top);
    }

    const container = await page
      .locator('.faq-accordion')
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right) };
      });
    for (const [i, b] of boxes.entries()) {
      expect(b.left, `пункт ${i + 1} вылез за левую кромку блока`).toBeGreaterThanOrEqual(
        container.left - 1,
      );
      expect(b.left + b.width, `пункт ${i + 1} вылез за правую кромку блока`).toBeLessThanOrEqual(
        container.right + 1,
      );
    }
  });

  test('1440: у каждого пункта появилась собственная поверхность', async ({ page }) => {

    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto(PAGE_ROUTES.home.mn);

    const styles = await page.locator('.faq-accordion details').evaluateAll((els) =>
      els.map((el) => {
        const cs = getComputedStyle(el);
        return { radius: cs.borderTopLeftRadius, bg: cs.backgroundColor, border: cs.borderTopWidth };
      }),
    );
    expect(styles.length).toBe(FAQ_ITEMS);
    for (const [i, s] of styles.entries()) {
      expect(parseFloat(s.radius), `у пункта ${i + 1} нет радиуса поверхности`).toBeGreaterThan(0);
      expect(parseFloat(s.border), `у пункта ${i + 1} нет волосяной кромки`).toBeGreaterThan(0);
      expect(s.bg, `у пункта ${i + 1} нет заливки поверхности`).not.toBe('rgba(0, 0, 0, 0)');
    }
  });

  for (const width of [390, 360]) {
    test(`${width}: карточек НЕТ, подача осталась прежней`, async ({ page }) => {

      await page.setViewportSize({ width, height: 844 });
      await page.goto(PAGE_ROUTES.home.mn);

      const radii = await page
        .locator('.faq-accordion details')
        .evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius)));
      expect(radii.length).toBe(FAQ_ITEMS);
      for (const [i, r] of radii.entries()) {
        expect(r, `на ${width} у пункта ${i + 1} появилась коробка`).toBe(0);
      }
    });
  }

  test('фоновых «?» на странице нет ни на одной ширине', async ({ page }) => {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(PAGE_ROUTES.home.mn);
      await expect(
        page.locator('.faq-marks'),
        `на ${width} вернулась декорация «?» — заказчик просил её убрать`,
      ).toHaveCount(0);
    }
  });

  test('1440: все ответы видны сразу и нажатие ничего не сворачивает', async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto(PAGE_ROUTES.home.ru);
    await page.locator('.faq-accordion').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    const shown = async () =>
      page.locator('.faq-answer p').evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { h: Math.round(r.height), op: Number(getComputedStyle(el).opacity) };
        }),
      );

    const before = await shown();
    expect(before.length, 'вопросов на десктопе не пять').toBe(5);
    for (const [i, a] of before.entries()) {
      expect(a.h, `ответ ${i + 1} не отрисован (высота ${a.h})`).toBeGreaterThan(10);
      expect(a.op, `ответ ${i + 1} прозрачен (opacity ${a.op})`).toBe(1);
    }

    await expect(page.locator('.faq-item .faq-caret').first()).toBeHidden();

    await page.locator('.faq-summary').first().click({ force: true });
    await page.waitForTimeout(400);
    const after = await shown();
    for (const [i, a] of after.entries()) {
      expect(a.h, `после нажатия ответ ${i + 1} схлопнулся`).toBeGreaterThan(10);
      expect(a.op, `после нажатия ответ ${i + 1} погас`).toBe(1);
    }
  });
});

test.describe('Вопрос FAQ раскрывается ходом, а не ступенью', () => {

  async function hodPervogoVoprosa(page: import('@playwright/test').Page) {
    return page.evaluate(async () => {
      const el = document.querySelector('.faq-item') as HTMLDetailsElement;
      const sum = el.querySelector('summary') as HTMLElement;
      const ryad: number[] = [];
      let t0: number | null = null;
      const tick = () => {
        const t = performance.now();
        ryad.push(+el.getBoundingClientRect().height.toFixed(1));
        if (t0 === null || t - t0 < 600) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await new Promise((r) => setTimeout(r, 50));
      t0 = performance.now();
      sum.click();
      await new Promise((r) => setTimeout(r, 800));
      const nachalo = ryad[0];
      const konec = ryad[ryad.length - 1];
      const nij = Math.min(nachalo, konec);
      const verh = Math.max(nachalo, konec);
      return {
        nachalo,
        konec,
        vPuti: ryad.filter((h) => h > nij + 1 && h < verh - 1).length,
      };
    });
  }

  test('раскрытие и сворачивание идут промежуточными кадрами, а не одним', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.mn);
    await page.locator('.faq-item').first().scrollIntoViewIfNeeded();

    const otkrytie = await hodPervogoVoprosa(page);
    expect(otkrytie.konec, 'вопрос не раскрылся вовсе').toBeGreaterThan(otkrytie.nachalo);

    expect(
      otkrytie.vPuti,
      'раскрытие пришло одним куском — механизм ::details-content снова не работает',
    ).toBeGreaterThanOrEqual(8);

    const svorachivanie = await hodPervogoVoprosa(page);
    expect(svorachivanie.konec, 'вопрос не свернулся').toBeLessThan(svorachivanie.nachalo);
    expect(
      svorachivanie.vPuti,
      'сворачивание пришло одним куском',
    ).toBeGreaterThanOrEqual(8);

    const mehanizm = await page
      .locator('.faq-item')
      .first()
      .evaluate((el) => getComputedStyle(el, '::details-content').transitionProperty);
    expect(
      mehanizm,
      'клип вернулся к grid-template-rows — внутри <details> он не исполняется',
    ).toContain('block-size');
  });

  test('prefers-reduced-motion гасит ход полностью', async ({ browser }) => {

    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    await page.goto(PAGE_ROUTES.home.mn);
    await page.locator('.faq-item').first().scrollIntoViewIfNeeded();

    const hod = await hodPervogoVoprosa(page);
    expect(hod.konec, 'вопрос не раскрылся при reduce — содержимое потеряно').toBeGreaterThan(
      hod.nachalo,
    );

    expect(hod.vPuti, 'движение идёт у того, кто его отключил').toBeLessThanOrEqual(1);
    await ctx.close();
  });
});

test.describe('05.09.2026: рамки у блока нет, карточки вдвое уже', () => {
  for (const width of [1050, 1440, 1920]) {
    test(`${width}: у контейнера блока нет ни собственной кромки, ни фильтра`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(PAGE_ROUTES.home.mn);

      const s = await page.locator('.faq-accordion').evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          boxShadow: cs.boxShadow,
          backdrop: cs.backdropFilter,

          bgImage: cs.backgroundImage,
          bgColor: cs.backgroundColor,
          before: getComputedStyle(el, '::before').content,
          after: getComputedStyle(el, '::after').content,
        };
      });

      expect(
        s.boxShadow,
        'десктопному контейнеру вернули кромку — это и есть та самая «квадратная рамка»',
      ).toBe('none');
      expect(
        s.backdrop,
        'десктопному контейнеру вернули backdrop-filter — фон внутри снова отличается от основного',
      ).toBe('none');
      expect(s.bgImage, 'десктопному контейнеру вернули заливку/блик').toBe('none');
      expect(s.bgColor, 'десктопному контейнеру вернули цвет фона').toBe('rgba(0, 0, 0, 0)');
      expect(s.before, 'слой толщины контейнера вернулся на десктоп').toBe('none');
      expect(s.after, 'кольцо контейнера вернулось на десктоп').toBe('none');
    });
  }

  test('1440 + prefers-reduced-transparency: рамки тоже нет', async ({ page }) => {

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    });
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto(PAGE_ROUTES.home.mn);

    const s = await page.locator('.faq-accordion').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { boxShadow: cs.boxShadow, bgImage: cs.backgroundImage, bgColor: cs.backgroundColor };
    });
    expect(s.boxShadow, 'при «меньше прозрачности» прямоугольник вернулся').toBe('none');
    expect(s.bgImage, 'при «меньше прозрачности» контейнер снова красится').toBe('none');
    expect(s.bgColor, 'при «меньше прозрачности» контейнер снова красится').toBe('rgba(0, 0, 0, 0)');
  });

  test('390: панель телефона НЕ тронута — кромка на месте', async ({ page }) => {

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.mn);
    const s = await page.locator('.faq-accordion').evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        boxShadow: cs.boxShadow,
        bgImage: cs.backgroundImage,
        radius: cs.borderTopLeftRadius,
      };
    });
    expect(s.boxShadow, 'у телефонной панели забрали кромку').not.toBe('none');
    expect(s.bgImage, 'у телефонной панели забрали заливку').not.toBe('none');
    expect(parseFloat(s.radius), 'у телефонной панели забрали радиус').toBeGreaterThan(0);
  });

  const STUPENI = [
    {
      label: 'точная (≥1260)',
      widths: [1260, 1440, 1920],
      columns: [

        ['2', 'span 4'],
        ['9', 'span 4'],
        ['4', 'span 5'],
        ['10', 'span 3'],
        ['1', 'span 4'],
      ],
    },
    {
      label: 'мягкая (1050…1259)',
      widths: [1050, 1151, 1259],
      columns: [

        ['2', 'span 5'],
        ['9', 'span 4'],
        ['4', 'span 5'],
        ['9', 'span 4'],
        ['1', 'span 4'],
      ],
    },
  ] as const;

  for (const stupen of STUPENI) {
    for (const width of stupen.widths) {
      test(`${width}: раскладка — ступень ${stupen.label}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(PAGE_ROUTES.home.mn);

        const data = await page.evaluate(() => {
          const acc = document.querySelector('.faq-accordion') as HTMLElement;
          const items = [...document.querySelectorAll('.faq-item')] as HTMLElement[];
          const box = acc.getBoundingClientRect();
          return {
            tracks: getComputedStyle(acc).gridTemplateColumns.split(' ').length,
            container: { left: box.left, right: box.right, width: box.width },
            items: items.map((el) => {
              const b = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              return {
                left: b.left,
                right: b.right,
                width: b.width,
                start: cs.gridColumnStart,
                end: cs.gridColumnEnd,
              };
            }),
          };
        });

        expect(data.tracks, 'сетка перестала быть двенадцатидольной').toBe(12);
        expect(data.items.length).toBe(FAQ_ITEMS);

        expect(
          data.items.map((i) => [i.start, i.end]),
          'набор колонок разошёлся с контрактом раскладки (LAYOUT-CONTRACT.md)',
        ).toEqual(stupen.columns.map((c) => [c[0], c[1]]));

        for (const [i, b] of data.items.entries()) {
          expect(
            b.width / data.container.width,
            `пункт ${i + 1} шире половины блока — ленты вернулись`,
          ).toBeLessThanOrEqual(0.45);
        }

        for (const i of [4]) {
          expect(
            Math.abs(data.items[i]!.left - data.container.left),
            `пункт ${i + 1} отошёл от левой кромки блока`,
          ).toBeLessThanOrEqual(1);
        }
        for (const i of [1, 3]) {
          expect(
            Math.abs(data.items[i]!.right - data.container.right),
            `пункт ${i + 1} отошёл от правой кромки блока`,
          ).toBeLessThanOrEqual(1);
        }

        const otstup = data.items[0]!.left - data.container.left;
        expect(otstup, 'пункт 1 вернулся к левой кромке — сдвиг вправо потерян').toBeGreaterThan(
          40,
        );
        expect(otstup, 'пункт 1 уехал дальше одной доли сетки').toBeLessThan(
          data.container.width / 8,
        );

        const samyjUzkij = Math.min(...data.items.map((b) => b.width));
        expect(
          data.items[0]!.width,
          'пункт 1 снова самый узкий в наборе — «подлиннее» отменено',
        ).toBeGreaterThan(samyjUzkij + 1);

        const razmery = new Set(data.items.map((b) => Math.round(b.width)));
        expect(
          razmery.size,
          'все пункты стали одной ширины — разнообразие потеряно',
        ).toBeGreaterThanOrEqual(2);

        for (const [i, b] of data.items.entries()) {
          expect(b.left, `пункт ${i + 1} вылез за левую кромку`).toBeGreaterThanOrEqual(
            data.container.left - 1,
          );
          expect(b.right, `пункт ${i + 1} вылез за правую кромку`).toBeLessThanOrEqual(
            data.container.right + 1,
          );
        }
      });
    }
  }

  for (const width of [1050, 1151]) {
    for (const locale of LOCALES) {
      test(`${width} ${locale}: мера строки ответа не ушла ниже 27 знаков`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(PAGE_ROUTES.home[locale]);

        const mery = await page.locator('.faq-item').evaluateAll((els) =>
          els.map((el) => {
            const p = el.querySelector('.faq-answer p');
            const node = p && p.firstChild;
            if (!node || node.nodeType !== 3) return null;
            const text = node.textContent ?? '';
            const range = document.createRange();
            const lines: number[] = [];
            let curTop: number | null = null;
            let count = 0;
            for (let i = 0; i < text.length; i++) {
              range.setStart(node, i);
              range.setEnd(node, i + 1);
              const rect = range.getClientRects()[0];
              if (!rect) {
                count++;
                continue;
              }
              const top = Math.round(rect.top);
              if (curTop === null) curTop = top;
              else if (Math.abs(top - curTop) > 3) {
                lines.push(count);
                curTop = top;
                count = 0;
              }
              count++;
            }
            lines.push(count);

            return lines.length > 1 ? Math.max(...lines.slice(0, -1)) : text.length;
          }),
        );

        for (const [i, m] of mery.entries()) {
          expect(m, `у пункта ${i + 1} не нашлось текста ответа`).not.toBeNull();
          expect(
            m!,
            `мера строки у пункта ${i + 1} на ${width}px опустилась до ${m} знаков`,
          ).toBeGreaterThanOrEqual(27);
        }
      });
    }
  }
});
