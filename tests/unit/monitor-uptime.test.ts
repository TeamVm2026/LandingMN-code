
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.fetch = (() => {
  throw new Error('СЕТЬ ЗАПРЕЩЕНА: решение о доставке обратилось к fetch');
}) as typeof fetch;

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const defaultDir = fileURLToPath(new URL('../../workers/bot/', import.meta.url));
const moduleDir = process.env.MONITOR_MODULE_DIR ?? defaultDir;
const modulePath = path.join(moduleDir, 'monitor.ts');

const {
  EMPTY_UPTIME_STATE,
  UPTIME_ATTEMPTS_PER_CYCLE,
  UPTIME_CONSECUTIVE_FAILURES,
  buildUptimeAlert,
  cycleFailed,
  decideUptimeAlert,
  nextUptimeState,
  probeOutcome,
} = (await import(pathToFileURL(modulePath).href)) as typeof import('../../workers/bot/monitor.ts');

type ProbeResult = import('../../workers/bot/monitor.ts').ProbeResult;
type UptimeState = import('../../workers/bot/monitor.ts').UptimeState;
type AlertDecision = import('../../workers/bot/monitor.ts').AlertDecision;

const T0 = Date.UTC(2026, 7, 26, 12, 0, 0);

function okProbe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    label: 'корень сайта',
    url: 'https://landingmn.pages.dev/',
    expected: 200,
    status: 200,
    attempts: 1,
    ms: 120,
    error: '',
    at: T0,
    ...overrides,
  };
}

function downProbe(status = 500): ProbeResult {
  return okProbe({ status, attempts: UPTIME_ATTEMPTS_PER_CYCLE, ms: 300 });
}

function unreachableProbe(): ProbeResult {
  return okProbe({
    status: null,
    attempts: UPTIME_ATTEMPTS_PER_CYCLE,
    ms: 5000,
    error: 'TimeoutError: signal timed out',
  });
}

function runCycles(cycles: readonly (readonly ProbeResult[])[]): {
  decisions: AlertDecision[];
  finalState: UptimeState;
} {
  let state: UptimeState = EMPTY_UPTIME_STATE;
  const decisions: AlertDecision[] = [];
  cycles.forEach((probes, i) => {
    const now = T0 + i * 5 * 60 * 1000;
    decisions.push(decideUptimeAlert({ probes, prevState: state, now }));
    state = nextUptimeState({ probes, prevState: state, now });
  });
  return { decisions, finalState: state };
}

test('ГЛУБИНА: модуль загружен с глубины 2 от корня — относительные импорты живы', () => {
  const depth = path
    .relative(projectRoot, moduleDir)
    .split(/[\\/]/)
    .filter((part) => part !== '').length;
  assert.equal(
    depth,
    2,
    `ГЛУБИНА-КОПИИ-НЕ-ТА: модуль взят из «${path.relative(projectRoot, moduleDir)}» (глубина ${String(depth)}).\n` +
      'monitor.ts импортирует ../../src/server/lead/message.ts — на другой глубине этот путь\n' +
      'уходит мимо дерева, и саботажный случай упал бы по отсутствующему модулю, а не по своей\n' +
      'подстановке. См. шапку сюиты.',
  );
});

test('МИГАНИЕ: одна осечка среди исправных циклов не порождает НИ ОДНОГО сообщения', () => {

  const cycles: ProbeResult[][] = [];
  for (let i = 0; i < 10; i++) {
    cycles.push(i % 2 === 1 ? [unreachableProbe()] : [okProbe()]);
  }
  const { decisions } = runCycles(cycles);
  const alerts = decisions.filter((d) => d === 'alert').length;
  const recovered = decisions.filter((d) => d === 'recovered').length;

  console.log(
    `      [замер] мигание: циклов ${String(cycles.length)}, одиночных осечек 5, ` +
      `решений alert ${String(alerts)}, recovered ${String(recovered)}`,
  );

  assert.equal(
    alerts,
    0,
    `МИГАНИЕ-ПОРОЖДАЕТ-СООБЩЕНИЯ: одиночные осечки дали ${String(alerts)} сообщени(й).\n` +
      'Монитор, кричащий на всхлип сети, за неделю приучает не читать техчат — и следующая\n' +
      'настоящая авария проходит незамеченной. Порог подряд идущих неудач обязан быть >= 2.',
  );
  assert.equal(
    recovered,
    0,
    `МИГАНИЕ-ПОРОЖДАЕТ-СООБЩЕНИЯ: одиночные осечки дали ${String(recovered)} сообщени(й) ` +
      'о восстановлении. Восстанавливаться не из чего: отказ не объявлялся.',
  );
});

