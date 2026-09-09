
import assert from 'node:assert/strict';
import test from 'node:test';

import { ATTRIBUTION_TTL_MS } from '../../src/lib/attribution.ts';
import { LEAD_KEY_PREFIX, LEAD_TTL_SECONDS } from '../../src/lib/lead-contract.ts';
import type { LeadMetadata } from '../../src/lib/lead-contract.ts';
import {
  DELIVERY_MARK_MIN_INTERVAL_MS,
  markDelivery,
  writeLead,
} from '../../src/server/lead/journal.ts';

interface RecordedPut {
  key: string;
  value: string;
  expirationTtl?: number;
  metadata?: LeadMetadata;
}

interface FakeKv {
  puts: RecordedPut[];
  store: Map<string, string>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: LeadMetadata },
  ): Promise<void>;
}

function fakeKv(failWith?: Error): FakeKv {
  const puts: RecordedPut[] = [];
  const store = new Map<string, string>();
  return {
    puts,
    store,
    async put(key, value, options) {
      if (failWith) throw failWith;
      puts.push({ key, value, expirationTtl: options?.expirationTtl, metadata: options?.metadata });
      store.set(key, value);
    },
  };
}

function fakeClock(startIso: string) {
  let t = Date.parse(startIso);
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

function fakeSleep(kv: FakeKv) {
  const calls: { ms: number; putsBefore: number }[] = [];
  return {
    calls,
    sleep: async (ms: number): Promise<void> => {
      calls.push({ ms, putsBefore: kv.puts.length });
    },
  };
}

const META = {
  direction: 'affiliate',
  source: 'fb',
  lang: 'mn',
  channel: 'telegram',
  host: 'landingmn.pages.dev',
} as const satisfies Omit<LeadMetadata, 'delivered'>;

const PAYLOAD = {
  name: 'Ө<&>Ү Батбаяр',
  contact: '+976 8800 1122',
  direction: 'affiliate',
  ts: '2026-08-20T11:04:07.114Z',
};

test('ключ журнала — lead:<ISO-время>:<8 hex>, время впереди ради сортировки', async () => {
  const kv = fakeKv();
  const clock = fakeClock('2026-08-20T11:04:07.114Z');

  const entry = await writeLead(kv, { payload: PAYLOAD, metadata: META }, { now: clock.now });

  assert.equal(kv.puts.length, 1, 'заявка обязана попасть в журнал ровно одной записью');
  assert.equal(entry.key, kv.puts[0]?.key);
  assert.match(
    entry.key,
    new RegExp(`^${LEAD_KEY_PREFIX}2026-08-20T11:04:07\\.114Z:[0-9a-f]{8}$`),
    `ключ «${entry.key}» не соответствует форме lead:<ISO>:<8 hex> из контракта`,
  );
});

test(`expirationTtl журнала равен LEAD_TTL_SECONDS = ${LEAD_TTL_SECONDS} с`, async () => {
  const kv = fakeKv();
  await writeLead(kv, { payload: PAYLOAD, metadata: META });

  const ttl = kv.puts[0]?.expirationTtl;
  assert.equal(ttl, LEAD_TTL_SECONDS, 'TTL записи обязан приходить из контракта');
  assert.equal(
    ttl,
    Math.floor(ATTRIBUTION_TTL_MS / 1000),
    'TTL обязан выводиться из единственного объявления срока хранения в проекте',
  );
  assert.ok(
    ttl !== undefined && ttl >= 60,
    'KV отвергает expirationTtl меньше 60 с четырёхсотым ответом — заявка не попала бы в журнал вовсе',
  );
});

test('метаданные дают триаж по list: направление, источник, язык, канал, хост', async () => {
  const kv = fakeKv();
  await writeLead(kv, { payload: PAYLOAD, metadata: META });

  assert.deepEqual(kv.puts[0]?.metadata, {
    direction: 'affiliate',
    source: 'fb',
    lang: 'mn',
    channel: 'telegram',
    host: 'landingmn.pages.dev',

    delivered: false,
  });
});

test('две заявки в одну миллисекунду получают разные ключи', async () => {
  const kv = fakeKv();
  const clock = fakeClock('2026-08-20T11:04:07.114Z');

  const first = await writeLead(kv, { payload: PAYLOAD, metadata: META }, { now: clock.now });
  const second = await writeLead(kv, { payload: PAYLOAD, metadata: META }, { now: clock.now });

  assert.notEqual(
    first.key,
    second.key,
    'ключ из одного только времени: вторая заявка молча затёрла бы первую',
  );
  assert.equal(kv.store.size, 2, 'в журнале обязаны лежать обе заявки');
});

test('ошибка записи пробрасывается наверх, а не глотается', async () => {
  const kv = fakeKv(new Error('KV PUT failed: 429 Too Many Requests'));

  await assert.rejects(
    () => writeLead(kv, { payload: PAYLOAD, metadata: META }),
    /KV PUT failed/,
    'проглоченная ошибка журнала = «принято» без единого следа: страховки нет, а посетитель уверен, что заявка ушла',
  );
});

test('значение записи — разбираемый JSON с телом заявки', async () => {
  const kv = fakeKv();
  const entry = await writeLead(kv, { payload: PAYLOAD, metadata: META });

  assert.deepEqual(JSON.parse(entry.value), PAYLOAD);
  assert.equal(kv.store.get(entry.key), entry.value);
});

test('признак доставки не пишется в тот же ключ раньше, чем через ~1,1 с', async () => {
  const kv = fakeKv();
  const clock = fakeClock('2026-08-20T11:04:07.114Z');
  const sleeper = fakeSleep(kv);

  const entry = await writeLead(kv, { payload: PAYLOAD, metadata: META }, { now: clock.now });
  clock.advance(200);

  await markDelivery(kv, entry, 'ok', { now: clock.now, sleep: sleeper.sleep });

  assert.equal(sleeper.calls.length, 1, 'интервал обязан выдерживаться явно, а не случайно');
  assert.equal(
    sleeper.calls[0]?.ms,
    DELIVERY_MARK_MIN_INTERVAL_MS - 200,
    'ждать надо ровно остаток интервала, а не фиксированную паузу',
  );
  assert.equal(
    sleeper.calls[0]?.putsBefore,
    1,
    'вторая запись обязана идти ПОСЛЕ ожидания: KV отвечает 429 на вторую запись в тот же ключ в ту же секунду',
  );
  assert.equal(kv.puts.length, 2);
  assert.equal(kv.puts[1]?.key, entry.key, 'признак доставки обновляет ту же запись');
});

test('если секунда уже прошла сама — ждать нечего', async () => {
  const kv = fakeKv();
  const clock = fakeClock('2026-08-20T11:04:07.114Z');
  const sleeper = fakeSleep(kv);

  const entry = await writeLead(kv, { payload: PAYLOAD, metadata: META }, { now: clock.now });
  clock.advance(5000);

  await markDelivery(kv, entry, 'failed', { now: clock.now, sleep: sleeper.sleep });

  assert.equal(sleeper.calls.length, 0, 'лишняя пауза в waitUntil тратит бюджет 30 с ни на что');
  assert.equal(kv.puts.length, 2);
});

test('markDelivery меняет только признак доставки: значение и остальные метаданные целы', async () => {
  for (const [outcome, expected] of [
    ['ok', true],
    ['failed', false],
  ] as const) {
    const kv = fakeKv();
    const clock = fakeClock('2026-08-20T11:04:07.114Z');
    const sleeper = fakeSleep(kv);

    const entry = await writeLead(kv, { payload: PAYLOAD, metadata: META }, { now: clock.now });
    clock.advance(2000);
    await markDelivery(kv, entry, outcome, { now: clock.now, sleep: sleeper.sleep });

    const [first, second] = kv.puts;
    assert.equal(
      second?.value,
      first?.value,
      `значение записи (${outcome}) обязано остаться байт в байт`,
    );
    assert.equal(
      second?.expirationTtl,
      LEAD_TTL_SECONDS,
      'повторная запись не имеет права укоротить срок хранения',
    );
    assert.deepEqual(
      second?.metadata,
      { ...META, delivered: expected },
      `метаданные (${outcome}): затёртый триаж означает, что разбор инцидента по list перестаёт работать`,
    );
  }
});
