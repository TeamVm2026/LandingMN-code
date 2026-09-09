
import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequestPost } from '../../functions/api/csp-report.ts';
import { onRequestPost as onClientErrorPost } from '../../functions/api/client-error.ts';
import { CSP_BODY_MAX_BYTES, CSP_MAX_PER_BODY } from '../../src/server/report/csp.ts';
import { HOURLY_CAP, IP_MAX_PER_WINDOW } from '../../src/server/report/throttle.ts';

const THROWING_FETCH = (() => {
  throw new Error('СЕТЬ ЗАПРЕЩЕНА: приёмник обратился к настоящему fetch');
}) as typeof fetch;
globalThis.fetch = THROWING_FETCH;

const TOKEN = '0000000000:FAKE-UNIT-TEST-TOKEN-NOT-A-REAL-BOT';
const TECH_CHAT = '-1000000000001';

const MANAGER_CHAT = '-1000000000000';

const API_BASE = 'https://telegram.invalid';
const ENDPOINT = 'https://landingmn.pages.dev/api/csp-report';

function legacyBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'csp-report': {
      'document-uri': 'https://landingmn.pages.dev/ru/?utm_source=fb&utm_campaign=aug',
      referrer: '',
      'violated-directive': 'script-src-elem',
      'effective-directive': 'script-src-elem',
      'original-policy': "default-src 'self'; script-src 'self' 'sha256-AAA'; report-uri /api/csp-report",
      disposition: 'report',
      'blocked-uri': 'https://evil.example.com/steal.js?victim=12345',
      'status-code': 200,
      'script-sample': '',
      'source-file': 'https://landingmn.pages.dev/_astro/BaseLayout.CZQU-FaU.js',
      'line-number': 12,
      ...overrides,
    },
  };
}

function reportsJsonBody(overrides: Record<string, unknown> = {}): unknown[] {
  return [
    {
      age: 12,
      type: 'csp-violation',
      url: 'https://landingmn.pages.dev/en/',
      user_agent: 'Mozilla/5.0 (Linux; Android 10; K)',
      body: {
        documentURL: 'https://landingmn.pages.dev/en/?utm_source=tg',
        disposition: 'report',
        effectiveDirective: 'style-src',
        blockedURL: 'https://cdn.example.net/theme.css',
        originalPolicy: "default-src 'self'; report-uri /api/csp-report",
        sourceFile: 'https://landingmn.pages.dev/en/',
        lineNumber: 3,
        statusCode: 200,
        ...overrides,
      },
    },
  ];
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
    keys(): string[] {
      return [...store.keys()];
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

  function contextFor(request: Request, functionPath: string): unknown {
    return {
      request,
      env: baseEnv,
      waitUntil: (promise: Promise<unknown>): void => {
        pending.push(promise);
      },
      passThroughOnException: (): void => undefined,
      next: async (): Promise<Response> => new Response(null, { status: 404 }),
      functionPath,
      params: {},
      data: {},
    };
  }

  async function post(
    payload: unknown,
    extra: { ip?: string; headers?: Record<string, string>; rawBody?: string } = {},
  ): Promise<Response> {
    const body = extra.rawBody ?? JSON.stringify(payload);
    const request = new Request(ENDPOINT, {
      method: 'POST',
      headers: {

        'content-type': 'application/csp-report',
        'CF-Connecting-IP': extra.ip ?? '203.0.113.7',
        ...(extra.headers ?? {}),
      },
      body,
    });
    return await onRequestPost(
      contextFor(request, '/api/csp-report') as Parameters<typeof onRequestPost>[0],
    );
  }

  async function postClientError(payload: unknown, ip = '203.0.113.9'): Promise<Response> {
    const request = new Request('https://landingmn.pages.dev/api/client-error', {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8', 'CF-Connecting-IP': ip },
      body: JSON.stringify(payload),
    });
    return await onClientErrorPost(
      contextFor(request, '/api/client-error') as Parameters<typeof onClientErrorPost>[0],
    );
  }

  return {
    fetchCalls,
    cache,
    post,
    postClientError,
    async settle(): Promise<void> {
      await Promise.allSettled(pending);
      pending.length = 0;
    },
    sent(): { chat_id?: string; text?: string }[] {
      return this.fetchCalls.map(
        (call) => JSON.parse(call.body) as { chat_id?: string; text?: string },
      );
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
      'БОЕВОЙ-ЧАТ-ЗАДЕТ: приёмник нарушений написал в чат менеджеров',
    );
  }
}

test('CSP-ФОРМЫ: старая форма report-uri разбирается и доезжает в техчат', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  const response = await h.post(legacyBody());
  await h.settle();

  assert.equal(response.status, 204);
  assert.equal(h.fetchCalls.length, 1, 'ровно одна доставка');
  const [message] = h.sent();
  assert.equal(message.chat_id, TECH_CHAT, 'чат назначения — ТЕХЧАТ');
  assert.match(message.text ?? '', /script-src-elem/, 'директива в сообщении');
  assert.match(message.text ?? '', /evil\.example\.com/, 'заблокированный ориген в сообщении');
  assertNeverManagerChat(h);
});

