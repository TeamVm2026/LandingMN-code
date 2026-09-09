
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from '../../src/lib/lead-contract.ts';
import { hitRateLimit, type RateLimitVerdict } from '../../src/server/lead/rate-limit.ts';

const T0 = 1_700_000_000_000;

const WINDOW_SEC = RATE_LIMIT_WINDOW_MS / 1000;

interface PutRecord {
  url: string;
  method: string;
  body: string;
  cacheControl: string | null;
  setCookie: string | null;
  status: number;
}

interface FakeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  readonly puts: PutRecord[];
  seed(url: string, body: string): void;
}

function createFakeCache(): FakeCache {
  const store = new Map<string, Response>();
  const puts: PutRecord[] = [];
  return {
    puts,
    seed(url, body) {
      store.set(url, new Response(body));
    },
    async match(request) {
      const hit = store.get(request.url);
      return hit ? hit.clone() : undefined;
    },
    async put(request, response) {
      const kept = response.clone();
      puts.push({
        url: request.url,
        method: request.method,
        body: await response.text(),
        cacheControl: kept.headers.get('cache-control'),
        setCookie: kept.headers.get('set-cookie'),
        status: kept.status,
      });
      store.set(request.url, kept);
    },
  };
}

test('пять попаданий подряд с одного адреса разрешены, шестое отклонено', async () => {
  const cache = createFakeCache();
  const verdicts: RateLimitVerdict[] = [];
  for (let i = 0; i <= RATE_LIMIT_MAX; i++) {
    verdicts.push(await hitRateLimit(cache, '203.0.113.7', T0 + i));
  }

  for (let i = 0; i < RATE_LIMIT_MAX; i++) {
    assert.equal(verdicts[i]?.allowed, true, `попадание ${i + 1} обязано пройти`);
    assert.equal(verdicts[i]?.count, i + 1, `счёт на попадании ${i + 1}`);
  }

  const sixth = verdicts[RATE_LIMIT_MAX];
  assert.equal(sixth?.allowed, false, 'шестое попадание обязано быть отклонено');
  assert.equal(sixth?.count, RATE_LIMIT_MAX + 1);
});

test('шестое попадание отдаёт remainingSec, из которого собирается Retry-After', async () => {
  const cache = createFakeCache();
  let verdict: RateLimitVerdict | undefined;
  for (let i = 0; i <= RATE_LIMIT_MAX; i++) {
    verdict = await hitRateLimit(cache, '203.0.113.7', T0 + i);
  }

  assert.ok(verdict && verdict.remainingSec >= 1, 'Retry-After меньше секунды бессмыслен');
  assert.ok(verdict && Number.isInteger(verdict.remainingSec), 'секунды обязаны быть целыми');
  assert.ok(verdict && verdict.remainingSec <= WINDOW_SEC, 'ждать дольше окна нечего');

  assert.equal(verdict?.remainingSec, WINDOW_SEC);
});

test('лимит считается на адрес, а не глобально', async () => {
  const cache = createFakeCache();
  for (let i = 0; i <= RATE_LIMIT_MAX; i++) {
    await hitRateLimit(cache, '203.0.113.7', T0 + i);
  }

  const neighbour = await hitRateLimit(cache, '198.51.100.9', T0 + 10);
  assert.equal(neighbour.allowed, true, 'сосед по интернету не платит за чужой флуд');
  assert.equal(neighbour.count, 1);
});

test('после истечения окна начинается новое окно со счётом один', async () => {
  const cache = createFakeCache();
  for (let i = 0; i <= RATE_LIMIT_MAX; i++) {
    await hitRateLimit(cache, '203.0.113.7', T0 + i);
  }

  const afterWindow = await hitRateLimit(cache, '203.0.113.7', T0 + RATE_LIMIT_WINDOW_MS);
  assert.equal(afterWindow.allowed, true);
  assert.equal(afterWindow.count, 1, 'новое окно начинается с единицы, а не продолжает старое');
});

