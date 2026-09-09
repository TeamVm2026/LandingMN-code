
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildCapNoticeMessage, buildReportMessage } from '../../src/server/report/message.ts';

globalThis.fetch = (() => {
  throw new Error('СЕТЬ ЗАПРЕЩЕНА: решение о доставке обратилось к fetch');
}) as typeof fetch;

const defaultDir = fileURLToPath(new URL('../../src/server/report/', import.meta.url));
const reportDir = process.env.REPORT_SERVER_DIR ?? defaultDir;
const modulePath = path.join(reportDir, 'throttle.ts');

const {
  CLIENT_MAX_PER_PAGELOAD,
  DEDUP_WINDOW_MS,
  HOURLY_CAP,
  IP_MAX_PER_WINDOW,
  MESSAGE_MAX,
  REPORT_BODY_MAX_BYTES,
  decideDelivery,
  nextWindow,
  normalizeReport,
  reportKey,
} = (await import(pathToFileURL(modulePath).href)) as typeof import('../../src/server/report/throttle.ts');

type HourWindow = import('../../src/server/report/throttle.ts').HourWindow;
type SeenRecord = import('../../src/server/report/throttle.ts').SeenRecord;
type ClientReport = import('../../src/server/report/throttle.ts').ClientReport;

const T0 = 1_700_000_000_000;

function rawReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'js-error',
    message: "Cannot read properties of null (reading 'value')",
    source: 'https://landingmn.pages.dev/_astro/BaseLayout.Dx50E8Ir.js',
    line: 412,
    col: 17,
    route: '/ru/',
    locale: 'ru',
    ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
    ...overrides,
  };
}

function must(raw: Record<string, unknown>): ClientReport {
  const parsed = normalizeReport(raw);
  assert.ok(parsed !== null, 'фикстура обязана быть валидной');
  return parsed;
}

function storm(keys: readonly string[], startAt = T0, stepMs = 10) {
  const seen = new Map<string, SeenRecord>();
  let window: HourWindow | null = null;
  const kinds: string[] = [];

  keys.forEach((key, index) => {
    const now = startAt + index * stepMs;
    const decision = decideDelivery({ key, now, seen: seen.get(key) ?? null, window });
    window = nextWindow(window, now, decision);
    if (decision.kind === 'deliver') seen.set(key, { firstSeenAt: now });
    kinds.push(decision.kind);
  });

  const count = (kind: string): number => kinds.filter((k) => k === kind).length;
  return { kinds, count, window: window as HourWindow | null };
}

test('КЛЮЧ: не зависит от стека и прочих полей вне белого списка', async () => {
  const base = must(rawReport());
  const first = await reportKey(base);

  const withNoise = { ...base, stack: 'at t (/_astro/BaseLayout.NEWHASH.js:1:1)' };
  const second = await reportKey(withNoise);
  assert.equal(first, second, 'КЛЮЧ-НЕУСТОЙЧИВ: посторонние поля попали в ключ');
});

test('КЛЮЧ: не зависит от маршрута и меток атрибуции', async () => {
  const a = await reportKey(must(rawReport({ route: '/ru/?utm_source=fb&utm_campaign=1' })));
  const b = await reportKey(must(rawReport({ route: '/en/' })));
  assert.equal(a, b, 'КЛЮЧ-НЕУСТОЙЧИВ: маршрут или метки попали в ключ');
});

test('КЛЮЧ: разные сообщения дают разные ключи', async () => {
  const a = await reportKey(must(rawReport()));
  const b = await reportKey(must(rawReport({ message: 'ReferenceError: t is not defined' })));
  assert.notEqual(a, b, 'КЛЮЧ-СКЛЕЕН: разные ошибки получили один ключ');
  assert.match(a, /^[0-9a-f]{64}$/, 'ключ обязан быть шестнадцатеричным sha-256');
});

test('ВИД: js-error и promise с одинаковым текстом НЕ склеиваются', async () => {
  const a = await reportKey(must(rawReport({ kind: 'js-error' })));
  const b = await reportKey(must(rawReport({ kind: 'promise' })));
  assert.notEqual(a, b, 'ВИД-СКЛЕЕН: исключение и промис получили один ключ');
});

test('ДЕДУПЛИКАЦИЯ: сто одинаковых отчётов подряд дают РОВНО одну доставку', () => {
  const keys = Array.from({ length: 100 }, () => 'k-one');
  const run = storm(keys);
  const delivered = run.count('deliver');
  const duplicates = run.count('duplicate');

  console.log(
    `ЗАМЕР ДЕДУПЛИКАЦИИ: отчётов ${String(keys.length)}, доставок ${String(delivered)}, ` +
      `признано дубликатами ${String(duplicates)}`,
  );

  assert.equal(
    delivered,
    1,
    `ДЕДУПЛИКАЦИЯ-ВЫКЛЮЧЕНА: сто одинаковых отчётов дали ${String(delivered)} доставок вместо одной`,
  );
  assert.equal(duplicates, 99, 'ДЕДУПЛИКАЦИЯ-ВЫКЛЮЧЕНА: не все повторы признаны дубликатами');
});