test('CSP-ФОРМЫ: новая форма reports+json (Reporting API) разбирается тоже', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  const response = await h.post(reportsJsonBody(), {
    headers: { 'content-type': 'application/reports+json' },
  });
  await h.settle();

  assert.equal(response.status, 204);
  assert.equal(h.fetchCalls.length, 1);
  const [message] = h.sent();
  assert.equal(message.chat_id, TECH_CHAT);
  assert.match(message.text ?? '', /style-src/, 'директива camelCase разобрана');
  assert.match(message.text ?? '', /cdn\.example\.net/, 'blockedURL разобран');
  assertNeverManagerChat(h);
});

test('CSP-ФОРМЫ: тип содержимого не решает ничего — старое тело под новым типом', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  await h.post(legacyBody(), { headers: { 'content-type': 'application/reports+json' } });
  await h.settle();

  assert.equal(h.fetchCalls.length, 1, 'тело разобрано вопреки несоответствующему типу');
  assertNeverManagerChat(h);
});

test('CSP-ФОРМЫ: чужие типы Reporting API (deprecation) игнорируются', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  const response = await h.post([
    { type: 'deprecation', url: 'https://landingmn.pages.dev/', body: { id: 'x', message: 'y' } },
  ]);
  await h.settle();

  assert.equal(response.status, 204);
  assert.equal(h.fetchCalls.length, 0, 'не нарушение CSP — не наше дело');
});

test('CSP-ФОРМЫ: пачка Reporting API усечена потолком CSP_MAX_PER_BODY', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  const batch = Array.from({ length: CSP_MAX_PER_BODY + 4 }, (_unused, i) => ({
    type: 'csp-violation',
    body: {
      documentURL: 'https://landingmn.pages.dev/',
      effectiveDirective: `img-src-${String(i)}`,
      blockedURL: `https://cdn${String(i)}.example.net/a.png`,
      disposition: 'report',
    },
  }));

  await h.post(batch);
  await h.settle();

  assert.equal(
    h.fetchCalls.length,
    CSP_MAX_PER_BODY,
    `ЗАМЕР ПОТОЛКА ТЕЛА: из ${String(batch.length)} нарушений доставлено ${String(h.fetchCalls.length)}`,
  );
  assertNeverManagerChat(h);
});

test('CSP-ШУМ: нарушение с blocked-uri расширения НЕ доставляется', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  for (const blocked of [
    'chrome-extension://abcdefghijklmnop/inject.js',
    'moz-extension://11111111-2222-3333-4444-555555555555/content.js',
    'safari-web-extension://ABCDEF/inject.js',
    'about',
  ]) {
    const response = await h.post(legacyBody({ 'blocked-uri': blocked }));
    assert.equal(response.status, 204, `${blocked}: ответ всегда 204`);
  }
  await h.settle();

  assert.equal(h.fetchCalls.length, 0, 'ЗАМЕР ШУМА: четыре нарушения расширений -> ноль доставок');
  assert.equal(h.cache.size, 0, 'шум не занимает и места в кэше');
});

