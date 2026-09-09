
import { test, expect } from '@playwright/test';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import path from 'node:path';

const LOCALES: Locale[] = ['mn', 'ru', 'en'];

function partnersFromConfig(): { id: string; name: string; followers: number }[] {
  const source = readFileSync(
    path.join(process.cwd(), 'src', 'config', 'index.ts'),
    'utf8',
  );
  const block = source.match(/people:\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
  expect(block, 'в src/config/index.ts не найден список config.partners.people').toBeTruthy();
  const people = [...block![1]!.matchAll(
    /id:\s*'([^']+)'\s*,\s*name:\s*'([^']+)'\s*,\s*followersThousands:\s*(\d+)/g,
  )].map((m) => ({ id: m[1]!, name: m[2]!, followers: Number(m[3]) }));

  expect(people.length, 'разбор конфига вернул пустой список — регулярка отстала от формата').toBe(4);
  return people;
}

function phoneOrderFromConfig(): string[] {
  const source = readFileSync(path.join(process.cwd(), 'src', 'config', 'index.ts'), 'utf8');

  const block = source.match(/phoneOrder:\s*Object\.freeze\(\[([\s\S]*?)\]\s*(?:as const\s*)?\)/);
  expect(block, 'в src/config/index.ts не найден config.partners.phoneOrder').toBeTruthy();
  const ids = [...block![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  expect(ids.length, 'разбор phoneOrder вернул не четыре имени').toBe(4);
  return ids;
}

const EXPECTED = partnersFromConfig();

const PHONE_ORDER = phoneOrderFromConfig();
const PHONE_EXPECTED = PHONE_ORDER.map((id) => {
  const person = EXPECTED.find((p) => p.id === id);
  expect(person, `phoneOrder называет «${id}», которого нет в people`).toBeTruthy();
  return person!;
});

test('⛔ два порядка блока РАЗНЫЕ, иначе проверки ниже ничего не различают', () => {
  expect(
    PHONE_ORDER.join(','),
    'phoneOrder совпал с people: либо Д-27 отменён (тогда правьте тесты явно), ' +
      'либо один из списков переставили молча',
  ).not.toBe(EXPECTED.map((p) => p.id).join(','));
});

test.describe('Блок «С нами уже сотрудничают» — состав (Д-07, Д-19)', () => {
  for (const locale of LOCALES) {
    test(`${locale}: ровно четыре человека в ТЕЛЕФОННОМ порядке разметки, у каждого имя и число`, async ({
      page,
    }) => {
      await page.goto(PAGE_ROUTES.home[locale]);

      const section = page.locator('section.partners');
      await expect(section).toHaveCount(1);

      const heading = section.locator('h2#partners-title');
      await expect(heading).toHaveCount(1);
      expect((await heading.innerText()).trim().length).toBeGreaterThan(0);
      await expect(section).toHaveAttribute('aria-labelledby', 'partners-title');

      const people = section.locator('.partners-person');
      await expect(people).toHaveCount(4);

      for (let i = 0; i < PHONE_EXPECTED.length; i++) {
        const row = people.nth(i);
        const name = (await row.locator('.partners-name').innerText()).trim();
        expect(name, `ряд ${i + 1} сверху на телефоне`).toBe(PHONE_EXPECTED[i]!.name);

        await expect(row).toHaveClass(new RegExp(`partners-person--${PHONE_EXPECTED[i]!.id}\\b`));

        const followers = (await row.locator('.partners-followers').innerText()).trim();
        expect(followers.length, `у ${name} пустая строка подписчиков`).toBeGreaterThan(0);
        expect(followers, `у ${name} нет числа ${PHONE_EXPECTED[i]!.followers}`).toContain(
          String(PHONE_EXPECTED[i]!.followers),
        );
      }

      const rendered = (await people.locator('.partners-name').allInnerTexts()).map((s) => s.trim());
      expect([...rendered].sort()).toEqual([...EXPECTED.map((p) => p.name)].sort());
    });
  }

  test('единица подписчиков ПЕРЕВЕДЕНА: три локали дают три разные строки', async ({ page }) => {

    const units = new Set<string>();
    for (const locale of LOCALES) {
      await page.goto(PAGE_ROUTES.home[locale]);
      const line = (
        await page.locator('.partners-person').first().locator('.partners-followers').innerText()
      ).trim();

      units.add(line.replace(String(EXPECTED[0]!.followers), '').trim());
    }
    expect(units.size, `единица не переведена: ${[...units].join(' | ')}`).toBe(3);
  });

  test('внутри блока ноль внешних ссылок', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.mn);
    const links = page.locator('section.partners a');
    await expect(links).toHaveCount(0);
  });
});

test.describe('Блок «С нами уже сотрудничают» — кадры', () => {

  test('групповой кадр ленивый, с явными размерами и непустым alt', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.mn);
    const img = page.locator('.partners-shot img');
    await expect(img).toHaveCount(1);

    await expect(img).toHaveAttribute('loading', 'lazy');
    await expect(img).toHaveAttribute('decoding', 'async');

    const width = Number(await img.getAttribute('width'));
    const height = Number(await img.getAttribute('height'));
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);

    const alt = (await img.getAttribute('alt')) ?? '';
    expect(alt.trim().length).toBeGreaterThan(0);

    for (const person of EXPECTED) {
      expect(alt).toContain(person.name);
    }
  });

  test('четыре портрета ленивые, с явными размерами и ПУСТЫМ alt', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.mn);
    const imgs = page.locator('.partners-bust img');
    await expect(imgs).toHaveCount(4);

    for (let i = 0; i < 4; i++) {
      const img = imgs.nth(i);
      await expect(img).toHaveAttribute('loading', 'lazy');
      await expect(img).toHaveAttribute('decoding', 'async');
      expect(Number(await img.getAttribute('width'))).toBeGreaterThan(0);
      expect(Number(await img.getAttribute('height'))).toBeGreaterThan(0);

      expect(await img.getAttribute('alt'), `у портрета ${i + 1} нет атрибута alt`).toBe('');
    }
  });

  test('портреты вне критического пути: после последнего блокирующего ресурса, сами не блокируют', async ({
    page,
  }) => {
    const requested: string[] = [];
    await page.route('**/_astro/client-partner-*', (route) => {
      requested.push(route.request().url());
      return route.continue();
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.mn);

    await page.waitForFunction(
      () => performance.getEntriesByType('resource').some((r) => /client-partner-/.test(r.name)),
      undefined,
      { timeout: 15_000 },
    );

    const timing = await page.evaluate(() => {
      const all = performance.getEntriesByType('resource') as (PerformanceResourceTiming & {
        renderBlockingStatus?: string;
      })[];
      const blocking = all.filter((r) => r.renderBlockingStatus === 'blocking');
      const busts = all.filter((r) => /client-partner-/.test(r.name));
      return {
        blockingCount: blocking.length,
        lastBlockingEnd: blocking.reduce((m, r) => Math.max(m, r.responseEnd), 0),
        starts: busts.map((r) => r.startTime),
        blockingStatus: busts.map((r) => r.renderBlockingStatus),
      };
    });

    expect(timing.blockingCount, 'блокирующих отрисовку ресурсов ноль — порог мерить не от чего').toBeGreaterThan(0);
    expect(timing.starts.length, 'портреты не запрошены ВООБЩЕ').toBeGreaterThan(0);

    for (const [i, start] of timing.starts.entries()) {
      expect(
        start,
        `портрет ${i + 1} попал в критический путь: запрос на ${start.toFixed(1)} мс при последнем блокирующем ресурсе на ${timing.lastBlockingEnd.toFixed(1)} мс`,
      ).toBeGreaterThanOrEqual(timing.lastBlockingEnd);
    }
    for (const status of timing.blockingStatus) {
      expect(status ?? 'non-blocking', 'портрет стал блокирующим отрисовку').toBe('non-blocking');
    }

    await page.locator('section.partners').scrollIntoViewIfNeeded();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll<HTMLImageElement>('.partners-bust img')].every(
          (img) => img.complete && img.naturalWidth > 0,
        ),
      undefined,
      { timeout: 10_000 },
    );
    expect(requested.length).toBeGreaterThan(0);
  });

  test('⛔ телефон везёт САМЫЙ УЗКИЙ кандидат портрета, а на плотном экране — следующий', async ({
    browser,
  }) => {

    const chosen = async (width: number, dpr: number) => {
      const ctx = await browser.newContext({
        viewport: { width, height: 844 },
        deviceScaleFactor: dpr,
      });
      const page = await ctx.newPage();
      await page.goto(PAGE_ROUTES.home.mn);
      await page.locator('section.partners').scrollIntoViewIfNeeded();
      await page.waitForFunction(
        () => {
          const img = document.querySelector<HTMLImageElement>('.partners-bust img');
          return Boolean(img && img.complete && img.naturalWidth > 0);
        },
        undefined,
        { timeout: 10_000 },
      );
      const out = await page.evaluate(() => {
        const img = document.querySelector<HTMLImageElement>('.partners-bust img')!;
        const picture = img.closest('picture')!;
        const entries = [...picture.querySelectorAll('source'), img].flatMap((el) =>
          (el.getAttribute('srcset') ?? '')
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => {
              const [url, descriptor] = part.split(/\s+/);
              return { file: url!.split('/').pop()!, w: parseInt(descriptor ?? '0', 10) };
            }),
        );
        const current = img.currentSrc.split('/').pop();
        const hit = entries.find((e) => e.file === current);
        return {
          picked: hit ? hit.w : null,
          candidates: [...new Set(entries.map((e) => e.w))].sort((a, b) => a - b),
        };
      });
      await ctx.close();
      return out;
    };

    const phone = await chosen(390, 1);
    expect(phone.candidates.length, 'у портрета нет набора кандидатов').toBeGreaterThan(1);
    expect(
      phone.picked,
      `на 390 при DPR 1 выбран кандидат ${phone.picked}w при наборе ${phone.candidates.join('/')} — sizes не сработал`,
    ).toBe(phone.candidates[0]);

    const dense = await chosen(430, 2);
    expect(
      dense.picked,
      `на 430 при DPR 2 выбран тот же минимальный кандидат ${dense.picked}w — значит srcset не работает`,
    ).toBeGreaterThan(phone.candidates[0]!);
  });
});

