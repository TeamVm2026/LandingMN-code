
import test from 'node:test';
import assert from 'node:assert/strict';
import { TURNSTILE_TOKEN_FIELD } from '../../src/lib/lead-contract.ts';
import {
  verifyTurnstile,
  extractTurnstileToken,
  TURNSTILE_BUDGET_MS,
  type FetchLike,
  type TurnstileFetchInit,
} from '../../src/server/lead/turnstile.ts';

const SECRET_ALWAYS_PASS = '1x0000000000000000000000000000000AA';
const SECRET_ALWAYS_FAIL = '2x0000000000000000000000000000000AA';

const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const LIVE_PASS = {
  'challenge_ts': '2026-08-19T12:00:00.000Z',
  'error-codes': [] as string[],
  hostname: 'example.com',
  metadata: { result_with_testing_key: true },
  success: true,
};

const LIVE_FAIL = { 'error-codes': ['invalid-input-response'], success: false };

const LIVE_MISSING_RESPONSE = { 'error-codes': ['missing-input-response'], success: false };

interface RecordedCall {
  url: string;
  init: TurnstileFetchInit;
}

function stubFetch(script: (attempt: number) => Promise<Response>): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return script(calls.length);
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('пустой секрет означает «выключено»: fetch не вызывается ни разу', async () => {
  const { fetchImpl, calls } = stubFetch(async () => jsonResponse(LIVE_PASS));

  const verdict = await verifyTurnstile({
    secret: '',
    token: DUMMY_TOKEN,
    budgetMs: TURNSTILE_BUDGET_MS,
    fetchImpl,
  });

  assert.equal(verdict.outcome, 'disabled');
  assert.equal(verdict.attempts, 0);
  assert.equal(calls.length, 0, 'выключенная проверка не имеет права ходить в сеть');
});

test('секрет из одних пробелов — тоже «выключено», а не «секрет есть»', async () => {
  const { fetchImpl, calls } = stubFetch(async () => jsonResponse(LIVE_PASS));

  const verdict = await verifyTurnstile({
    secret: '   ',
    token: DUMMY_TOKEN,
    budgetMs: TURNSTILE_BUDGET_MS,
    fetchImpl,
  });

  assert.equal(verdict.outcome, 'disabled');
  assert.equal(calls.length, 0);
});

test('секрета нет, токена тоже нет — штатно выключено, tokenPresent = false', async () => {
  const { fetchImpl, calls } = stubFetch(async () => jsonResponse(LIVE_PASS));

  const verdict = await verifyTurnstile({
    secret: '',
    token: '',
    budgetMs: TURNSTILE_BUDGET_MS,
    fetchImpl,
  });

  assert.equal(verdict.outcome, 'disabled');
  assert.equal(
    verdict.tokenPresent,
    false,
    'без виджета токена нет — это Фаза 4, превью и localhost, а не поломка',
  );
  assert.equal(calls.length, 0, 'выключенная проверка не имеет права ходить в сеть');
});

test('секрета нет, а ТОКЕН ПРИСЛАН — виджет есть, проверки нет: tokenPresent = true', async () => {
  const { fetchImpl, calls } = stubFetch(async () => jsonResponse(LIVE_PASS));

  const verdict = await verifyTurnstile({
    secret: '',
    token: DUMMY_TOKEN,
    budgetMs: TURNSTILE_BUDGET_MS,
    fetchImpl,
  });

  assert.equal(verdict.outcome, 'disabled');
  assert.equal(verdict.tokenPresent, true);

  assert.equal(calls.length, 0, 'признак стоит один trim(), а не запрос в сеть');
});

test('tokenPresent заполняется и в сетевых исходах, а не только при выключенной проверке', async () => {
  const { fetchImpl } = stubFetch(async () => jsonResponse(LIVE_PASS));

  const withToken = await verifyTurnstile({
    secret: SECRET_ALWAYS_PASS,
    token: DUMMY_TOKEN,
    budgetMs: TURNSTILE_BUDGET_MS,
    fetchImpl,
  });
  assert.equal(withToken.outcome, 'pass');
  assert.equal(withToken.tokenPresent, true);

  const blank = await verifyTurnstile({
    secret: SECRET_ALWAYS_PASS,
    token: '   ',
    budgetMs: TURNSTILE_BUDGET_MS,
    fetchImpl,
  });

  assert.equal(blank.tokenPresent, false);
});

test('success: true → исход pass', async () => {
  const { fetchImpl, calls } = stubFetch(async () => jsonResponse(LIVE_PASS));

  const verdict = await verifyTurnstile({
    secret: SECRET_ALWAYS_PASS,
    token: DUMMY_TOKEN,
    budgetMs: TURNSTILE_BUDGET_MS,
    fetchImpl,
  });

  assert.equal(verdict.outcome, 'pass');
  assert.deepEqual(verdict.errorCodes, []);
  assert.equal(verdict.attempts, 1);
  assert.equal(calls.length, 1);
});

