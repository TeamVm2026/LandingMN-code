
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TELEGRAM_API_BASE,
  TELEGRAM_RETRY_DELAYS_MS,
  classifyTelegramResult,
  deliverWithRetries,
  sendMessage,
} from '../../src/server/lead/telegram.ts';
import type { SendMessageResult } from '../../src/server/lead/telegram.ts';

const TOKEN = '8100200300:AAF-FAKE-TOKEN-DO-NOT-USE-0123456789';
const CHAT = '-1002233445566';
const TECH_CHAT = '-1009988776655';
const LEAD_KEY = 'lead:2026-08-20T11:04:07.114Z:9f3c1a02';
const TEXT = 'Шинэ хүсэлт: Ө&lt;&amp;&gt;Ү Батбаяр';

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown>;
  hasSignal: boolean;
}

type Reply = { status: number; payload: unknown } | { throws: Error };

function fakeFetch(replies: Reply[]) {
  const calls: FetchCall[] = [];
  let i = 0;
  const impl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: String(init.method ?? 'GET'),
      body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>,
      hasSignal: Boolean(init.signal),
    });
    const reply = replies[i++] ?? { status: 200, payload: { ok: true } };
    if ('throws' in reply) throw reply.throws;
    return new Response(JSON.stringify(reply.payload), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, impl };
}

function fakeSleep() {
  const waited: number[] = [];
  return {
    waited,
    sleep: async (ms: number): Promise<void> => {
      waited.push(ms);
    },
  };
}

function reply(status: number, payload: object): SendMessageResult {
  return { status, body: payload as SendMessageResult['body'] };
}

test('sendMessage: POST на <база>/bot<токен>/sendMessage с parse_mode HTML и без предпросмотра', async () => {
  const f = fakeFetch([{ status: 200, payload: { ok: true, result: { message_id: 12 } } }]);

  const result = await sendMessage({
    token: TOKEN,
    chatId: CHAT,
    text: TEXT,
    fetchImpl: f.impl,
    apiBase: 'http://127.0.0.1:8799',
  });

  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call?.url, `http://127.0.0.1:8799/bot${TOKEN}/sendMessage`);
  assert.equal(call?.method, 'POST');
  assert.equal(call?.body.chat_id, CHAT);
  assert.equal(call?.body.text, TEXT);
  assert.equal(call?.body.parse_mode, 'HTML');
  assert.deepEqual(
    call?.body.link_preview_options,
    { is_disabled: true },
    'иначе ссылка на профиль в поле contact развернётся карточкой и вытеснит текст лида',
  );
  assert.equal(call?.hasSignal, true, 'попытка обязана иметь потолок по времени');
  assert.equal(result.status, 200);
  assert.equal(result.body?.ok, true);
});

test('sendMessage: база по умолчанию — боевой адрес Telegram', async () => {
  const f = fakeFetch([{ status: 200, payload: { ok: true } }]);

  await sendMessage({ token: TOKEN, chatId: CHAT, text: TEXT, fetchImpl: f.impl });

  assert.equal(TELEGRAM_API_BASE, 'https://api.telegram.org');
  assert.equal(f.calls[0]?.url, `${TELEGRAM_API_BASE}/bot${TOKEN}/sendMessage`);
});

test('sendMessage: в собранный URL не попадает ничего лишнего даже с хвостовой косой', async () => {
  const f = fakeFetch([{ status: 200, payload: { ok: true } }]);

  await sendMessage({
    token: TOKEN,
    chatId: CHAT,
    text: TEXT,
    fetchImpl: f.impl,

    apiBase: 'http://127.0.0.1:8799/',
  });

  assert.equal(f.calls[0]?.url, `http://127.0.0.1:8799/bot${TOKEN}/sendMessage`);
});

test('sendMessage: токен не появляется ни в возвращаемом значении, ни в тексте ошибки', async () => {

  const leaky = new Error(`connect ETIMEDOUT https://api.telegram.org/bot${TOKEN}/sendMessage`);
  const f = fakeFetch([{ throws: leaky }]);

  const result = await sendMessage({ token: TOKEN, chatId: CHAT, text: TEXT, fetchImpl: f.impl });

  assert.equal(result.status, null, 'ответа не было — это не «ok: false», а отсутствие ответа');
  assert.ok(result.error, 'причина обязана сохраниться, иначе разбирать нечего');
  assert.ok(
    !JSON.stringify(result).includes(TOKEN),
    `токен утёк в результат: ${JSON.stringify(result)}`,
  );
  assert.match(result.error ?? '', /ETIMEDOUT/, 'сама причина при этом обязана остаться читаемой');
});

test('классификация: ok:true — доставлено, повторять нечего', () => {
  assert.deepEqual(classifyTelegramResult(reply(200, { ok: true, result: { message_id: 1 } })), {
    kind: 'delivered',
  });
});

test('классификация: 429 повторяется ровно через parameters.retry_after секунд', () => {
  const d = classifyTelegramResult(
    reply(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } }),
  );

  assert.equal(d.kind, 'retry');
  assert.equal(
    d.kind === 'retry' ? d.delayMs : -1,
    7000,
    'собственная оценка вместо retry_after — второй 429 подряд и потраченная попытка',
  );
});

