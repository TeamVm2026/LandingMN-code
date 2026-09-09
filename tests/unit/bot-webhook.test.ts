
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultDir = fileURLToPath(new URL('../../workers/bot/', import.meta.url));
const botDir = process.env.BOT_MODULE_DIR ?? defaultDir;
const modulePath = path.join(botDir, 'webhook.ts');

const { handleWebhook, timingSafeEqualStr, REQUIRED_INPUTS, WEBHOOK_SECRET_HEADER, WEBHOOK_PATH } =
  (await import(pathToFileURL(modulePath).href)) as typeof import('../../workers/bot/webhook.ts');

const { sendMessage } = await import('../../src/server/lead/telegram.ts');

const SECRET = 'webhook-secret-value-0123456789';
const TOKEN = '8100200300:TESTTESTTESTTESTTESTTESTTESTTESTTES';
const CHAT = '-1002222222222';
const TECH = '-1003333333333';
const MANAGER = 'https://t.me/melbet_mn_manager';
const API = 'https://api.example.invalid';
const USER = 8123456789;
const T0 = Date.parse('2026-08-22T10:00:00.000Z');

interface Recorded {
  url: string;
  body: Record<string, unknown>;
}

type Trace = string[];

function label(key: string): string {
  if (key.startsWith('botupd:')) return 'дедуп';
  if (key.startsWith('botcd:')) return `окно:${key.split(':')[1]}`;
  if (key.startsWith('bot:')) return 'журнал';

  if (key.startsWith('mon:start:')) return 'счётчик:start';
  return `неизвестно:${key}`;
}

interface KvFlags {
  failPutJournal?: boolean;
}

type VisitorFailureMode =

  | 'blocked'

  | 'flood'

  | 'network';

interface FetchFlags {

  failChat?: string;

  visitorFailure?: { mode: VisitorFailureMode; firstN?: number };
}

function fakeFetch(trace: Trace, flags: FetchFlags = {}) {
  const calls: Recorded[] = [];
  let visitorAttempts = 0;
  const impl = async (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, body });
    const chatId = String(body.chat_id ?? '');
    const to = chatId === CHAT ? 'менеджерам' : chatId === TECH ? 'в техчат' : 'посетителю';
    trace.push(`fetch ${to}`);
    if (flags.failChat !== undefined && chatId === flags.failChat) {
      return new Response(JSON.stringify({ ok: false, error_code: 403, description: 'bot was blocked' }), {
        status: 403,
      });
    }
    if (flags.visitorFailure !== undefined && chatId === String(USER)) {
      visitorAttempts += 1;
      const limit = flags.visitorFailure.firstN ?? Number.POSITIVE_INFINITY;
      if (visitorAttempts <= limit) {
        if (flags.visitorFailure.mode === 'blocked') {
          return new Response(
            JSON.stringify({
              ok: false,
              error_code: 403,
              description: 'Forbidden: bot was blocked by the user',
            }),
            { status: 403 },
          );
        }
        if (flags.visitorFailure.mode === 'flood') {
          return new Response(
            JSON.stringify({
              ok: false,
              error_code: 429,
              description: 'Too Many Requests: retry after 1',
              parameters: { retry_after: 1 },
            }),
            { status: 429 },
          );
        }

        throw new Error('ETIMEDOUT: соединение с Bot API оборвано');
      }
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  };
  return { impl, calls };
}

function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>): void => void pending.push(p) },
    async drain(): Promise<void> {
      while (pending.length > 0) await pending.splice(0, pending.length)[0];
    },
  };
}

function envOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    TG_BOT_TOKEN: TOKEN,
    TG_CHAT_ID: CHAT,
    TG_TECH_CHAT_ID: TECH,
    TG_WEBHOOK_SECRET: SECRET,
    MANAGER_CONTACT_URL: MANAGER,
    TG_API_BASE: API,
    ...over,
  };
}

function startUpdate(updateId: number, raw = '1_fb_a_m'): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: 100 + updateId,
      from: { id: USER, is_bot: false, first_name: 'Бат', language_code: 'mn' },
      chat: { id: USER, type: 'private' },
      text: raw === '' ? '/start' : `/start ${raw}`,
    },
  };
}

function textUpdate(updateId: number, text: string): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: 100 + updateId,
      from: { id: USER, is_bot: false, first_name: 'Бат', language_code: 'mn' },
      chat: { id: USER, type: 'private' },
      text,
    },
  };
}

interface RequestOptions {
  method?: string;
  secret?: string | null;
  contentLength?: string;
  update?: unknown;
}

