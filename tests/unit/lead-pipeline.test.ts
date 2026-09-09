
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ATTRIBUTION_FIELD,
  ERROR_CODES,
  FIELDS,
  HONEYPOT_FIELD,
  LEAD_KEY_PREFIX,
  RATE_LIMIT_MAX,
  TURNSTILE_TOKEN_FIELD,
} from '../../src/lib/lead-contract.ts';
import type { LeadMetadata } from '../../src/lib/lead-contract.ts';
import { onRequest } from '../../functions/api/lead.ts';

const TOKEN = '0000000000:FAKE-UNIT-TEST-TOKEN-NOT-A-REAL-BOT';
const CHAT = '-1000000000000';
const TECH_CHAT = '-1000000000001';

const API_BASE = 'http://127.0.0.1:9099';
const ENDPOINT = 'https://landingmn.pages.dev/api/lead';
const MANAGER = 'https://t.me/Example_Manager';

const TRICKY_NAME = 'Батбаяр Ө<&>Ү"\'';

const VALID_LEAD: Record<string, string> = {
  [FIELDS.name]: TRICKY_NAME,
  [FIELDS.contact]: '99112233',
  [FIELDS.contactChannel]: 'phone',
  [FIELDS.direction]: 'teamcash',
  [FIELDS.consent]: 'on',
};

type Step = 'kv:put' | 'fetch';

interface KvPut {
  key: string;
  value: string;
  metadata?: LeadMetadata;
}

interface FetchCall {
  url: string;
  body: string;
}

type TurnstileReply = { status: number; payload: unknown } | null;

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
  };
}

interface HarnessOptions {

  env?: Record<string, string | undefined>;

  turnstile?: TurnstileReply;
}

