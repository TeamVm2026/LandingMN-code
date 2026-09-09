
import { test, expect, type Page } from '@playwright/test';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';
import {
  ATTRIBUTION_KEY,
  ATTRIBUTION_VERSION,
  ATTRIBUTION_TTL_MS,
  VALUE_MAX_LEN,
  CAPTURED_PARAMS,
  MARKS_MAX_COUNT,
  PRIORITY_MARKS,
  readAttribution,
  attributionSummary,
  type AttrRecord,
} from '../src/lib/attribution';

function subIds(n: number): Record<string, string> {
  const marks: Record<string, string> = {};
  for (let i = 1; i <= n; i++) marks[`sub_id_${i}`] = `v${i}`;
  return marks;
}

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  clear(): void {
    this.data.clear();
  }
}

function installStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
  return storage;
}

function removeStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

function touch(overrides: Partial<{ ts: number; m: Record<string, string>; ref: string; lp: string }> = {}) {
  return { ts: Date.now(), m: {}, ref: '', lp: '/', ...overrides };
}

test.describe('Модуль контракта: чтение записи', () => {
  test('пустое хранилище — это null, а не пустая запись', () => {
    installStorage();
    expect(readAttribution()).toBeNull();
  });

  test('отсутствующее хранилище не роняет вызов', () => {

    removeStorage();
    expect(() => readAttribution()).not.toThrow();
    expect(readAttribution()).toBeNull();
  });

  test('чужая версия схемы отбрасывается целиком, а не мигрируется', () => {
    const storage = installStorage();
    storage.setItem(
      ATTRIBUTION_KEY,
      JSON.stringify({ v: 999, ft: touch(), fc: null, lt: touch(), n: 3 }),
    );
    expect(readAttribution()).toBeNull();
  });

  test('запись старше 90 дней отбрасывается', () => {
    const storage = installStorage();
    const now = Date.now();
    const old = touch({ ts: now - ATTRIBUTION_TTL_MS - 1000 });
    storage.setItem(
      ATTRIBUTION_KEY,
      JSON.stringify({ v: ATTRIBUTION_VERSION, ft: old, fc: null, lt: old, n: 0 }),
    );
    expect(readAttribution(now)).toBeNull();

    const fresh = touch({ ts: now - ATTRIBUTION_TTL_MS + 1000 });
    storage.setItem(
      ATTRIBUTION_KEY,
      JSON.stringify({ v: ATTRIBUTION_VERSION, ft: fresh, fc: null, lt: fresh, n: 0 }),
    );
    expect(readAttribution(now)).not.toBeNull();
  });

  test('мусор вместо JSON даёт null, а не исключение', () => {
    const storage = installStorage();
    for (const junk of ['{не json', '[]', 'null', '42', '"строка"', '{}']) {
      storage.setItem(ATTRIBUTION_KEY, junk);
      expect(() => readAttribution(), `бросил на ${junk}`).not.toThrow();
      expect(readAttribution(), `не null на ${junk}`).toBeNull();
    }
  });

  test('запись с __proto__ читается, но не загрязняет Object.prototype', () => {

    const storage = installStorage();
    const now = Date.now();
    storage.setItem(
      ATTRIBUTION_KEY,
      `{"v":${ATTRIBUTION_VERSION},"ft":{"ts":${now},"m":{"utm_source":"fb","__proto__":{"polluted":true}},"ref":"","lp":"/"},` +
        `"fc":null,"lt":{"ts":${now},"m":{},"ref":"","lp":"/"},"n":1,"__proto__":{"polluted":true}}`,
    );

    const record = readAttribution(now);
    expect(record).not.toBeNull();
    expect(record!.ft.m.utm_source).toBe('fb');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((record!.ft.m as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(record!.ft.m)).toBe(Object.prototype);
  });

  test('значения режутся до потолка длины', () => {
    const storage = installStorage();
    const now = Date.now();
    const long = 'x'.repeat(VALUE_MAX_LEN * 3);
    storage.setItem(
      ATTRIBUTION_KEY,
      JSON.stringify({
        v: ATTRIBUTION_VERSION,
        ft: touch({ ts: now, m: { utm_campaign: long }, ref: long }),
        fc: null,
        lt: touch({ ts: now }),
        n: 0,
      }),
    );
    const record = readAttribution(now);
    expect(record!.ft.m.utm_campaign!.length).toBe(VALUE_MAX_LEN);
    expect(record!.ft.ref.length).toBe(VALUE_MAX_LEN);
  });

  test('усечение по числу меток не съедает utm_source и utm_campaign', () => {

    const storage = installStorage();
    const now = Date.now();
    const m = { ...subIds(15), utm_source: 'facebook', utm_campaign: 'august' };
    const t = touch({ ts: now, m, ref: 'l.facebook.com' });
    storage.setItem(
      ATTRIBUTION_KEY,
      JSON.stringify({ v: ATTRIBUTION_VERSION, ft: t, fc: t, lt: t, n: 1 }),
    );

    const record = readAttribution(now);
    expect(Object.keys(record!.fc!.m).length, 'потолок числа меток не применён').toBe(
      MARKS_MAX_COUNT,
    );
    expect(record!.fc!.m.utm_source, 'источник вытеснен метками трекера').toBe('facebook');
    expect(record!.fc!.m.utm_campaign, 'кампания вытеснена метками трекера').toBe('august');

    const summary = attributionSummary(record);
    expect(summary.source, 'менеджеру показан хост реферера вместо платного источника').toBe(
      'facebook',
    );
    expect(summary.campaign).toBe('august');
  });

  test('все приоритетные метки переживают усечение, даже когда их поставили последними', () => {
    const storage = installStorage();
    const now = Date.now();
    const priority = Object.fromEntries(PRIORITY_MARKS.map((k, i) => [k, `p${i}`]));

    const t = touch({ ts: now, m: { ...subIds(30), ...priority } });
    storage.setItem(
      ATTRIBUTION_KEY,
      JSON.stringify({ v: ATTRIBUTION_VERSION, ft: t, fc: null, lt: t, n: 1 }),
    );

    const record = readAttribution(now);
    for (const key of PRIORITY_MARKS) {
      expect(record!.ft.m[key], `${key} не пережил усечение`).toBe(priority[key]);
    }
    expect(Object.keys(record!.ft.m).length).toBe(MARKS_MAX_COUNT);
  });

  test('список ловимых параметров содержит и UTM, и метки BeMob', () => {
    for (const name of ['utm_source', 'utm_medium', 'utm_campaign', 'fbclid', 'bm_uid', 'sub_id', 's']) {
      expect(CAPTURED_PARAMS as readonly string[], `${name} выпал из списка`).toContain(name);
    }
  });
});

test.describe('Модуль контракта: сводка для менеджера', () => {
  test('пустая атрибуция — это «direct», а не пустая строка', () => {
    expect(attributionSummary(null)).toEqual({
      source: 'direct',
      campaign: '',
      medium: '',
      lastSource: '',
      touches: 0,
    });
  });

  test('источником считается первое касание С МЕТКОЙ, последнее идёт отдельно', () => {
    const now = Date.now();
    const record: AttrRecord = {
      v: ATTRIBUTION_VERSION,
      ft: touch({ ts: now, ref: 'facebook.com' }),
      fc: touch({ ts: now, m: { utm_source: 'fb', utm_campaign: 'aug', utm_medium: 'cpc' } }),
      lt: touch({ ts: now, m: { utm_source: 'tg' } }),
      n: 2,
    };
    const summary = attributionSummary(record);
    expect(summary.source).toBe('fb');
    expect(summary.campaign).toBe('aug');
    expect(summary.medium).toBe('cpc');
    expect(summary.lastSource).toBe('tg');
    expect(summary.touches).toBe(2);
  });

  test('без единой метки источником становится хост реферера', () => {

    const now = Date.now();
    const record: AttrRecord = {
      v: ATTRIBUTION_VERSION,
      ft: touch({ ts: now, ref: 'google.com' }),
      fc: null,
      lt: touch({ ts: now, ref: 'google.com' }),
      n: 0,
    };
    const summary = attributionSummary(record);
    expect(summary.source).toBe('google.com');
    expect(summary.campaign).toBe('');

    expect(summary.lastSource).toBe('');
  });

  test('совпадающее последнее касание не дублируется в сводке', () => {
    const now = Date.now();
    const record: AttrRecord = {
      v: ATTRIBUTION_VERSION,
      ft: touch({ ts: now, m: { utm_source: 'fb' } }),
      fc: touch({ ts: now, m: { utm_source: 'fb' } }),
      lt: touch({ ts: now, m: { utm_source: 'fb' } }),
      n: 1,
    };
    expect(attributionSummary(record).lastSource).toBe('');
  });
});

const LOCALES_UNDER_TEST: Locale[] = ['mn', 'ru', 'en'];

async function stored(page: Page): Promise<AttrRecord | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as AttrRecord) : null;
  }, ATTRIBUTION_KEY);
}