test('CSP-ШУМ: inline от РАСШИРЕНИЯ отсекается, inline от НАС — доставляется', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  await h.post(
    legacyBody({
      'blocked-uri': 'inline',
      'source-file': 'chrome-extension://abcdefghijklmnop/content.js',
    }),
  );
  await h.settle();
  assert.equal(h.fetchCalls.length, 0, 'inline из расширения — шум');

  await h.post(
    legacyBody({
      'blocked-uri': 'inline',
      'source-file': 'https://landingmn.pages.dev/ru/',
    }),
  );
  await h.settle();
  assert.equal(h.fetchCalls.length, 1, 'inline из НАШЕГО документа — находка, а не шум');
  assert.match(h.sent()[0].text ?? '', /inline/);
  assertNeverManagerChat(h);
});

test('CSP-ДЕДУП: то же нарушение дважды -> ОДНА доставка', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  await h.post(legacyBody());
  await h.post(legacyBody());
  await h.settle();

  assert.equal(h.fetchCalls.length, 1, 'ЗАМЕР ДЕДУПЛИКАЦИИ: 2 одинаковых -> 1 доставка');
  assertNeverManagerChat(h);
});

test('CSP-ДЕДУП: метки атрибуции и путь заблокированного НЕ делают событие новым', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  await h.post(legacyBody());

  await h.post(
    legacyBody({
      'document-uri': 'https://landingmn.pages.dev/ru/?utm_source=tg&utm_campaign=sept',
      'blocked-uri': 'https://evil.example.com/other.js?victim=999',
      'line-number': 87,
    }),
  );
  await h.settle();

  assert.equal(h.fetchCalls.length, 1, 'ЗАМЕР КЛЮЧА: разные метки и пути -> одно событие');
});

test('CSP-ПОТОЛОК: ста разных нарушений хватает на HOURLY_CAP + одно уведомление', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  const total = 100;
  for (let i = 0; i < total; i++) {
    const response = await h.post(
      legacyBody({ 'violated-directive': `img-src`, 'blocked-uri': `https://cdn${String(i)}.example.net/a.png` }),

      { ip: `198.51.100.${String(i % 250)}` },
    );
    assert.equal(response.status, 204);
  }
  await h.settle();

  assert.equal(
    h.fetchCalls.length,
    HOURLY_CAP + 1,
    `ЗАМЕР ПОТОЛКА: ${String(total)} разных нарушений -> ${String(h.fetchCalls.length)} сообщений`,
  );
  const last = h.sent()[h.fetchCalls.length - 1];
  assert.match(last.text ?? '', /Потолок отчётов о нарушениях CSP/, 'уведомление называет СВОЙ поток');
  assert.equal(last.chat_id, TECH_CHAT);
  assertNeverManagerChat(h);
});

test('CSP-АДРЕС: сверх IP_MAX_PER_WINDOW тел с одного адреса -> молчание и 204', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  for (let i = 0; i < IP_MAX_PER_WINDOW + 5; i++) {
    const response = await h.post(
      legacyBody({ 'blocked-uri': `https://cdn${String(i)}.example.net/a.png` }),
      { ip: '198.51.100.77' },
    );
    assert.equal(response.status, 204, 'ответ одинаков и до, и после лимита');
  }
  await h.settle();

  assert.equal(
    h.fetchCalls.length,
    IP_MAX_PER_WINDOW,
    `ЗАМЕР ЛИМИТА АДРЕСА: принято ${String(h.fetchCalls.length)} из ${String(IP_MAX_PER_WINDOW + 5)}`,
  );
});

test('CSP-РАЗДЕЛЬНОСТЬ: шторм нарушений НЕ съедает бюджет клиентских ошибок', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  for (let i = 0; i < HOURLY_CAP + 5; i++) {
    await h.post(legacyBody({ 'blocked-uri': `https://cdn${String(i)}.example.net/a.png` }), {
      ip: `198.51.100.${String(i)}`,
    });
  }
  await h.settle();
  const afterStorm = h.fetchCalls.length;
  assert.equal(afterStorm, HOURLY_CAP + 1, 'потолок CSP исчерпан');

  await h.postClientError({
    kind: 'js-error',
    message: "Cannot read properties of null (reading 'value')",
    source: 'https://landingmn.pages.dev/_astro/BaseLayout.CZQU-FaU.js',
    line: 412,
    col: 17,
    route: '/ru/',
    locale: 'ru',
    ua: 'Mozilla/5.0 (Linux; Android 10; K)',
  });
  await h.settle();

  assert.equal(
    h.fetchCalls.length,
    afterStorm + 1,
    'ЗАМЕР РАЗДЕЛЬНОСТИ: исключение JS доставлено ПОСЛЕ исчерпания потолка CSP',
  );
  assert.match(h.sent()[h.fetchCalls.length - 1].text ?? '', /Ошибка на клиенте/);
  assertNeverManagerChat(h);
});