test.describe('Блок «С нами уже сотрудничают» — раскладка', () => {
  test('360×800 mn: ни горизонтальной прокрутки, ни обрезанных имён', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(PAGE_ROUTES.home.mn);
    await page.locator('section.partners').scrollIntoViewIfNeeded();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'страница даёт горизонтальную прокрутку на 360').toBeLessThanOrEqual(0);

    const names = page.locator('.partners-name');
    const count = await names.count();
    expect(count).toBe(4);

    const fits = await names.evaluateAll((els) =>
      els.map((el) => {
        const box = el.getBoundingClientRect();
        const col = el.closest('.partners-line')!.getBoundingClientRect();
        return {
          text: (el.textContent ?? '').trim(),
          over: +Math.max(col.left - box.left, box.right - col.right).toFixed(1),
        };
      }),
    );
    for (const row of fits) {
      expect(row.over, `бокс ника «${row.text}» вылезает из колонки на 360px`).toBeLessThanOrEqual(0.5);
    }

    const followerCuts = await page.locator('.partners-followers').evaluateAll((els) =>
      els
        .map((el) => ({ text: (el.textContent ?? '').trim(), cut: el.scrollWidth - el.clientWidth }))
        .filter((r) => r.cut > 1),
    );
    expect(followerCuts, `на 360px обрезано ${JSON.stringify(followerCuts)}`).toEqual([]);
  });

  test('⛔ ЗАМОК 3: телефон идёт по разметке сверху вниз, десктоп — по четвертям холста', async ({
    page,
  }) => {

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.mn);
    await page.locator('section.partners').scrollIntoViewIfNeeded();
    const phone = await page.locator('.partners-person').evaluateAll((nodes) =>
      nodes.map((n) => ({
        name: (n.querySelector('.partners-name')?.textContent ?? '').trim(),
        y: n.getBoundingClientRect().top,
      })),
    );
    expect(phone.length).toBe(4);
    expect(
      phone.map((p) => p.name),
      'разметка телефона разошлась с config.partners.phoneOrder',
    ).toEqual(PHONE_EXPECTED.map((p) => p.name));
    for (let i = 1; i < phone.length; i++) {
      expect(
        phone[i]!.y,
        `на 390px ряд «${phone[i]!.name}» стоит выше более раннего соседа`,
      ).toBeGreaterThan(phone[i - 1]!.y);
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.mn);
    await page.locator('section.partners').scrollIntoViewIfNeeded();
    const desk = await page.locator('.partners-person').evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return {
          name: (n.querySelector('.partners-name')?.textContent ?? '').trim(),
          x: r.left,
          cx: r.left + r.width / 2,
          y: r.top,
        };
      }),
    );
    expect(desk.length).toBe(4);
    const leftToRight = [...desk].sort((a, b) => a.x - b.x);
    expect(
      leftToRight.map((p) => p.name),
      'на 1440px имена стоят не в порядке четвертей группового кадра',
    ).toEqual(EXPECTED.map((p) => p.name));

    const rowTops = new Set(desk.map((p) => Math.round(p.y)));
    expect(rowTops.size, `имена разъехались по ${rowTops.size} строкам вместо одной`).toBe(1);

    const shot = await page.locator('.partners-shot').boundingBox();
    expect(shot, 'группового кадра нет на 1440').toBeTruthy();
    const heads = [0.2522, 0.422, 0.5826, 0.7524];
    for (let i = 0; i < leftToRight.length; i++) {
      const head = shot!.x + shot!.width * heads[i]!;
      expect(
        Math.abs(leftToRight[i]!.cx - head),
        `имя «${leftToRight[i]!.name}» стоит на ${leftToRight[i]!.cx.toFixed(0)}, ` +
          `а голова его человека — на ${head.toFixed(0)}`,
      ).toBeLessThan(shot!.width * 0.03);
    }
  });

  test('имена партнёров ничем не перекрыты внизу экрана', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.mn);

    await expect(page.locator('.sticky-cta')).toHaveCount(0);

    const names = page.locator('.partners-name');
    await expect(names).toHaveCount(4);

    for (let i = 0; i < 4; i++) {

      await names.nth(i).evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(300);

      await names.nth(i).evaluate(
        (el) =>
          new Promise<void>((done) => {
            let prev = -1;
            let stabil = 0;
            const tick = () => {
              const y = Math.round(el.getBoundingClientRect().top);
              stabil = y === prev ? stabil + 1 : 0;
              prev = y;
              if (stabil >= 2) {
                el.scrollIntoView({ block: 'center' });
                requestAnimationFrame(() => done());
                return;
              }
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
      );
      await page.waitForTimeout(200);

      const hit = await names.nth(i).evaluate((el) => {
        const r = el.getBoundingClientRect();

        const vTop = Math.max(r.top, 0);
        const vBottom = Math.min(r.bottom, window.innerHeight);
        if (vBottom - vTop < 2) return '(имя не попало в кадр вовсе)';
        const y = (vTop + vBottom) / 2;
        const x = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1);
        const top = document.elementFromPoint(x, y);
        if (!top) return '(elementFromPoint вернул null при видимом имени)';
        return el.contains(top) || top === el
          ? null
          : `${top.tagName.toLowerCase()}.${(top.className || '').toString().trim().split(/\s+/)[0]}`;
      });
      const text = (await names.nth(i).innerText()).trim();
      expect(hit, `имя «${text}» перекрыто элементом ${hit} — до него не дотянуться`).toBeNull();
    }

    await page.locator('.site-footer').scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await expect(page.locator('.sticky-cta')).toHaveCount(0);
  });
});

