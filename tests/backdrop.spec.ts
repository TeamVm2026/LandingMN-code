
import { test, expect, type Page } from '@playwright/test';

import sharp from 'sharp';

async function setCards(page: Page, open: boolean) {
  await page.evaluate((o) => {
    document
      .querySelectorAll<HTMLDetailsElement>('details.direction-card')
      .forEach((d) => (d.open = o));
  }, open);
  await page.waitForTimeout(350);
}

async function prepare(page: Page, width: number) {
  await page.setViewportSize({ width, height: width >= 1440 ? 900 : 844 });
  await page.goto('/');
  await page.addStyleTag({
    content: 'html{scrollbar-width:none}::-webkit-scrollbar{display:none}',
  });

  await page.evaluate(async () => {
    const step = window.innerHeight / 2;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 50));
    }
    window.scrollTo(0, 0);
  });
  await page
    .waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 15000 })
    .catch(() => {});

  await page.addStyleTag({
    content: '.consent-banner,[data-consent-banner]{display:none!important}',
  });
  await page.evaluate(() =>
    document
      .querySelectorAll('*')
      .forEach((e) => (e.getAnimations?.() ?? []).forEach((x) => x.pause())),
  );
  await page.waitForTimeout(300);
}

const APPROVED_LAYERS = [
  'scene-layer--veil-hero',
  'scene-layer--main',
  'scene-layer--cards',
  'scene-layer--faq',
  'scene-layer--veil-faq',
  'scene-layer--form',
  'scene-layer--hills',
];

const RETIRED_LAYERS = [
  '.scene-hills',
  '.scene-clouds',
  '.scene-drift',
  '.scene-form',
  '.spine-haze',
  '.partners-scene',
  '.band-steps',
  '.scene-form-band',
];

for (const width of [390, 1440] as const) {
  test(`сцена — ровно семь утверждённых слоёв, ширина ${width}`, async ({ page }) => {
    await prepare(page, width);
    const found = await page.evaluate(
      (approved) => {
        const layers = [...document.querySelectorAll('.scene-layer')];
        return layers.map((l) => ({
          mod: [...l.classList].find((c) => approved.includes(c)) ?? `НЕИЗВЕСТНЫЙ:${l.className}`,
          hidden: l.getAttribute('aria-hidden'),
          z: getComputedStyle(l).zIndex,
          pos: getComputedStyle(l).position,
        }));
      },
      APPROVED_LAYERS as unknown as string[],
    );

    expect(
      found.map((f) => f.mod).sort(),
      'состав сцены разошёлся с утверждённой спекой spec-desktop.json / spec-mobile.json',
    ).toEqual([...APPROVED_LAYERS].sort());

    for (const f of found) {
      expect(
        f.hidden,
        `слой ${f.mod} не помечен aria-hidden — он попадёт в дерево доступности`,
      ).toBe('true');
      expect(
        f.z,
        `слой ${f.mod} ушёл со ступени −1 шкалы слоёв (docs/architecture-layers.md §3)`,
      ).toBe('-1');

      expect(f.pos, `слой ${f.mod} стал fixed — заказчик это запретил прямым текстом`).toBe(
        'absolute',
      );
    }

    const crossing = await page.evaluate(() =>
      [...document.querySelectorAll('.scene-layer[data-crosses-fold="true"]')].map((l) => ({
        mod: [...l.classList].find((c) => c.startsWith('scene-layer--')) ?? l.className,
        loading: l.querySelector('img')?.getAttribute('loading') ?? '(нет img)',
      })),
    );
    expect(
      crossing.map((c) => c.mod).sort(),
      'состав слоёв, пересекающих первый экран, разошёлся со спекой',
    ).toEqual(['scene-layer--main', 'scene-layer--veil-hero']);
    for (const c of crossing) {
      expect(
        c.loading,
        `слой ${c.mod} пересекает первый экран и перестал быть lazy — ` +
          'критический путь вырастет на 75,6 КБ реально отданных байт, а LCP на ~0,3 с',
      ).toBe('lazy');
    }

    const haze = await page.evaluate(() => {
      const el = document.querySelector('.hero-haze');
      if (!el) return null;
      return {
        marked: el.getAttribute('data-crosses-fold'),
        loading: el.querySelector('img')?.getAttribute('loading') ?? '(нет img)',
      };
    });
    expect(haze, 'блок .hero-haze исчез — проверить, не сняли ли дымку целиком').not.toBeNull();
    expect(
      haze?.marked,
      'у дымки первого экрана пропал data-crosses-fold — её 17,9 КБ снова станут ' +
        'невидимы для check:perf, и честная сумма первого экрана начнёт врать',
    ).toBe('true');
    expect(
      haze?.loading,
      'дымка перестала быть lazy — она обязана уступать очередь фотографии первого экрана ' +
        '(fetchpriority="high"), иначе LCP растёт',
    ).toBe('lazy');

    const retired = await page.evaluate(
      (sels) => sels.filter((s) => document.querySelector(s) !== null),
      RETIRED_LAYERS as unknown as string[],
    );
    expect(
      retired,
      `вернулись классы, снятые 03.09.2026: ${retired.join(', ')}. ` +
        'Утверждённая 06.09 сцена их не восстанавливает — у неё своя геометрия и свои полотна.',
    ).toEqual([]);
  });
}

