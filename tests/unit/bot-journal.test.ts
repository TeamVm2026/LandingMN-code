
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LEAD_TTL_SECONDS } from '../../src/lib/lead-contract.ts';
import { writeBotLead } from '../../workers/bot/journal.ts';

globalThis.fetch = (() => {
  throw new Error('СЕТЬ ЗАПРЕЩЕНА: журнал лидов бота обратился к fetch');
}) as typeof fetch;

const AT = Date.parse('2026-08-22T14:57:01.429Z');

interface RecordedPut {
  key: string;
  value: string;
  options?: { expirationTtl?: number; metadata?: unknown };
}

function fakeKv() {
  const puts: RecordedPut[] = [];
  const flags = { failPut: false };
  const kv = {
    async put(
      key: string,
      value: string,
      options?: { expirationTtl?: number; metadata?: unknown },
    ): Promise<void> {
      if (flags.failPut) throw new Error('KV лёг на записи');
      puts.push({ key, value, options });
    },
  };
  return { kv, puts, flags };
}

const input = {
  payload: { user: { id: 8_123_456_789, username: 'ganbaatar' }, raw: '1_fb_a_m' },
  metadata: { direction: 'affiliate', source: 'fb', lang: 'mn' },
} as const;

test('КЛЮЧ: форма bot:<ISO>:<8 hex> — время впереди, случайный хвост сзади', async () => {
  const { kv, puts } = fakeKv();
  const entry = await writeBotLead(kv, input, { now: () => AT });

  assert.equal(entry.key, puts[0]?.key, 'возвращённый ключ не тот, что записан');
  assert.match(
    entry.key,
    /^bot:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:[0-9a-f]{8}$/,
    'ключ не той формы',
  );
  assert.ok(entry.key.startsWith('bot:'), 'префикс не bot: — запись попадёт в выборку заявок с формы');
  assert.ok(!entry.key.startsWith('lead:'), 'запись бота легла под префикс заявок с формы');
  assert.ok(entry.key.includes(new Date(AT).toISOString()), 'время в ключе не то, что дали часы');
});

test('КЛЮЧ: две записи одной миллисекунды не затирают друг друга', async () => {
  const { kv } = fakeKv();
  const a = await writeBotLead(kv, input, { now: () => AT });
  const b = await writeBotLead(kv, input, { now: () => AT });
  assert.notEqual(a.key, b.key, 'случайный хвост не разводит записи одной миллисекунды');
});

test('СРОК: expirationTtl равен LEAD_TTL_SECONDS и приходит импортом, а не числом', async () => {
  const { kv, puts } = fakeKv();
  await writeBotLead(kv, input, { now: () => AT });

  assert.equal(puts[0]?.options?.expirationTtl, LEAD_TTL_SECONDS, 'срок хранения не из контракта');

  const source = readFileSync(
    fileURLToPath(new URL('../../workers/bot/journal.ts', import.meta.url)),
    'utf8',
  );
  assert.match(
    source,
    /import\s*\{[^}]*\bLEAD_TTL_SECONDS\b[^}]*\}\s*from\s*['"][^'"]*lead-contract(?:\.ts)?['"]/,
    'СРОК-НЕ-ИМПОРТИРОВАН: нет именованного импорта LEAD_TTL_SECONDS из контракта',
  );
  assert.ok(
    !/expirationTtl\s*:\s*[0-9]/.test(source),
    'СРОК-НЕ-ИМПОРТИРОВАН: expirationTtl передан числом — обещание посетителю разойдётся с кодом молча',
  );
});

test('МЕТА: направление, источник, локаль, delivered false и kind bot', async () => {
  const { kv, puts } = fakeKv();
  const entry = await writeBotLead(kv, input, { now: () => AT });

  assert.deepEqual(
    puts[0]?.options?.metadata,
    { direction: 'affiliate', source: 'fb', lang: 'mn', delivered: false, kind: 'bot' },
    'метаданные триажа не те',
  );
  assert.deepEqual(entry.metadata, puts[0]?.options?.metadata, 'возвращённые метаданные разошлись с записанными');
});

test('МЕТА: признак доставки ставит журнал, а не вызывающий', async () => {
  const { kv, puts } = fakeKv();

  await writeBotLead(
    kv,
    { ...input, metadata: { ...input.metadata, delivered: true } as never },
    { now: () => AT },
  );
  const meta = puts[0]?.options?.metadata as { delivered?: unknown };
  assert.equal(meta.delivered, false, 'вызывающий подделал признак доставки');
});

test('ЗНАЧЕНИЕ: тело лида ложится в запись целиком и разбирается обратно', async () => {
  const { kv, puts } = fakeKv();
  await writeBotLead(kv, input, { now: () => AT });
  assert.deepEqual(JSON.parse(puts[0]?.value ?? 'null'), input.payload, 'тело лида не то');
});

test('ОШИБКА: сбой записи НЕ глотается', async () => {
  const { kv, flags } = fakeKv();
  flags.failPut = true;
  await assert.rejects(
    () => writeBotLead(kv, input, { now: () => AT }),
    /KV лёг на записи/,
    'ошибка записи проглочена — лид принят без единого следа',
  );
});
