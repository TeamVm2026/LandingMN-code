
import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequestPost } from '../../functions/api/client-error.ts';
import {
  HOURLY_CAP,
  IP_MAX_PER_WINDOW,
  IP_SHARE_OF_CAP,
  MESSAGE_MAX,
  REPORT_BODY_MAX_BYTES,
} from '../../src/server/report/throttle.ts';

const THROWING_FETCH = (() => {
  throw new Error('СЕТЬ ЗАПРЕЩЕНА: приёмник обратился к настоящему fetch');
}) as typeof fetch;
globalThis.fetch = THROWING_FETCH;

const TOKEN = '0000000000:FAKE-UNIT-TEST-TOKEN-NOT-A-REAL-BOT';
const TECH_CHAT = '-1000000000001';

const MANAGER_CHAT = '-1000000000000';

const API_BASE = 'https://telegram.invalid';
const ENDPOINT = 'https://landingmn.pages.dev/api/client-error';

function rawReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'js-error',
    message: "Cannot read properties of null (reading 'value')",
    source: 'https://landingmn.pages.dev/_astro/BaseLayout.Dx50E8Ir.js',
    line: 412,
    col: 17,
    route: '/ru/',
    locale: 'ru',
    ua: 'Mozilla/5.0 (Linux; Android 10; K)',
    ...overrides,
  };
}

interface FetchCall {
  url: string;
  body: string;
}

function createFakeCache() {
  const store = new Map<string, Response>();
  return {
    async match(request: Request): Promise<Response | undefined> {
      const hit = store.get(request.url);
      return hit ? hit.clone() : undefined;
    },
    async put(request: Request, response: Response): Promise<void> {
      store.set(request.url, response.clone());
    },
    get size(): number {
      return store.size;
    },
  };
}

interface HarnessOptions {
  env?: Record<string, string | undefined>;

  withoutCaches?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const fetchCalls: FetchCall[] = [];
  const pending: Promise<unknown>[] = [];
  const cache = createFakeCache();

  const globals = globalThis as unknown as { fetch: typeof fetch; caches?: unknown };
  const hadCaches = 'caches' in globals;
  const originalCaches = globals.caches;

  globals.fetch = (async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    fetchCalls.push({ url: String(input), body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ ok: true, result: { message_id: fetchCalls.length } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  if (options.withoutCaches) delete globals.caches;
  else globals.caches = { default: cache };

  const baseEnv: Record<string, unknown> = {
    TG_BOT_TOKEN: TOKEN,
    TG_TECH_CHAT_ID: TECH_CHAT,
    TG_API_BASE: API_BASE,
  };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete baseEnv[key];
    else baseEnv[key] = value;
  }

  async function post(
    payload: unknown,
    extra: { ip?: string; headers?: Record<string, string>; rawBody?: string } = {},
  ): Promise<Response> {
    const body = extra.rawBody ?? JSON.stringify(payload);
    const request = new Request(ENDPOINT, {
      method: 'POST',
      headers: {

        'content-type': 'text/plain;charset=UTF-8',
        'CF-Connecting-IP': extra.ip ?? '203.0.113.7',
        ...(extra.headers ?? {}),
      },
      body,
    });

    const context = {
      request,
      env: baseEnv,
      waitUntil: (promise: Promise<unknown>): void => {
        pending.push(promise);
      },
      passThroughOnException: (): void => undefined,
      next: async (): Promise<Response> => new Response(null, { status: 404 }),
      functionPath: '/api/client-error',
      params: {},
      data: {},
    };

    return await onRequestPost(context as unknown as Parameters<typeof onRequestPost>[0]);
  }

  return {
    fetchCalls,
    cache,
    post,
    async settle(): Promise<void> {
      await Promise.allSettled(pending);
      pending.length = 0;
    },

    sent(): { chat_id?: string; text?: string }[] {
      return this.fetchCalls.map((call) => JSON.parse(call.body) as { chat_id?: string; text?: string });
    },
    restore(): void {
      globals.fetch = THROWING_FETCH;
      if (hadCaches) globals.caches = originalCaches;
      else delete globals.caches;
    },
  };
}

function assertNeverManagerChat(harness: ReturnType<typeof createHarness>): void {
  for (const call of harness.fetchCalls) {
    assert.ok(
      !call.body.includes(MANAGER_CHAT),
      'БОЕВОЙ-ЧАТ-ЗАДЕТ: приёмник диагностики написал в чат менеджеров',
    );
  }
}

test('ПРИЁМНИК: незаданный TG_TECH_CHAT_ID -> 204 и НОЛЬ сетевых вызовов', async (t) => {
  const h = createHarness({ env: { TG_TECH_CHAT_ID: undefined } });
  t.after(() => h.restore());

  const response = await h.post(rawReport());
  await h.settle();

  assert.equal(response.status, 204);
  assert.equal(h.fetchCalls.length, 0, 'неконфигурированный приёмник не ходит в сеть');
});

test('ПРИЁМНИК: незаданный TG_BOT_TOKEN -> 204, тело даже не читается', async (t) => {
  const h = createHarness({ env: { TG_BOT_TOKEN: undefined } });
  t.after(() => h.restore());

  const response = await h.post(rawReport());
  await h.settle();

  assert.equal(response.status, 204);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.cache.size, 0, 'без секретов приёмник не трогает и кэш');
});

test('ПРИЁМНИК: объявленная длина больше потолка -> 204 и ноль доставок', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  const response = await h.post(rawReport(), {
    headers: { 'content-length': String(REPORT_BODY_MAX_BYTES + 1) },
  });
  await h.settle();

  assert.equal(response.status, 204);
  assert.equal(h.fetchCalls.length, 0, 'ТЕЛО-НЕ-ОГРАНИЧЕНО: гигантский отчёт дошёл до доставки');
});