test('МИГАНИЕ: одна осечка не сбрасывает счётчик исправных циклов в объявленный отказ', () => {
  const { decisions } = runCycles([[okProbe()], [unreachableProbe()], [okProbe()]]);
  assert.deepEqual(
    decisions,
    ['silent', 'silent', 'silent'],
    `МИГАНИЕ-ПОРОЖДАЕТ-СООБЩЕНИЯ: ожидалось молчание на всех трёх циклах, получено ${JSON.stringify(decisions)}`,
  );
});

test('ПОРОГ: две неудачи подряд дают РОВНО ОДНО сообщение, третья и дальше молчат', () => {
  const cycles = [[downProbe()], [downProbe()], [downProbe()], [downProbe()], [downProbe()]];
  const { decisions, finalState } = runCycles(cycles);
  const alerts = decisions.filter((d) => d === 'alert').length;

  console.log(
    `      [замер] отказ подряд: циклов ${String(cycles.length)}, решений alert ${String(alerts)}, ` +
      `неудачных циклов в состоянии ${String(finalState.fails)}, порог ${String(UPTIME_CONSECUTIVE_FAILURES)}`,
  );

  assert.equal(
    decisions[0],
    'silent',
    'ПОРОГ-НЕ-СРАБОТАЛ: первый неудачный цикл обязан молчать — он неотличим от осечки сети',
  );
  assert.equal(
    decisions[1],
    'alert',
    `ПОРОГ-НЕ-СРАБОТАЛ: второй неудачный цикл подряд обязан дать сообщение, получено «${String(decisions[1])}»`,
  );
  assert.equal(
    alerts,
    1,
    `ШТОРМ-АЛЕРТОВ: пять неудачных циклов дали ${String(alerts)} сообщени(й) вместо одного. ` +
      'Длительный отказ обязан стоить ОДНОГО сообщения на переход, а не одного на цикл.',
  );
  assert.equal(finalState.fails, 5, 'ПОРОГ-НЕ-СРАБОТАЛ: счётчик неудачных циклов не растёт');
  assert.equal(finalState.since, T0, 'ПОРОГ-НЕ-СРАБОТАЛ: время начала отказа обязано быть временем ПЕРВОЙ неудачи');
});

test('ПОРОГ: сто неудачных циклов подряд — по-прежнему одно сообщение', () => {
  const cycles = Array.from({ length: 100 }, () => [unreachableProbe()]);
  const { decisions } = runCycles(cycles);
  const alerts = decisions.filter((d) => d === 'alert').length;
  console.log(`      [замер] шторм: циклов 100, решений alert ${String(alerts)}`);
  assert.equal(
    alerts,
    1,
    `ШТОРМ-АЛЕРТОВ: сто неудачных циклов дали ${String(alerts)} сообщени(й) вместо одного`,
  );
});

test('ВОЗВРАТ: после объявленного отказа исправный цикл даёт РОВНО ОДНО «recovered»', () => {
  const cycles = [
    [downProbe()],
    [downProbe()],
    [downProbe()],
    [okProbe()],
    [okProbe()],
    [okProbe()],
  ];
  const { decisions, finalState } = runCycles(cycles);
  const recovered = decisions.filter((d) => d === 'recovered').length;

  console.log(
    `      [замер] возврат: решения ${decisions.join(', ')}; recovered ${String(recovered)}`,
  );

  assert.equal(
    recovered,
    1,
    `ВОЗВРАТ-МОЛЧИТ: ожидалось ровно одно сообщение о восстановлении, получено ${String(recovered)}`,
  );
  assert.equal(decisions[3], 'recovered', 'ВОЗВРАТ-МОЛЧИТ: сообщение обязано прийти на ПЕРВОМ исправном цикле');
  assert.deepEqual(
    finalState,
    EMPTY_UPTIME_STATE,
    'ВОЗВРАТ-МОЛЧИТ: после восстановления состояние обязано обнулиться, иначе следующий отказ не объявится',
  );
});

test('ВОЗВРАТ: исправный цикл без объявленного отказа молчит — объявлять было нечего', () => {
  const { decisions } = runCycles([[unreachableProbe()], [okProbe()]]);
  assert.deepEqual(decisions, ['silent', 'silent'], `ВОЗВРАТ-МОЛЧИТ: получено ${JSON.stringify(decisions)}`);
});