async function seed(page: Page, record: unknown): Promise<void> {
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key as string, value as string),
    [ATTRIBUTION_KEY, JSON.stringify(record)],
  );
}

test.describe('Перехват инлайновый, а не отложенный', () => {

  for (const locale of LOCALES_UNDER_TEST) {
    test(`метка сохраняется при полностью заблокированном /_astro/*.js (${locale})`, async ({ page }) => {
      const blocked: string[] = [];
      await page.route('**/_astro/*.js', (route) => {
        blocked.push(route.request().url());
        return route.abort();
      });

      await page.goto(`${PAGE_ROUTES.home[locale]}?utm_source=fb&utm_campaign=aug`);

      const record = await stored(page);
      expect(record, 'записи нет вовсе — перехват не исполнился в критическом пути').not.toBeNull();
      expect(record!.v).toBe(ATTRIBUTION_VERSION);
      expect(record!.fc, 'первое касание с меткой не создано').not.toBeNull();
      expect(record!.fc!.m.utm_source).toBe('fb');
      expect(record!.fc!.m.utm_campaign).toBe('aug');
      expect(record!.lt.m.utm_source).toBe('fb');
      expect(record!.n).toBe(1);
      expect(record!.ft.lp, 'страница входа записана неверно').toBe(PAGE_ROUTES.home[locale]);

      expect(blocked.length, 'ни один /_astro/*.js не запрашивался — блокировка мнимая').toBeGreaterThan(0);
    });
  }
});