const PHONE_WIDTHS = [360, 390, 430] as const;
const BREAKPOINT = 720;

interface RowBox {
  name: string;
  li: { x: number; y: number; w: number; h: number };
  bust: { x: number; y: number; w: number; h: number } | null;
  text: { x: number; y: number; w: number; h: number };
  nameBox: { x: number; y: number; w: number; h: number };
  fontSize: string;
}

async function goldInkAngle(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const pts: [number, number, number][] = [];
  let sw = 0;
  let mx = 0;
  let my = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * C;
      if (data[i + 3]! < 128) continue;
      const w = Math.max(0, data[i]! - data[i + 2]! - 20) * (data[i + 1]! > 60 ? 1 : 0);
      if (w <= 0) continue;
      pts.push([x, y, w]);
      sw += w;
      mx += x * w;
      my += y * w;
    }
  }
  expect(sw, 'на кадре ника нет золотых чернил — маска не доехала').toBeGreaterThan(0);
  mx /= sw;
  my /= sw;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y, w] of pts) {
    const dx = x - mx;
    const dy = y - my;
    sxx += w * dx * dx;
    sxy += w * dx * dy;
    syy += w * dy * dy;
  }
  sxx /= sw;
  sxy /= sw;
  syy /= sw;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  let vx = sxy;
  let vy = l1 - sxx;
  if (Math.abs(sxy) < 1e-9) {
    vx = 1;
    vy = 0;
  }
  const n = Math.hypot(vx, vy);
  vx /= n;
  vy /= n;
  if (vx < 0) {
    vx = -vx;
    vy = -vy;
  }
  return (-Math.atan2(vy, vx) * 180) / Math.PI;
}