function makeRequest(options: RequestOptions = {}): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  const secret = options.secret === undefined ? SECRET : options.secret;
  if (secret !== null) headers.set(WEBHOOK_SECRET_HEADER, secret);
  if (options.contentLength !== undefined) headers.set('content-length', options.contentLength);
  const payload = JSON.stringify(options.update ?? startUpdate(1));
  return new Request(`https://bot.example.com${WEBHOOK_PATH}`, {
    method: options.method ?? 'POST',
    headers,
    body: options.method === 'GET' ? undefined : payload,
  });
}

function makeUnreadableRequest(secret: string | null): Request {
  const headers = new Headers({ 'content-type': 'application/json', 'content-length': '42' });
  if (secret !== null) headers.set(WEBHOOK_SECRET_HEADER, secret);
  const boom = (): never => {
    throw new Error('ТЕЛО-ПРОЧИТАНО: неаутентифицированный запрос заставил воркер читать поток');
  };
  return {
    method: 'POST',
    url: `https://bot.example.com${WEBHOOK_PATH}`,
    headers,
    get body(): never {
      return boom();
    },
    text: boom,
    json: boom,
    arrayBuffer: boom,
  } as unknown as Request;
}

interface RunResult {
  response: Response;
  trace: Trace;
  calls: Recorded[];
  store: Map<string, unknown>;
}

async function run(options: {
  request?: Request;
  env?: Record<string, unknown>;
  kvFlags?: KvFlags;
  fetchFlags?: FetchFlags;
  now?: number;
  store?: Map<string, unknown>;
  trace?: Trace;
}): Promise<RunResult> {
  const trace: Trace = options.trace ?? [];
  const store = options.store ?? new Map<string, unknown>();
  const kv = {
    get: (key: string, _type: 'json') => {
      trace.push(`kv.get ${label(key)}`);
      return Promise.resolve(store.has(key) ? store.get(key) : null);
    },
    put: (key: string, value: string) => {
      trace.push(`kv.put ${label(key)}`);
      if (options.kvFlags?.failPutJournal && key.startsWith('bot:')) {
        return Promise.reject(new Error('KV лёг на записи журнала'));
      }
      store.set(key, JSON.parse(value) as unknown);
      return Promise.resolve();
    },
  };
  const f = fakeFetch(trace, options.fetchFlags);
  const { ctx, drain } = fakeCtx();
  const env = { LEADS: kv, ...(options.env ?? envOf()) };

  const response = await handleWebhook(
    options.request ?? makeRequest(),
    env as never,
    ctx as never,
    {
      fetchImpl: f.impl as never,
      sleep: async () => {},
      now: () => options.now ?? T0,
    },
  );
  await drain();
  return { response, trace, calls: f.calls, store };
}

const toChat = (calls: Recorded[], chat: string): Recorded[] =>
  calls.filter((c) => String(c.body.chat_id ?? '') === chat);

const toVisitor = (calls: Recorded[]): Recorded[] =>
  calls.filter((c) => String(c.body.chat_id ?? '') === String(USER));

test('МЕТОД: не POST даёт 405 и не трогает ни хранилища, ни сети', async () => {
  const r = await run({ request: makeRequest({ method: 'GET' }) });
  assert.equal(r.response.status, 405);
  assert.deepEqual(r.trace, [], 'МЕТОД: запрос не тем методом дошёл до хранилища или сети');
});

test('ПОТОЛОК: объявленная длина больше потолка даёт 413 без обращений к KV', async () => {
  const r = await run({ request: makeRequest({ contentLength: String(10 * 1024 * 1024) }) });
  assert.equal(r.response.status, 413);
  assert.deepEqual(r.trace, [], 'ПОТОЛОК: слишком большое тело дошло до хранилища или сети');
});

test('СЕКРЕТ: без заголовка — 401, ноль обращений к KV и ноль исходящих', async () => {
  const r = await run({ request: makeRequest({ secret: null }) });
  assert.equal(r.response.status, 401, 'ВЕБХУК-БЕЗ-СЕКРЕТА-ПРИНЯТ: запрос без заголовка не получил 401');
  assert.deepEqual(r.trace, [], 'ВЕБХУК-БЕЗ-СЕКРЕТА-ПРИНЯТ: неаутентифицированный запрос дошёл до KV или сети');
});