test('ДЕДУПЛИКАЦИЯ: повтор ПОСЛЕ истечения окна доставляется снова', () => {
  const seen: SeenRecord = { firstSeenAt: T0 };

  const inside = decideDelivery({
    key: 'k',
    now: T0 + DEDUP_WINDOW_MS - 1,
    seen,
    window: { start: T0, delivered: 1, noticed: false },
  });
  assert.equal(
    inside.kind,
    'duplicate',
    'ДЕДУПЛИКАЦИЯ-ВЫКЛЮЧЕНА: повтор ВНУТРИ окна не признан дубликатом',
  );

  const outside = decideDelivery({
    key: 'k',
    now: T0 + DEDUP_WINDOW_MS,
    seen,
    window: { start: T0, delivered: 1, noticed: false },
  });
  assert.equal(outside.kind, 'deliver', 'ОКНО-НЕ-ИСТЕКАЕТ: поломка не вернётся в чат никогда');
});

test('ДЕДУПЛИКАЦИЯ: дубликаты НЕ съедают часовой потолок', () => {

  const distinct = HOURLY_CAP - 1;
  const keys = [
    ...Array.from({ length: 90 }, () => 'noisy'),
    ...Array.from({ length: distinct }, (_, i) => `other-${String(i)}`),
  ];
  const run = storm(keys);

  assert.equal(
    run.count('deliver'),
    HOURLY_CAP,
    `ДЕДУПЛИКАЦИЯ-ВЫКЛЮЧЕНА: доставок ${String(run.count('deliver'))} вместо ${String(HOURLY_CAP)} ` +
      '(1 шумная + остальные разные)',
  );
  assert.equal(
    run.count('cap-notice'),
    0,
    'ДЕДУПЛИКАЦИЯ-ВЫКЛЮЧЕНА: потолок сработал на повторах, а не на разных ошибках',
  );
});

test('ПОТОЛОК: шторм из ста РАЗНЫХ ошибок обрывается на потолке', () => {
  const keys = Array.from({ length: 100 }, (_, i) => `k-${String(i)}`);
  const run = storm(keys);
  const delivered = run.count('deliver');
  const notices = run.count('cap-notice');
  const silenced = run.count('capped');

  console.log(
    `ЗАМЕР ПОТОЛОКА: разных ошибок ${String(keys.length)}, доставлено ${String(delivered)} ` +
      `при потолке ${String(HOURLY_CAP)}, уведомлений о потолке ${String(notices)}, ` +
      `промолчано ${String(silenced)}; всего сообщений в техчат ${String(delivered + notices)}`,
  );

  assert.equal(
    delivered,
    HOURLY_CAP,
    `ПОТОЛОК-НЕ-СРАБОТАЛ: доставлено ${String(delivered)} при потолке ${String(HOURLY_CAP)}`,
  );
  assert.equal(
    notices,
    1,
    `ПОТОЛОК-МОЛЧИТ: уведомлений о потолке ${String(notices)}, а обязано быть ровно одно`,
  );
  assert.equal(silenced, 100 - HOURLY_CAP - 1, 'остаток шторма обязан быть проглочен молча');
  assert.equal(
    delivered + notices,
    HOURLY_CAP + 1,
    `ПОТОЛОК-НЕ-СРАБОТАЛ: в техчат ушло бы ${String(delivered + notices)} сообщений`,
  );
});

test('ПОТОЛОК: уведомление уходит РОВНО один раз, даже если шторм не кончается', () => {
  const keys = Array.from({ length: 500 }, (_, i) => `k-${String(i)}`);
  const run = storm(keys, T0, 1);
  assert.equal(
    run.count('cap-notice'),
    1,
    `ПОТОЛОК-МОЛЧИТ: уведомлений ${String(run.count('cap-notice'))} на пятистах ошибках`,
  );
  assert.equal(run.window?.noticed, true, 'признак «уведомление ушло» обязан сохраниться в окне');
});

test('ПОТОЛОК: после истечения часа счётчик обнуляется', () => {
  const full: HourWindow = { start: T0, delivered: HOURLY_CAP, noticed: true };

  const inside = decideDelivery({ key: 'fresh', now: T0 + DEDUP_WINDOW_MS - 1, seen: null, window: full });
  assert.equal(inside.kind, 'capped', 'ПОТОЛОК-НЕ-СРАБОТАЛ: внутри окна доставка прошла сверх потолка');

  const after = decideDelivery({ key: 'fresh', now: T0 + DEDUP_WINDOW_MS, seen: null, window: full });
  assert.equal(after.kind, 'deliver', 'ОКНО-НЕ-ИСТЕКАЕТ: мониторинг замолчал бы навсегда');

  const reset = nextWindow(full, T0 + DEDUP_WINDOW_MS, after);
  assert.deepEqual(
    reset,
    { start: T0 + DEDUP_WINDOW_MS, delivered: 1, noticed: false },
    'новое окно обязано начаться с чистого счёта',
  );
});

