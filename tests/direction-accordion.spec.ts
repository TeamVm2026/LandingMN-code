
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';
import { MOBILE_VIEWPORT, DESKTOP_VIEWPORT } from '../playwright.config';

const PROGRAMS = ['affiliate', 'bank', 'teamcash'] as const;
const LOCALE: Locale = 'mn';

const detailsSelector = (program: string) => `details[data-track-direction="${program}"]`;
const summarySelector = (program: string) => `${detailsSelector(program)} > summary`;

for (const program of PROGRAMS) {
  test.describe(`DirectionCards — аккордеон ${program} (LAND-03 / CMPL-02)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto(PAGE_ROUTES.home[LOCALE]);
    });

    test('раскрывается по нажатию на summary и показывает содержимое', async ({ page }) => {
      const card = page.locator(detailsSelector(program));
      const summary = page.locator(summarySelector(program));

      await expect(card).toHaveJSProperty('open', false);
      await summary.focus();
      await page.keyboard.press('Enter');
      await expect(card).toHaveJSProperty('open', true);

      await expect(card.locator('.direction-steps')).toBeVisible();
      await expect(card.locator('.direction-gains')).toBeVisible();
    });

    test('повторное нажатие сворачивает карточку', async ({ page }) => {
      const card = page.locator(detailsSelector(program));
      const summary = page.locator(summarySelector(program));

      await summary.focus();
      await page.keyboard.press('Enter');
      await expect(card).toHaveJSProperty('open', true);
      await page.keyboard.press('Enter');
      await expect(card).toHaveJSProperty('open', false);
    });

    test('клавиатура (Tab-фокус + Enter/Space) переключает карточку', async ({ page }) => {

      const card = page.locator(detailsSelector(program));
      const summary = page.locator(summarySelector(program));

      await summary.focus();
      await expect(summary).toBeFocused();

      await page.keyboard.press('Enter');
      await expect(card).toHaveJSProperty('open', true);

      await page.keyboard.press('Enter');
      await expect(card).toHaveJSProperty('open', false);

      await page.keyboard.press('Space');
      await expect(card).toHaveJSProperty('open', true);
    });

    test('раскрытое содержимое проходимо табом: фокус не застревает в карточке', async ({
      page,
    }) => {

      const summary = page.locator(summarySelector(program));
      await summary.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator(detailsSelector(program))).toHaveJSProperty('open', true);

      await summary.focus();
      await page.keyboard.press('Tab');

      const focusState = await page.evaluate((sel) => {
        const active = document.activeElement;
        const card = document.querySelector(sel);
        return {
          inBody: !!active && active !== document.body && active !== document.documentElement,
          insideCard: !!card && !!active && card.contains(active),
          tag: active?.tagName ?? '(none)',
        };
      }, detailsSelector(program));

      expect(focusState.inBody, 'фокус выпал из документа после Tab').toBe(true);
      expect(
        focusState.insideCard,
        `фокус застрял внутри раскрытой карточки (на ${focusState.tag}) — в ней нет фокусируемых элементов, Tab обязан идти дальше`,
      ).toBe(false);
    });

    test('кольцо фокуса на summary то же, что на остальных остановках страницы', async ({
      page,
    }) => {

      const summary = page.locator(summarySelector(program));
      await summary.focus();
      const cardOutline = await summary.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { width: cs.outlineWidth, style: cs.outlineStyle, color: cs.outlineColor };
      });

      const faqSummary = page.locator('.faq-accordion summary').first();
      await faqSummary.focus();
      const faqOutline = await faqSummary.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { width: cs.outlineWidth, style: cs.outlineStyle, color: cs.outlineColor };
      });

      expect(cardOutline.style, 'у summary карточки нет видимого кольца фокуса').not.toBe('none');
      expect(cardOutline, 'кольцо фокуса карточки разошлось с кольцом FAQ').toEqual(faqOutline);
    });

    test('summary несёт непустое доступное имя и роль с состоянием раскрытия', async ({
      page,
    }) => {

      const summary = page.locator(summarySelector(program));

      const name = (await summary.innerText()).trim();
      expect(name.length, 'у summary пустое доступное имя').toBeGreaterThan(0);

      await summary.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator(`${detailsSelector(program)}[open]`)).toHaveCount(1);
      await page.keyboard.press('Enter');
      await expect(page.locator(`${detailsSelector(program)}[open]`)).toHaveCount(0);
    });

    test('пары кнопок связи внутри карточки нет — Д-12 заперт', async ({ page }) => {

      const summary = page.locator(summarySelector(program));
      await summary.focus();
      await page.keyboard.press('Enter');
      const card = page.locator(detailsSelector(program));
      await expect(card).toHaveJSProperty('open', true);
      await expect(card.locator('.contact-btn, [data-track="messenger_click"]')).toHaveCount(0);
    });
  });
}

test.describe('DirectionCards — мобильный вьюпорт (I18N-04, нет переполнения с mn-строками)', () => {
  test('раскрытие карточки Bank Transfer на 390px не даёт горизонтального переполнения', async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(PAGE_ROUTES.home.mn);

    await page.locator(summarySelector('bank')).click();
    await expect(page.locator(detailsSelector('bank'))).toHaveJSProperty('open', true);

    const noOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(noOverflow).toBe(true);
  });
});

const ALL_LOCALES: Locale[] = ['mn', 'ru', 'en'];

function dictReceives(locale: Locale): Record<string, string[]> {
  const raw = JSON.parse(
    readFileSync(path.join(process.cwd(), 'src', 'i18n', `${locale}.json`), 'utf-8'),
  ) as { dialog: Record<string, { receives: Record<string, { title: string }> }> };
  const out: Record<string, string[]> = {};
  for (const program of PROGRAMS) {
    out[program] = [0, 1, 2, 3, 4, 5].map((i) => raw.dialog[program].receives[String(i)].title);
  }
  return out;
}

async function openAllCards(page: Page) {

  for (const summary of await page.locator('details[data-track-direction] > summary').all()) {
    await summary.evaluate((el) => {
      const details = el.closest('details');
      if (details) details.open = true;
    });
  }
  await expect(page.locator('details[data-track-direction][open]')).toHaveCount(3);
}

test.describe('DirectionCards — плитки «Что получает партнёр?» (LAND-03 / I18N-04)', () => {
  for (const locale of ALL_LOCALES) {
    test(`[${locale}] в каждой карточке ровно 6 плитки, у каждой один значок и непустая подпись`, async ({
      page,
    }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto(PAGE_ROUTES.home[locale]);
      await openAllCards(page);

      for (const program of PROGRAMS) {
        const tiles = page.locator(`${detailsSelector(program)} .direction-gain`);
        await expect(tiles, `в карточке ${program} не шесть плиток`).toHaveCount(6);

        for (let i = 0; i < 6; i++) {
          const tile = tiles.nth(i);

          await expect(
            tile.locator('.direction-gain-mark svg'),
            `плитка ${program}[${i}] несёт не один значок`,
          ).toHaveCount(1);
          const label = (await tile.locator('.direction-gain-label').innerText()).trim();
          expect(
            label.length,
            `подпись плитки ${program}[${i}] пуста (${locale})`,
          ).toBeGreaterThan(0);
        }
      }
    });

    test(`[${locale}] подписи плиток совпадают со словарём на диске — замок против подмены текстом макета`, async ({
      page,
    }) => {

      const expected = dictReceives(locale);
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto(PAGE_ROUTES.home[locale]);
      await openAllCards(page);

      for (const program of PROGRAMS) {
        const labels = await page
          .locator(`${detailsSelector(program)} .direction-gain-label`)
          .allInnerTexts();

        expect(expected[program], `словарь ${locale} не дал 6 подписей для ${program}`).toHaveLength(
          6,
        );
        for (const value of expected[program]) expect(value.trim().length).toBeGreaterThan(0);

        expect(
          labels.map((s) => s.trim()),
          `подписи плиток ${program} разошлись со словарём ${locale}`,
        ).toEqual(expected[program]);
      }
    });

    test(`[${locale}] значки: одинаковый текст плитки → одинаковый значок, разный текст → разный значок`, async ({
      page,
    }) => {

      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto(PAGE_ROUTES.home[locale]);
      await openAllCards(page);

      const tiles = await page.locator('.direction-gain').evaluateAll((nodes) =>
        nodes.map((el) => ({
          label: (el.querySelector('.direction-gain-label')?.textContent ?? '').trim(),
          glyph: el.querySelector('.direction-gain-mark svg')?.innerHTML ?? '',
        })),
      );

      expect(tiles.length, 'плиток на странице не восемнадцать').toBe(18);
      for (const t of tiles) {
        expect(t.label.length, 'подпись плитки пуста').toBeGreaterThan(0);
        expect(t.glyph.length, `значок плитки «${t.label}» пуст`).toBeGreaterThan(0);
      }

      const byLabel = new Map<string, string[]>();
      for (const t of tiles) {
        const glyphs = byLabel.get(t.label) ?? [];
        glyphs.push(t.glyph);
        byLabel.set(t.label, glyphs);
      }
      for (const [label, glyphs] of byLabel) {
        if (glyphs.length <= 1) continue;
        expect(
          new Set(glyphs).size,
          `текст «${label}» повторяется ${glyphs.length} раз(а), но значков среди них ${new Set(glyphs).size} — обязан быть один`,
        ).toBe(1);
      }

      for (const program of PROGRAMS) {
        const inCard = await page
          .locator(`${detailsSelector(program)} .direction-gain-mark svg`)
          .evaluateAll((nodes) => nodes.map((n) => n.innerHTML));
        expect(inCard.length).toBe(6);
        expect(new Set(inCard).size, `в карточке ${program} значки повторяются`).toBe(6);
      }
    });

    test(`[${locale}] плитка не выглядит и не ведёт себя как нажимаемый элемент`, async ({
      page,
    }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto(PAGE_ROUTES.home[locale]);
      await openAllCards(page);

      const state = await page.locator('.direction-gain').evaluateAll((nodes) =>
        nodes.map((el) => ({
          href: el.hasAttribute('href') || !!el.querySelector('a[href]'),
          role: el.getAttribute('role'),
          tabindex: el.hasAttribute('tabindex') || !!el.querySelector('[tabindex]'),
          control: !!el.querySelector('a, button, input, select, textarea, summary'),
        })),
      );
      expect(state.length, 'плиток на странице не восемнадцать').toBe(18);
      for (const s of state) {
        expect(s.href, 'плитка стала ссылкой').toBe(false);
        expect(s.role, 'плитке приписана роль нажимаемого элемента').toBeNull();
        expect(s.tabindex, 'плитка попала в порядок табуляции через tabindex').toBe(false);
        expect(s.control, 'внутри плитки появился фокусируемый элемент').toBe(false);
      }

      const summary = page.locator(summarySelector('bank'));
      await summary.focus();
      await page.keyboard.press('Tab');
      const inTile = await page.evaluate(
        () => !!document.activeElement?.closest('.direction-gain'),
      );
      expect(inTile, 'фокус зашёл в плитку — она не должна быть остановкой табуляции').toBe(false);
    });
  }

  test('словари: ни в одной из новых 36 строк нет длинного или короткого тире', () => {
    const DASH_RE = /[–—]/;
    for (const locale of ALL_LOCALES) {
      const raw = JSON.parse(
        readFileSync(path.join(process.cwd(), 'src', 'i18n', `${locale}.json`), 'utf-8'),
      ) as {
        cards: Record<string, { audience: string }>;
        dialog: Record<
          string,
          {
            receives: Record<string, { title: string }>;
            needs: Record<string, { lead: string; tail: string }>;
          }
        >;
      };

      const strings: { path: string; value: string }[] = [];
      for (const program of PROGRAMS) {
        strings.push({ path: `${locale}/cards.${program}.audience`, value: raw.cards[program].audience });
        for (let i = 0; i < 6; i++) {
          strings.push({
            path: `${locale}/dialog.${program}.receives.${i}.title`,
            value: raw.dialog[program].receives[String(i)].title,
          });
        }
        for (let i = 0; i < 5; i++) {
          strings.push({
            path: `${locale}/dialog.${program}.needs.${i}.lead`,
            value: raw.dialog[program].needs[String(i)].lead,
          });
          strings.push({
            path: `${locale}/dialog.${program}.needs.${i}.tail`,
            value: raw.dialog[program].needs[String(i)].tail,
          });
        }
      }

      expect(strings.length, `для ${locale} собрано не 51 строка`).toBe(51);
      for (const s of strings) {
        expect(DASH_RE.test(s.value), `тире в ${s.path}: "${s.value}"`).toBe(false);
      }
    }
  });

  for (const locale of ALL_LOCALES) {
    test(`[${locale}] 1440: у каждого пункта «Что нужно?» lead и tail лежат в одном grid-элементе`, async ({
      page,
    }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto(PAGE_ROUTES.home[locale]);
      await openAllCards(page);

      for (const program of PROGRAMS) {
        const steps = page.locator(`${detailsSelector(program)} .direction-step`);
        const count = await steps.count();
        expect(count, `в карточке ${program} не пять пунктов needs`).toBe(5);

        for (let i = 0; i < count; i++) {
          const step = steps.nth(i);
          const shape = await step.evaluate((el) => ({
            directChildren: el.children.length,
            leadCount: el.querySelectorAll(':scope > .direction-step-text > .direction-step-lead')
              .length,
            tailCount: el.querySelectorAll(':scope > .direction-step-text > .direction-step-tail')
              .length,
          }));
          expect(
            shape.directChildren,
            `у пункта needs №${i} карточки ${program} прямых потомков ${shape.directChildren}, а не 1`,
          ).toBe(1);
          expect(shape.leadCount, `пункт needs №${i} карточки ${program} потерял .direction-step-lead`).toBe(
            1,
          );
          expect(shape.tailCount, `пункт needs №${i} карточки ${program} потерял .direction-step-tail`).toBe(
            1,
          );

          const rects = await step.evaluate((el) => {
            const before = getComputedStyle(el, '::before');
            const lead = el.querySelector('.direction-step-lead')!.getBoundingClientRect();
            const tail = el.querySelector('.direction-step-tail')!.getBoundingClientRect();
            const stepLeft = el.getBoundingClientRect().left;
            return {
              leadLeft: lead.left,
              tailLeft: tail.left,
              stepLeft,
              numberWidth: parseFloat(before.width) || 22,
            };
          });

          expect(
            Math.abs(rects.leadLeft - rects.tailLeft),
            `пункт needs №${i} карточки ${program}: lead (left=${rects.leadLeft}) и tail (left=${rects.tailLeft}) стоят в разных колонках — Блокер 1 вернулся`,
          ).toBeLessThanOrEqual(1);

          expect(
            rects.tailLeft,
            `пункт needs №${i} карточки ${program}: tail стоит у левого края пункта — там же, где номер`,
          ).toBeGreaterThan(rects.stepLeft + rects.numberWidth);
        }
      }
    });
  }

  test('[mn] 360x800: раскрытые карточки не дают горизонтальной прокрутки и ни одна подпись не обрезана', async ({
    page,
  }) => {

    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(PAGE_ROUTES.home.mn);
    await page.evaluate(() => document.fonts.ready);
    await openAllCards(page);

    const noOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(noOverflow, 'раскрытые карточки дали горизонтальную прокрутку на 360px').toBe(true);

    const measuredCount = await page.locator('.direction-gain-label').count();
    expect(measuredCount, 'подписей плиток на странице не восемнадцать').toBe(18);

    const clipped = await page.locator('.direction-gain-label').evaluateAll((nodes) =>
      nodes
        .map((el) => ({
          text: (el.textContent ?? '').trim(),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        }))

        .filter((m) => m.scrollWidth > m.clientWidth + 1),
    );

    expect(clipped, `подпись плитки обрезана на 360px (mn): ${JSON.stringify(clipped)}`).toEqual([]);
  });
});

test.describe('Подхват на десктопе невозможен по построению (Д-13 сужен Д-15)', () => {
  test('1440: раскрытие карточки не создаёт в шапке ни одной ссылки связи', async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto(PAGE_ROUTES.home[LOCALE]);

    await expect(page.locator('.site-header [data-track="messenger_click"]')).toHaveCount(0);
    await expect(page.locator('.site-header a[href*="t.me/"]')).toHaveCount(0);

    const bankSummary = page.locator(summarySelector('bank'));
    await bankSummary.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(`${detailsSelector('bank')}[open]`)).toHaveCount(1);

    await expect(page.locator('.site-header [data-track="messenger_click"]')).toHaveCount(0);
    await expect(page.locator('.site-header a[href*="t.me/"]')).toHaveCount(0);

    await expect(page.locator('.site-header a.brand')).toHaveCount(1);
  });

  test('390: раскрытие карточки не переписывает ни один якорь (Д-13 отменён)', async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(PAGE_ROUTES.home[LOCALE]);

    await expect(page.locator('#lead-contact')).toHaveJSProperty('inputMode', 'tel');

    await expect(page.locator('.sticky-cta')).toHaveCount(0);

    const snapshot = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="t.me"]')).map((el) => ({
          href: el.href,
          program: el.dataset.program ?? null,
        })),
      );

    const before = await snapshot();

    expect(before.length, 'на странице нет ни одной ссылки на t.me').toBeGreaterThan(0);

    await page.locator(summarySelector('bank')).click();
    await expect(page.locator(detailsSelector('bank'))).toHaveJSProperty('open', true);
    await page.waitForTimeout(400);
    expect(await snapshot(), 'раскрытие карточки переписало якорь').toEqual(before);

    await page.locator(summarySelector('bank')).click();
    await expect(page.locator(detailsSelector('bank'))).toHaveJSProperty('open', false);
    await page.waitForTimeout(400);
    expect(await snapshot(), 'закрытие карточки переписало якорь').toEqual(before);
  });
});

test.describe('Вид карточек, разбор 28.08.2026', () => {
  const MOBILE = [
    { width: 360, height: 844 },
    { width: 390, height: 844 },
    { width: 430, height: 844 },
  ];

  for (const size of MOBILE) {
    for (const locale of ALL_LOCALES) {
      test(`${size.width} (${locale}): плитки стоят сеткой 2x3, ни одна подпись не рвётся`, async ({
        page,
      }) => {
        await page.setViewportSize(size);
        await page.goto(PAGE_ROUTES.home[locale]);
        await page.evaluate(() => document.fonts.ready);
        await openAllCards(page);

        const shape = await page.evaluate(() => {
          const out: { cols: number; rows: number }[] = [];
          document.querySelectorAll('.direction-gains').forEach((panel) => {
            const cols = getComputedStyle(panel).gridTemplateColumns.split(' ').length;
            const tops = [...panel.querySelectorAll('.direction-gain')].map((el) =>
              Math.round(el.getBoundingClientRect().top),
            );
            out.push({ cols, rows: new Set(tops).size });
          });
          return out;
        });

        expect(shape.length, 'панелей плиток на странице не три').toBe(3);
        for (const s of shape) {
          expect(s.cols, 'плитки перестали стоять в две колонки').toBe(2);
          expect(s.rows, 'плитки перестали стоять в три ряда').toBe(3);
        }

        const split = await page.evaluate(() => {
          const bad: { text: string; word: string; rects: number }[] = [];
          let checked = 0;
          document.querySelectorAll('.direction-gain-label').forEach((el) => {
            const node = el.firstChild;
            if (!node || node.nodeType !== Node.TEXT_NODE) return;
            const text = node.textContent ?? '';

            const re = /[^\s-]+-?/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text))) {
              const range = document.createRange();
              range.setStart(node, m.index);
              range.setEnd(node, m.index + m[0].length);
              const rects = range.getClientRects().length;
              checked++;
              if (rects > 1) bad.push({ text: text.trim(), word: m[0], rects });
            }
          });
          return { bad, checked };
        });

        expect(split.checked, 'слов подписей не измерено ни одного').toBeGreaterThan(24);
        expect(
          split.bad,
          `подпись плитки разорвана внутри слова: ${JSON.stringify(split.bad)}`,
        ).toEqual([]);
      });
    }
  }

  for (const size of MOBILE) {
    test(`${size.width}: имя направления — вывеска, а не подзаголовок, и не переносится`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.goto(PAGE_ROUTES.home.mn);
      await page.evaluate(() => document.fonts.ready);

      const names = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;left:-9999px';
        document.body.appendChild(probe);
        const out: { text: string; fs: number; lines: number; natural: number; avail: number }[] =
          [];
        document.querySelectorAll('.direction-name').forEach((el) => {
          const cs = getComputedStyle(el);
          probe.style.font = cs.font;
          probe.style.letterSpacing = cs.letterSpacing;
          probe.textContent = el.textContent;
          out.push({
            text: (el.textContent ?? '').trim(),
            fs: parseFloat(cs.fontSize),
            lines: Math.round(el.getBoundingClientRect().height / parseFloat(cs.lineHeight)),
            natural: +probe.getBoundingClientRect().width.toFixed(1),
            avail: el.clientWidth,
          });
        });
        probe.remove();
        return out;
      });

      expect(names.length, 'имён направлений на странице не три').toBe(3);
      for (const n of names) {

        expect(n.fs, `имя «${n.text}» набрано ${n.fs}px — мельче вывески макета`).toBeGreaterThan(
          36,
        );
        expect(n.lines, `имя «${n.text}» перенеслось на ${n.lines} строки`).toBe(1);
        expect(
          n.avail - n.natural,
          `имя «${n.text}» не помещается: ${n.natural}px при доступных ${n.avail}px`,
        ).toBeGreaterThan(0);
      }
    });
  }

  test('внутренние поверхности карточки — один материал, и он темнее самой карточки', async ({
    page,
  }) => {

    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(PAGE_ROUTES.home.mn);
    await openAllCards(page);

    const fills = await page.evaluate(() =>
      ['.direction-gains', '.direction-steps'].map((sel) => {
        const els = [...document.querySelectorAll(sel)];
        return {
          sel,
          count: els.length,
          colors: [...new Set(els.map((el) => getComputedStyle(el).backgroundColor))],
        };
      }),
    );

    for (const f of fills) expect(f.count, `${f.sel} не найден на странице`).toBeGreaterThan(0);

    const all = [...new Set(fills.flatMap((f) => f.colors))];
    expect(
      all.length,
      `внутренние поверхности карточки залиты разными материалами: ${JSON.stringify(fills)}`,
    ).toBe(1);

    const cardFill = await page.evaluate(
      () => getComputedStyle(document.querySelector('.direction-card') as HTMLElement).backgroundColor,
    );

    const parse = (s: string): { rgb: number[]; a: number } => {
      const n = (s.match(/[\d.]+/g) ?? []).map(Number);
      return { rgb: n.slice(0, 3), a: n.length > 3 ? n[3] : 1 };
    };
    const lum = (rgb: number[]): number => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

    const panel = parse(all[0]);
    const card = parse(cardFill);

    expect(panel.a, `панель непрозрачна (${all[0]}) — стекла нет`).toBeLessThan(1);
    expect(card.a, `карточка непрозрачна (${cardFill}) — стекла нет`).toBeLessThan(1);
    expect(
      lum(panel.rgb),
      `краска панели ${all[0]} светлее краски карточки ${cardFill}`,
    ).toBeLessThanOrEqual(lum(card.rgb));
    expect(
      panel.a,
      `панель прозрачнее карточки (${panel.a} против ${card.a}) — на светлом фоне она окажется СВЕТЛЕЕ карточки`,
    ).toBeGreaterThanOrEqual(card.a);
  });

  test('стекло снимается под prefers-reduced-transparency, и карточка снова плита макета', async ({
    browser,
  }) => {

    const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    });
    await page.goto(PAGE_ROUTES.home.mn);
    await openAllCards(page);

    const seen = await page.evaluate(() => {
      const card = document.querySelector('.direction-card') as HTMLElement;
      const cs = getComputedStyle(card);
      return {
        card: cs.backgroundColor,
        cardBlur: cs.backdropFilter,
        rim: getComputedStyle(card, '::after').opacity,
        panels: [...new Set(
          ['.direction-gains', '.direction-steps'].flatMap((sel) =>
            [...document.querySelectorAll(sel)].map((el) => getComputedStyle(el).backgroundColor),
          ),
        )],
      };
    });

    expect(seen.card, 'карточка осталась полупрозрачной при выключенной прозрачности').toBe(
      'rgb(18, 19, 26)',
    );
    expect(seen.cardBlur, 'у карточки осталось размытие').toMatch(/none/);
    expect(Number(seen.rim), 'кромка-градиент не погашена').toBe(0);
    for (const p of seen.panels) {
      expect(p, `панель осталась полупрозрачной: ${p}`).not.toMatch(/rgba/);
    }
    await context.close();
  });

  test('номер списка — золотой текст с точкой, а не залитая плашка', async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(PAGE_ROUTES.home.mn);
    await openAllCards(page);

    const marks = await page.evaluate(() =>
      [...document.querySelectorAll('.direction-step')].map((el) => {
        const cs = getComputedStyle(el, '::before');
        return { content: cs.content, color: cs.color, bg: cs.backgroundColor };
      }),
    );

    expect(marks.length, 'пунктов списка на странице нет вовсе').toBeGreaterThan(8);
    for (const m of marks) {
      expect(m.content, 'у номера пропала точка макета').toMatch(/\./);
      expect(m.color, 'номер перестал быть золотым').toBe('rgb(241, 198, 50)');
      expect(m.bg, 'у номера вернулась залитая плашка').toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    }
  });

  test('над заголовками разделов нет волосяных линий — их работу несут панели', async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(PAGE_ROUTES.home.mn);
    await openAllCards(page);

    const titles = await page.evaluate(() =>
      [...document.querySelectorAll('.direction-section-title')].map((el) => {
        const cs = getComputedStyle(el);
        return { w: cs.borderTopWidth, style: cs.borderTopStyle, align: cs.textAlign };
      }),
    );

    expect(titles.length, 'заголовков разделов на странице не шесть').toBe(6);
    for (const t of titles) {
      expect(
        t.w === '0px' || t.style === 'none',
        'над заголовком раздела вернулась волосяная линия',
      ).toBe(true);

      expect(t.align, 'заголовок раздела уехал по центру — это против макета').not.toBe('center');
    }
  });
});

test.describe('Стрелка закрывает раскрытую карточку (баг заказчика 28.08.2026)', () => {
  const caretPoint = async (page: Page, program: string) => {
    const details = page.locator(detailsSelector(program));

    await page.waitForTimeout(600);

    await details.locator('.direction-caret').evaluate((el) => {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    });

    await page.waitForFunction(() => {
      const w = window as unknown as { __y?: number };
      const y = window.scrollY;
      const stoit = w.__y === y;
      w.__y = y;
      return stoit;
    });
    return details.evaluate((el) => {
      const caret = el.querySelector('.direction-caret') as HTMLElement;
      const r = caret.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(cx, cy) as HTMLElement | null;
      return {
        cx,
        cy,
        hitTag: hit ? hit.tagName : '(none)',
        hitClass: hit ? String(hit.className) : '(none)',
        insideSummary: hit ? Boolean(hit.closest('summary')) : false,
      };
    });
  };

  for (const locale of ['mn', 'ru', 'en'] as Locale[]) {
    for (const width of [360, 390, 1440]) {
      test(`${width} (${locale}): нажатие в стрелку закрывает все три карточки`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(PAGE_ROUTES.home[locale]);

        for (const program of PROGRAMS) {
          const details = page.locator(detailsSelector(program));
          await page.locator(`${summarySelector(program)} .direction-summary-copy`).click();
          await expect(details).toHaveJSProperty('open', true);

          const point = await caretPoint(page, program);
          expect(
            point.insideSummary,
            `${program}: под стрелкой лежит ${point.hitTag}.${point.hitClass}, а не потомок summary`,
          ).toBe(true);

          await page.mouse.click(point.cx, point.cy);
          await expect(
            details,
            `${program}: нажатие в стрелку не закрыло карточку`,
          ).toHaveJSProperty('open', false);
        }
      });
    }
  }

  test('390: каретку у нижней кромки окна не перекрывает ни один слой самой карточки', async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(PAGE_ROUTES.home.mn);
    const details = page.locator(detailsSelector('teamcash'));
    await page.locator(`${summarySelector('teamcash')} .direction-summary-copy`).click();
    await expect(details).toHaveJSProperty('open', true);
    await page.waitForTimeout(600);
    await details.locator('.direction-caret').scrollIntoViewIfNeeded();

    const kto = await details.evaluate((el) => {
      const caret = el.querySelector('.direction-caret') as HTMLElement;
      const r = caret.getBoundingClientRect();
      const hit = document.elementFromPoint(
        Math.round(r.left + r.width / 2),
        Math.round(r.top + r.height / 2),
      ) as HTMLElement | null;
      return {
        tag: hit ? hit.tagName : '(none)',
        cls: hit ? String(hit.className) : '(none)',
        vnutriKartochki: hit ? el.contains(hit) : false,
        potomokSummary: hit ? Boolean(hit.closest('summary')) : false,
      };
    });

    expect(
      kto.vnutriKartochki && !kto.potomokSummary,
      `каретку накрыл слой самой карточки: ${kto.tag}.${kto.cls}`,
    ).toBe(false);
  });

  test('цель нажатия стрелки не меньше 44px, а сам глиф остаётся 18px', async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(PAGE_ROUTES.home.mn);
    await openAllCards(page);

    await page.waitForTimeout(600);

    const boxes = await page.locator('.direction-caret').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        const target = getComputedStyle(el, '::before');
        return {
          glyph: { w: Math.round(r.width), h: Math.round(r.height) },
          target: { w: parseFloat(target.width), h: parseFloat(target.height) },
        };
      }),
    );

    expect(boxes.length, 'кареток на странице не три').toBe(3);
    for (const b of boxes) {

      expect(b.glyph.w, 'глиф каретки перестал быть 18px').toBe(18);
      expect(b.glyph.h, 'глиф каретки перестал быть 18px').toBe(18);

      expect(b.target.w, 'цель нажатия стрелки уже 44px').toBeGreaterThanOrEqual(44);
      expect(b.target.h, 'цель нажатия стрелки ниже 44px').toBeGreaterThanOrEqual(44);
    }
  });

  test('у стрелки раскрытой карточки больше нет своего кольца ни на наведении, ни на фокусе — индикатор фокуса живёт на карточке', async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto(PAGE_ROUTES.home.mn);

    const details = page.locator(detailsSelector('bank'));
    await page.locator(`${summarySelector('bank')} .direction-summary-copy`).click();
    await expect(details).toHaveJSProperty('open', true);

    const plate = () =>
      details.locator('.direction-caret').evaluate((el) => {
        const cs = getComputedStyle(el, '::before');
        return { bg: cs.backgroundColor, border: cs.borderTopColor };
      });
    const cardOutline = () =>
      details.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
      });

    const rest = await plate();
    expect(rest.bg, 'подложка стрелки видна в покое — в макете её там нет').toMatch(
      /, 0\)|transparent/,
    );
    const restOutline = await cardOutline();
    expect(restOutline.style, 'у карточки в покое уже есть контур — замер станет недостоверным').toBe(
      'none',
    );

    await details.locator('.direction-caret').hover();

    await page.waitForTimeout(400);
    const hovered = await plate();
    expect(
      hovered.bg,
      'у стрелки снова появилось своё кольцо на наведении — заказчик просил убрать его дважды',
    ).toBe(rest.bg);

    await page.mouse.move(0, 0);
    await page.locator(summarySelector('affiliate')).focus();
    await page.keyboard.press('Tab');
    const focusedOn = await page.evaluate(
      () => document.activeElement?.parentElement?.getAttribute('data-track-direction') ?? '',
    );
    expect(focusedOn, 'Tab с первой карточки привёл не ко второй').toBe('bank');
    await page.waitForTimeout(400);

    const focused = await plate();
    expect(
      focused.bg,
      'у стрелки на фокусе снова есть своё кольцо — по замеру caret-focus-measure.mjs оно избыточно (карточный outline самостоятелен)',
    ).toBe(rest.bg);

    const focusedOutline = await cardOutline();
    expect(
      focusedOutline.style,
      'у карточки нет контура на фокусе — индикатор фокуса потерян, а замена (кольцо каретки) снята этим же планом',
    ).not.toBe('none');
    expect(focusedOutline.width, 'контур фокуса карточки нулевой ширины').toBeGreaterThan(0);
  });

  test('свёрнутая карточка не приобрела второй нажимаемый элемент', async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(PAGE_ROUTES.home.mn);

    const stops = await page
      .locator(detailsSelector('affiliate'))
      .evaluate(
        (el) =>
          el.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]')
            .length,
      );
    expect(stops, 'у свёрнутой карточки появилась вторая остановка табуляции').toBe(1);

    const caret = await page
      .locator(`${detailsSelector('affiliate')} .direction-caret`)
      .evaluate((el) => ({
        role: el.getAttribute('role'),
        tabindex: el.getAttribute('tabindex'),
        hidden: el.getAttribute('aria-hidden'),
      }));
    expect(caret.role, 'стрелке приписана роль').toBeNull();
    expect(caret.tabindex, 'стрелка попала в порядок табуляции').toBeNull();
    expect(caret.hidden, 'стрелка перестала быть скрытой от диктора').toBe('true');
  });
});

test.describe('Стрелка закрывает карточку без JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  for (const locale of ['mn', 'ru', 'en'] as Locale[]) {
    test(`390 (${locale}): три карточки закрываются нажатием в стрелку без JS`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(PAGE_ROUTES.home[locale]);

      for (const program of PROGRAMS) {
        const details = page.locator(detailsSelector(program));
        await page.locator(`${summarySelector(program)} .direction-summary-copy`).click();
        await expect(details).toHaveJSProperty('open', true);

        const caret = details.locator('.direction-caret');
        await page.waitForTimeout(600);
        await caret.scrollIntoViewIfNeeded();
        const box = (await caret.boundingBox())!;
        await page.mouse.click(
          Math.round(box.x + box.width / 2),
          Math.round(box.y + box.height / 2),
        );

        await expect(
          details,
          `${program}: без JS нажатие в стрелку не закрыло карточку`,
        ).toHaveJSProperty('open', false);

        await page.waitForTimeout(600);
      }
    });
  }
});

test.describe('Каретка принимает нажатие ВО ВРЕМЯ хода, а не только в покое', () => {
  for (const program of PROGRAMS) {
    test(`${program}: стрелка достижима весь ход и переключает карточку на ходу`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(PAGE_ROUTES.home.ru);

      const details = page.locator(detailsSelector(program));
      const summaryCopy = page.locator(`${summarySelector(program)} .direction-summary-copy`);

      const podvesti = async () =>
        details.evaluate((el) => {
          el.querySelector('.direction-caret')!.scrollIntoView({
            block: 'center',
            behavior: 'instant',
          });
        });

      type Kadr = { h: number; inSummary: boolean; tag: string; vOkne: boolean };
      const perepis = (ms: number) =>
        details.evaluate(
          (el, window_ms) =>
            new Promise<
              { h: number; inSummary: boolean; tag: string; vOkne: boolean }[]
            >((done) => {
              const out: { h: number; inSummary: boolean; tag: string; vOkne: boolean }[] = [];
              const t0 = performance.now();
              const step = () => {
                const r = el.querySelector('.direction-caret')!.getBoundingClientRect();
                const x = Math.round(r.left + r.width / 2);
                const y = Math.round(r.top + r.height / 2);
                const vOkne = y >= 0 && y <= innerHeight && x >= 0 && x <= innerWidth;
                const hit = vOkne ? document.elementFromPoint(x, y) : null;
                out.push({
                  h: Math.round(el.getBoundingClientRect().height),
                  inSummary: !!hit?.closest('summary'),
                  tag: hit?.tagName ?? '(none)',
                  vOkne,
                });
                if (performance.now() - t0 < window_ms) requestAnimationFrame(step);
                else done(out);
              };
              requestAnimationFrame(step);
            }),
          ms,
        );

      const hSvernutaya = await details.evaluate((el) =>
        Math.round(el.getBoundingClientRect().height),
      );

      await summaryCopy.click();
      await expect(details).toHaveJSProperty('open', true);
      const hodRaskrytiya = await perepis(700);
      const hRaskrytaya = Math.max(...hodRaskrytiya.map((k) => k.h));

      const naHodu = (kadry: Kadr[]) =>
        kadry.filter((k) => k.vOkne && k.h > hSvernutaya + 8 && k.h < hRaskrytaya - 8);

      const midRaskrytie = naHodu(hodRaskrytiya);
      const promahRaskrytie = midRaskrytie.filter((k) => !k.inSummary);
      expect(
        promahRaskrytie.length,
        `${program}: во время РАСКРЫТИЯ центр каретки закрыт чужим узлом в ${promahRaskrytie.length} кадре(ах) из ${midRaskrytie.length} (${[
          ...new Set(promahRaskrytie.map((k) => k.tag)),
        ].join(', ')})`,
      ).toBe(0);

      await podvesti();
      const tochka = await details.evaluate((el) => {
        const r = el.querySelector('.direction-caret')!.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      await page.mouse.click(tochka.x, tochka.y);
      await expect(details, `${program}: нажатие в стрелку не закрыло карточку`).toHaveJSProperty(
        'open',
        false,
      );

      const hodSvorachivaniya = await perepis(700);
      const midSvorachivanie = naHodu(hodSvorachivaniya);

      expect(
        midSvorachivanie.length,
        `${program}: ход сворачивания не наблюдался ни в одном кадре с кареткой на экране (высоты ${hSvernutaya}…${hRaskrytaya})`,
      ).toBeGreaterThan(0);
      const promahSvorachivanie = midSvorachivanie.filter((k) => !k.inSummary);
      expect(
        promahSvorachivanie.length,
        `${program}: во время СВОРАЧИВАНИЯ центр каретки закрыт чужим узлом в ${promahSvorachivanie.length} кадре(ах) из ${midSvorachivanie.length} (${[
          ...new Set(promahSvorachivanie.map((k) => k.tag)),
        ].join(', ')})`,
      ).toBe(0);

      await summaryCopy.click();
      await expect(details).toHaveJSProperty('open', true);
      await page.waitForTimeout(700);
      await podvesti();
      const startPoint = await details.evaluate((el) => {
        const r = el.querySelector('.direction-caret')!.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      await page.mouse.click(startPoint.x, startPoint.y);
      await expect(details).toHaveJSProperty('open', false);

      await details.evaluate(
        (el, [hMin, hMax]) =>
          new Promise<void>((done) => {
            const porog = hMin + (hMax - hMin) * 0.03;
            const t0 = performance.now();
            const step = () => {

              if (el.getBoundingClientRect().height <= porog || performance.now() - t0 > 1500) {
                done();
              } else {
                requestAnimationFrame(step);
              }
            };
            requestAnimationFrame(step);
          }),
        [hSvernutaya, hRaskrytaya],
      );
      await podvesti();
      const vHodu = await details.evaluate((el) => {
        const r = el.querySelector('.direction-caret')!.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(x, y);
        return { x, y, inSummary: !!hit?.closest('summary'), tag: hit?.tagName ?? '(none)' };
      });
      expect(
        vHodu.inSummary,
        `${program}: на исходе сворачивания под центром каретки лежит ${vHodu.tag}, а не summary`,
      ).toBe(true);
      await page.mouse.click(vHodu.x, vHodu.y);
      await expect(
        details,
        `${program}: нажатие в стрелку на исходе сворачивания не раскрыло карточку обратно`,
      ).toHaveJSProperty('open', true);
    });
  }
});

test.describe('Плитка «Что получает партнёр?»: значок слева от 390px', () => {
  const geometry = async (page: Page) =>
    page.locator('.direction-gain').evaluateAll((tiles) =>
      tiles.map((tile) => {
        const mark = tile.querySelector('.direction-gain-mark')!.getBoundingClientRect();
        const label = tile.querySelector('.direction-gain-label')!.getBoundingClientRect();
        return {
          markRight: Math.round(mark.right),
          markBottom: Math.round(mark.bottom),
          labelLeft: Math.round(label.left),
          labelTop: Math.round(label.top),
          markSize: Math.round(mark.width),
        };
      }),
    );

  for (const width of [390, 430]) {
    for (const locale of ['mn', 'ru', 'en'] as Locale[]) {
      test(`${width} (${locale}): значок слева от подписи во всех восемнадцати плитках`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(PAGE_ROUTES.home[locale]);
        await page.evaluate(() => document.fonts.ready);
        await openAllCards(page);

        const tiles = await geometry(page);
        expect(tiles.length, 'плиток на странице не восемнадцать').toBe(18);
        for (const t of tiles) {
          expect(
            t.markRight,
            'значок перестал стоять СЛЕВА от подписи — это правка против макета',
          ).toBeLessThanOrEqual(t.labelLeft);
        }
      });
    }
  }

  test('360: значок остаётся сверху — боковая раскладка там не помещается', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto(PAGE_ROUTES.home.ru);
    await page.evaluate(() => document.fonts.ready);
    await openAllCards(page);

    const tiles = await geometry(page);
    expect(tiles.length, 'плиток на странице не восемнадцать').toBe(18);
    for (const t of tiles) {
      expect(
        t.markBottom,
        'на 360 значок уехал вбок — самое длинное слово ru/mn там не помещается и порвётся',
      ).toBeLessThanOrEqual(t.labelTop);
    }
  });

  test('раскрытая карточка не держит мёртвый резерв под стрелку', async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(PAGE_ROUTES.home.mn);

    const paddingOf = (program: string) =>
      page
        .locator(summarySelector(program))
        .evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));

    const collapsed = await paddingOf('affiliate');
    await page.locator(`${summarySelector('affiliate')} .direction-summary-copy`).click();
    await page.waitForTimeout(600);
    const opened = await paddingOf('affiliate');

    expect(collapsed, 'у свёрнутой карточки пропал резерв под стрелку').toBeGreaterThan(opened);
    expect(
      collapsed - opened,
      'резерв под стрелку в раскрытом состоянии вернулся',
    ).toBeGreaterThanOrEqual(20);
  });
});

test.describe('Раскрытая карточка: цвет текста остаётся белым, а не серым (выгрузка из Фигмы, 28.08.2026; предмет золотой строки снят 04.09.2026, см. историю выше)', () => {
  for (const program of PROGRAMS) {
    test(`${program}: подзаголовок направления и пункты «Что нужно?» — белые, не серые`, async ({
      page,
    }) => {
      await page.setViewportSize(MOBILE_VIEWPORT);
      await page.goto(PAGE_ROUTES.home.ru);
      await page.locator(`${summarySelector(program)} .direction-summary-copy`).click();
      await expect(page.locator(detailsSelector(program))).toHaveJSProperty('open', true);
      await page.waitForTimeout(600);

      const m = await page.locator(detailsSelector(program)).evaluate((card) => ({
        stepsColor: getComputedStyle(card.querySelector('.direction-steps')!).color,
        audienceColor: getComputedStyle(card.querySelector('.direction-audience')!).color,
      }));

      expect(m.stepsColor, 'пункты списка снова стали серыми').toBe('rgb(247, 246, 241)');
      expect(m.audienceColor, 'подзаголовок направления снова стал серым').toBe(
        'rgb(247, 246, 241)',
      );
    });
  }
});

test.describe('Единый фон страницы и шапка под содержимым', () => {
  test('поверхность страницы лежит выше шапки, шапка остаётся липкой', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.mn);

    const layers = await page.evaluate(() => {
      const surface = document.querySelector('.page-surface') as HTMLElement | null;
      const header = document.querySelector('.site-header') as HTMLElement;

      return {
        hasSurface: Boolean(surface),
        surfaceZ: surface ? Number(getComputedStyle(surface).zIndex) : NaN,
        headerZ: Number(getComputedStyle(header).zIndex),
        headerPos: getComputedStyle(header).position,

      };
    });

    expect(layers.hasSurface, 'обёртка поверхности страницы исчезла').toBe(true);
    expect(
      layers.surfaceZ,
      'поверхность страницы опустилась под шапку — наезд вернётся',
    ).toBeGreaterThan(layers.headerZ);
    expect(layers.headerPos, 'шапка перестала быть липкой (на ней держится Д-21)').toBe('sticky');

  });

  for (const width of [390, 1440]) {
    test(`${width}: имя раскрытой карточки не перекрыто шапкой`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(PAGE_ROUTES.home.ru);
      await page.locator(`${summarySelector('bank')} .direction-summary-copy`).click();
      await expect(page.locator(detailsSelector('bank'))).toHaveJSProperty('open', true);
      await page.waitForTimeout(600);

      await page.evaluate(() => {
        const name = document.querySelector('#direction-bank .direction-name') as HTMLElement;
        window.scrollTo({ top: window.scrollY + name.getBoundingClientRect().top - 30 });
      });
      await page.waitForTimeout(300);

      const hit = await page.evaluate(() => {
        const brand = document.querySelector('.site-header a.brand') as HTMLElement;
        const r = brand.getBoundingClientRect();
        const el = document.elementFromPoint(
          Math.round(r.left + r.width / 2),
          Math.round(r.top + r.height / 2),
        ) as HTMLElement | null;
        return {
          insideHeader: el ? Boolean(el.closest('.site-header')) : false,
          insideSurface: el ? Boolean(el.closest('.page-surface')) : false,
          tag: el ? el.tagName : '(none)',
        };
      });

      expect(
        hit.insideHeader,
        `на ${width} шапка снова лежит поверх содержимого (под точкой знака ${hit.tag})`,
      ).toBe(false);
      expect(hit.insideSurface, 'над шапкой оказалось не содержимое страницы').toBe(true);
    });
  }

  test('1440: тонированных полос с кромками у вопросов и формы больше нет', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.ru);

    const bands = await page.evaluate(() => {
      const read = (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement;
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, top: cs.borderTopWidth, bottom: cs.borderBottomWidth };
      };
      return { faq: read('.trust-faq'), form: read('.lead-form') };
    });

    for (const [name, b] of Object.entries(bands)) {
      expect(b.bg, `у полосы ${name} вернулась собственная заливка`).toMatch(/, 0\)|transparent/);
      expect(b.top, `у полосы ${name} вернулась верхняя кромка`).toBe('0px');
      expect(b.bottom, `у полосы ${name} вернулась нижняя кромка`).toBe('0px');
    }
  });

  test('краска страницы гаснет ДО блока блогеров: ступеньки на его кромке нет', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.mn);

    const m = await page.evaluate(() => {
      const surface = document.querySelector('.page-surface') as HTMLElement;
      const partners = document.querySelector('.partners') as HTMLElement;
      const sTop = surface.getBoundingClientRect().top + window.scrollY;
      const sH = surface.getBoundingClientRect().height;
      const pTop = partners.getBoundingClientRect().top + window.scrollY;
      return { share: (pTop - sTop) / sH };
    });

    expect(
      m.share,
      `блок блогеров начинается на ${(m.share * 100).toFixed(1)}% поверхности, а краска гаснет к 66%`,
    ).toBeGreaterThan(0.66);
  });
});