test('CSP-ПРИЁМНИК: незаданный TG_TECH_CHAT_ID -> 204 и НОЛЬ сетевых вызовов', async (t) => {
  const h = createHarness({ env: { TG_TECH_CHAT_ID: undefined } });
  t.after(() => h.restore());

  const response = await h.post(legacyBody());
  await h.settle();

  assert.equal(response.status, 204);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.cache.size, 0, 'без секретов приёмник не трогает и кэш');
});

test('CSP-ПРИЁМНИК: объявленная длина больше потолка -> 204 и ноль доставок', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  const response = await h.post(legacyBody(), {
    headers: { 'content-length': String(CSP_BODY_MAX_BYTES + 1) },
  });
  await h.settle();

  assert.equal(response.status, 204);
  assert.equal(h.fetchCalls.length, 0, 'чужой мегабайт не разбирается ради того, чтобы его отвергнуть');
  assert.equal(h.cache.size, 0);
});

test('CSP-ПРИЁМНИК: тело больше потолка без Content-Length -> 204 и ноль доставок', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  const huge = JSON.stringify({
    'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'x'.repeat(CSP_BODY_MAX_BYTES) },
  });
  const response = await h.post(null, { rawBody: huge });
  await h.settle();

  assert.equal(response.status, 204);
  assert.equal(h.fetchCalls.length, 0);
});

test('CSP-ПРИЁМНИК: мусор, пустое тело и отчёт без директивы -> 204 и молчание', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  for (const raw of ['', 'не json вовсе', '[]', '{}', '{"csp-report":{}}', 'null', '"строка"']) {
    const response = await h.post(null, { rawBody: raw });
    assert.equal(response.status, 204, `${raw || '<пусто>'}: 204`);
  }
  await h.settle();

  assert.equal(h.fetchCalls.length, 0, 'ни одно из семи тел не породило сообщения');
});

test('CSP-ПРИЁМНИК: без caches.default -> 204 и МОЛЧАНИЕ, а не доставка без ограничений', async (t) => {
  const h = createHarness({ withoutCaches: true });
  t.after(() => h.restore());

  const response = await h.post(legacyBody());
  await h.settle();

  assert.equal(response.status, 204);
  assert.equal(
    h.fetchCalls.length,
    0,
    'сломанное хранилище не имеет права стоить техчата — противоположно решению счётчика заявок',
  );
});

test('CSP-ТАЙНА: ни политика целиком, ни script-sample, ни query в сообщение не попадают', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  await h.post(
    legacyBody({
      'script-sample': 'alert(document.cookie)',
      'original-policy': "default-src 'self'; script-src 'self' 'sha256-СЕКРЕТНЫЙ-ХЕШ'",
      'document-uri': 'https://landingmn.pages.dev/ru/?utm_source=fb&sub_id=partner-777',
      'blocked-uri': 'https://evil.example.com/steal.js?victim=12345',
    }),
  );
  await h.settle();

  const text = h.sent()[0].text ?? '';
  assert.ok(!text.includes('sub_id'), 'T-08-18: метка атрибуции в техчат не уезжает');
  assert.ok(!text.includes('victim=12345'), 'T-08-18: query заблокированного адреса отброшен');
  assert.ok(!text.includes('alert(document.cookie)'), 'кусок чужого кода в чат не переносится');
  assert.ok(!text.includes('sha256-СЕКРЕТНЫЙ-ХЕШ'), 'original-policy в сообщение не входит');
  assert.match(text, /\/ru\//, 'путь страницы при этом сохранён — без него отчёт бесполезен');
  assertNeverManagerChat(h);
});

test('CSP-РЕЖИМ: disposition печатается — переключение на enforce видно из первого отчёта', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  await h.post(legacyBody({ disposition: 'enforce' }));
  await h.settle();

  assert.match(h.sent()[0].text ?? '', /enforce/, 'режим доставки виден в сообщении');
  assertNeverManagerChat(h);
});