test('ПОТОЛОК: уведомление не занимает места в самом потолке', () => {
  const full: HourWindow = { start: T0, delivered: HOURLY_CAP, noticed: false };
  const decision = decideDelivery({ key: 'x', now: T0 + 5, seen: null, window: full });
  assert.equal(decision.kind, 'cap-notice');
  const after = nextWindow(full, T0 + 5, decision);
  assert.equal(after?.delivered, HOURLY_CAP, 'счётчик доставок не двигается уведомлением');
  assert.equal(after?.noticed, true);
  if (decision.kind === 'cap-notice') {
    assert.equal(decision.until, T0 + DEDUP_WINDOW_MS, 'момент «молчу до» — конец ТЕКУЩЕГО окна');
  }
});

test('УСЕЧЕНИЕ: огромное сообщение режется до объявленной длины, пустое отвергается', () => {
  const huge = normalizeReport(rawReport({ message: 'ы'.repeat(5000) }));
  assert.ok(huge !== null, 'длинное сообщение — не повод потерять отчёт целиком');
  assert.equal(huge.message.length, MESSAGE_MAX, 'сообщение обязано быть усечено до MESSAGE_MAX');

  assert.equal(normalizeReport(rawReport({ message: '' })), null, 'пустое сообщение — не отчёт');
  assert.equal(normalizeReport(rawReport({ message: '   ' })), null, 'пробелы — не сообщение');
  assert.equal(normalizeReport(rawReport({ message: 42 })), null, 'не строка — не сообщение');
});

test('УСЕЧЕНИЕ: неизвестный вид, не-объект и массив отвергаются целиком', () => {
  assert.equal(normalizeReport(rawReport({ kind: 'csp' })), null, 'неизвестный вид не проходит');
  assert.equal(normalizeReport('строка'), null);
  assert.equal(normalizeReport(null), null);
  assert.equal(normalizeReport([rawReport()]), null, 'массив — не отчёт');
});

test('УСЕЧЕНИЕ: мусорные номера строк обнуляются, а не уезжают в чат', () => {
  const parsed = must(rawReport({ line: -5, col: Number.NaN }));
  assert.equal(parsed.line, null);
  assert.equal(parsed.col, null);
});

test('СООБЩЕНИЕ: HTML-спецсимволы из недоверенного тела экранированы', () => {
  const report = must(rawReport({ message: '<b>bold</b> & <script>alert(1)</script>' }));
  const text = buildReportMessage({ report, key: 'a'.repeat(64), at: new Date(T0), host: 'x.test' });

  assert.ok(!text.includes('<script>'), 'ЭКРАНИРОВАНИЕ-ПРОПУЩЕНО: тег из тела уехал разметкой');
  assert.ok(text.includes('&lt;script&gt;'), 'спецсимволы обязаны быть заменены сущностями');
  assert.ok(text.includes('&amp;'), 'амперсанд обязан быть заменён');
  assert.ok(text.includes('<b>Сообщение:</b>'), 'разметку добавляют только литералы файла');
  assert.ok(text.includes('aaaaaaaaaaaa'), 'ключ печатается усечённым — по нему сверяют повторы');
});

test('СООБЩЕНИЕ: уведомление о потолке называет потолок и момент возврата', () => {
  const text = buildCapNoticeMessage({
    cap: HOURLY_CAP,
    until: T0 + DEDUP_WINDOW_MS,
    at: new Date(T0),
    host: 'landingmn.pages.dev',
  });
  assert.ok(text.includes(String(HOURLY_CAP)), 'потолок обязан быть назван числом');
  assert.ok(text.includes('Молчу до'), 'момент возврата обязан быть назван');
});

test('ПОРОГИ: объявлены одним местом и осмысленны', () => {
  assert.equal(DEDUP_WINDOW_MS, 3_600_000, 'окно дедупликации — час');
  assert.ok(HOURLY_CAP > 0 && HOURLY_CAP <= 50, 'потолок обязан быть читаемым человеком');
  assert.ok(
    CLIENT_MAX_PER_PAGELOAD < IP_MAX_PER_WINDOW,
    'честный клиент обязан помещаться в лимит по адресу, иначе он блокирует сам себя',
  );
  assert.equal(REPORT_BODY_MAX_BYTES, 4096, 'потолок тела — 4 КБ');
});