test.describe('Поведение при повторных заходах', () => {
  test('первое касание с меткой не переписывается вторым', async ({ page }) => {

    await page.goto('/?utm_source=fb&utm_campaign=aug');
    const first = await stored(page);
    expect(first!.fc!.m.utm_source).toBe('fb');

    await page.goto('/?utm_source=tg&utm_campaign=sep');
    const second = await stored(page);

    expect(second!.fc!.m.utm_source, 'первое касание переписано вторым').toBe('fb');
    expect(second!.fc!.m.utm_campaign).toBe('aug');
    expect(second!.lt.m.utm_source, 'последнее касание не обновилось').toBe('tg');
    expect(second!.lt.m.utm_campaign).toBe('sep');
    expect(second!.n).toBe(2);
    expect(second!.ft.ts, 'самое первое касание тронуто').toBe(first!.ft.ts);
  });

  test('заход без меток не портит уже сохранённую запись', async ({ page }) => {
    await page.goto('/?utm_source=fb&utm_campaign=aug');
    const before = await stored(page);

    await page.goto('/');
    const after = await stored(page);

    expect(after).toEqual(before);
  });

  test('запись старше 90 дней отбрасывается, а не чинится', async ({ page }) => {
    await page.goto('/');
    const stale = Date.now() - ATTRIBUTION_TTL_MS - 60_000;
    await seed(page, {
      v: ATTRIBUTION_VERSION,
      ft: { ts: stale, m: { utm_source: 'старьё' }, ref: '', lp: '/' },
      fc: { ts: stale, m: { utm_source: 'старьё' }, ref: '', lp: '/' },
      lt: { ts: stale, m: { utm_source: 'старьё' }, ref: '', lp: '/' },
      n: 7,
    });

    await page.goto('/?utm_source=fb');
    const record = await stored(page);

    expect(record!.n, 'счётчик унаследован от протухшей записи').toBe(1);
    expect(record!.fc!.m.utm_source).toBe('fb');
    expect(record!.ft.ts, 'старое первое касание уцелело').toBeGreaterThan(stale);
  });

  test('чужая версия схемы отбрасывается целиком, а не мигрируется', async ({ page }) => {
    await page.goto('/');
    await seed(page, {
      v: 999,
      ft: { ts: Date.now(), m: { utm_source: 'из-будущего' }, ref: '', lp: '/' },
      fc: null,
      lt: { ts: Date.now(), m: {}, ref: '', lp: '/' },
      n: 42,

      legacySource: 'миграция',
      extra: { deep: true },
    });

    await page.goto('/?utm_source=fb');
    const record = (await stored(page)) as unknown as Record<string, unknown>;

    expect(record.v).toBe(ATTRIBUTION_VERSION);
    expect(record.n, 'счётчик пережил смену версии').toBe(1);
    expect(Object.keys(record).sort(), 'в записи остались посторонние поля').toEqual([
      'fc',
      'ft',
      'lt',
      'n',
      'v',
    ]);
  });
});