test('success: false → исход fail, коды сохранены', async () => {
  const { fetchImpl } = stubFetch(async () => jsonResponse(LIVE_FAIL));

  const verdict = await verifyTurnstile({
    secret: SECRET_ALWAYS_FAIL,
    token: DUMMY_TOKEN,
    budgetMs: TURNSTILE_BUDGET_MS,
    fetchImpl,
  });

  assert.equal(verdict.outcome, 'fail');
  assert.deepEqual(verdict.errorCodes, ['invalid-input-response']);
  assert.equal(verdict.configError, false, 'отказ по токену — вина не наша');
});

test('отсутствующий токен не пропускается мимо проверки: запрос всё равно уходит', async () => {
  const { fetchImpl, calls } = stubFetch(async () => jsonResponse(LIVE_MISSING_RESPONSE));

  const verdict = await verifyTurnstile({
    secret: SECRET_ALWAYS_PASS,
    token: '',
    budgetMs: TURNSTILE_BUDGET_MS,
    fetchImpl,
  });

  assert.equal(calls.length, 1, 'решение о пустом токене принимает siteverify, а не мы');
  assert.equal(verdict.outcome, 'fail');
  assert.deepEqual(verdict.errorCodes, ['missing-input-response']);
});

test('в siteverify действительно уезжают секрет и токен, методом POST', async () => {
  const { fetchImpl, calls } = stubFetch(async () => jsonResponse(LIVE_PASS));

  await verifyTurnstile({
    secret: SECRET_ALWAYS_PASS,
    token: DUMMY_TOKEN,
    remoteip: '203.0.113.7',
    budgetMs: TURNSTILE_BUDGET_MS,
    fetchImpl,
  });

  const call = calls[0];
  assert.ok(call, 'запрос обязан состояться');
  assert.equal(call.url, SITEVERIFY_URL, 'адрес проверки зафиксирован документацией');
  assert.equal(call.init.method, 'POST', 'GET siteverify отвечает 405 [VERIFIED]');

  const sent = new URLSearchParams(call.init.body);
  assert.equal(sent.get('secret'), SECRET_ALWAYS_PASS);
  assert.equal(sent.get('response'), DUMMY_TOKEN, 'токен обязан доехать — см. шапку файла');
  assert.equal(sent.get('remoteip'), '203.0.113.7');

  assert.equal(sent.get(TURNSTILE_TOKEN_FIELD), null);
});

test('сетевая ошибка → unavailable, и ровно одна повторная попытка', async () => {
  const { fetchImpl, calls } = stubFetch(async () => {
    throw new TypeError('fetch failed');
  });

  const verdict = await verifyTurnstile({
    secret: SECRET_ALWAYS_PASS,
    token: DUMMY_TOKEN,
    budgetMs: TURNSTILE_BUDGET_MS,
    fetchImpl,
  });

  assert.equal(verdict.outcome, 'unavailable');
  assert.notEqual(verdict.outcome, 'fail', 'недоступность проверки — не отказ проверки');
  assert.equal(calls.length, 2, 'ровно одна повторная попытка, а не бесконечный цикл');
  assert.equal(verdict.attempts, 2);
});

test('не-200 от siteverify → unavailable, а не fail', async () => {
  const { fetchImpl } = stubFetch(async () => new Response('gateway blew up', { status: 502 }));

  const verdict = await verifyTurnstile({
    secret: SECRET_ALWAYS_PASS,
    token: DUMMY_TOKEN,
    budgetMs: TURNSTILE_BUDGET_MS,
    fetchImpl,
  });

  assert.equal(verdict.outcome, 'unavailable');
});

test('200 с неразбираемым телом → unavailable: вердикта нет', async () => {
  const { fetchImpl } = stubFetch(async () => new Response('<html>captive portal</html>', { status: 200 }));

  const verdict = await verifyTurnstile({
    secret: SECRET_ALWAYS_PASS,
    token: DUMMY_TOKEN,
    budgetMs: TURNSTILE_BUDGET_MS,
    fetchImpl,
  });

  assert.equal(verdict.outcome, 'unavailable', 'нечитаемый ответ — не разрешение и не запрет');
});