test('СЕКРЕТ: неверное значение — 401 и ни одного побочного действия', async () => {
  const r = await run({ request: makeRequest({ secret: 'wrong-secret-value' }) });
  assert.equal(r.response.status, 401, 'ВЕБХУК-БЕЗ-СЕКРЕТА-ПРИНЯТ: неверный секрет принят');
  assert.deepEqual(r.trace, [], 'ВЕБХУК-БЕЗ-СЕКРЕТА-ПРИНЯТ: неверный секрет дошёл до KV или сети');
});

test('СЕКРЕТ: верная длина, но иное значение — 401', async () => {
  const other = `${'x'.repeat(SECRET.length - 1)}y`;
  assert.equal(other.length, SECRET.length, 'проба построена неверно: длины разошлись');
  const r = await run({ request: makeRequest({ secret: other }) });
  assert.equal(r.response.status, 401, 'ВЕБХУК-БЕЗ-СЕКРЕТА-ПРИНЯТ: значение верной длины принято');
  assert.deepEqual(r.trace, []);
});

test('СЕКРЕТ: сверка идёт ДО ЧТЕНИЯ ТЕЛА — поток не трогается вовсе', async () => {

  for (const presented of [null, 'wrong-secret-value']) {
    const r = await run({ request: makeUnreadableRequest(presented) });
    assert.equal(
      r.response.status,
      401,
      'ВЕБХУК-БЕЗ-СЕКРЕТА-ПРИНЯТ: неаутентифицированный запрос прочитал собственное тело',
    );
    assert.deepEqual(r.trace, []);
  }
});

test('СЕКРЕТ: незаданный TG_WEBHOOK_SECRET закрывает вебхук 401-м, а не открывает его', async () => {
  for (const value of [undefined, '', '   ']) {
    const r = await run({
      request: makeRequest({ secret: typeof value === 'string' ? value : null }),
      env: envOf({ TG_WEBHOOK_SECRET: value }),
    });
    assert.equal(
      r.response.status,
      401,
      'ВЕБХУК-БЕЗ-СЕКРЕТА-ПРИНЯТ: пустой секрет в окружении открыл вебхук всему интернету',
    );
    assert.deepEqual(r.trace, []);
  }
});

const TIMING_SAFE_FROZEN =
  'function timingSafeEqualStr(a , b ) { ' +
  'if (a.length !== b.length) return false; ' +
  'let diff = 0; ' +
  'for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); ' +
  'return diff === 0; }';

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

test('ФОРМА: текст timingSafeEqualStr совпадает с замороженным эталоном', () => {
  assert.equal(
    normalize(timingSafeEqualStr.toString()),
    TIMING_SAFE_FROZEN,
    'СРАВНЕНИЕ-ПЕРЕПИСАНО: тело timingSafeEqualStr отличается от замороженной формы. ' +
      'Ранний выход из цикла поведением НЕ ОТЛИЧИМ — он даёт тот же результат, — ' +
      'поэтому здесь закреплена форма, а не поведение. Если правка осознанная, ' +
      'снимите новый эталон ПРОГОНОМ fn.toString() под --experimental-strip-types ' +
      'и обновите TIMING_SAFE_FROZEN вместе с обоснованием.',
  );
});

test('ФОРМА: сравнение работает на равных, неравных и разной длины', () => {
  assert.equal(timingSafeEqualStr('abc', 'abc'), true);
  assert.equal(timingSafeEqualStr('abc', 'abd'), false);
  assert.equal(timingSafeEqualStr('abc', 'abcd'), false);
  assert.equal(timingSafeEqualStr('', ''), true);
});

test('КОНВЕЙЕР: первый /start даёт 200 и РОВНО объявленный порядок вызовов', async () => {
  const r = await run({ request: makeRequest({ update: startUpdate(1) }) });
  assert.equal(r.response.status, 200);
  assert.deepEqual(
    r.trace,
    [
      'kv.get дедуп',
      'kv.put дедуп',

      'kv.get счётчик:start',
      'kv.put счётчик:start',
      'fetch посетителю',
      'kv.get окно:start',
      'kv.put окно:start',
      'kv.put журнал',
      'fetch менеджерам',
    ],
    'ПОРЯДОК-КОНВЕЙЕРА-СМЕНИЛСЯ: ответ посетителю обязан уходить ПЕРВЫМ (решение ' +
      'заказчика Д-01), дедупликация — до окна охлаждения, журнал — до сообщения менеджерам',
  );
  assert.equal(toVisitor(r.calls).length, 1);
  assert.equal(toChat(r.calls, CHAT).length, 1);
});