test('РАЗЛИЧЕНИЕ: обрыв (ответа нет) и отказ (код не тот) — РАЗНЫЕ исходы и РАЗНЫЙ текст', () => {
  assert.equal(
    probeOutcome(unreachableProbe()),
    'unreachable',
    'ОБРЫВ-НЕ-ОТЛИЧЁН-ОТ-ОТКАЗА: отсутствие ответа обязано быть «unreachable», а не «down»',
  );
  assert.equal(
    probeOutcome(downProbe(500)),
    'down',
    'ОБРЫВ-НЕ-ОТЛИЧЁН-ОТ-ОТКАЗА: чужой код обязан быть «down»',
  );
  assert.equal(probeOutcome(okProbe()), 'ok');

  const state: UptimeState = { fails: 2, alerted: true, since: T0 };
  const downText = buildUptimeAlert({
    kind: 'alert',
    probes: [downProbe(503)],
    state,
    target: 'https://landingmn.pages.dev',
    now: T0,
  });
  const dropText = buildUptimeAlert({
    kind: 'alert',
    probes: [unreachableProbe()],
    state,
    target: 'https://landingmn.pages.dev',
    now: T0,
  });

  assert.notEqual(
    downText,
    dropText,
    'ОБРЫВ-НЕ-ОТЛИЧЁН-ОТ-ОТКАЗА: тексты совпали — человек в три ночи не поймёт, чинить сайт или сеть',
  );
  assert.ok(
    downText.includes('ОТКАЗ') && downText.includes('503'),
    `ОБРЫВ-НЕ-ОТЛИЧЁН-ОТ-ОТКАЗА: в тексте отказа нет ни слова «ОТКАЗ», ни измеренного кода:\n${downText}`,
  );
  assert.ok(
    dropText.includes('ОБРЫВ') && dropText.includes('signal timed out'),
    `ОБРЫВ-НЕ-ОТЛИЧЁН-ОТ-ОТКАЗА: в тексте обрыва нет ни слова «ОБРЫВ», ни причины:\n${dropText}`,
  );
  assert.ok(
    dropText.includes('сеть между наблюдателем и сайтом'),
    'ОБРЫВ-НЕ-ОТЛИЧЁН-ОТ-ОТКАЗА: текст обрыва обязан вслух назвать сеть как подозреваемого №1',
  );
  console.log(
    `      [замер] длина текста отказа ${String(downText.length)} симв., текста обрыва ${String(dropText.length)} симв.`,
  );
});

test('РАЗЛИЧЕНИЕ: цикл неудачен, если провалилась ХОТЯ БЫ ОДНА проба из трёх', () => {
  assert.equal(cycleFailed([okProbe(), okProbe(), okProbe()]), false);
  assert.equal(cycleFailed([okProbe(), downProbe(), okProbe()]), true);
  assert.equal(
    cycleFailed([]),
    false,
    'ПОРОГ-НЕ-СРАБОТАЛ: пустой список проб — это «замерить не удалось», а не «сайт лежит». ' +
      'Считать его отказом значило бы кричать на собственную ошибку конфигурации.',
  );
});

test('ТЕКСТ: сообщение несёт ИЗМЕРЕННЫЕ числа — адрес, код, попытки, число неудачных циклов', () => {
  const text = buildUptimeAlert({
    kind: 'alert',
    probes: [downProbe(502), unreachableProbe()],
    state: { fails: 2, alerted: true, since: T0 - 300000 },
    target: 'https://landingmn.pages.dev',
    now: T0,
  });
  for (const needle of ['502', 'landingmn.pages.dev', 'попыток: 2', 'Неудачных циклов подряд']) {
    assert.ok(text.includes(needle), `ТЕКСТ-БЕЗ-ЧИСЕЛ: в сообщении нет «${needle}»:\n${text}`);
  }
  const recoveredText = buildUptimeAlert({
    kind: 'recovered',
    probes: [okProbe()],
    state: { fails: 3, alerted: true, since: T0 - 15 * 60 * 1000 },
    target: 'https://landingmn.pages.dev',
    now: T0,
  });
  assert.ok(
    recoveredText.includes('15 мин'),
    `ТЕКСТ-БЕЗ-ЧИСЕЛ: сообщение о восстановлении обязано назвать длительность отказа:\n${recoveredText}`,
  );
});