test('классификация: 429 без retry_after — обычный backoff, а не ноль', () => {
  const d = classifyTelegramResult(reply(429, { ok: false, error_code: 429 }), 1);
  assert.equal(d.kind, 'retry');
  assert.equal(d.kind === 'retry' ? d.delayMs : -1, TELEGRAM_RETRY_DELAYS_MS[0]);
});

test('классификация: 5xx — временное, backoff по номеру попытки', () => {
  const first = classifyTelegramResult(reply(500, { ok: false, error_code: 500, description: 'Internal Server Error' }), 1);
  const second = classifyTelegramResult(reply(502, { ok: false }), 2);

  assert.equal(first.kind, 'retry');
  assert.equal(first.kind === 'retry' ? first.delayMs : -1, TELEGRAM_RETRY_DELAYS_MS[0]);
  assert.equal(second.kind, 'retry');
  assert.equal(second.kind === 'retry' ? second.delayMs : -1, TELEGRAM_RETRY_DELAYS_MS[1]);
});

test('классификация: сети не случилось (обрыв, таймаут) — временное', () => {
  const d = classifyTelegramResult({ status: null, body: null, error: 'AbortError: timeout' }, 1);
  assert.equal(d.kind, 'retry');
  assert.equal(d.kind === 'retry' ? d.delayMs : -1, TELEGRAM_RETRY_DELAYS_MS[0]);
});

test('классификация: 400 — постоянное, дефект наш, повторять бессмысленно', () => {
  for (const description of ['message is too long', 'chat not found']) {
    const d = classifyTelegramResult(reply(400, { ok: false, error_code: 400, description }));
    assert.equal(d.kind, 'permanent', `${description} обязано быть постоянным`);
    assert.equal(d.kind === 'permanent' ? d.errorCode : 0, 400);
    assert.match(d.kind === 'permanent' ? d.reason : '', new RegExp(description));
  }
});