const LAYER_ANCHORS: [string, string][] = [
  ['scene-layer--veil-hero', '.page-surface'],
  ['scene-layer--main', '.page-surface'],
  ['scene-layer--cards', '#programs'],

  ['scene-layer--faq', '.page-surface'],
  ['scene-layer--veil-faq', '.page-surface'],
  ['scene-layer--form', '.lead-form'],
  ['scene-layer--hills', '.partners'],
];

const SKY_LAYERS = [
  'scene-layer--veil-hero',
  'scene-layer--main',
  'scene-layer--cards',
  'scene-layer--faq',
  'scene-layer--veil-faq',
];

for (const width of [390, 1440] as const) {
  test(`слои держатся за свою секцию, а не за пиксель, ширина ${width}`, async ({ page }) => {
    test.slow();
    await prepare(page, width);
    const pairsArg = LAYER_ANCHORS as unknown as [string, string][];
    const read = async () =>
      page.evaluate((pairs) => {
        const out: Record<string, number> = {};
        for (const [mod, anchor] of pairs) {
          const l = document.querySelector(`.${mod}`);
          const a = document.querySelector(anchor);
          if (!l || !a) continue;
          out[mod] = Math.round(l.getBoundingClientRect().top - a.getBoundingClientRect().top);
        }
        return out;
      }, pairsArg);

    await setCards(page, false);
    const closed = await read();
    await setCards(page, true);
    const open = await read();

    for (const [mod] of LAYER_ANCHORS) {

      expect(
        open[mod],
        `слой ${mod} стоит на ${closed[mod]} от своей секции в свёрнутом состоянии и на ` +
          `${open[mod]} в раскрытом — значит он держится за пиксель, а не за секцию, ` +
          'и уедет при первом же нажатии (docs/architecture-layers.md, правило 4)',
      ).toBe(closed[mod]);
    }
  });
}

for (const width of [390, 1440] as const) {
  test(`небо стоит на месте при раскрытии карточек, ширина ${width}`, async ({ page }) => {
    test.slow();
    await prepare(page, width);
    const read = async () =>
      page.evaluate((mods) => {
        const out: Record<string, number> = {};
        for (const mod of mods) {
          const l = document.querySelector(`.${mod}`);
          if (l) out[mod] = Math.round(l.getBoundingClientRect().top + window.scrollY);
        }
        return out;
      }, SKY_LAYERS as unknown as string[]);

    await setCards(page, false);
    const closed = await read();
    const hClosed = await page.evaluate(() => document.documentElement.scrollHeight);
    await setCards(page, true);
    const open = await read();
    const hOpen = await page.evaluate(() => document.documentElement.scrollHeight);

    expect(
      hOpen - hClosed,
      'карточки перестали растить страницу — замок потерял предмет, а не прошёл',
    ).toBeGreaterThan(300);

    for (const mod of SKY_LAYERS) {
      expect(
        open[mod],
        `слой неба ${mod} уехал на ${open[mod] - closed[mod]}px при раскрытии карточек ` +
          `(страница выросла на ${hOpen - hClosed}px). Это ровно то, что заказчик назвал ` +
          '«карточки триггерят выезжание фона»: слой держится за секцию НИЖЕ карточек.',
      ).toBe(closed[mod]);
    }
  });
}

