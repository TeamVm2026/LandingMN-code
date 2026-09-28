import { test, expect, type Page } from '@playwright/test';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';
import { DESKTOP_VIEWPORT } from '../playwright.config';

const LOCALE: Locale = 'mn';

async function openAllCards(page: Page) {
  await page.locator('details[data-track-direction]').first().waitFor();
  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLDetailsElement>('details[data-track-direction]')
      .forEach((el) => {
        el.open = true;
      });
  });
}

test.describe('D-02: раскрытие карточки при выключенных анимациях идёт одним кадром', () => {
  const ms = (v: string) => Math.max(...v.split(',').map((p) => parseFloat(p) * 1000));

  for (const width of [390, DESKTOP_VIEWPORT.width]) {
    test(`${width}: ни длительности, ни задержки у содержимого раскрытой карточки`, async ({
      browser,
      baseURL,
    }) => {

      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      try {
        await page.goto(new URL(PAGE_ROUTES.home[LOCALE], baseURL).toString());
        expect(
          await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
          'настройка reduce до страницы не доехала — тест мерил бы не то',
        ).toBe(true);

        await openAllCards(page);

        const probes = await page.locator('.direction-body-inner').evaluateAll((nodes) =>
          nodes.map((n) => {
            const cs = getComputedStyle(n);
            return {
              delay: cs.transitionDelay,
              duration: cs.transitionDuration,
              opacity: cs.opacity,
            };
          }),
        );

        expect(probes.length, 'содержимого карточек на странице не три').toBe(3);

        for (const p of probes) {

          expect(
            ms(p.delay),
            'у содержимого раскрытой карточки осталась ЗАДЕРЖКА перехода при ' +
              'выключенных анимациях — текст появится отдельным кадром. Причин две ' +
              'и они независимы: (1) блок @media(prefers-reduced-motion) в ' +
              'DirectionCards.astro снова стоит ВЫШЕ правила ' +
              '`details[open] .direction-body-inner` и проигрывает ему по порядку; ' +
              '(2) в глобальном глушителе tokens.css пропал `transition-delay`.',
          ).toBeLessThanOrEqual(1);

          expect(
            ms(p.duration),
            'у содержимого раскрытой карточки осталась ДЛИТЕЛЬНОСТЬ перехода при ' +
              'выключенных анимациях',
          ).toBeLessThanOrEqual(1);

          expect(Number(p.opacity), 'содержимое раскрытой карточки невидимо').toBe(1);
        }
      } finally {
        await ctx.close();
      }
    });
  }
});

test.describe('D-01: наведение на плашку формы даёт кольцо, а не только цвет текста', () => {
  test('десктоп: box-shadow у .chip-radio под курсором отличается от покоя', async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto(PAGE_ROUTES.home[LOCALE]);

    const chip = page.locator('.field--direction .chip-radio:not(:has(input:checked))').first();
    await chip.scrollIntoViewIfNeeded();

    const shadow = () => chip.evaluate((el) => getComputedStyle(el).boxShadow);

    const rest = await shadow();
    await chip.hover();
    const hovered = await shadow();

    expect(
      hovered,
      'при наведении на плашку не появилось кольцо. Самая вероятная причина — ' +
        'снова оборванный комментарий в LeadFormMarkup.astro: последовательность ' +
        '«звёздочка-слеш» внутри врезки закрывает её досрочно, и следующее за ней ' +
        'объявление browser отбрасывает целиком. Прогони npm run check:cascade-order.',
    ).not.toBe(rest);

    expect(hovered, 'кольцо наведения не нарисовано вовсе').not.toBe('none');
  });
});

test.describe('D-03: подпись плашки формы крупнее на десктопе', () => {
  const size = (page: Page) =>
    page.locator('.chip-radio__text').first().evaluate((el) => getComputedStyle(el).fontSize);

  test('от 860px подпись 13px, ниже — 11px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home[LOCALE]);
    expect(
      await size(page),
      'на десктопе подпись плашки осталась телефонной. Медиазапрос ' +
        '`min-width: 860px` в LeadFormMarkup.astro снова стоит ВЫШЕ базового ' +
        'правила `.chip-radio__text` и проигрывает ему по порядку.',
    ).toBe('13px');

    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await size(page),
      'на телефоне подпись выросла — замер запаса ширины (70,5 из 75,3 CSS на ' +
        '«Bank Transfer») этого не выдержит, подпись порвётся',
    ).toBe('11px');
  });
});

test.describe('D-04: значок плитки совпадает со своей дорожкой сетки', () => {
  for (const [width, expected] of [
    [390, 24],
    [430, 24],
    [640, 26],
    [DESKTOP_VIEWPORT.width, 26],
  ] as const) {
    test(`${width}: значок ${expected}px и вписан в дорожку`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(PAGE_ROUTES.home[LOCALE]);
      await page.evaluate(() => document.fonts.ready);
      await openAllCards(page);

      const tiles = await page.locator('.direction-gain').evaluateAll((nodes) =>
        nodes.map((tile) => {
          const mark = tile.querySelector('.direction-gain-mark')!.getBoundingClientRect();
          const track = getComputedStyle(tile).gridTemplateColumns.split(' ')[0];
          return { size: Math.round(mark.width), track: Math.round(parseFloat(track)) };
        }),
      );

      expect(tiles.length, 'плиток на странице не восемнадцать').toBe(18);
      for (const t of tiles) {
        expect(
          t.size,
          `значок плитки на ${width} не ${expected}px — медиазапрос размера ` +
            'в DirectionCards.astro снова перебит базовым правилом ниже по файлу',
        ).toBe(expected);

        expect(
          t.size,
          'значок шире своей дорожки сетки — он вылезает в зазор между колонками',
        ).toBeLessThanOrEqual(t.track);
      }
    });
  }
});
