
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  COUNTER_HOURLY_WRITE_CAP,
  COUNTER_TTL_SECONDS,
  bumpCounter,
  counterKey,
  hourBucket,
  readAttempts,
} from '../../src/server/report/counters.ts';
import type { CounterKv } from '../../src/server/report/counters.ts';

globalThis.fetch = (() => {
  throw new Error('СЕТЬ ЗАПРЕЩЕНА: решение о доставке обратилось к fetch');
}) as typeof fetch;

const defaultDir = fileURLToPath(new URL('../../workers/bot/', import.meta.url));
const moduleDir = process.env.MONITOR_MODULE_DIR ?? defaultDir;
const modulePath = path.join(moduleDir, 'monitor.ts');

const {
  EMPTY_NO_LEADS_STATE,
  NO_LEADS_MIN_ATTEMPTS,
  NO_LEADS_WINDOW_HOURS,
  buildNoLeadsAlert,
  decideNoLeadsAlert,
  nextNoLeadsState,
} = (await import(pathToFileURL(modulePath).href)) as typeof import('../../workers/bot/monitor.ts');

type NoLeadsState = import('../../workers/bot/monitor.ts').NoLeadsState;
type AlertDecision = import('../../workers/bot/monitor.ts').AlertDecision;

const T0 = Date.UTC(2026, 7, 26, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

function decide(attempts: number, leads: number, prevState = EMPTY_NO_LEADS_STATE): AlertDecision {
  return decideNoLeadsAlert({
    attempts,
    leads,
    windowHours: NO_LEADS_WINDOW_HOURS,
    prevState,
    now: T0,
  });
}

function advance(attempts: number, leads: number, prevState = EMPTY_NO_LEADS_STATE): NoLeadsState {
  return nextNoLeadsState({
    attempts,
    leads,
    windowHours: NO_LEADS_WINDOW_HOURS,
    prevState,
    now: T0,
  });
}

function fakeKv(): CounterKv & { store: Map<string, string>; writes: number } {
  const store = new Map<string, string>();
  const kv = {
    store,
    writes: 0,
    get(key: string, _type: 'json'): Promise<unknown> {
      const raw = store.get(key);
      return Promise.resolve(raw === undefined ? null : (JSON.parse(raw) as unknown));
    },
    put(key: string, value: string, _options?: { expirationTtl?: number }): Promise<void> {
      kv.writes++;
      store.set(key, value);
      return Promise.resolve();
    },
  };
  return kv;
}

test('ТИШИНА: ноль попыток и ноль лидов — молчание. Это отсутствие рекламы, а не поломка', () => {
  assert.equal(
    decide(0, 0),
    'silent',
    'ТИШИНА-ЛОЖНАЯ-ТРЕВОГА: ноль лидов при нуле попыток обязан молчать. Замер живой выборки KV:\n' +
      '8 конверсий за 50 ч 55 мин, максимальный промежуток 24 ч 04 мин при исправном сайте.\n' +
      'Календарное правило краснело бы на этой истории десятки раз подряд.',
  );
});

test('ТИШИНА: одна попытка без лида — молчание. Это опечатка в телефоне, а не авария', () => {
  assert.equal(
    decide(1, 0),
    'silent',
    `ТИШИНА-ЛОЖНАЯ-ТРЕВОГА: одна попытка без лида обязана молчать (пол ${String(NO_LEADS_MIN_ATTEMPTS)}).\n` +
      'Попытка засчитывается ДО валидации и Turnstile, поэтому один человек, ошибшийся в поле,\n' +
      'даёт ровно эту картину при полностью исправном сайте.',
  );
});

test('ТИШИНА: попытки есть и лиды есть — молчание', () => {
  assert.equal(decide(7, 3), 'silent', 'ТИШИНА-ЛОЖНАЯ-ТРЕВОГА: лиды доходят, тревожить не о чем');
});

test('ТИШИНА: лиды без попыток (счётчик потерян) — молчание, а не тревога', () => {

  assert.equal(decide(0, 2), 'silent', 'ТИШИНА-ЛОЖНАЯ-ТРЕВОГА: лиды есть — тревожиться не о чем');
});

test('ТРЕВОГА: попыток не меньше порога и ноль лидов — ровно одно сообщение', () => {
  assert.equal(
    decide(NO_LEADS_MIN_ATTEMPTS, 0),
    'alert',
    `ТРЕВОГА-МОЛЧИТ: ${String(NO_LEADS_MIN_ATTEMPTS)} попыт(ки) без единого лида обязаны дать сообщение`,
  );
  const state = advance(NO_LEADS_MIN_ATTEMPTS, 0);
  assert.equal(state.alerted, true, 'ТРЕВОГА-МОЛЧИТ: признак «уже объявлено» не выставлен');
  assert.equal(state.since, T0, 'ТРЕВОГА-МОЛЧИТ: время начала не записано');
});

test('ТРЕВОГА: пол достижим на измеренном темпе — две конверсии в одном окне в истории есть', () => {

  const observedPairsWithinWindow = [
    [Date.UTC(2026, 7, 20, 23, 38, 58), Date.UTC(2026, 7, 20, 23, 46, 17)],
    [Date.UTC(2026, 7, 22, 17, 51, 33), Date.UTC(2026, 7, 22, 17, 52, 40)],
  ];
  const windowMs = NO_LEADS_WINDOW_HOURS * HOUR;
  for (const [a, b] of observedPairsWithinWindow) {
    assert.ok(
      b - a < windowMs,
      `ПОРОГ-НЕДОСТИЖИМ: пара конверсий с расстоянием ${String(b - a)} мс не влезает в окно ` +
        `${String(windowMs)} мс — значит пол ${String(NO_LEADS_MIN_ATTEMPTS)} глушил бы алерт навсегда`,
    );
  }
  console.log(
    `      [замер] окно ${String(NO_LEADS_WINDOW_HOURS)} ч, пол ${String(NO_LEADS_MIN_ATTEMPTS)} попыт.; ` +
      `наблюдённые пары в одном окне: ${String(observedPairsWithinWindow.length)}`,
  );
});

test('ПОВТОР: при уже объявленной тревоге следующее окно молчит', () => {
  const alerted: NoLeadsState = { alerted: true, since: T0 - HOUR };
  assert.equal(
    decide(9, 0, alerted),
    'silent',
    'ШТОРМ-АЛЕРТОВ: объявленная тревога обязана стоить одного сообщения, а не одного в час',
  );
});

test('ПОВТОР: сутки окон при объявленной тревоге дают ровно одно сообщение', () => {
  let state = EMPTY_NO_LEADS_STATE;
  let alerts = 0;
  for (let i = 0; i < 24; i++) {
    if (decide(4, 0, state) === 'alert') alerts++;
    state = advance(4, 0, state);
  }
  console.log(`      [замер] окон 24 подряд без лидов -> решений alert ${String(alerts)}`);
  assert.equal(alerts, 1, `ШТОРМ-АЛЕРТОВ: получено ${String(alerts)} сообщени(й) вместо одного`);
});

test('ПОВТОР: признак снимает ТОЛЬКО доехавший лид, а не исчезновение попыток', () => {
  const alerted: NoLeadsState = { alerted: true, since: T0 - HOUR };
  assert.equal(
    decide(0, 0, alerted),
    'silent',
    'ТРЕВОГА-МОЛЧИТ: отсутствие попыток — не доказательство починки',
  );
  assert.deepEqual(
    advance(0, 0, alerted),
    alerted,
    'ТРЕВОГА-МОЛЧИТ: ночная тишина не имеет права «чинить» аварию сама — иначе утром та же авария\n' +
      'объявится как новая, и так каждые сутки',
  );
  assert.equal(decide(3, 1, alerted), 'recovered', 'ВОЗВРАТ-МОЛЧИТ: доехавший лид обязан дать «recovered»');
  assert.deepEqual(
    advance(3, 1, alerted),
    EMPTY_NO_LEADS_STATE,
    'ВОЗВРАТ-МОЛЧИТ: после восстановления состояние обязано обнулиться',
  );
});

test('ТЕКСТ: сообщение несёт ИЗМЕРЕННЫЕ числа и вслух говорит, что «попытки» — не просмотры', () => {
  const text = buildNoLeadsAlert({
    kind: 'alert',
    attempts: 5,
    leads: 0,
    windowHours: NO_LEADS_WINDOW_HOURS,
    formAttempts: 3,
    startAttempts: 2,
    now: T0,
  });
  for (const needle of ['5', 'форма 3', '/start 2', `${String(NO_LEADS_WINDOW_HOURS)} ч`, 'НЕ просмотры страниц']) {
    assert.ok(text.includes(needle), `ТЕКСТ-БЕЗ-ЧИСЕЛ: в сообщении нет «${needle}»:\n${text}`);
  }
});

test('СЧЁТЧИК: ведро часовое, ключ выводится из времени', () => {
  assert.equal(hourBucket(T0), '2026-08-26T12');
  assert.equal(counterKey('attempt', T0), 'mon:attempt:2026-08-26T12');
  assert.equal(counterKey('start', T0), 'mon:start:2026-08-26T12');
  assert.ok(COUNTER_TTL_SECONDS >= NO_LEADS_WINDOW_HOURS * 3600, 'ведро обязано дожить до чтения кроном');
  assert.ok(COUNTER_TTL_SECONDS >= 60, 'KV отвергает expirationTtl меньше минуты');
});

test('СЧЁТЧИК: инкремент копится в одном ведре и читается окном', async () => {
  const kv = fakeKv();
  await bumpCounter(kv, 'attempt', T0);
  await bumpCounter(kv, 'attempt', T0);
  await bumpCounter(kv, 'start', T0 - HOUR);

  const window = await readAttempts(kv, T0, NO_LEADS_WINDOW_HOURS);
  console.log(
    `      [замер] окно ${String(NO_LEADS_WINDOW_HOURS)} ч: форма ${String(window.form)}, ` +
      `/start ${String(window.start)}, всего ${String(window.total)}, вёдер ${String(window.buckets.length)}`,
  );
  assert.equal(window.form, 2);
  assert.equal(window.start, 1);
  assert.equal(window.total, 3);
  assert.equal(window.buckets.length, NO_LEADS_WINDOW_HOURS);
});

test('СЧЁТЧИК: ведро вне окна в счёт не идёт', async () => {
  const kv = fakeKv();
  await bumpCounter(kv, 'attempt', T0 - (NO_LEADS_WINDOW_HOURS + 1) * HOUR);
  const window = await readAttempts(kv, T0, NO_LEADS_WINDOW_HOURS);
  assert.equal(window.total, 0, 'окно обязано быть окном, а не всей историей');
});

test('ПОТОЛОК: записи в одно ведро упираются в потолок — общий бюджет KV защищён', async () => {
  const kv = fakeKv();
  for (let i = 0; i < COUNTER_HOURLY_WRITE_CAP * 5; i++) await bumpCounter(kv, 'attempt', T0);
  console.log(
    `      [замер] попыток ${String(COUNTER_HOURLY_WRITE_CAP * 5)} -> записей в KV ${String(kv.writes)} ` +
      `при потолке ${String(COUNTER_HOURLY_WRITE_CAP)}`,
  );
  assert.equal(
    kv.writes,
    COUNTER_HOURLY_WRITE_CAP,
    `ПОТОЛОК-НЕ-СРАБОТАЛ: сделано ${String(kv.writes)} записей при потолке ${String(COUNTER_HOURLY_WRITE_CAP)}.\n` +
      'Суточный бюджет KV свободного плана ОБЩИЙ с журналом лидов: залп через счётчик выел бы его,\n' +
      'и заявки перестали бы попадать в журнал — наблюдаемость съела бы страховку от потери лида.',
  );
  const last = await bumpCounter(kv, 'attempt', T0);
  assert.equal(last.capped, true, 'ПОТОЛОК-НЕ-СРАБОТАЛ: упор в потолок обязан быть виден вызывающему');
  const window = await readAttempts(kv, T0, NO_LEADS_WINDOW_HOURS);
  assert.equal(window.capped, true, 'ПОТОЛОК-НЕ-СРАБОТАЛ: признак усечения обязан доехать до сообщения');
  assert.ok(
    window.total >= NO_LEADS_MIN_ATTEMPTS,
    'ПОТОЛОК-НЕ-СРАБОТАЛ: усечение не имеет права опустить счёт ниже порога тревоги',
  );
});

test('СЧЁТЧИК: отказ хранилища НЕ роняет вызывающего — лид важнее статистики', async () => {
  const broken: CounterKv = {
    get: () => Promise.reject(new Error('KV лежит')),
    put: () => Promise.reject(new Error('KV лежит')),
  };
  const result = await bumpCounter(broken, 'attempt', T0);
  assert.deepEqual(
    result,
    { written: false, capped: false, count: 0 },
    'СЧЁТЧИК-РОНЯЕТ-ЛИД: отказ KV обязан деградировать до нуля, а не бросать',
  );

  const window = await readAttempts(broken, T0, NO_LEADS_WINDOW_HOURS);
  assert.equal(
    window.total,
    0,
    'СЧЁТЧИК-РОНЯЕТ-ЛИД: отказ чтения обязан деградировать до нуля — иначе отказ KV выключил бы ОБА алерта',
  );
});

test('СЧЁТЧИК: мусор в ведре равен нулю, а не исключению', async () => {
  const kv = fakeKv();
  kv.store.set(counterKey('attempt', T0), '"не число"');
  const result = await bumpCounter(kv, 'attempt', T0);
  assert.equal(result.count, 1, 'мусор обязан читаться как ноль, и счёт начинаться заново');
});
