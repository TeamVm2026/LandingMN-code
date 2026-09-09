
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultDir = fileURLToPath(new URL('../../workers/bot/', import.meta.url));
const botDir = process.env.BOT_MODULE_DIR ?? defaultDir;
const adminPath = path.join(botDir, 'admin.ts');

const { handleAdmin, ADMIN_TOKEN_HEADER } = (await import(
  pathToFileURL(adminPath).href
)) as typeof import('../../workers/bot/admin.ts');

const ADMIN = 'admin-token-value-0123456789abcd';
const TOKEN = '8100200300:TESTTESTTESTTESTTESTTESTTESTTESTTES';
const SECRET = 'webhook-secret-value-0123456789';
const CHAT = '-1002222222222';
const MANAGER = 'https://t.me/melbet_mn_manager';
const API = 'https://api.example.invalid';
const ORIGIN = 'https://landingmn-bot.workers.dev';

interface Recorded {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

interface FetchFlags {

  throwOn?: string;

  failOn?: string;
}

const RESULTS: Record<string, unknown> = {
  getMe: {
    id: 8100200300,
    is_bot: true,
    first_name: 'MELBET Partners MN',
    username: 'melbet_mn_bot',
    can_join_groups: true,
  },
  getWebhookInfo: {
    url: `${ORIGIN}/tg/webhook`,
    has_custom_certificate: false,
    pending_update_count: 3,
    last_error_date: 1755859200,
    last_error_message: 'Wrong response from the webhook: 401 Unauthorized',
    max_connections: 5,
    allowed_updates: ['message'],
  },
  setWebhook: true,
  deleteWebhook: true,
  setMyDescription: true,
  setMyShortDescription: true,
  setMyCommands: true,
};

function fakeFetch(flags: FetchFlags = {}) {
  const calls: Recorded[] = [];
  const impl = async (url: string, init: RequestInit): Promise<Response> => {
    const method = url.slice(url.lastIndexOf('/') + 1);
    calls.push({
      url,
      method,
      body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>,
    });
    if (flags.throwOn === method) {

      throw new Error(`connect ETIMEDOUT ${url}`);
    }
    if (flags.failOn === method) {
      return new Response(
        JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: bad webhook' }),
        { status: 400 },
      );
    }
    return new Response(JSON.stringify({ ok: true, result: RESULTS[method] ?? true }), {
      status: 200,
    });
  };
  return { impl, calls };
}

function envOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    BOT_ADMIN_TOKEN: ADMIN,
    TG_BOT_TOKEN: TOKEN,
    TG_CHAT_ID: CHAT,
    TG_WEBHOOK_SECRET: SECRET,
    MANAGER_CONTACT_URL: MANAGER,
    TG_API_BASE: API,
    ...over,
  };
}