test('КОНВЕЙЕР: ответ посетителю несёт кнопку с адресом менеджера', async () => {
  const r = await run({});
  const reply = toVisitor(r.calls)[0];
  assert.ok(reply, 'ПЕРЕДАЧА-МЕНЕДЖЕРУ-ПОТЕРЯНА: посетителю не ушло ни одного сообщения');
  const markup = JSON.stringify(reply.body.reply_markup ?? null);
  assert.ok(
    markup.includes(MANAGER),
    'ПЕРЕДАЧА-МЕНЕДЖЕРУ-ПОТЕРЯНА: в ответе посетителю нет кнопки с адресом менеджера',
  );
});

test('КОНВЕЙЕР: повтор внутри окна даёт КОРОТКУЮ пометку и не пишет журнал', async () => {
  const store = new Map<string, unknown>();
  const first = await run({ request: makeRequest({ update: startUpdate(1) }), store });
  assert.equal(first.response.status, 200);

  const trace: Trace = [];
  const second = await run({ request: makeRequest({ update: startUpdate(2) }), store, trace });
  assert.equal(second.response.status, 200);
  assert.equal(toVisitor(second.calls).length, 1, 'посетителю ответ на повтор не ушёл');
  assert.equal(toChat(second.calls, CHAT).length, 1, 'менеджерам не ушла пометка повтора');
  assert.equal(
    trace.filter((step) => step === 'kv.put журнал').length,
    0,
    'ПОВТОР-НЕ-ОПОЗНАН: повторное обращение записало в журнал полный лид',
  );
  const notice = String(toChat(second.calls, CHAT)[0]?.body.text ?? '');
  assert.ok(
    notice.length < String(toChat(first.calls, CHAT)[0]?.body.text ?? '').length,
    'ПОВТОР-НЕ-КОРОТКИЙ: пометка повтора не короче полного лида',
  );
});

test('КОНВЕЙЕР: третий /start внутри окна отвечает посетителю и молчит менеджерам', async () => {
  const store = new Map<string, unknown>();
  await run({ request: makeRequest({ update: startUpdate(1) }), store });
  await run({ request: makeRequest({ update: startUpdate(2) }), store });
  const third = await run({ request: makeRequest({ update: startUpdate(3) }), store });
  assert.equal(third.response.status, 200);
  assert.equal(toVisitor(third.calls).length, 1, 'посетителю ответ на третье обращение не ушёл');
  assert.equal(
    toChat(third.calls, CHAT).length,
    0,
    'ПОВТОР-НЕ-ОПОЗНАН: третье обращение внутри окна ушло в чат менеджеров',
  );
});

test('КОНВЕЙЕР: не-/start отвечает посетителю и ничего не шлёт менеджерам', async () => {
  const r = await run({ request: makeRequest({ update: textUpdate(7, 'сайн байна уу') }) });
  assert.equal(r.response.status, 200);
  assert.equal(toVisitor(r.calls).length, 1);
  assert.equal(toChat(r.calls, CHAT).length, 0, 'свободное сообщение ушло в чат менеджеров');
  assert.equal(
    r.trace.filter((step) => step === 'kv.put журнал').length,
    0,
    'свободное сообщение записано в журнал лидов',
  );
});

test('КОНВЕЙЕР: второй не-/start внутри окна не шлёт НИ ОДНОГО сообщения', async () => {
  const store = new Map<string, unknown>();
  await run({ request: makeRequest({ update: textUpdate(7, 'привет') }), store });
  const second = await run({ request: makeRequest({ update: textUpdate(8, 'ещё раз') }), store });
  assert.equal(second.response.status, 200);
  assert.equal(
    second.calls.length,
    0,
    'ОКНО-OTHER-НЕ-РАБОТАЕТ: второе свободное сообщение внутри окна вызвало исходящий запрос — ' +
      'без потолка любой, кто знает имя бота, заставляет воркер слать сообщения бесконечно',
  );
});