test('ПРИЁМНИК: тело больше потолка БЕЗ Content-Length -> 204 и ноль доставок', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  const huge = JSON.stringify(rawReport({ message: 'ы'.repeat(REPORT_BODY_MAX_BYTES) }));
  const response = await h.post(null, { rawBody: huge });
  await h.settle();

  assert.equal(response.status, 204);
  assert.equal(h.fetchCalls.length, 0, 'ТЕЛО-НЕ-ОГРАНИЧЕНО: поток не оборван на потолке');
});

test('ПРИЁМНИК: битый JSON, пустое тело и не-отчёт -> 204 и ноль доставок', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  for (const raw of ['{не json', '', '[]', '"строка"', '{"kind":"csp","message":"x"}', '{"kind":"js-error"}']) {
    const response = await h.post(null, { rawBody: raw });
    assert.equal(response.status, 204, `мусор «${raw}» обязан получить 204`);
  }
  await h.settle();

  assert.equal(h.fetchCalls.length, 0, 'МУСОР-ДОСТАВЛЕН: непохожее на отчёт ушло в техчат');
});

test('ПРИЁМНИК: без кэша приёмник МОЛЧИТ, а не доставляет без ограничений', async (t) => {
  const h = createHarness({ withoutCaches: true });
  t.after(() => h.restore());

  const response = await h.post(rawReport());
  await h.settle();

  assert.equal(response.status, 204);
  assert.equal(
    h.fetchCalls.length,
    0,
    'ПОТОЛОК-НЕ-СРАБОТАЛ: без хранилища состояния доставка пошла бы без потолка',
  );
});

test('ДОСТАВКА: валидный отчёт -> ровно одно сообщение в ТЕХЧАТ', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  const response = await h.post(rawReport());
  await h.settle();

  assert.equal(response.status, 204, 'ответ всегда 204 и без тела');
  assert.equal(response.body, null, 'тела в ответе нет: читать его некому');
  assert.equal(h.fetchCalls.length, 1, 'ровно одна отправка');

  const [sent] = h.sent();
  assert.equal(sent?.chat_id, TECH_CHAT, 'ЧАТ-НЕ-ТОТ: отчёт ушёл не в техчат');
  assert.ok(h.fetchCalls[0]?.url.startsWith(API_BASE), 'адрес API — подставленный, не боевой');
  assert.ok(sent?.text?.includes('Ошибка на клиенте'), 'текст обязан называть предмет');
  assert.ok(sent?.text?.includes('/ru/'), 'маршрут обязан быть в сообщении');
  assertNeverManagerChat(h);
});

test('ДОСТАВКА: HTML-спецсимволы из тела экранированы, разметка не уезжает', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  await h.post(rawReport({ message: '<b>x</b> & <script>alert(1)</script>' }));
  await h.settle();

  const text = h.sent()[0]?.text ?? '';
  assert.ok(!text.includes('<script>'), 'ЭКРАНИРОВАНИЕ-ПРОПУЩЕНО: тег из тела уехал разметкой');
  assert.ok(text.includes('&lt;script&gt;'), 'спецсимволы обязаны стать сущностями');
  assertNeverManagerChat(h);
});