test('повторная попытка спасает: первый вызов упал, второй ответил', async () => {
  const { fetchImpl, calls } = stubFetch(async (attempt) => {
    if (attempt === 1) throw new TypeError('fetch failed');
    return jsonResponse(LIVE_PASS);
  });

  const verdict = await verifyTurnstile({
    secret: SECRET_ALWAYS_PASS,
    token: DUMMY_TOKEN,
    budgetMs: TURNSTILE_BUDGET_MS,
    fetchImpl,
  });

  assert.equal(verdict.outcome, 'pass', 'повтор обязан быть настоящим, а не декоративным');
  assert.equal(verdict.attempts, 2);
  assert.equal(calls.length, 2);
});

test('обе попытки несут ОДИН И ТОТ ЖЕ idempotency_key', async () => {
  const { fetchImpl, calls } = stubFetch(async (attempt) => {
    if (attempt === 1) throw new TypeError('fetch failed');
    return jsonResponse(LIVE_PASS);
  });

  await verifyTurnstile({
    secret: SECRET_ALWAYS_PASS,
    token: DUMMY_TOKEN,
    idempotencyKey: 'lead-2026-08-20-0001',
    budgetMs: TURNSTILE_BUDGET_MS,
    fetchImpl,
  });

  const keys = calls.map((call) => new URLSearchParams(call.init.body).get('idempotency_key'));
  assert.equal(keys.length, 2);
  assert.equal(keys[0], 'lead-2026-08-20-0001');
  assert.equal(keys[1], keys[0], 'второй ключ обязан совпасть с первым');
});

test('ключ идемпотентности берётся сам, если его не передали', async () => {
  const { fetchImpl, calls } = stubFetch(async (attempt) => {
    if (attempt === 1) throw new TypeError('fetch failed');
    return jsonResponse(LIVE_PASS);
  });

  await verifyTurnstile({
    secret: SECRET_ALWAYS_PASS,
    token: DUMMY_TOKEN,
    budgetMs: TURNSTILE_BUDGET_MS,
    fetchImpl,
  });

  const keys = calls.map((call) => new URLSearchParams(call.init.body).get('idempotency_key'));
  assert.ok(keys[0] && keys[0].length > 0, 'без ключа повтор ловит timeout-or-duplicate');
  assert.equal(keys[1], keys[0]);
});

test('исчерпанный бюджет отменяет повтор', async () => {
  let clock = 1_000;
  const { fetchImpl, calls } = stubFetch(async () => {
    clock += 4_000;
    throw new TypeError('fetch failed');
  });

  const verdict = await verifyTurnstile({
    secret: SECRET_ALWAYS_PASS,
    token: DUMMY_TOKEN,
    budgetMs: 3_000,
    fetchImpl,
    now: () => clock,
  });

  assert.equal(verdict.outcome, 'unavailable');
  assert.equal(calls.length, 1, 'повтор за пределами бюджета — это просроченный ответ посетителю');
});

test('каждой попытке передаётся сигнал отмены', async () => {
  const { fetchImpl, calls } = stubFetch(async () => jsonResponse(LIVE_PASS));

  await verifyTurnstile({
    secret: SECRET_ALWAYS_PASS,
    token: DUMMY_TOKEN,
    budgetMs: TURNSTILE_BUDGET_MS,
    fetchImpl,
  });

  assert.ok(calls[0]?.init.signal instanceof AbortSignal, 'без сигнала повисший запрос повесит заявку');
});

test('вердикт не выносит секрет наружу ни в каком поле', async () => {
  const { fetchImpl } = stubFetch(async () => jsonResponse(LIVE_FAIL));

  const verdict = await verifyTurnstile({
    secret: SECRET_ALWAYS_FAIL,
    token: DUMMY_TOKEN,
    budgetMs: TURNSTILE_BUDGET_MS,
    fetchImpl,
  });

  assert.ok(!JSON.stringify(verdict).includes(SECRET_ALWAYS_FAIL));
  assert.ok(!Object.keys(verdict).some((key) => key.toLowerCase().includes('secret')));
});

test('рекомендованный бюджет не больше пяти секунд', () => {

  assert.ok(TURNSTILE_BUDGET_MS <= 5_000, `бюджет ${TURNSTILE_BUDGET_MS} мс больше пяти секунд`);
});

test('имя поля с токеном берётся из контракта, а не выдумывается', () => {
  const fromWidget = new URLSearchParams();
  fromWidget.set(TURNSTILE_TOKEN_FIELD, DUMMY_TOKEN);
  assert.equal(extractTurnstileToken(fromWidget), DUMMY_TOKEN);

  const invented = new URLSearchParams();
  invented.set('turnstile_token', DUMMY_TOKEN);
  assert.equal(extractTurnstileToken(invented), '');

  const absent = new URLSearchParams();
  assert.equal(extractTurnstileToken(absent), '', 'отсутствующее поле равно пустому токену');
});