test.describe('Что именно ловится из адресной строки', () => {
  test('параметры BeMob ловятся наравне с UTM', async ({ page }) => {
    await page.goto('/?sub_id=abc123&bm_uid=xyz&utm_source=bemob');
    const record = await stored(page);

    expect(record!.lt.m.sub_id).toBe('abc123');
    expect(record!.lt.m.bm_uid).toBe('xyz');
    expect(record!.lt.m.utm_source).toBe('bemob');
  });

  test('страховочное правило ловит sub_id с любым индексом', async ({ page }) => {

    await page.goto('/?sub_id_7=zzz&subid=plain');
    const record = await stored(page);

    expect(record!.lt.m.sub_id_7, 'sub_id_7 не пойман — страховка не работает').toBe('zzz');
    expect(record!.lt.m.subid).toBe('plain');
  });

  test('пятнадцать sub_id перед блоком UTM не вытесняют источник из записи', async ({ page }) => {

    const params = [...Object.entries(subIds(15)).map(([k, v]) => `${k}=${v}`)];
    params.push('utm_source=facebook', 'utm_campaign=august');
    await page.goto(`/?${params.join('&')}`);

    const record = await stored(page);
    expect(record!.lt.m.utm_source, 'источник не записан — усечение съело его на записи').toBe(
      'facebook',
    );
    expect(record!.lt.m.utm_campaign).toBe('august');
    expect(
      Object.keys(record!.lt.m).length,
      'потолок числа меток на записи не применён — запись растёт без границ',
    ).toBe(MARKS_MAX_COUNT);
    expect(record!.fc!.m.utm_source).toBe('facebook');
  });

  test('сорок посторонних меток не раздувают запись сверх потолка', async ({ page }) => {

    const params = Object.entries(subIds(40)).map(([k, v]) => `${k}=${v}`);
    await page.goto(`/?${params.join('&')}`);

    const record = await stored(page);
    expect(Object.keys(record!.lt.m).length).toBe(MARKS_MAX_COUNT);
  });

  test('посторонние параметры в запись не попадают', async ({ page }) => {

    await page.goto('/?utm_source=fb&page=2&__proto__=x&session=secret');
    const record = await stored(page);

    expect(Object.keys(record!.lt.m).sort()).toEqual(['utm_source']);
  });
});

test.describe('Отказ хранилища — штатная ветка, а не авария', () => {
  test('страница читается и кнопки работают при неработающем localStorage', async ({ page }) => {

    await page.addInitScript(() => {
      const boom = () => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      };
      Storage.prototype.setItem = boom;
      Storage.prototype.getItem = boom;
    });

    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto('/?utm_source=fb&utm_campaign=aug');

    await expect(page.locator('h1').first()).toBeVisible();

    await expect(page.locator('#lead-contact')).toHaveJSProperty('inputMode', 'tel');
    const summary = page.locator('details[data-track-direction="bank"] > summary');
    await expect(summary).toBeVisible();

    await summary.evaluate((el) => (el as HTMLElement).click());
    await expect(page.locator('details[data-track-direction="bank"][open]')).toBeVisible();

    expect(pageErrors, `необработанные ошибки на странице: ${pageErrors.join(' | ')}`).toEqual([]);
  });
});