test('полотна слоёв не растут с шириной окна выше 1440', async ({ page }) => {
  test.slow();
  const heights = async (width: number) => {
    await prepare(page, width);
    return page.evaluate(() => {
      const out: Record<string, number> = {};
      for (const l of document.querySelectorAll('.scene-layer')) {
        const mod = [...l.classList].find((c) => c.startsWith('scene-layer--'));
        const img = l.querySelector('img');
        if (mod && img) out[mod] = Math.round(img.getBoundingClientRect().height);
      }
      return out;
    });
  };
  const at1440 = await heights(1440);
  const at1920 = await heights(1920);
  for (const mod of Object.keys(at1440)) {

    expect(
      at1920[mod] - at1440[mod],
      `полотно слоя ${mod} выросло с ${at1440[mod]}px на 1440 до ${at1920[mod]}px на 1920. ` +
        'Полотно прижато к ВЕРХУ коробки, поэтому весь прирост уходит вниз — облака съезжают ' +
        'относительно содержимого, которое от ширины окна не зависит.',
    ).toBeLessThanOrEqual(40);
  }
});

const BARE_GROUND = 25;
const MAX_P95_DRIFT = 6;

const SKY_SECTIONS: [string, string][] = [
  ['направления', '.block-programs'],
  ['как начать', '#how-to-start'],
  ['вопросы', '.trust-faq'],
  ['форма', '.lead-form'],
  ['партнёры', '.partners'],
];

for (const width of [390, 1440] as const) {
  test(`каждая секция сохраняет своё небо при раскрытии карточек, ширина ${width}`, async ({
    page,
  }) => {
    test.slow();
    await prepare(page, width);
    const gut = width >= 1270 ? Math.round((width - 1210) / 2) - 8 : Math.max(10, Math.round(width * 0.055));

    const snap = async (open: boolean) => {
      await setCards(page, open);
      await page.evaluate(async () => {
        const step = window.innerHeight / 2;
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 40));
        }
        window.scrollTo(0, 0);
      });
      await page.evaluate(() =>
        document.querySelectorAll('.is-pending').forEach((e) => {
          e.classList.remove('is-pending');
          e.classList.add('is-revealed');
        }),
      );
      await page.waitForTimeout(400);
      const buf = await page.screenshot({ fullPage: true });
      const boxes = await page.evaluate((sels: [string, string][]) => {
        const out: Record<string, [number, number]> = {};
        for (const [name, sel] of sels) {
          const e = document.querySelector(sel);
          if (e) {
            const r = e.getBoundingClientRect();
            out[name] = [Math.round(r.top + window.scrollY), Math.round(r.bottom + window.scrollY)];
          }
        }
        return out;
      }, SKY_SECTIONS);
      return { buf, boxes };
    };

    const p95 = async (buf: Buffer, top: number, height: number) => {
      const vals: number[] = [];
      for (const left of [6, width - gut]) {
        const raw = await sharp(buf)
          .extract({ left, top, width: gut - 6, height })
          .removeAlpha()
          .raw()
          .toBuffer();
        for (let i = 0; i < raw.length; i += 9) {
          vals.push(0.2126 * raw[i] + 0.7152 * raw[i + 1] + 0.0722 * raw[i + 2]);
        }
      }
      vals.sort((a, b) => a - b);
      return vals[Math.floor(vals.length * 0.95)];
    };

    const closed = await snap(false);
    const open = await snap(true);

    for (const [name] of SKY_SECTIONS) {
      const c = closed.boxes[name];
      const o = open.boxes[name];
      if (!c || !o) continue;

      const h = Math.min(c[1] - c[0], o[1] - o[0]);
      const a = await p95(closed.buf, c[0], h);
      const b = await p95(open.buf, o[0], h);
      expect(
        b,
        `секция «${name}» в раскрытом состоянии стоит на голом грунте: ` +
          `p95 = ${b.toFixed(1)} из 255 (грунт ~17,5). Это ровно то, что заказчик назвал ` +
          '«у других блоков пропадает фон».',
      ).toBeGreaterThan(BARE_GROUND);
      expect(
        Math.abs(b - a),
        `секция «${name}» меняет своё небо при раскрытии карточек: ` +
          `p95 ${a.toFixed(1)} → ${b.toFixed(1)} из 255. Небо стоит на месте, а содержимое едет поверх, ` +
          'поэтому хвосты слоёв 3 и 5 обязаны держать плотность одинаковой на всём ходе.',
      ).toBeLessThanOrEqual(MAX_P95_DRIFT);
    }
  });
}