function createHarness(options: HarnessOptions = {}) {
  const journal: Step[] = [];
  const kvPuts: KvPut[] = [];
  const fetchCalls: FetchCall[] = [];
  const pending: Promise<unknown>[] = [];
  const cache = createFakeCache();

  const globals = globalThis as unknown as {
    fetch: typeof fetch;
    caches?: unknown;
  };
  const originalFetch = globals.fetch;
  const hadCaches = 'caches' in globals;
  const originalCaches = globals.caches;

  const kv = {
    async put(key: string, value: string, opts?: { metadata?: LeadMetadata }): Promise<void> {
      journal.push('kv:put');
      kvPuts.push({ key, value, metadata: opts?.metadata });
    },
  };

  const turnstile = options.turnstile === undefined ? { status: 200, payload: { success: true } } : options.turnstile;

  globals.fetch = (async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const url = String(input);
    journal.push('fetch');
    fetchCalls.push({ url, body: String(init?.body ?? '') });

    if (url.includes('siteverify')) {
      if (turnstile === null) throw new Error('siteverify недоступен (подделка)');
      return new Response(JSON.stringify(turnstile.payload), {
        status: turnstile.status,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true, result: { message_id: fetchCalls.length } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  globals.caches = { default: cache };

  const baseEnv: Record<string, unknown> = {
    LEADS: kv,
    TG_BOT_TOKEN: TOKEN,
    TG_CHAT_ID: CHAT,
    TG_TECH_CHAT_ID: TECH_CHAT,
    TG_API_BASE: API_BASE,
    PUBLIC_TG_CONTACT_URL: MANAGER,
    TURNSTILE_SECRET_KEY: '',
  };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete baseEnv[key];
    else baseEnv[key] = value;
  }

  async function call(
    fields: Record<string, string>,
    extra: { ip?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);

    const request = new Request(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'CF-Connecting-IP': extra.ip ?? '203.0.113.7',
        ...(extra.headers ?? {}),
      },
      body: form.toString(),
    });

    const context = {
      request,
      env: baseEnv,
      waitUntil: (promise: Promise<unknown>): void => {
        pending.push(promise);
      },
      passThroughOnException: (): void => undefined,
      next: async (): Promise<Response> => new Response(null, { status: 404 }),
      functionPath: '/api/lead',
      params: {},
      data: {},
    };

    return await onRequest(context as unknown as Parameters<typeof onRequest>[0]);
  }

  return {
    journal,
    kvPuts,
    fetchCalls,
    call,

    async settle(): Promise<void> {
      await Promise.allSettled(pending);
    },
    restore(): void {
      globals.fetch = originalFetch;
      if (hadCaches) globals.caches = originalCaches;
      else delete globals.caches;
    },
  };
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test('honeypot заполнен -> 200, ни записи в KV, ни единого вызова fetch', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  const response = await h.call({ ...VALID_LEAD, [HONEYPOT_FIELD]: 'http://spam.example' });

  assert.equal(response.status, 200, 'ответ обязан быть неотличим от успеха');
  assert.deepEqual(await jsonBody(response), { ok: true }, 'тело обязано быть как у успеха');
  assert.equal(h.kvPuts.length, 0, 'заявка бота в журнал не пишется');
  assert.equal(h.fetchCalls.length, 0, 'ни одного исходящего запроса');
});

test('honeypot ПРИ НЕПУСТОМ секрете Turnstile -> fetch не вызван ни разу', async (t) => {

  const h = createHarness({ env: { TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' } });
  t.after(() => h.restore());

  const response = await h.call({
    ...VALID_LEAD,
    [HONEYPOT_FIELD]: 'bot',
    [TURNSTILE_TOKEN_FIELD]: 'какой-угодно-токен',
  });

  assert.equal(response.status, 200);
  assert.equal(h.fetchCalls.length, 0, 'siteverify не вызывается: honeypot отработал раньше');
  assert.equal(h.kvPuts.length, 0);
});

test('валидная заявка: kv:put встречается в журнале РАНЬШЕ первого fetch', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  const response = await h.call(VALID_LEAD);
  assert.equal(response.status, 200);

  const firstPut = h.journal.indexOf('kv:put');
  const firstFetch = h.journal.indexOf('fetch');
  assert.notEqual(firstPut, -1, 'запись в журнал обязана произойти');
  assert.notEqual(firstFetch, -1, 'попытка доставки обязана произойти');
  assert.ok(
    firstPut < firstFetch,
    `журнал вызовов ${JSON.stringify(h.journal)}: kv:put обязан быть раньше fetch`,
  );

  assert.ok(h.kvPuts[0]?.key.startsWith(LEAD_KEY_PREFIX));

  assert.equal(h.kvPuts[0]?.metadata?.delivered, false);

  await h.settle();
  assert.deepEqual(h.journal, ['kv:put', 'fetch', 'kv:put'], 'журнал -> доставка -> пометка');
  assert.equal(h.kvPuts[1]?.metadata?.delivered, true, 'delivered булево, не строка');
  assert.equal(h.kvPuts[1]?.key, h.kvPuts[0]?.key, 'пометка правит ТУ ЖЕ запись');
});

test('TG_API_BASE с чужим хостом игнорируется — токен бота туда не уходит', async (t) => {
  const h = createHarness({ env: { TG_API_BASE: 'https://evil.example' } });
  t.after(() => h.restore());

  await h.call({ ...VALID_LEAD });

  const call = h.fetchCalls.find((c) => !c.url.includes('siteverify'));
  assert.ok(call, 'сообщение менеджеру обязано уйти — заявка не должна теряться из-за переменной');
  assert.ok(
    !call.url.includes('evil.example'),
    'адрес чужого хоста не имеет права попасть в запрос: вместе с ним ушёл бы токен бота',
  );
  assert.ok(
    call.url.startsWith('https://api.telegram.org/bot'),
    'при неразрешённом хосте обязан быть откат на настоящий API, а не отказ приёма лида',
  );
});

test('TG_API_BASE с разрешённым хостом по-прежнему действует', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  await h.call({ ...VALID_LEAD });

  const call = h.fetchCalls.find((c) => !c.url.includes('siteverify'));
  assert.ok(call?.url.startsWith(`${API_BASE}/bot`), 'подмена для тестовых драйверов обязана работать');
});

test('монгольская кириллица и <&>"\' доезжают до Telegram экранированными', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  await h.call({ ...VALID_LEAD, [ATTRIBUTION_FIELD]: JSON.stringify({ source: 'google', touches: 3 }) });

  const call = h.fetchCalls[0];
  assert.ok(call, 'запрос к Telegram обязан быть');
  assert.ok(call.url.startsWith(`${API_BASE}/bot`), 'адрес собран из TG_API_BASE окружения');

  const text = String((JSON.parse(call.body) as { text: string }).text);
  assert.ok(text.includes('Ө'), 'Ө (U+04E8) обязана дойти неискажённой');
  assert.ok(text.includes('Ү'), 'Ү (U+04AE) обязана дойти неискажённой');
  assert.ok(text.includes('Ө&lt;&amp;&gt;Ү'), `разметка не разорвана: ${text}`);
  assert.ok(!text.includes('Ө<&>Ү'), 'сырые угловые скобки в текст попасть не могут');
  assert.ok(text.includes('google'), 'сводка атрибуции доезжает до менеджера');
});

test(`${RATE_LIMIT_MAX} заявок проходят, следующая с того же адреса -> 429 + Retry-After`, async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  const statuses: number[] = [];
  let last: Response | null = null;
  for (let i = 0; i <= RATE_LIMIT_MAX; i++) {
    last = await h.call(VALID_LEAD, { ip: '198.51.100.7' });
    statuses.push(last.status);
  }

  assert.deepEqual(
    statuses.slice(0, RATE_LIMIT_MAX),
    new Array(RATE_LIMIT_MAX).fill(200),
    'первые пять обязаны пройти',
  );
  assert.equal(last?.status, 429, 'шестая обязана быть отклонена');
  const retryAfter = Number(last?.headers.get('retry-after'));
  assert.ok(Number.isFinite(retryAfter) && retryAfter > 0, 'Retry-After обязан быть и быть положительным');
  assert.equal((await jsonBody(last as Response)).error, ERROR_CODES.rateLimited);
  assert.equal(h.kvPuts.length, RATE_LIMIT_MAX, 'отклонённая по лимиту заявка в журнал не пишется');
});