test('ДЕДУП: тот же update_id второй раз не проходит конвейер и оставляет след', async () => {
  const store = new Map<string, unknown>();
  const first = await run({ request: makeRequest({ update: startUpdate(42) }), store });
  assert.equal(first.response.status, 200);
  const windowAfterFirst = JSON.stringify(store.get(`botcd:start:${USER}`));

  const trace: Trace = [];
  const retry = await run({ request: makeRequest({ update: startUpdate(42) }), store, trace });
  assert.equal(retry.response.status, 200);
  assert.equal(toVisitor(retry.calls).length, 0, 'РЕТРАЙ-НЕ-ОТСЕЧЁН: посетитель получил второй ответ');
  assert.equal(toChat(retry.calls, CHAT).length, 0, 'РЕТРАЙ-НЕ-ОТСЕЧЁН: менеджерам ушёл дубль');
  assert.equal(
    trace.filter((step) => step === 'kv.put журнал').length,
    0,
    'РЕТРАЙ-НЕ-ОТСЕЧЁН: ретрай записал второй лид в журнал',
  );
  assert.equal(
    JSON.stringify(store.get(`botcd:start:${USER}`)),
    windowAfterFirst,
    'РЕТРАЙ-НЕ-ОТСЕЧЁН: ретрай сдвинул счётчик окна охлаждения — ' +
      'следующее настоящее обращение получило бы ложную пометку «повторный лид»',
  );
  const techLines = toChat(retry.calls, TECH);
  assert.equal(
    techLines.length,
    1,
    'РЕТРАЙ-МОЛЧИТ: отсечённый ретрай не оставил строки в техчате — это единственный ' +
      'путь фазы, на котором лид может пропасть бесследно',
  );
  assert.ok(String(techLines[0]?.body.text ?? '').includes('42'), 'в строке нет номера апдейта');
});

test('ИНЕРТНОСТЬ: список обязательных входов содержит РОВНО пять имён', () => {
  assert.deepEqual(
    [...REQUIRED_INPUTS].sort(),
    ['LEADS', 'MANAGER_CONTACT_URL', 'TG_BOT_TOKEN', 'TG_CHAT_ID', 'TG_WEBHOOK_SECRET'].sort(),
    'ИНЕРТНОСТЬ-ОСЛАБЛЕНА: список обязательных входов изменился. MANAGER_CONTACT_URL ' +
      'входит в него не для симметрии: это единственный вход, несущий главное решение ' +
      'заказчика (Д-01), и без него buildReply бросает в горячем пути',
  );
});

test('ИНЕРТНОСТЬ: отсутствие любого обязательного входа даёт 503 без KV и без сети', async () => {
  for (const name of ['TG_BOT_TOKEN', 'TG_CHAT_ID', 'MANAGER_CONTACT_URL']) {
    const r = await run({ env: envOf({ [name]: '' }) });
    assert.equal(r.response.status, 503, `ИНЕРТНОСТЬ-ОСЛАБЛЕНА: без ${name} воркер не отдал 503`);
    assert.deepEqual(r.trace, [], `ИНЕРТНОСТЬ-ОСЛАБЛЕНА: без ${name} воркер обратился к KV или сети`);
  }
});

test('ИНЕРТНОСТЬ: без биндинга LEADS воркер отдаёт 503 и ничего не шлёт', async () => {
  const f = fakeFetch([]);
  const { ctx, drain } = fakeCtx();
  const response = await handleWebhook(makeRequest(), envOf() as never, ctx as never, {
    fetchImpl: f.impl as never,
    sleep: async () => {},
    now: () => T0,
  });
  await drain();
  assert.equal(response.status, 503, 'ИНЕРТНОСТЬ-ОСЛАБЛЕНА: без биндинга LEADS воркер не отдал 503');
  assert.equal(f.calls.length, 0, 'ИНЕРТНОСТЬ-ОСЛАБЛЕНА: без биндинга LEADS ушёл исходящий запрос');
});

test('ГРУППА: апдейт не из личного чата не доходит до конвейера вовсе', async () => {
  const update = {
    update_id: 5,
    message: {
      message_id: 1,
      from: { id: USER, is_bot: false, first_name: 'Менеджер' },
      chat: { id: -100999, type: 'supergroup' },
      text: '/start@melbet_mn_bot 1_fb_a_m',
    },
  };
  const r = await run({ request: makeRequest({ update }) });
  assert.equal(r.response.status, 200);
  assert.deepEqual(
    r.trace,
    [],
    'ГРУППА-ПРОШЛА: апдейт из группы дошёл до хранилища или сети — бот уже участник ' +
      'чата менеджеров и техчата, и такой апдейт завёл бы лида ПРО МЕНЕДЖЕРА',
  );
});

test('НЕДОСТАВКА: отказ чата менеджеров даёт 200 и алерт в техчат с ключом журнала', async () => {
  const r = await run({ fetchFlags: { failChat: CHAT } });
  assert.equal(r.response.status, 200, 'ШТОРМ-РЕТРАЕВ: недоставка отдала Telegram не 200');
  const alerts = toChat(r.calls, TECH);
  assert.equal(alerts.length, 1, 'алерт о недоставке в техчат не ушёл');
  assert.ok(
    String(alerts[0]?.body.text ?? '').includes('bot:'),
    'в алерте нет ключа журнала — достать лид по нему будет нечем',
  );
});