async function rowBoxes(page: import('@playwright/test').Page): Promise<RowBox[]> {
  return page.locator('.partners-person').evaluateAll((nodes) =>
    nodes.map((li) => {
      const box = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
      };
      const bust = li.querySelector('.partners-bust');
      const visible = bust && getComputedStyle(bust).display !== 'none';
      const name = li.querySelector('.partners-name')!;
      return {
        name: (name.textContent ?? '').trim(),
        li: box(li)!,
        bust: visible ? box(bust) : null,
        text: box(li.querySelector('.partners-line'))!,
        nameBox: box(name)!,
        fontSize: getComputedStyle(name).fontSize,
      };
    }),
  );
}

test.describe('Блок блогеров — телефонная раскладка (28.08.2026)', () => {
  for (const locale of LOCALES) {
    test(`⛔ ЗАМОК 1 (${locale}): каждое имя стоит рядом со СВОИМ портретом, сверено по имени файла`, async ({
      page,
    }) => {

      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(PAGE_ROUTES.home[locale]);
      await page.locator('section.partners').scrollIntoViewIfNeeded();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll<HTMLImageElement>('.partners-bust img')].every(
            (i) => i.complete && i.naturalWidth > 0,
          ),
        undefined,
        { timeout: 15_000 },
      );

      const rows = await page.locator('.partners-person').evaluateAll((nodes) =>
        nodes.map((li) => {
          const nameEl = li.querySelector('.partners-name')!;
          const img = li.querySelector<HTMLImageElement>('.partners-bust img')!;
          const style = getComputedStyle(nameEl);
          return {
            text: (nameEl.textContent ?? '').trim(),
            liClass: li.className,
            nameClass: nameEl.className,
            bustSrc: img.currentSrc || img.src,
            mask: style.maskImage || style.webkitMaskImage || '',
          };
        }),
      );

      expect(rows.length).toBe(4);
      for (let i = 0; i < PHONE_EXPECTED.length; i++) {
        const want = PHONE_EXPECTED[i]!;
        const row = rows[i]!;
        expect(row.text, `ряд ${i + 1}: чужое имя`).toBe(want.name);
        expect(row.liClass, `ряд ${i + 1}: класс ряда не про ${want.id}`).toContain(
          `partners-person--${want.id}`,
        );
        expect(row.nameClass, `ряд ${i + 1}: класс ника не про ${want.id}`).toContain(
          `partners-name--${want.id}`,
        );

        expect(
          row.bustSrc,
          `у ряда «${want.name}» стоит кадр ${row.bustSrc}, а должен client-partner-${want.id}`,
        ).toContain(`client-partner-${want.id}`);
        expect(
          row.mask,
          `у ряда «${want.name}» маска ника ${row.mask}, а должна client-name-${want.id}`,
        ).toContain(`client-name-${want.id}`);
      }
    });
  }

  test('⛔ ЗАМОК 2: сторона портрета следует чётности ряда, фигура уходит за кромку экрана', async ({
    page,
  }) => {

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.mn);
    await page.locator('section.partners').scrollIntoViewIfNeeded();

    const frame = await page.evaluate(() => {
      const ul = document.querySelector('.partners-names')!.getBoundingClientRect();
      return { left: +ul.x.toFixed(1), right: +(ul.x + ul.width).toFixed(1) };
    });
    const rows = await rowBoxes(page);
    for (const [i, row] of rows.entries()) {
      const bust = row.bust!;
      const wantLeft = i % 2 === 0;
      if (wantLeft) {
        expect(bust.x, `ряд ${i + 1} («${row.name}») не прижат к ЛЕВОЙ кромке`).toBeLessThanOrEqual(
          frame.left + 0.5,
        );
      } else {
        expect(
          bust.x + bust.w,
          `ряд ${i + 1} («${row.name}») не прижат к ПРАВОЙ кромке`,
        ).toBeGreaterThanOrEqual(frame.right - 0.5);
      }
    }
  });

  test('⛔ телефон везёт ЧЕТЫРЕ портрета и НИ ОДНОГО группового кадра', async ({ page }) => {
    const seen: string[] = [];
    await page.route('**/_astro/client-partner*', (route) => {
      seen.push(route.request().url().split('/').pop()!);
      return route.continue();
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.mn);
    await page.locator('section.partners').scrollIntoViewIfNeeded();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll<HTMLImageElement>('.partners-bust img')].every(
          (i) => i.complete && i.naturalWidth > 0,
        ),
      undefined,
      { timeout: 15_000 },
    );

    await page.waitForTimeout(800);

    const busts = seen.filter((f) => f.startsWith('client-partner-'));
    const groups = seen.filter((f) => f.startsWith('client-partners-group'));

    expect(new Set(busts).size, `бюстов приехало ${busts.length}: ${busts.join(', ')}`).toBe(4);
    expect(
      groups,
      'телефон скачал ДЕСКТОПНЫЙ групповой кадр — значит display:none у ленивого кадра сломан',
    ).toEqual([]);

    expect(busts.length, 'перехват не увидел ни одного портрета').toBeGreaterThan(0);
  });

  test('⛔ десктоп везёт групповой кадр и НИ ОДНОГО портрета', async ({ page }) => {
    const seen: string[] = [];
    await page.route('**/_astro/client-partner*', (route) => {
      seen.push(route.request().url().split('/').pop()!);
      return route.continue();
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.mn);
    await page.locator('section.partners').scrollIntoViewIfNeeded();
    await page.waitForFunction(
      () => {
        const img = document.querySelector<HTMLImageElement>('.partners-shot img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      },
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(800);

    expect(
      seen.filter((f) => f.startsWith('client-partner-')),
      'десктоп скачал телефонные портреты — значит display:none у бюстов сломан',
    ).toEqual([]);
    expect(seen.filter((f) => f.startsWith('client-partners-group')).length).toBeGreaterThan(0);
  });

  for (const width of PHONE_WIDTHS) {
    test(`${width}px: шахматный порядок, полное поле, перекрытие рядов`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(PAGE_ROUTES.home.mn);
      await page.locator('section.partners').scrollIntoViewIfNeeded();

      const frame = await page.evaluate(() => {
        const ul = document.querySelector('.partners-names')!.getBoundingClientRect();
        const sec = document.querySelector('section.partners')!.getBoundingClientRect();
        return { left: +ul.x.toFixed(1), right: +(ul.x + ul.width).toFixed(1), width: +ul.width.toFixed(1), sectionWidth: +sec.width.toFixed(1) };
      });

      expect(frame.width, 'список имён уже секции — значит он вернулся в контейнер с полями').toBe(
        frame.sectionWidth,
      );
      const canvas = frame.width;
      const rows = await rowBoxes(page);
      expect(rows.length).toBe(4);

      for (const [i, row] of rows.entries()) {
        expect(row.bust, `у ряда ${i + 1} нет портрета на ${width}px`).not.toBeNull();
        const bust = row.bust!;

        if (i % 2 === 0) {

          expect(bust.x, `ряд ${i + 1}: портрет не прижат к левой кромке`).toBeLessThanOrEqual(frame.left + 0.5);
          expect(row.text.x, `ряд ${i + 1}: текст не справа от портрета`).toBeGreaterThan(
            bust.x + bust.w - 1,
          );
        } else {

          expect(
            bust.x + bust.w,
            `ряд ${i + 1}: портрет не прижат к правой кромке`,
          ).toBeGreaterThanOrEqual(frame.right - 0.5);
          expect(row.text.x, `ряд ${i + 1}: текст не слева от портрета`).toBeLessThan(bust.x);
        }

        expect(
          bust.h / bust.w,
          `ряд ${i + 1}: пропорция портрета ${(bust.h / bust.w).toFixed(3)} вместо 1,458 — холст бюста в конвейере изменён`,
        ).toBeCloseTo(1400 / 960, 2);

        expect(bust.w / canvas, `ряд ${i + 1}: доля портрета ${(bust.w / canvas).toFixed(3)}`).toBeGreaterThan(0.42);
        expect(bust.w / canvas, `ряд ${i + 1}: доля портрета ${(bust.w / canvas).toFixed(3)}`).toBeLessThan(0.5);
      }

      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1]!.li;
        const cur = rows[i]!.li;
        expect(
          cur.y,
          `ряды ${i} и ${i + 1} не перекрываются: следующий начинается на ${cur.y}, предыдущий кончается на ${prev.y + prev.h}`,
        ).toBeLessThan(prev.y + prev.h);
      }
    });

    test(`${width}px: имя следующего ряда не ложится на печать футболки предыдущего`, async ({
      page,
    }) => {

      await page.setViewportSize({ width, height: 844 });
      await page.goto(PAGE_ROUTES.home.mn);
      await page.locator('section.partners').scrollIntoViewIfNeeded();

      const rows = await rowBoxes(page);
      for (let i = 1; i < rows.length; i++) {
        const prevBust = rows[i - 1]!.bust!;
        const nameTop = rows[i]!.nameBox.y;
        const limit = prevBust.y + prevBust.h * 0.88;
        expect(
          nameTop,
          `имя «${rows[i]!.name}» встаёт на ${nameTop} при печати предыдущего ряда до ${limit}`,
        ).toBeGreaterThanOrEqual(limit);
      }
    });
  }

  test('⛔ точка слома 720px: ниже — портреты, от 720 — групповой кадр', async ({ page }) => {
    const state = async (width: number) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(PAGE_ROUTES.home.mn);
      await page.locator('section.partners').scrollIntoViewIfNeeded();
      return page.evaluate(() => ({
        busts: [...document.querySelectorAll('.partners-bust')].filter(
          (el) => getComputedStyle(el).display !== 'none',
        ).length,
        group: getComputedStyle(document.querySelector('.partners-shot-wrap')!).display,
        columns: getComputedStyle(document.querySelector('.partners-names')!).gridTemplateColumns,
      }));
    };

    const below = await state(BREAKPOINT - 1);
    expect(below.busts, 'на 719px портретов нет').toBe(4);
    expect(below.group, 'на 719px групповой кадр показан').toBe('none');

    const above = await state(BREAKPOINT);
    expect(above.busts, 'на 720px портреты остались').toBe(0);
    expect(above.group, 'на 720px группового кадра нет').not.toBe('none');

    expect(above.columns.split(' ').length, `колонок имён: ${above.columns}`).toBe(4);
  });

  test('⛔ десктопный кегль имени НЕ ТРОНУТ правкой телефона', async ({ page }) => {

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.mn);
    const size = await page
      .locator('.partners-name')
      .first()
      .evaluate((el) => getComputedStyle(el).fontSize);
    expect(size).toBe('36px');
  });

  test('⛔ ник остаётся ТЕКСТОМ, а начертание приходит маской, и маска реально загрузилась', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.mn);
    await page.locator('section.partners').scrollIntoViewIfNeeded();

    const rows = await page.locator('.partners-name').evaluateAll(async (els) =>
      Promise.all(
        els.map(async (el) => {
          const cs = getComputedStyle(el);
          const raw = cs.maskImage !== 'none' ? cs.maskImage : cs.webkitMaskImage;
          const url = /url\("?([^")]+)"?\)/.exec(raw ?? '')?.[1] ?? '';

          const nat = await new Promise<{ w: number; h: number } | null>((res) => {
            if (!url) return res(null);
            const im = new Image();
            im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
            im.onerror = () => res(null);
            im.src = url;
          });
          const box = el.getBoundingClientRect();
          return {
            text: (el.textContent ?? '').trim(),
            url,
            nat,
            bg: cs.backgroundColor,
            color: cs.color,
            w: +box.width.toFixed(2),
            h: +box.height.toFixed(2),
          };
        }),
      ),
    );

    expect(rows).toHaveLength(4);
    for (const row of rows) {

      expect(row.text.length, 'ник пропал из разметки').toBeGreaterThan(0);

      expect(row.bg, `${row.text}: бокс ника красится не --gold`).toBe('rgb(241, 198, 50)');

      expect(row.color, `${row.text}: текст под маской не прозрачен`).toBe('rgba(0, 0, 0, 0)');

      expect(row.url, `${row.text}: маска не назначена`).toMatch(/client-name-[a-z0-9]+\.[A-Za-z0-9_-]+\.webp$/);
      expect(row.nat, `${row.text}: маска ${row.url} не загрузилась`).not.toBeNull();

      const want = row.nat!.w / row.nat!.h;
      const got = row.w / row.h;
      expect(
        Math.abs(got - want) / want,
        `${row.text}: бокс ${row.w}×${row.h} (${got.toFixed(3)}) против маски ${row.nat!.w}×${row.nat!.h} (${want.toFixed(3)})`,
      ).toBeLessThan(0.02);
    }

    const geom = await page.locator('.partners-name').evaluateAll((els) =>
      els.map((el) => {
        const cs = getComputedStyle(el);
        return {
          text: (el.textContent ?? '').trim(),
          h: +el.getBoundingClientRect().height.toFixed(2),

          k: parseFloat(cs.getPropertyValue('--partner-name-k') || '1'),
        };
      }),
    );
    expect(geom).toHaveLength(4);
    const bases: number[] = [];
    for (const g of geom) {

      expect(g.k, `${g.text}: множитель высоты ${g.k} вне вилки`).toBeGreaterThan(0.7);
      expect(g.k, `${g.text}: множитель высоты ${g.k} вне вилки`).toBeLessThanOrEqual(1.3);
      bases.push(g.h / g.k);
    }

    const spread = Math.max(...bases) - Math.min(...bases);
    expect(
      spread,
      `база высоты разошлась: ${bases.map((b) => b.toFixed(2)).join(', ')} ` +
        `(высоты ${geom.map((g) => g.h).join(', ')}, множители ${geom.map((g) => g.k).join(', ')})`,
    ).toBeLessThan(0.8);

    expect(
      geom.filter((g) => Math.abs(g.k - 1) > 0.001).length,
      `множителей, отличных от единицы: ${geom.map((g) => g.k).join(', ')}`,
    ).toBe(4);

    expect(new Set(rows.map((r) => r.w)).size).toBe(4);
  });

  test('⛔ ОТРИСОВАННЫЙ наклон ников равен наклону макета (Д-27.2)', async ({ page }) => {

    const TARGET: Record<string, number> = {
      Lexor2k: 6.13,
      'MaaRaa MN': 2.68,
      Newsac: 0.87,
      Zilkenberg: 0.56,
    };

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_ROUTES.home.mn);
    await page.locator('section.partners').scrollIntoViewIfNeeded();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll<HTMLImageElement>('.partners-bust img')].every(
          (i) => i.complete && i.naturalWidth > 0,
        ),
      undefined,
      { timeout: 15_000 },
    );

    await page.waitForTimeout(600);

    const names = page.locator('.partners-name');
    expect(await names.count()).toBe(4);

    await page.addStyleTag({
      content: `html, body { background: #000 !important; }
        body * { visibility: hidden !important; }
        .partners-name.mera-izolyaciya,
        .partners-name.mera-izolyaciya * { visibility: visible !important; }`,
    });

    const measured: { text: string; deg: number; want: number }[] = [];
    for (let i = 0; i < 4; i++) {
      const el = names.nth(i);
      const text = (await el.evaluate((n) => (n.textContent ?? '').trim())) as string;
      await el.evaluate((n) => n.classList.add('mera-izolyaciya'));
      const deg = await goldInkAngle(await el.screenshot({ scale: 'device' }));
      await el.evaluate((n) => n.classList.remove('mera-izolyaciya'));
      const want = TARGET[text];
      expect(want, `в таблице целей нет «${text}»`).toBeDefined();
      measured.push({ text, deg, want: want! });
    }
    for (const m of measured) {
      expect(
        Math.abs(m.deg - m.want),
        `ник «${m.text}» отрисован под ${m.deg.toFixed(2)}°, макет требует ${m.want}°. ` +
          `Все четыре: ${measured.map((x) => `${x.text} ${x.deg.toFixed(2)}° (цель ${x.want}°)`).join('; ')}`,
      ).toBeLessThanOrEqual(0.8);
    }
  });

  test('⛔ ЧЕТЫРЕ маски на три локали, а не двенадцать (слово заказчика 28.08.2026)', async ({
    page,
  }) => {
    const perLocale: Record<string, string[]> = {};
    for (const locale of LOCALES) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(PAGE_ROUTES.home[locale]);
      await page.locator('section.partners').scrollIntoViewIfNeeded();
      perLocale[locale] = await page.locator('.partners-name').evaluateAll((els) =>
        els.map((el) => {
          const cs = getComputedStyle(el);
          const raw = cs.maskImage !== 'none' ? cs.maskImage : cs.webkitMaskImage;
          return /url\("?([^")]+)"?\)/.exec(raw ?? '')?.[1] ?? '';
        }),
      );
    }
    // Полное совпадение НАБОРА И ПОРЯДКА: локалезависимой ветки нет и быть не
    // может, ник выбирается по person.id, а не по языку.
    expect(perLocale.ru, 'ru едет с другими масками, чем mn').toEqual(perLocale.mn);
    expect(perLocale.en, 'en едет с другими масками, чем mn').toEqual(perLocale.mn);
    expect(new Set(perLocale.mn).size, 'маски не уникальны — кто-то из четверых носит чужой ник').toBe(4);
  });

  // ⛔⛔ ЗАМОК ПЕРЕПИСАН 03.09.2026, ПОТОМУ ЧТО У НЕГО ИСЧЕЗ ПРЕДМЕТ. Правило
  // проекта: замок, потерявший предмет, переписывается на НОВОЕ обещание, а не
  // удаляется молча (амендмент CMPL-02 в .planning/REQUIREMENTS.md).
  //
  // ⚠️ ОН ПЕРЕПИСЫВАЕТСЯ УЖЕ ВТОРОЙ РАЗ, И ОБЕ ПРЕЖНИЕ РЕДАКЦИИ НАЗВАНЫ ВСЛУХ:
  //   1. «⛔ ночная подложка живёт ТОЛЬКО ниже 720px и на десктопе не
  //      скачивается» — требовал `display: none` и ноль запросов к
  //      `client-bokeh-hills` при 1440. Довод был про ГРАНИЦУ ЗАДАЧИ («пока не
  //      будем брать пк»), а не про красоту.
  //   2. «⛔ ночная подложка есть на ОБЕИХ раскладках и на десктопе не
  //      миниатюра» (02.09.2026) — требовал обратного: слой `.partners-scene`
  //      виден, прижат к низу секции, выше трети её высоты, и браузер берёт
  //      вариант шире 700px.
  //
  // ⛔ ПРЕДМЕТ ИСЧЕЗ 03.09.2026 ВМЕСТЕ СО ВСЕМИ СЛОЯМИ-КАДРАМИ НИЖЕ ПЕРВОГО
  // ЭКРАНА. Заказчик: «Зачем мне столько фонов которые конфликтуют между
  // собой?» — и эта полоса была САМОЙ ВЫБИВАЮЩЕЙСЯ из восьми. Замер того же
  // дня: полоса партнёров rgb(101,77,53) при соседях около rgb(20,25,40), то
  // есть тёплое пятно температурой B−R = −48 посреди страницы, где у всех
  // остальных полос +9…+39.
  //
  // Новое обещание — ровно то, ради чего слой сняли: у полосы партнёров НЕТ
  // своего фонового кадра, и её тон не отрывается от соседних полос.
  // ⚠️ Групповой кадр и четыре бюста замок не трогает: это СОДЕРЖИМОЕ блока,
  // оно осталось и остаётся.
  test('⛔ у полосы партнёров нет своего фона: тёплого острова на странице больше нет', async ({
    page,
  }) => {
    const requested: string[] = [];
    page.on('request', (r) => {
      if (/client-bokeh-hills/.test(r.url())) requested.push(r.url());
    });

    for (const width of [1440, 390]) {
      requested.length = 0;
      await page.setViewportSize({ width, height: width >= 1440 ? 900 : 844 });
      await page.goto(PAGE_ROUTES.home.mn);
      await page.locator('section.partners').scrollIntoViewIfNeeded();
      await page.waitForTimeout(900);

      expect(
        await page.locator('.partners-scene').count(),
        `на ${width} вернулась ночная подложка .partners-scene — у полосы снова свой фон`,
      ).toBe(0);
      expect(
        requested,
        `на ${width} снова запрошен client-bokeh-hills: ${requested.join(', ')}`,
      ).toEqual([]);

      // ⛔⛔ 06.09.2026 — УТВЕРЖДЕНИЕ ПЕРЕВЁРНУТО ТРЕТИЙ РАЗ, И ПРЕЖНЕЕ НАЗВАНО.
      // ~~«декоративных кадров внутри полосы ноль»~~ отменено заказчиком
      // вместе с плоским фоном: «Перенеси дизайн полностью как на
      // скрине». На всех четырёх утверждённых кадрах за блогерами и ПОД
      // ПОДВАЛОМ стоит гряда с огнями — слой 7 облачной сцены.
      //
      // ⛔ НОВОЕ ОБЕЩАНИЕ СТРОЖЕ, А НЕ СЛАБЕЕ: кадр внутри полосы обязан быть
      // РОВНО ОДИН и обязан быть именно слоем утверждённой сцены. Прежняя
      // болезнь («у полосы свой фон, тёплое пятно B−R = −48») этим закрыта не
      // хуже: любой второй кадр или кадр без класса `.scene-layer--hills`
      // роняет замок.
      const decor = await page.evaluate(() =>
        [...document.querySelectorAll('section.partners [aria-hidden="true"]')]
          .filter((el) => el.querySelector('img, picture'))
          .map((el) => el.className),
      );
      expect(
        decor.length,
        `на ${width} внутри полосы партнёров ${decor.length} декоративных кадров вместо одного: ` +
          decor.join(' | '),
      ).toBe(1);
      expect(
        decor[0],
        `на ${width} кадр внутри полосы — не слой утверждённой сцены: «${decor[0]}»`,
      ).toContain('scene-layer--hills');

      // Секция не красит себя сама: она стоит на сквозной краске страницы.
      const bg = await page.locator('section.partners').evaluate((el) => {
        const cs = getComputedStyle(el);
        return { color: cs.backgroundColor, image: cs.backgroundImage };
      });
      expect(
        bg.image,
        `на ${width} у полосы партнёров появился собственный фоновый рисунок: ${bg.image}`,
      ).toBe('none');
      expect(
        bg.color,
        `на ${width} полоса партнёров красит себя непрозрачно (${bg.color}) — ` +
          'сквозная сцена под ней оборвётся кромкой',
      ).toBe('rgba(0, 0, 0, 0)');
    }
  });

  // ⛔ ЗАМОК ПЕРЕВЁРНУТ 02.09.2026, И ПРЕЖНЯЯ ЕГО РЕДАКЦИЯ НАЗВАНА ВСЛУХ.
  // Он назывался «⛔ ДЕСКТОП масок не получает: там имя остаётся набранным
  // Manrope» и требовал `maskImage === 'none'` у всех четырёх ников при 1440.
  // Требование было верным ровно до тех пор, пока кистевые ники считались
  // телефонным приёмом.
  //
  // 02.09.2026 заказчик, глядя на десктоп: «вот эту картинку с именами возьми
  // другую, там в архиве с креативами есть другая картинка и сделай как в
  // макете». «Другая картинка» — те же `*_name.png` из архива, то есть
  // кистевые ники; в десктопном макете имена набраны именно ими, а не нашей
  // гарнитурой. Замок теперь стережёт ЭТО, и с той же строгостью: маска обязана
  // быть у всех четверых, и она обязана быть СВОЯ у каждого — иначе один и тот
  // же файл под четырьмя именами прошёл бы прежнюю проверку.
  test('⛔ на десктопе у каждого ника СВОЯ кистевая маска', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.mn);
    await page.locator('section.partners').scrollIntoViewIfNeeded();
    const masks = await page.locator('.partners-name').evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).maskImage),
    );
    expect(masks).toHaveLength(4);
    for (const m of masks) {
      expect(m, 'на десктопе ник остался без кистевой маски').toContain('url(');
    }
    expect(new Set(masks).size, 'у ников одна маска на всех — файлы перепутаны').toBe(4);
  });

  test('⛔ кегль имени на телефоне вырос и ни одно имя не обрезано в трёх локалях', async ({
    page,
  }) => {
    for (const width of PHONE_WIDTHS) {
      for (const locale of LOCALES) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(PAGE_ROUTES.home[locale]);
        await page.locator('section.partners').scrollIntoViewIfNeeded();

        const rows = await rowBoxes(page);
        for (const row of rows) {
          // 26px — нижняя ступень телефонного clamp. Прежняя раскладка давала
          // 20,6px на 390, и заказчик назвал блок непохожим на макет.
          expect(
            parseFloat(row.fontSize),
            `${locale} ${width}px: кегль имени ${row.fontSize}`,
          ).toBeGreaterThanOrEqual(26);
        }

        // ⚠️ `.partners-name` выведен из проверки текстового переполнения
        // 28.08.2026: его буквы рисует маска, а текст под ней прозрачен и
        // клипается боксом СПЕЦИАЛЬНО. Вместо этого бокс ника проверяется на
        // выход из колонки — тем же замером, что и на 360.
        const cuts = await page.locator('.partners-followers').evaluateAll((els) =>
          els
            .map((el) => ({ text: (el.textContent ?? '').trim(), cut: el.scrollWidth - el.clientWidth }))
            .filter((r) => r.cut > 1),
        );
        expect(cuts, `${locale} ${width}px: обрезано ${JSON.stringify(cuts)}`).toEqual([]);

        const over = await page.locator('.partners-name').evaluateAll((els) =>
          els
            .map((el) => {
              const box = el.getBoundingClientRect();
              const col = el.closest('.partners-line')!.getBoundingClientRect();
              return {
                text: (el.textContent ?? '').trim(),
                over: +Math.max(col.left - box.left, box.right - col.right).toFixed(1),
              };
            })
            .filter((r) => r.over > 0.5),
        );
        expect(over, `${locale} ${width}px: бокс ника вне колонки ${JSON.stringify(over)}`).toEqual([]);

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${locale} ${width}px: горизонтальная прокрутка`).toBeLessThanOrEqual(0);
      }
    }
  });
});