test('лимит считается на адрес, а не на весь трафик', async (t) => {
  const h = createHarness();
  t.after(() => h.restore());

  for (let i = 0; i <= RATE_LIMIT_MAX; i++) await h.call(VALID_LEAD, { ip: '198.51.100.8' });
  const other = await h.call(VALID_LEAD, { ip: '198.51.100.9' });

  assert.equal(other.status, 200, 'другой адрес обязан проходить: ведро своё у каждого');
});

test('заявка, отклонённая по honeypot, ВСЁ РАВНО увеличила счётчик лимита', async (t) => {

  const h = createHarness();
  t.after(() => h.restore());

  for (let i = 0; i < RATE_LIMIT_MAX; i++) {
    const dropped = await h.call({ ...VALID_LEAD, [HONEYPOT_FIELD]: 'bot' }, { ip: '198.51.100.10' });
    assert.equal(dropped.status, 200, 'дроп обязан выглядеть как успех');
  }
  assert.equal(h.kvPuts.length, 0, 'ни одна из них не дошла до журнала');

  const sixth = await h.call(VALID_LEAD, { ip: '198.51.100.10' });
  assert.equal(sixth.status, 429, 'шестой запрос с того же адреса обязан упереться в лимит');
});

test('невалидный direction при НЕПУСТОМ секрете и переданном токене -> 422, fetch не вызван', async (t) => {

  const h = createHarness({ env: { TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' } });
  t.after(() => h.restore());

  const response = await h.call({
    ...VALID_LEAD,
    [FIELDS.direction]: 'nope',
    [TURNSTILE_TOKEN_FIELD]: 'настоящий-на-вид-токен',
  });

  assert.equal(response.status, 422);
  const body = await jsonBody(response);
  assert.equal(body.error, ERROR_CODES.validationFailed);
  assert.deepEqual(body.fields, [FIELDS.direction]);
  assert.equal(h.fetchCalls.length, 0, 'siteverify не вызывается: валидация отработала раньше');
  assert.equal(h.kvPuts.length, 0);
});

test('без TG_BOT_TOKEN -> 503, в KV пусто, fetch не вызывался', async (t) => {
  const h = createHarness({ env: { TG_BOT_TOKEN: undefined } });
  t.after(() => h.restore());

  const response = await h.call(VALID_LEAD);

  assert.equal(response.status, 503);
  assert.equal((await jsonBody(response)).error, ERROR_CODES.serviceUnconfigured);
  assert.equal(h.kvPuts.length, 0, 'неконфигурированный эндпоинт не принимает заявку в журнал');
  assert.equal(h.fetchCalls.length, 0, 'и не делает ни одного исходящего запроса');
});

test('без биндинга LEADS -> 503: страховки нет, значит принимать нечего', async (t) => {
  const h = createHarness({ env: { LEADS: undefined } });
  t.after(() => h.restore());

  const response = await h.call(VALID_LEAD);

  assert.equal(response.status, 503);
  assert.equal((await jsonBody(response)).error, ERROR_CODES.serviceUnconfigured);
  assert.equal(h.fetchCalls.length, 0);
});

test('неверный секрет Turnstile -> посетителю captcha_failed без кодов, техчату — объяснение', async (t) => {

  const h = createHarness({
    env: { TURNSTILE_SECRET_KEY: 'секрет-с-опечаткой' },
    turnstile: { status: 200, payload: { success: false, 'error-codes': ['invalid-input-secret'] } },
  });
  t.after(() => h.restore());

  const response = await h.call({ ...VALID_LEAD, [TURNSTILE_TOKEN_FIELD]: 'токен' });

  assert.equal(response.status, 403);
  const raw = JSON.stringify(await jsonBody(response));
  assert.ok(raw.includes(ERROR_CODES.captchaFailed), 'наружу уходит код контракта');
  assert.ok(!raw.includes('invalid-input-secret'), 'коды siteverify наружу не уходят никогда');
  assert.ok(!raw.includes('configError'), 'признак конфигурации наружу не уходит никогда');
  assert.equal(h.kvPuts.length, 0, 'отклонённая заявка в журнал не пишется');

  await h.settle();
  const alert = h.fetchCalls.find((c) => !c.url.includes('siteverify'));
  assert.ok(alert, 'в техчат обязано уйти сообщение — иначе сигнал 04-06 никем не потреблён');
  const payload = JSON.parse(alert.body) as { chat_id: string; text: string; parse_mode?: string };
  assert.equal(payload.chat_id, TECH_CHAT, 'алерт идёт в техчат, а не в чат менеджеров');
  assert.ok(payload.text.includes('TURNSTILE_SECRET_KEY'), 'алерт называет, что именно чинить');
  assert.equal(payload.parse_mode, undefined, 'алерт уходит простым текстом');
});

test('siteverify недоступен -> заявка принята с видимой пометкой «антиспам не проверен»', async (t) => {

  const h = createHarness({
    env: { TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' },
    turnstile: null,
  });
  t.after(() => h.restore());

  const response = await h.call({ ...VALID_LEAD, [TURNSTILE_TOKEN_FIELD]: 'токен' });

  assert.equal(response.status, 200, 'заявка обязана быть принята');
  assert.equal(h.kvPuts.length, 1, 'и записана в журнал');

  const delivery = h.fetchCalls.find((c) => !c.url.includes('siteverify'));
  assert.ok(delivery, 'сообщение менеджеру обязано уйти');
  const text = String((JSON.parse(delivery.body) as { text: string }).text);
  assert.ok(
    text.includes('Антиспам не проверен'),
    '«открыто» без видимого следа однажды означало бы, что все лиды идут непроверенными',
  );
});

test('секрета нет, а токен прислан -> заявка принята, помечена и техчат предупреждён', async (t) => {
  const h = createHarness({
    env: { TURNSTILE_SECRET_KEY: '' },

    turnstile: { status: 200, payload: { success: true } },
  });
  t.after(() => h.restore());

  const response = await h.call({ ...VALID_LEAD, [TURNSTILE_TOKEN_FIELD]: 'токен-от-виджета' });

  assert.equal(response.status, 200, 'заявка обязана быть принята: критерий «без потери лида»');
  assert.equal(
    h.fetchCalls.filter((c) => c.url.includes('siteverify')).length,
    0,
    'выключенная проверка не имеет права ходить в сеть',
  );

  assert.equal(h.kvPuts.length, 1, 'заявка записана в журнал');
  const stored = JSON.parse(String(h.kvPuts[0]?.value)) as { captcha_unverified?: boolean };
  assert.equal(
    stored.captcha_unverified,
    true,
    'до правки здесь стояло false — заявка выглядела проверенной',
  );

  await h.settle();
  const outgoing = h.fetchCalls.filter((c) => !c.url.includes('siteverify'));

  const delivery = outgoing.find((c) => String(c.body).includes('Антиспам не проверен'));
  assert.ok(delivery, 'сообщение менеджеру обязано нести пометку');
  assert.ok(
    !String(delivery.body).includes('недоступна'),
    'причина «недоступна» здесь ЛОЖНА: проверка не запускалась вовсе, а не падала',
  );

  const alert = outgoing.find((c) => String(c.body).includes('TURNSTILE_SECRET_KEY'));
  assert.ok(alert, 'без тревоги поломку нашли бы по потоку спама, а не по сигналу');
  const payload = JSON.parse(String(alert.body)) as { chat_id: string; text: string };
  assert.equal(payload.chat_id, TECH_CHAT, 'тревога идёт в техчат, а не менеджерам');
  assert.ok(
    payload.text.includes('виджет на странице есть'),
    'текст обязан называть ЭТУ поломку, а не «секрет неверен» — последствия у них противоположные',
  );
});

test('секрета нет и токена нет -> штатное превью: ни пометки, ни тревоги', async (t) => {
  const h = createHarness({
    env: { TURNSTILE_SECRET_KEY: '' },
    turnstile: { status: 200, payload: { success: true } },
  });
  t.after(() => h.restore());

  const response = await h.call({ ...VALID_LEAD, [TURNSTILE_TOKEN_FIELD]: '' });

  assert.equal(response.status, 200);
  const stored = JSON.parse(String(h.kvPuts[0]?.value)) as { captcha_unverified?: boolean };
  assert.equal(stored.captcha_unverified, false, 'Фаза 4, превью и localhost — это НОРМА');

  await h.settle();
  const outgoing = h.fetchCalls.filter((c) => !c.url.includes('siteverify'));
  assert.ok(
    !outgoing.some((c) => String(c.body).includes('Антиспам не проверен')),
    'пометка на штатном состоянии обесценила бы пометку',
  );
  assert.ok(
    !outgoing.some((c) => String(c.body).includes('TURNSTILE_SECRET_KEY')),
    'тревога на каждой заявке превью — это шум, который отучают игнорировать',
  );
});