test('CATCH-ALL: исключение на записи журнала даёт 200 и диагностику без содержимого апдейта', async () => {
  const r = await run({ kvFlags: { failPutJournal: true } });
  assert.equal(
    r.response.status,
    200,
    'ШТОРМ-РЕТРАЕВ: исключение отдало Telegram не 200 — ретрай принёс бы посетителю ' +
      'второй ответ, а окно охлаждения опубликовало бы ложную пометку «повторный лид»',
  );
  const alerts = toChat(r.calls, TECH);
  assert.equal(alerts.length, 1, 'диагностика в техчат не ушла — поломка невидима');
  const text = String(alerts[0]?.body.text ?? '');
  assert.ok(!text.includes('1_fb_a_m'), 'ТЕКСТ-АПДЕЙТА-В-АЛЕРТЕ: диагностика унесла содержимое апдейта');
  assert.ok(!text.includes('Бат'), 'ТЕКСТ-АПДЕЙТА-В-АЛЕРТЕ: диагностика унесла имя человека');
});

test('CATCH-ALL: непригодный адрес менеджера даёт 200 и диагностику, а не 500', async () => {
  const r = await run({ env: envOf({ MANAGER_CONTACT_URL: 'https://evil.t.me.attacker.tld/x' }) });
  assert.equal(r.response.status, 200, 'ШТОРМ-РЕТРАЕВ: брошенный buildReply отдал Telegram не 200');
  assert.equal(toVisitor(r.calls).length, 0, 'сообщение без рабочей кнопки всё-таки ушло посетителю');
  assert.equal(toChat(r.calls, TECH).length, 1, 'диагностика в техчат не ушла');
});

test('CATCH-ALL: битый JSON в теле не роняет воркер', async () => {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set(WEBHOOK_SECRET_HEADER, SECRET);
  const request = new Request(`https://bot.example.com${WEBHOOK_PATH}`, {
    method: 'POST',
    headers,
    body: '{не json',
  });
  const r = await run({ request });
  assert.equal(r.response.status, 200);
  assert.deepEqual(r.trace, [], 'битый JSON дошёл до хранилища или сети');
});

test('ТОКЕН: ни один ответ и ни один алерт не содержат подстроки токена', async () => {
  const runs = [
    await run({}),
    await run({ kvFlags: { failPutJournal: true } }),
    await run({ fetchFlags: { failChat: CHAT } }),
    await run({ request: makeRequest({ secret: null }) }),
  ];
  for (const r of runs) {
    const body = await r.response.clone().text();
    assert.ok(!body.includes(TOKEN), 'ТОКЕН-В-ОТВЕТЕ: тело ответа воркера содержит токен бота');
    for (const call of r.calls) {
      const text = String(call.body.text ?? '');
      assert.ok(!text.includes(TOKEN), 'ТОКЕН-В-ОТВЕТЕ: текст сообщения содержит токен бота');
    }
  }
});

test('ТОКЕН: воркер не пишет в консоль ни одной строки', () => {
  const source = readFileSync(modulePath, 'utf8');
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !/\bconsole\s*\./.test(withoutComments),
    'КОНСОЛЬ-В-ВОРКЕРЕ: вывод `wrangler tail` видит любой, у кого есть токен аккаунта. ' +
      'Диагностика уходит сообщением в техчат, а не в лог.',
  );
});