test('ДОСТАВКА: сообщение усечено, гигантский UA не раздувает отчёт', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  await h.post(rawReport({ message: 'ю'.repeat(3000), ua: 'U'.repeat(3000) }));
  await h.settle();

  const text = h.sent()[0]?.text ?? '';
  assert.ok(text.length < 2000, `ДЛИНА-НЕ-ОГРАНИЧЕНА: сообщение вышло ${String(text.length)} знаков`);
  assert.ok(!text.includes('ю'.repeat(MESSAGE_MAX + 1)), 'сообщение обязано быть усечено');
});

test('ШТОРМ: сто ОДИНАКОВЫХ отчётов от ста разных посетителей -> ОДНО сообщение', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  for (let i = 0; i < 100; i++) {
    await h.post(rawReport(), { ip: `198.51.100.${String(i)}` });
  }
  await h.settle();

  console.log(`ЗАМЕР ПРИЁМНИКА (дедупликация): 100 одинаковых отчётов -> ${String(h.fetchCalls.length)} сообщений`);

  assert.equal(
    h.fetchCalls.length,
    1,
    `ДЕДУПЛИКАЦИЯ-ВЫКЛЮЧЕНА: сто одинаковых отчётов дали ${String(h.fetchCalls.length)} сообщений`,
  );
  assertNeverManagerChat(h);
});

test('ШТОРМ: сто РАЗНЫХ ошибок обрываются потолком, уведомление ровно одно', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  for (let i = 0; i < 100; i++) {
    await h.post(rawReport({ message: `Ошибка номер ${String(i)}` }), { ip: `198.51.100.${String(i)}` });
  }
  await h.settle();

  const texts = h.sent().map((message) => message.text ?? '');
  const notices = texts.filter((text) => text.includes('Потолок отчётов')).length;

  console.log(
    `ЗАМЕР ПРИЁМНИКА (потолок): 100 разных ошибок -> ${String(texts.length)} сообщений ` +
      `(${String(texts.length - notices)} отчётов при потолке ${String(HOURLY_CAP)} + ${String(notices)} уведомление)`,
  );

  assert.equal(
    texts.length,
    HOURLY_CAP + 1,
    `ПОТОЛОК-НЕ-СРАБОТАЛ: в техчат ушло ${String(texts.length)} сообщений вместо ${String(HOURLY_CAP + 1)}`,
  );
  assert.equal(notices, 1, `ПОТОЛОК-МОЛЧИТ: уведомлений о потолке ${String(notices)}`);
  assert.ok(
    texts[texts.length - 1]?.includes('Молчу до'),
    'последнее сообщение обязано называть момент возврата',
  );
  assertNeverManagerChat(h);
});

test('ШТОРМ: залп с ОДНОГО адреса обрывается лимитом по адресу', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  let accepted = 0;
  for (let i = 0; i < 40; i++) {
    await h.post(rawReport({ message: `Ошибка ${String(i)}` }), { ip: '203.0.113.9' });
    await h.settle();
    accepted = h.fetchCalls.length;
  }

  console.log(
    `ЗАМЕР ПРИЁМНИКА (доля адреса): 40 тел с одного адреса -> ${String(accepted)} сообщений ` +
      `при доле ${String(IP_SHARE_OF_CAP)} и частотном лимите ${String(IP_MAX_PER_WINDOW)} тел в минуту`,
  );

  assert.equal(
    accepted,
    IP_SHARE_OF_CAP,
    `ДОЛЯ-АДРЕСА-НЕ-ОГРАНИЧЕНА: с одного адреса прошло ${String(accepted)} сообщений`,
  );
  assertNeverManagerChat(h);
});

test('ДОЛЯ АДРЕСА: залп с одного адреса не мешает отчёту с другого', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  for (let i = 0; i < 20; i++) {
    await h.post(rawReport({ message: `Мусор ${String(i)}` }), { ip: '203.0.113.9' });
    await h.settle();
  }
  const afterFlood = h.fetchCalls.length;

  await h.post(rawReport({ message: 'Настоящая ошибка живого посетителя' }), { ip: '198.51.100.7' });
  await h.settle();

  const delivered = h.fetchCalls.length - afterFlood;
  console.log(
    `ЗАМЕР ПРИЁМНИКА (вытеснение): залп занял ${String(afterFlood)} мест, ` +
      `отчёт с другого адреса доставлен: ${delivered > 0 ? 'да' : 'НЕТ'}`,
  );

  assert.ok(
    afterFlood <= IP_SHARE_OF_CAP,
    `залп с одного адреса занял ${String(afterFlood)} мест при доле ${String(IP_SHARE_OF_CAP)}`,
  );
  assert.equal(
    delivered,
    1,
    'ГЛУШЕНИЕ: отчёт с другого адреса не дошёл — один отправитель снова выжигает потолок',
  );
  assertNeverManagerChat(h);
});