test('окно фиксированное: попадания внутри него не продлевают срок', async () => {
  const cache = createFakeCache();
  const ip = '203.0.113.20';

  for (let i = 0; i < RATE_LIMIT_MAX; i++) {
    await hitRateLimit(cache, ip, T0 + i * 60_000);
  }

  const stored = JSON.parse(cache.puts.at(-1)?.body ?? '{}');
  assert.equal(stored.start, T0, 'начало окна обязано остаться на первом попадании');

  const denied = await hitRateLimit(cache, ip, T0 + RATE_LIMIT_WINDOW_MS - 1);
  assert.equal(denied.allowed, false);
  assert.equal(denied.remainingSec, 1);

  const renewed = await hitRateLimit(cache, ip, T0 + RATE_LIMIT_WINDOW_MS);
  assert.equal(renewed.allowed, true, 'фиксированное окно обязано открыться в срок');
  assert.equal(renewed.count, 1);
});

test('ключ кэша не содержит сырого адреса ни в каком виде', async () => {
  const cache = createFakeCache();
  const ip = '203.0.113.7';
  await hitRateLimit(cache, ip, T0);

  const record = cache.puts[0];
  assert.ok(record, 'запись в кэш обязана состояться');
  assert.ok(!record.url.includes(ip), `сырой адрес осел в ключе: ${record.url}`);

  const expected = createHash('sha256').update(ip, 'utf8').digest('hex');
  const url = new URL(record.url);
  assert.equal(url.hostname, 'ratelimit.invalid', 'ключ — не адрес, хост обязан быть несуществующим');
  assert.match(url.pathname, /^\/lead\/[0-9a-f]{64}$/);
  assert.ok(url.pathname.endsWith(expected), 'в ключе не sha256 от адреса');
});

test('ключ-запрос имеет метод GET — иначе настоящий cache.put бросит', async () => {
  const cache = createFakeCache();
  await hitRateLimit(cache, '203.0.113.7', T0);

  assert.equal(cache.puts[0]?.method, 'GET');
});

test('запись пригодна для Cache API: крошечная, 200, без Set-Cookie, с max-age на остаток окна', async () => {
  const cache = createFakeCache();
  const verdict = await hitRateLimit(cache, '203.0.113.7', T0);
  const record = cache.puts[0];

  assert.equal(record?.status, 200, '206 настоящий cache.put не принимает');
  assert.equal(record?.setCookie, null, 'ответы с Set-Cookie не кэшируются никогда');
  assert.ok((record?.body.length ?? 0) < 100, `тело записи обязано быть крошечным, а не ${record?.body.length}`);
  assert.equal(record?.cacheControl, `max-age=${verdict.remainingSec}`, 'запись обязана истечь вместе с окном');
});

test('сбой cache.match не отказывает форме, а снимает лимит', async () => {
  const broken = {
    async match(): Promise<Response | undefined> {
      throw new Error('cache unavailable');
    },
    async put(): Promise<void> {},
  };

  const verdict = await hitRateLimit(broken, '203.0.113.7', T0);
  assert.equal(verdict.allowed, true, 'сломанный кэш не повод терять лид');
  assert.equal(verdict.count, 1);
});

test('сбой cache.put не отказывает форме: вердикт уже вынесен по чтению', async () => {
  const halfBroken = {
    async match(): Promise<Response | undefined> {
      return new Response(JSON.stringify({ start: T0, n: RATE_LIMIT_MAX }));
    },
    async put(): Promise<void> {
      throw new Error('cache put failed');
    },
  };

  const verdict = await hitRateLimit(halfBroken, '203.0.113.7', T0 + 1);
  assert.equal(verdict.allowed, false, 'непрошедшая запись не отменяет уже посчитанный отказ');
  assert.equal(verdict.count, RATE_LIMIT_MAX + 1);
});

test('испорченное тело в кэше не роняет вызов, а открывает новое окно', async () => {
  const cache = createFakeCache();
  const ip = '203.0.113.7';

  await hitRateLimit(cache, ip, T0);
  const key = cache.puts[0]?.url ?? '';
  cache.seed(key, 'не json вовсе');

  const verdict = await hitRateLimit(cache, ip, T0 + 1);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.count, 1, 'нечитаемое состояние равно отсутствию состояния');
});

test('модуль не обращается к глобальному caches — иначе его не проверить вне Workers', async () => {
  const cache = createFakeCache();
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    get() {
      throw new Error('модуль полез в глобальный caches');
    },
  });

  try {
    const verdict = await hitRateLimit(cache, '203.0.113.7', T0);
    assert.equal(verdict.allowed, true);
  } finally {
    Reflect.deleteProperty(globalThis, 'caches');
  }
});