function makeRequest(
  pathname: string,
  options: { method?: string; admin?: string | null; body?: unknown } = {},
): Request {
  const headers = new Headers();
  const admin = options.admin === undefined ? ADMIN : options.admin;
  if (admin !== null) headers.set(ADMIN_TOKEN_HEADER, admin);
  const method = options.method ?? (pathname.endsWith('/diag') ? 'GET' : 'POST');
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${ORIGIN}${pathname}`, {
    method,
    headers,
    body: options.body === undefined || method === 'GET' ? undefined : JSON.stringify(options.body),
  });
}

async function run(options: {
  request?: Request;
  env?: Record<string, unknown>;
  fetchFlags?: FetchFlags;
} = {}): Promise<{ response: Response; calls: Recorded[]; json: Record<string, unknown> }> {
  const f = fakeFetch(options.fetchFlags);
  const response = await handleAdmin(
    options.request ?? makeRequest('/admin/diag'),
    (options.env ?? envOf()) as never,
    { fetchImpl: f.impl as never },
  );
  const text = await response.clone().text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { response, calls: f.calls, json: parsed };
}

const ADMIN_ROUTES: [string, string][] = [
  ['GET', '/admin/diag'],
  ['POST', '/admin/webhook'],
  ['POST', '/admin/webhook/delete'],
  ['POST', '/admin/profile'],
];

test('АДМИНКА: без заголовка X-Bot-Admin-Token — 401 и ноль исходящих запросов', async () => {
  for (const [method, route] of ADMIN_ROUTES) {
    const r = await run({ request: makeRequest(route, { method, admin: null }) });
    assert.equal(
      r.response.status,
      401,
      `АДМИНКА-БЕЗ-ТОКЕНА-ПРИНЯЛА: ${method} ${route} без заголовка не получил 401`,
    );
    assert.equal(
      r.calls.length,
      0,
      `АДМИНКА-БЕЗ-ТОКЕНА-ПРИНЯЛА: ${method} ${route} без заголовка дошёл до Bot API`,
    );
  }
});

test('АДМИНКА: неверный токен — 401 и ноль исходящих запросов', async () => {
  for (const [method, route] of ADMIN_ROUTES) {
    const r = await run({ request: makeRequest(route, { method, admin: 'wrong-admin-token' }) });
    assert.equal(
      r.response.status,
      401,
      `АДМИНКА-БЕЗ-ТОКЕНА-ПРИНЯЛА: ${method} ${route} принял неверный токен`,
    );
    assert.equal(r.calls.length, 0, 'АДМИНКА-БЕЗ-ТОКЕНА-ПРИНЯЛА: неверный токен дошёл до Bot API');
  }
});

test('АДМИНКА: токен верной длины, но иной — 401', async () => {
  const other = `${'z'.repeat(ADMIN.length - 1)}q`;
  assert.equal(other.length, ADMIN.length, 'проба построена неверно: длины разошлись');
  const r = await run({ request: makeRequest('/admin/diag', { admin: other }) });
  assert.equal(r.response.status, 401, 'АДМИНКА-БЕЗ-ТОКЕНА-ПРИНЯЛА: значение верной длины принято');
});

test('АДМИНКА: незаданный BOT_ADMIN_TOKEN закрывает поверхность РОВНО 401-м, а не 503', async () => {
  for (const value of [undefined, '', '   ']) {
    for (const [method, route] of ADMIN_ROUTES) {
      for (const presented of [null, ADMIN, '']) {
        const r = await run({
          request: makeRequest(route, { method, admin: presented }),
          env: envOf({ BOT_ADMIN_TOKEN: value }),
        });
        assert.equal(
          r.response.status,
          401,
          'АДМИНКА-БЕЗ-ТОКЕНА-ПРИНЯЛА: незаданный BOT_ADMIN_TOKEN дал не 401. ' +
            'Fail-closed обязан быть ЗАФИКСИРОВАН, а не подразумеваться: 503 здесь означал бы, ' +
            'что проба, принимающая два кода, не отличает закрытую поверхность от открытой',
        );
        assert.equal(r.calls.length, 0, 'АДМИНКА-БЕЗ-ТОКЕНА-ПРИНЯЛА: запрос дошёл до Bot API');
      }
    }
  }
});

test('АДМИНКА: сверка идёт timingSafeEqualStr, прямого сравнения в файле нет', () => {
  const source = readFileSync(adminPath, 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    /timingSafeEqualStr\s*\(/.test(code),
    'АДМИНКА-СРАВНИВАЕТ-НАПРЯМУЮ: в admin.ts нет вызова timingSafeEqualStr. ' +
      'Админ-токен СИЛЬНЕЕ секрета вебхука: секрет позволяет прислать апдейт, ' +
      'админ-токен — перерегистрировать или УДАЛИТЬ вебхук, то есть выключить бота молча. ' +
      'Защищать более слабый вход строже более сильного — дорогая асимметрия.',
  );
  assert.ok(
    !/adminToken\s*[!=]==?/.test(code) && !/[!=]==?\s*adminToken/.test(code),
    'АДМИНКА-СРАВНИВАЕТ-НАПРЯМУЮ: админ-токен сравнивается оператором === или !== ' +
      'вместо timingSafeEqualStr. Проверка длины пустоты пишется через .length.',
  );
});

test('АДМИНКА: неизвестный путь под /admin/ даёт 404 с пустым телом', async () => {
  const r = await run({ request: makeRequest('/admin/unknown') });
  assert.equal(r.response.status, 404);
  assert.equal(await r.response.clone().text(), '');
});

const DIAG_SHAPE: Record<string, string[]> = {
  bot: ['id', 'username', 'first_name', 'can_join_groups'],
  webhook: [
    'url',
    'has_custom_certificate',
    'pending_update_count',
    'last_error_date',
    'last_error_message',
    'max_connections',
    'allowed_updates',
  ],
  config: [
    'manager_contact_url',
    'tg_chat_id_len',
    'tg_chat_id_tail4',
    'tg_webhook_secret_len',
    'version_id',
  ],
};

function assertShape(json: Record<string, unknown>, where: string): void {
  assert.deepEqual(
    Object.keys(json).sort(),
    Object.keys(DIAG_SHAPE).sort(),
    `ФОРМА-DIAG-ИЗМЕНИЛАСЬ (${where}): верхний уровень ответа /admin/diag`,
  );
  for (const [group, fields] of Object.entries(DIAG_SHAPE)) {
    const actual = Object.keys((json[group] ?? {}) as Record<string, unknown>);
    for (const field of fields) {
      assert.ok(
        actual.includes(field),
        `ФОРМА-DIAG-ИЗМЕНИЛАСЬ (${where}): в «${group}» нет ключа «${field}». ` +
          'Незаданный вход обязан давать ПУСТОЕ ЗНАЧЕНИЕ поля, а не отсутствующий ключ: ' +
          'потребитель отличает «не задано» от «форма изменилась».',
      );
    }
  }
}

test('DIAG: форма ответа совпадает с замороженной дословно', async () => {
  const r = await run({ request: makeRequest('/admin/diag') });
  assert.equal(r.response.status, 200);
  assertShape(r.json, 'вооружённый воркер');

  const bot = r.json.bot as Record<string, unknown>;
  assert.equal(bot.id, 8100200300);
  assert.equal(bot.username, 'melbet_mn_bot');
  assert.equal(bot.can_join_groups, true);

  const webhook = r.json.webhook as Record<string, unknown>;
  assert.equal(webhook.url, `${ORIGIN}/tg/webhook`);
  assert.equal(webhook.pending_update_count, 3);
  assert.deepEqual(webhook.allowed_updates, ['message']);
  assert.ok(
    String(webhook.last_error_message).includes('401'),
    'last_error_message не доехал: без него «вебхук молчит, потому что никто не пишет» ' +
      'не отличить от «вебхук падает на каждом апдейте»',
  );
});

test('DIAG: незаданный вход даёт ПУСТОЕ значение поля, а не отсутствующий ключ', async () => {
  const r = await run({
    request: makeRequest('/admin/diag'),
    env: envOf({ MANAGER_CONTACT_URL: undefined, TG_CHAT_ID: undefined, TG_WEBHOOK_SECRET: undefined }),
  });
  assert.equal(r.response.status, 200);
  assertShape(r.json, 'недонастроенный воркер');
  const config = r.json.config as Record<string, unknown>;
  assert.equal(config.manager_contact_url, '');
  assert.equal(config.tg_chat_id_len, 0);
  assert.equal(config.tg_chat_id_tail4, '');
  assert.equal(config.tg_webhook_secret_len, 0);
});

test('DIAG: manager_contact_url отдаётся ЦЕЛИКОМ — это не секрет', async () => {
  const r = await run({ request: makeRequest('/admin/diag') });
  const config = r.json.config as Record<string, unknown>;
  assert.equal(
    config.manager_contact_url,
    MANAGER,
    'DIAG — ЕДИНСТВЕННЫЙ живой детектор потери --var MANAGER_CONTACT_URL: пробы плана ' +
      '06-05 идут ДО вооружения и увидеть его не могут по построению',
  );
});

test('DIAG: свидетели chat_id неразглашающие — длина и последние четыре символа', async () => {
  const r = await run({ request: makeRequest('/admin/diag') });
  const config = r.json.config as Record<string, unknown>;
  assert.equal(config.tg_chat_id_len, CHAT.length);
  assert.equal(config.tg_chat_id_tail4, CHAT.slice(-4));
  assert.equal(config.tg_webhook_secret_len, SECRET.length);
  const body = await r.response.clone().text();
  assert.ok(
    !body.includes(CHAT),
    'СЕКРЕТ-В-DIAG: идентификатор чата отдан целиком. Свидетеля хватает, чтобы отличить ' +
      'техчат от боевого, и не хватает, чтобы им воспользоваться',
  );
  assert.ok(!body.includes(SECRET), 'СЕКРЕТ-В-DIAG: секрет вебхука отдан целиком');
});

test('DIAG: недоступность Telegram не ломает форму — ключи на месте', async () => {
  const r = await run({ request: makeRequest('/admin/diag'), fetchFlags: { throwOn: 'getMe' } });
  assert.equal(r.response.status, 200);
  assertShape(r.json, 'Telegram недоступен');
});

test('DIAG: без TG_BOT_TOKEN админка отдаёт 503 и не ходит в Bot API', async () => {
  const r = await run({
    request: makeRequest('/admin/diag'),
    env: envOf({ TG_BOT_TOKEN: '' }),
  });
  assert.equal(r.response.status, 503);
  assert.equal(r.calls.length, 0);
});

test('ВЕБХУК: без тела регистрируется origin ТОГО ЖЕ запроса плюс /tg/webhook', async () => {
  const r = await run({ request: makeRequest('/admin/webhook') });
  assert.equal(r.response.status, 200);
  const call = r.calls.find((c) => c.method === 'setWebhook');
  assert.ok(call, 'setWebhook не вызван');
  assert.equal(
    call.body.url,
    `${ORIGIN}/tg/webhook`,
    'АДРЕС-ВЕБХУКА-ЛИТЕРАЛ: регистрируется не тот origin, по которому пришёл админ-запрос. ' +
      'Свойство выбрано ради дня переезда: вызов по новому поддомену регистрирует новый ' +
      'адрес САМ, без переменной, которую можно забыть обновить',
  );
});

test('ВЕБХУК: явный origin в теле регистрируется вместо origin запроса', async () => {
  const r = await run({
    request: makeRequest('/admin/webhook', { body: { origin: 'https://bot.example.com' } }),
  });
  const call = r.calls.find((c) => c.method === 'setWebhook');
  assert.equal(call?.body.url, 'https://bot.example.com/tg/webhook');
});

test('ВЕБХУК: не-https и не абсолютный origin дают 400 без обращения к Telegram', async () => {
  for (const origin of ['http://bot.example.com', '/tg/webhook', 'bot.example.com', 'ftp://x.y']) {
    const r = await run({ request: makeRequest('/admin/webhook', { body: { origin } }) });
    assert.equal(r.response.status, 400, `непригодный origin «${origin}» не дал 400`);
    assert.equal(r.calls.length, 0, `непригодный origin «${origin}» дошёл до Telegram`);
  }
});

test('ВЕБХУК: setWebhook уходит с secret_token и замороженными параметрами', async () => {
  const r = await run({ request: makeRequest('/admin/webhook') });
  const call = r.calls.find((c) => c.method === 'setWebhook');
  assert.equal(call?.body.secret_token, SECRET, 'вебхук зарегистрирован БЕЗ secret_token');
  assert.deepEqual(call?.body.allowed_updates, ['message']);
  assert.equal(call?.body.max_connections, 5);
  assert.equal(call?.body.drop_pending_updates, false);
});

test('ВЕБХУК: без TG_WEBHOOK_SECRET регистрация не происходит вовсе — 503', async () => {
  const r = await run({
    request: makeRequest('/admin/webhook'),
    env: envOf({ TG_WEBHOOK_SECRET: '' }),
  });
  assert.equal(r.response.status, 503);
  assert.equal(
    r.calls.length,
    0,
    'вебхук зарегистрирован без секрета — это открытая дверь, а не половина настройки',
  );
});

test('УДАЛЕНИЕ: /admin/webhook/delete снимает вебхук и отдаёт исход', async () => {
  const r = await run({ request: makeRequest('/admin/webhook/delete') });
  assert.equal(r.response.status, 200);
  const call = r.calls.find((c) => c.method === 'deleteWebhook');
  assert.ok(call, 'deleteWebhook не вызван');
  assert.equal(r.json.ok, true);
});

test('УДАЛЕНИЕ: без админ-токена вебхук не снимается — 401 и ноль вызовов', async () => {
  const r = await run({ request: makeRequest('/admin/webhook/delete', { admin: null }) });
  assert.equal(
    r.response.status,
    401,
    'АДМИНКА-БЕЗ-ТОКЕНА-ПРИНЯЛА: разрушительный вызов выполнен без токена. ' +
      '«Его никто не позовёт» — не защита: deleteWebhook выключает бота МОЛЧА',
  );
  assert.equal(r.calls.length, 0);
});

test('ПРОФИЛЬ: три вызова Bot API и исход КАЖДОГО отдельно', async () => {
  const r = await run({
    request: makeRequest('/admin/profile', {
      body: {
        description: 'Хамтрагчийн хөтөлбөр',
        shortDescription: 'MELBET Partners',
        commands: [{ command: 'start', description: 'Эхлэх' }],
      },
    }),
  });
  assert.equal(r.response.status, 200);
  for (const method of ['setMyDescription', 'setMyShortDescription', 'setMyCommands']) {
    assert.ok(
      r.calls.some((c) => c.method === method),
      `${method} не вызван`,
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(r.json, method),
      `исход ${method} не отдан отдельным полем — по общему «ok» нельзя понять, что именно упало`,
    );
  }
});

test('ПРОФИЛЬ: language_code доезжает до ВСЕХ ТРЁХ вызовов, а пустой — не кладётся', async () => {

  const withLang = await run({
    request: makeRequest('/admin/profile', {
      body: {
        description: 'd',
        shortDescription: 's',
        commands: [{ command: 'start', description: 'e' }],
        language_code: 'ru',
      },
    }),
  });
  assert.equal(withLang.response.status, 200);
  for (const method of ['setMyDescription', 'setMyShortDescription', 'setMyCommands']) {
    const call = withLang.calls.find((c) => c.method === method);
    assert.ok(call, `${method} не вызван`);
    assert.equal(
      (call.body as Record<string, unknown>).language_code,
      'ru',
      `${method} ушёл БЕЗ language_code — значит перезаписал набор по умолчанию, а не русский`,
    );
  }

  const noLang = await run({
    request: makeRequest('/admin/profile', {
      body: { description: 'd', shortDescription: 's', commands: [{ command: 'start', description: 'e' }] },
    }),
  });
  for (const method of ['setMyDescription', 'setMyShortDescription', 'setMyCommands']) {
    const call = noLang.calls.find((c) => c.method === method);
    assert.ok(call, `${method} не вызван`);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(call.body as Record<string, unknown>, 'language_code'),
      `${method} унёс пустой language_code — Bot API отвергает его как Bad Request`,
    );
  }
});

test('ПРОФИЛЬ: отказ одного вызова не скрывает исходы двух других', async () => {
  const r = await run({
    request: makeRequest('/admin/profile', {
      body: { description: 'd', shortDescription: 's', commands: [{ command: 'start', description: 'e' }] },
    }),
    fetchFlags: { failOn: 'setMyCommands' },
  });
  assert.equal(r.response.status, 200);
  const commands = r.json.setMyCommands as Record<string, unknown>;
  const description = r.json.setMyDescription as Record<string, unknown>;
  assert.equal(commands.ok, false);
  assert.equal(description.ok, true);
});

test('ТОКЕН: ни один ответ админ-поверхности не содержит подстроки токена', async () => {
  const runs = [
    await run({ request: makeRequest('/admin/diag') }),
    await run({ request: makeRequest('/admin/diag'), fetchFlags: { throwOn: 'getMe' } }),
    await run({ request: makeRequest('/admin/webhook'), fetchFlags: { throwOn: 'setWebhook' } }),
    await run({ request: makeRequest('/admin/webhook'), fetchFlags: { failOn: 'setWebhook' } }),
    await run({ request: makeRequest('/admin/webhook/delete'), fetchFlags: { throwOn: 'deleteWebhook' } }),
  ];
  for (const r of runs) {
    const body = await r.response.clone().text();
    assert.ok(
      !body.includes(TOKEN),
      'ТОКЕН-В-ОТВЕТЕ: ответ админ-поверхности содержит токен бота. Сообщения сетевых ошибок ' +
        'часто содержат URL целиком, а в нём токен: наивное String(err) унесло бы его наружу',
    );
  }
});

test('ТОКЕН: адрес вебхука не является литералом ни в одной строке admin.ts', () => {
  const source = readFileSync(adminPath, 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !/https:\/\/[A-Za-z0-9.-]+/.test(code),
    'АДРЕС-ВЕБХУКА-ЛИТЕРАЛ: в admin.ts найден захардкоженный адрес. Регистрируется origin ' +
      'САМОГО админ-запроса — ровно затем, чтобы день переезда на кастомный поддомен был ' +
      'сменой конфигурации, а не правкой кода',
  );
});

test('ТОКЕН: админка не пишет в консоль ни одной строки', () => {
  const source = readFileSync(adminPath, 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !/\bconsole\s*\./.test(code),
    'КОНСОЛЬ-В-ВОРКЕРЕ: вывод `wrangler tail` видит любой, у кого есть токен аккаунта',
  );
});