test('классификация: 403 — бот заблокирован или исключён из группы, это навсегда', () => {
  const d = classifyTelegramResult(
    reply(403, { ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the group chat' }),
  );
  assert.equal(d.kind, 'permanent');
  assert.equal(d.kind === 'permanent' ? d.errorCode : 0, 403);
});

test('классификация: прочее ok:false — постоянное, но описание сохраняется целиком', () => {
  const d = classifyTelegramResult(reply(409, { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates' }));
  assert.equal(d.kind, 'permanent');
  assert.match(d.kind === 'permanent' ? d.reason : '', /Conflict: terminated by other getUpdates/);
});

test('повторы: не больше трёх попыток, задержки 1 с и 4 с, алерт в техчат ровно один', async () => {
  const f = fakeFetch([
    { status: 500, payload: { ok: false, error_code: 500 } },
    { status: 500, payload: { ok: false, error_code: 500 } },
    { status: 500, payload: { ok: false, error_code: 500 } },
    { status: 200, payload: { ok: true } },
  ]);
  const s = fakeSleep();
  const startedAt = Date.now();

  const result = await deliverWithRetries({
    token: TOKEN,
    chatId: CHAT,
    text: TEXT,
    fetchImpl: f.impl,
    sleep: s.sleep,
    alert: { chatId: TECH_CHAT, leadKey: LEAD_KEY },
  });

  assert.equal(result.delivered, false);
  assert.equal(result.attempts, 3, 'четвёртая попытка — это уже не ретрай, а цикл');
  assert.deepEqual(s.waited, [...TELEGRAM_RETRY_DELAYS_MS]);
  assert.ok(
    Date.now() - startedAt < 500,
    'сюита обязана проходить мгновенно: пять секунд ожидания запрошены, но не отбыты',
  );

  const alerts = f.calls.filter((c) => c.body.chat_id === TECH_CHAT);
  assert.equal(alerts.length, 1, 'алерт ровно один: три штуки на один лид — это шум, а не диагностика');
  assert.equal(result.alerted, true);
  assert.equal(
    f.calls.filter((c) => c.body.chat_id === CHAT).length,
    3,
    'в чат менеджеров ушли только попытки доставки',
  );
});

test('алерт несёт ключ журнала и код ошибки — и ни содержимого лида, ни токена', async () => {
  const f = fakeFetch([
    { status: 400, payload: { ok: false, error_code: 400, description: 'chat not found' } },
    { status: 200, payload: { ok: true } },
  ]);
  const s = fakeSleep();

  await deliverWithRetries({
    token: TOKEN,
    chatId: CHAT,
    text: TEXT,
    fetchImpl: f.impl,
    sleep: s.sleep,
    alert: { chatId: TECH_CHAT, leadKey: LEAD_KEY },
  });

  const alert = f.calls.find((c) => c.body.chat_id === TECH_CHAT);
  const alertText = String(alert?.body.text ?? '');
  assert.match(alertText, new RegExp(LEAD_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'по ключу лид достают процедурой docs/ops.md §2');
  assert.match(alertText, /400/, 'код ошибки — половина диагностики');
  assert.ok(
    !alertText.includes('Батбаяр'),
    'содержимое лида уже лежит в журнале; дублировать ПДн в третье место незачем',
  );
  assert.ok(!alertText.includes(TOKEN), 'токен в тексте алерта = токен в чате');
  assert.equal(
    alert?.body.parse_mode,
    undefined,
    'алерт уходит простым текстом: у диагностики нет разметки, а «<» из описания Telegram ' +
      'сломал бы разбор HTML — и алерт потерялся бы ровно тогда, когда он нужен',
  );
});

test('повторы: постоянная ошибка не повторяется ни разу', async () => {
  const f = fakeFetch([
    { status: 403, payload: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } },
    { status: 200, payload: { ok: true } },
  ]);
  const s = fakeSleep();

  const result = await deliverWithRetries({
    token: TOKEN,
    chatId: CHAT,
    text: TEXT,
    fetchImpl: f.impl,
    sleep: s.sleep,
    alert: { chatId: TECH_CHAT, leadKey: LEAD_KEY },
  });

  assert.equal(result.attempts, 1, 'бесконечный ретрай на постоянной ошибке — это отказ в обслуживании самим себе');
  assert.deepEqual(s.waited, [], 'ждать перед несостоявшейся второй попыткой незачем');
  assert.equal(result.delivered, false);
  assert.equal(f.calls.filter((c) => c.body.chat_id === TECH_CHAT).length, 1);
});

test('повторы: успех со второй попытки — доставлено, алерта нет', async () => {
  const f = fakeFetch([
    { status: 500, payload: { ok: false, error_code: 500 } },
    { status: 200, payload: { ok: true } },
  ]);
  const s = fakeSleep();

  const result = await deliverWithRetries({
    token: TOKEN,
    chatId: CHAT,
    text: TEXT,
    fetchImpl: f.impl,
    sleep: s.sleep,
    alert: { chatId: TECH_CHAT, leadKey: LEAD_KEY },
  });

  assert.equal(result.delivered, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.alerted, false);
  assert.equal(f.calls.filter((c) => c.body.chat_id === TECH_CHAT).length, 0);
});

test('повторы: попытка, сделанная вызывающим, засчитывается — всего их всё равно три', async () => {

  const f = fakeFetch([
    { status: 500, payload: { ok: false, error_code: 500 } },
    { status: 500, payload: { ok: false, error_code: 500 } },
    { status: 200, payload: { ok: true } },
  ]);
  const s = fakeSleep();

  const result = await deliverWithRetries({
    token: TOKEN,
    chatId: CHAT,
    text: TEXT,
    fetchImpl: f.impl,
    sleep: s.sleep,
    attemptsAlreadyMade: 1,
    alert: { chatId: TECH_CHAT, leadKey: LEAD_KEY },
  });

  assert.equal(result.attempts, 3, 'попытка 1 уже сделана вызывающим — этот вызов делает ровно две');
  assert.equal(f.calls.filter((c) => c.body.chat_id === CHAT).length, 2);
  assert.deepEqual(s.waited, [...TELEGRAM_RETRY_DELAYS_MS]);
});

test('повторы: задержка перед первым повтором может прийти от вызывающего (retry_after первой попытки)', async () => {
  const f = fakeFetch([{ status: 200, payload: { ok: true } }]);
  const s = fakeSleep();

  await deliverWithRetries({
    token: TOKEN,
    chatId: CHAT,
    text: TEXT,
    fetchImpl: f.impl,
    sleep: s.sleep,
    attemptsAlreadyMade: 1,
    nextDelayMs: 7000,
  });

  assert.deepEqual(s.waited, [7000], 'иначе retry_after первой попытки теряется и второй 429 гарантирован');
});

test('повторы: упавший алерт не роняет доставку — иначе падает весь waitUntil', async () => {
  const f = fakeFetch([
    { status: 500, payload: { ok: false, error_code: 500 } },
    { status: 500, payload: { ok: false, error_code: 500 } },
    { status: 500, payload: { ok: false, error_code: 500 } },
    { throws: new Error(`connect ETIMEDOUT https://api.telegram.org/bot${TOKEN}/sendMessage`) },
  ]);
  const s = fakeSleep();

  const result = await deliverWithRetries({
    token: TOKEN,
    chatId: CHAT,
    text: TEXT,
    fetchImpl: f.impl,
    sleep: s.sleep,
    alert: { chatId: TECH_CHAT, leadKey: LEAD_KEY },
  });

  assert.equal(result.delivered, false);
  assert.equal(result.alerted, false, 'алерт не ушёл — врать об этом нельзя');
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('повторы: без техчата алерт не шлётся вовсе', async () => {
  const f = fakeFetch([
    { status: 400, payload: { ok: false, error_code: 400, description: 'chat not found' } },
  ]);
  const s = fakeSleep();

  const result = await deliverWithRetries({
    token: TOKEN,
    chatId: CHAT,
    text: TEXT,
    fetchImpl: f.impl,
    sleep: s.sleep,
  });

  assert.equal(f.calls.length, 1, 'приёмник без TG_TECH_CHAT_ID не имеет права слать диагностику в чат менеджеров');
  assert.equal(result.alerted, false);
});