for (const width of [390, 1440] as const) {
  test(`у каждого слоя обе кромки растворены, ширина ${width}`, async ({ page }) => {
    await prepare(page, width);
    const masks = await page.evaluate(() =>
      [...document.querySelectorAll('.scene-layer')].map((l) => ({
        mod: [...l.classList].find((c) => c.startsWith('scene-layer--')) ?? l.className,
        mask: getComputedStyle(l).maskImage,
      })),
    );
    expect(masks.length, 'слоёв сцены не найдено вовсе — проверять нечего').toBeGreaterThan(0);
    for (const m of masks) {
      expect(m.mask, `у слоя ${m.mod} нет маски — его кромка станет прямой горизонталью`).not.toBe(
        'none',
      );

      const stops = m.mask.match(/rgba?\([^)]*\)/g) ?? [];
      expect(stops.length, `маску слоя ${m.mod} не удалось разобрать: ${m.mask}`).toBeGreaterThan(
        1,
      );
      const alpha = (s: string | undefined) => {
        if (!s) return 1;
        const n = s.match(/[\d.]+/g)!.map(Number);
        return n.length >= 4 ? n[3] : 1;
      };
      expect(
        alpha(stops[0]),
        `верхняя кромка слоя ${m.mod} непрозрачна (${stops[0]}) — это прямая горизонталь через весь экран`,
      ).toBeLessThan(1);
      expect(
        alpha(stops[stops.length - 1]),
        `нижняя кромка слоя ${m.mod} непрозрачна (${stops[stops.length - 1]}) — это прямая горизонталь`,
      ).toBeLessThan(1);
    }
  });
}

for (const width of [390, 1440] as const) {
  for (const open of [false, true]) {
    test(`сцена не расширяет документ, ширина ${width}, карточки ${open ? 'раскрыты' : 'закрыты'}`, async ({
      page,
    }) => {
      await prepare(page, width);
      await setCards(page, open);
      const box = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
        docH: document.documentElement.scrollHeight,
        footBottom: Math.round(
          document.querySelector('.site-footer')!.getBoundingClientRect().bottom + window.scrollY,
        ),
      }));
      expect(
        box.scrollW,
        `у страницы появилась горизонтальная прокрутка (${box.scrollW} при окне ${box.clientW}): ` +
          'слой сцены шире окна и не обрезан — проверь `overflow-x: clip` у его секции-хозяина',
      ).toBeLessThanOrEqual(box.clientW);
      expect(
        box.docH - box.footBottom,
        `под подвалом осталось ${box.docH - box.footBottom}px пустоты: слой сцены свисает ниже ` +
          'конца страницы и тянет прокрутку за собой (гряда с огнями, «+100 за конец страницы»)',
      ).toBeLessThanOrEqual(1);
    });
  }
}

test('html и body красятся одним токеном', async ({ page }) => {
  await prepare(page, 390);
  const c = await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
  }));
  expect(
    c.body,
    `html ${c.html} против body ${c.body}: у страницы снова два цвета в корне, ` +
      'и при переполнении прокрутки видна полоса другого тона',
  ).toBe(c.html);
});

test('звёзды: восемь штук, и ни одна не лежит на тексте первого экрана', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const stars = await page.evaluate(() => {
    const hero = document.querySelector('.hero')!;
    const value = getComputedStyle(hero).getPropertyValue('--hero-stars');
    const positions = [...value.matchAll(/at\s+([\d.]+)%\s+([\d.]+)%/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }));
    const box = hero.getBoundingClientRect();
    const blockers = ['.hero-h1', '.hero-actions', '.hero-stats', '.site-header', 'header']
      .map((s) => document.querySelector(s))
      .filter((e): e is Element => Boolean(e))
      .map((e) => {
        const r = e.getBoundingClientRect();
        return {
          top: r.top - box.top,
          bottom: r.bottom - box.top,
          left: r.left - box.left,
          right: r.right - box.left,
        };
      });
    return {
      count: positions.length,
      hits: positions.filter((p) => {
        const px = (p.x / 100) * box.width;
        const py = (p.y / 100) * box.height;
        return blockers.some(
          (b) => px >= b.left - 6 && px <= b.right + 6 && py >= b.top - 6 && py <= b.bottom + 6,
        );
      }),
    };
  });
  expect(stars.count, 'звёзд в --hero-stars стало не восемь — макет показывает восемь').toBe(8);
  expect(
    stars.hits,
    `звёзды попали на текст или кнопки первого экрана: ${JSON.stringify(stars.hits)}`,
  ).toEqual([]);
});