test('ДОСТАВКА: тело запроса без replyMarkup осталось прежним байт в байт', async () => {
  let captured = '';
  const fetchImpl = async (_url: string, init: RequestInit): Promise<Response> => {
    captured = String(init.body ?? '');
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  await sendMessage({ token: TOKEN, chatId: CHAT, text: 'проба', fetchImpl, apiBase: API });
  assert.equal(
    captured,
    `{"chat_id":"${CHAT}","text":"проба","link_preview_options":{"is_disabled":true},"parse_mode":"HTML"}`,
    'ДОСТАВКА-ИЗМЕНЕНА: тело sendMessage без replyMarkup отличается от прежнего. ' +
      'Правка обязана быть АДДИТИВНОЙ: одно необязательное поле и ничего больше — ' +
      'на разборе ответа, классификации и повторах стоит вся сюита lead-telegram.',
  );
});

test('ДОСТАВКА: replyMarkup уходит полем reply_markup, только когда передан', async () => {
  let captured: Record<string, unknown> = {};
  const fetchImpl = async (_url: string, init: RequestInit): Promise<Response> => {
    captured = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const markup = { inline_keyboard: [[{ text: 'Менеджер', url: MANAGER }]] };
  await sendMessage({
    token: TOKEN,
    chatId: CHAT,
    text: 'проба',
    fetchImpl,
    apiBase: API,
    replyMarkup: markup,
  });
  assert.deepEqual(captured.reply_markup, markup, 'инлайн-кнопка не доехала до Bot API');
});

test('ОТВЕТ-ПОСЕТИТЕЛЮ: 403 «заблокирован» — менеджеру уходит ПРАВДА, а не обычный лид', async () => {
  const r = await run({ fetchFlags: { visitorFailure: { mode: 'blocked' } } });

  assert.equal(r.response.status, 200, 'ШТОРМ-РЕТРАЕВ: недоставка ответа отдала Telegram не 200');

  const notice = String(toChat(r.calls, CHAT)[0]?.body.text ?? '');
  assert.ok(notice.length > 0, 'менеджерам не ушло вообще ничего — проба построена неверно');
  assert.ok(
    notice.toLowerCase().includes('не доставлен'),
    'ИСХОД-ОТВЕТА-НЕ-ПРОВЕРЕН: человек заблокировал бота и контакта не получил, а менеджеру ' +
      'ушёл обычный лид. Менеджер будет ждать сообщения, которого не будет, — это и есть ' +
      'молчаливая отмена решения заказчика Д-01',
  );

  const tech = toChat(r.calls, TECH);
  assert.equal(
    tech.length,
    1,
    'ИСХОД-ОТВЕТА-НЕ-ПРОВЕРЕН: недоставка ответа не оставила ни строки в техчате',
  );
  assert.ok(
    String(tech[0]?.body.text ?? '').includes(String(USER)),
    'в строке техчата нет id посетителя — искать человека будет нечем',
  );
});

test('ОТВЕТ-ПОСЕТИТЕЛЮ: 403 НЕ повторяется — это навсегда', async () => {
  const r = await run({ fetchFlags: { visitorFailure: { mode: 'blocked' } } });
  assert.equal(
    toVisitor(r.calls).length,
    1,
    'ПОВТОР-ЗАБЛОКИРОВАВШЕМУ: 403 повторён. Повтор отправляет сообщение человеку, который ' +
      'нас заблокировал, и тратит попытку из общего с лидом бюджета',
  );
});

test('ОТВЕТ-ПОСЕТИТЕЛЮ: 429 повторяется, потолок ТРИ попытки СУММАРНО', async () => {
  const r = await run({ fetchFlags: { visitorFailure: { mode: 'flood' } } });
  assert.equal(
    toVisitor(r.calls).length,
    3,
    'ИСХОД-ОТВЕТА-НЕ-ПРОВЕРЕН: 429 — временный отказ, его обязаны повторить, и ровно трижды ' +
      'суммарно (attemptsAlreadyMade: 1, а не «три сверху»)',
  );
  assert.equal(r.response.status, 200);
  assert.equal(toChat(r.calls, TECH).length, 1, 'ИСХОД-ОТВЕТА-НЕ-ПРОВЕРЕН: молчание после трёх неудач');
});

test('ОТВЕТ-ПОСЕТИТЕЛЮ: обрыв связи идёт тем же путём, что 429', async () => {
  const r = await run({ fetchFlags: { visitorFailure: { mode: 'network' } } });
  assert.equal(r.response.status, 200, 'ШТОРМ-РЕТРАЕВ: обрыв на ответе отдал Telegram не 200');
  assert.equal(
    toVisitor(r.calls).length,
    3,
    'ИСХОД-ОТВЕТА-НЕ-ПРОВЕРЕН: обрыв и таймаут приходят исключением, а не кодом ответа — ' +
      'ветка status === null обязана повторяться так же',
  );
  const tech = String(toChat(r.calls, TECH)[0]?.body.text ?? '');
  assert.ok(tech.length > 0, 'ИСХОД-ОТВЕТА-НЕ-ПРОВЕРЕН: обрыв не оставил строки в техчате');
  assert.ok(!tech.includes(TOKEN), 'ТОКЕН-В-ОТВЕТЕ: описание сетевой ошибки унесло токен в техчат');
});

test('ОТВЕТ-ПОСЕТИТЕЛЮ: доехавший ПОВТОРОМ не тревожит техчат', async () => {
  const r = await run({ fetchFlags: { visitorFailure: { mode: 'flood', firstN: 1 } } });
  assert.equal(toVisitor(r.calls).length, 2, 'повтор не сделан или сделан лишний раз');
  assert.equal(
    toChat(r.calls, TECH).length,
    0,
    'ТЕХЧАТ-ЗАШУМЛЁН: строка о КАЖДОМ временном 429 превратит техчат в шум, ' +
      'в котором не видно настоящих отказов',
  );
});

test('ОТВЕТ-ПОСЕТИТЕЛЮ: повтор уходит С КНОПКОЙ менеджера', async () => {
  const r = await run({ fetchFlags: { visitorFailure: { mode: 'flood', firstN: 1 } } });
  const second = toVisitor(r.calls)[1];
  assert.ok(second, 'повтора не было');
  assert.ok(
    JSON.stringify(second.body.reply_markup ?? null).includes(MANAGER),
    'ПЕРЕДАЧА-МЕНЕДЖЕРУ-ПОТЕРЯНА: повтор ушёл без кнопки. Спасая Д-01, повтор его бы и отменил',
  );
});

test('ОТВЕТ-ПОСЕТИТЕЛЮ: успешная доставка НЕ печатает пометки и молчит в техчате', async () => {
  const r = await run({});
  const notice = String(toChat(r.calls, CHAT)[0]?.body.text ?? '');
  assert.ok(notice.length > 0, 'менеджерам не ушло ничего — проба построена неверно');
  assert.ok(
    !notice.toLowerCase().includes('не доставлен'),
    'ЛОЖНАЯ-ТРЕВОГА: пометка о недоставке напечатана при УСПЕШНОЙ передаче. Пометка под ' +
      'каждым лидом перестаёт читаться через день, и настоящая недоставка потеряется',
  );
  assert.equal(
    toChat(r.calls, TECH).length,
    0,
    'ЛОЖНАЯ-ТРЕВОГА: успешный ответ оставил строку в техчате',
  );
  assert.equal(toVisitor(r.calls).length, 1, 'ЛОЖНАЯ-ТРЕВОГА: успешный ответ повторён');
});

test('ОТВЕТ-ПОСЕТИТЕЛЮ: пометка повтора тоже несёт правду о передаче', async () => {
  const store = new Map<string, unknown>();
  await run({ request: makeRequest({ update: startUpdate(1) }), store });
  const second = await run({
    request: makeRequest({ update: startUpdate(2) }),
    store,
    fetchFlags: { visitorFailure: { mode: 'blocked' } },
  });
  const notice = String(toChat(second.calls, CHAT)[0]?.body.text ?? '');
  assert.ok(
    notice.toLowerCase().includes('повторный лид'),
    'проба построена неверно: второе обращение не дало пометки повтора',
  );
  assert.ok(
    notice.toLowerCase().includes('не доставлен'),
    'ИСХОД-ОТВЕТА-НЕ-ПРОВЕРЕН: у ветки повтора исход отправки не проверяется. Ветка тише ' +
      'основной — у неё нет ни записи журнала, ни алерта по ключу лида, — и потому дефект ' +
      'в ней невидим ровно вдвое дольше',
  );
});

test('ОТВЕТ-ПОСЕТИТЕЛЮ: свободное сообщение — недоставка не молчит и без лида', async () => {
  const r = await run({
    request: makeRequest({ update: textUpdate(7, 'сайн байна уу') }),
    fetchFlags: { visitorFailure: { mode: 'blocked' } },
  });
  assert.equal(r.response.status, 200);
  assert.equal(toChat(r.calls, CHAT).length, 0, 'свободное сообщение ушло в чат менеджеров');
  assert.equal(
    toChat(r.calls, TECH).length,
    1,
    'ИСХОД-ОТВЕТА-НЕ-ПРОВЕРЕН: у ветки свободного сообщения лида нет вовсе, значит пометке ' +
      'в чате менеджеров появиться негде — и тем важнее строка в техчате',
  );
});

test('КОНВЕЙЕР: пометка повтора несёт направление ЭТОГО обращения', async () => {
  const store = new Map<string, unknown>();

  await run({ request: makeRequest({ update: startUpdate(1, '1__x_m') }), store });

  const second = await run({ request: makeRequest({ update: startUpdate(2, '1__b_m') }), store });

  const notice = String(toChat(second.calls, CHAT)[0]?.body.text ?? '');
  assert.ok(notice.toLowerCase().includes('повторный лид'), 'проба построена неверно');
  assert.ok(
    notice.includes('Bank Transfer'),
    'ПОВТОР-БЕЗ-НАПРАВЛЕНИЯ: интерес уточнился внутри окна, а менеджер об этом не узнал. ' +
      'Окно start длиной сутки, записи bot: для повтора нет по построению — направление ' +
      'второго тапа не сохраняется больше НИГДЕ',
  );
});
