
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export interface GreenRun {

  command: string[];

  env?: Record<string, string>;

  costly?: string;
}

export interface SabotageCase {

  id: string;

  gate: string;

  describe: string;

  setup(): Promise<void> | void;

  command: string[];

  expectOutputContains: string;

  greenRun: GreenRun;

  teardown(): Promise<void> | void;
}

const projectRoot = path.resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
const withCostly = argv.includes('--with-costly');
const sabotageDir = ((): string => {
  const at = argv.indexOf('--cases-dir');
  if (at === -1) return path.join(projectRoot, 'scripts', 'sabotage');
  const value = argv[at + 1];
  if (!value) throw new Error('--cases-dir без пути');
  return path.resolve(projectRoot, value);
})();

const MARK_REACHABLE = 'ПОДСТРОКА ДОСТИЖИМА НА ЗЕЛЁНОМ ПРОГОНЕ';
const MARK_NO_GREEN = 'СЛУЧАЙ БЕЗ ЗЕЛЁНОГО ПРОГОНА';

interface CaseResult {
  id: string;
  gate: string;
  describe: string;
  passed: boolean;
  verdict: string;
}

function gitSnapshot(): string {
  const res = spawnSync('git', ['status', '--porcelain'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (res.error || res.status !== 0) {
    throw new Error(
      `не удалось снять снимок рабочего дерева: ${res.error?.message ?? res.stderr ?? 'git вернул ' + res.status}`
    );
  }
  return (res.stdout ?? '').trim();
}

function validateShape(c: SabotageCase, file: string): void {
  const green = c.greenRun as GreenRun | undefined;
  const where = `${file}, случай «${c.id ?? '(без id)'}»`;
  if (green === undefined || green === null || typeof green !== 'object') {
    throw new Error(
      `${MARK_NO_GREEN} — ${where} не объявил greenRun.\n` +
        '  Подстрока expectOutputContains обязана быть НЕВОЗМОЖНОЙ на зелёном прогоне\n' +
        '  своего гейта, и стенд проверяет это сам. Объявите greenRun.command — argv\n' +
        '  того же гейта на несаботированном дереве. Дорогой эталон помечайте\n' +
        '  greenRun.costly с названной ценой.'
    );
  }
  if (!Array.isArray(green.command) || green.command.length === 0) {
    throw new Error(`${MARK_NO_GREEN} — ${where}: greenRun.command пуст или не массив.`);
  }
  if (green.command.some((a) => typeof a !== 'string')) {
    throw new Error(`${MARK_NO_GREEN} — ${where}: greenRun.command содержит не строку.`);
  }
  if (
    green.costly !== undefined &&
    (typeof green.costly !== 'string' || green.costly.trim() === '')
  ) {
    throw new Error(
      `${MARK_NO_GREEN} — ${where}: greenRun.costly объявлен пустым.\n` +
        '  Пропуск эталона допустим только с НАЗВАННОЙ ценой — она печатается в отчёте\n' +
        '  как причина, по которой случай остался непроверенным.'
    );
  }
}

async function loadCases(): Promise<SabotageCase[]> {
  const dirLabel = path.relative(projectRoot, sabotageDir).replace(/\\/g, '/');
  if (!existsSync(sabotageDir)) {
    throw new Error(`нет каталога ${dirLabel} — регистрировать нечего`);
  }
  const files = readdirSync(sabotageDir)
    .filter((f) => f.endsWith('.ts'))
    .sort();
  if (files.length === 0) {
    throw new Error(`в ${dirLabel} нет ни одного файла со случаями`);
  }

  const all: SabotageCase[] = [];
  for (const file of files) {
    const href = pathToFileURL(path.join(sabotageDir, file)).href;
    const mod = (await import(href)) as { cases?: unknown };
    if (!Array.isArray(mod.cases)) {
      throw new Error(`${dirLabel}/${file} не экспортирует массив cases`);
    }
    if (mod.cases.length === 0) {
      throw new Error(`${dirLabel}/${file} экспортирует пустой массив cases`);
    }
    for (const c of mod.cases as SabotageCase[]) validateShape(c, `${dirLabel}/${file}`);
    all.push(...(mod.cases as SabotageCase[]));
  }

  const seen = new Set<string>();
  for (const c of all) {
    if (seen.has(c.id)) throw new Error(`дубликат идентификатора случая: ${c.id}`);
    seen.add(c.id);
  }
  return all;
}

interface GreenGroup {
  label: string;
  run: GreenRun;
  cases: SabotageCase[];
}

function groupByGreenRun(cases: SabotageCase[]): GreenGroup[] {
  const groups = new Map<string, GreenGroup>();
  for (const c of cases) {
    const key = JSON.stringify([c.greenRun.command, c.greenRun.env ?? null]);
    let group = groups.get(key);
    if (!group) {
      group = { label: c.greenRun.command.join(' '), run: c.greenRun, cases: [] };
      groups.set(key, group);
    }
    group.cases.push(c);
  }
  return [...groups.values()];
}

interface GreenPhase {

  disqualified: Map<string, string>;

  skipped: GreenGroup[];
}

function runGreenPhase(cases: SabotageCase[]): GreenPhase {
  const disqualified = new Map<string, string>();
  const skipped: GreenGroup[] = [];

  console.log('--- Эталоны: подстрока обязана быть недостижима без саботажа ---\n');

  for (const group of groupByGreenRun(cases)) {
    const ids = group.cases.map((c) => c.id).join(', ');

    if (group.run.costly !== undefined && !withCostly) {
      skipped.push(group);
      console.log(`ПРОПУСК  ${group.label}`);
      console.log(`      цена: ${group.run.costly}`);
      console.log(`      НЕ СВЕРЕНЫ (${group.cases.length}): ${ids}\n`);
      continue;
    }

    const env = group.run.env ? { ...process.env, ...group.run.env } : process.env;
    const res = spawnSync(process.execPath, group.run.command, {
      cwd: projectRoot,
      encoding: 'utf8',
      env,
    });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    if (res.error) {
      for (const c of group.cases) {
        disqualified.set(c.id, `эталон не запустился: ${res.error.message}`);
      }
      console.log(`FAIL     ${group.label}`);
      console.log(`      эталон не запустился: ${res.error.message}\n`);
      continue;
    }

    if (res.status !== 0) {

      const tail = output.trim().split('\n').slice(-4).join('\n      ');
      for (const c of group.cases) {
        disqualified.set(c.id, `эталон сам упал (код ${res.status}) — правило непроверяемо`);
      }
      console.log(`FAIL     ${group.label}`);
      console.log(`      эталон сам упал (код ${res.status}):\n      ${tail}\n`);
      continue;
    }

    const hits = group.cases
      .map((c) => ({ c, n: output.split(c.expectOutputContains).length - 1 }))
      .filter((h) => h.n > 0);

    if (hits.length === 0) {
      console.log(`OK       ${group.label}`);
      console.log(`      код 0, ${output.length} Б; недостижимы (${group.cases.length}): ${ids}\n`);
      continue;
    }

    for (const { c, n } of hits) {
      disqualified.set(
        c.id,
        `${MARK_REACHABLE}: «${c.expectOutputContains}» встречается ${n} раз(а) на успешном прогоне`
      );
    }
    console.log(`FAIL     ${group.label}`);
    for (const { c, n } of hits) {
      console.log(`      ${MARK_REACHABLE} — ${c.id}`);
      console.log(`      «${c.expectOutputContains}» — ${n} раз(а) при коде возврата 0.`);
    }
    console.log(
      '      Такая подстрока не различает отказ: случай, упавший по посторонней\n' +
        '      причине, был бы зачтён как доказавший свою проверку. Заменить на текст\n' +
        '      ОТКАЗА с конкретикой — имя поля, найденное значение, номер строки.\n'
    );
  }

  return { disqualified, skipped };
}

async function runCase(c: SabotageCase): Promise<CaseResult> {
  const base = { id: c.id, gate: c.gate, describe: c.describe };
  try {
    await c.setup();
  } catch (err) {
    try {
      await c.teardown();
    } catch {
      /* */
    }
    return { ...base, passed: false, verdict: `саботаж не применился: ${(err as Error).message}` };
  }

  try {
    const res = spawnSync(process.execPath, c.command, { cwd: projectRoot, encoding: 'utf8' });
    if (res.error) {
      return { ...base, passed: false, verdict: `гейт не запустился: ${res.error.message}` };
    }
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    if (res.status === 0) {
      return { ...base, passed: false, verdict: 'ГЕЙТ НЕ УПАЛ — проверка не работает' };
    }
    if (!output.includes(c.expectOutputContains)) {
      return {
        ...base,
        passed: false,
        verdict: `упал (код ${res.status}), но БЕЗ «${c.expectOutputContains}» — падение по посторонней причине`,
      };
    }
    return { ...base, passed: true, verdict: `гейт упал как положено (код ${res.status})` };
  } finally {
    await c.teardown();
  }
}

async function main(): Promise<void> {
  let cases: SabotageCase[];
  let baselineSnapshot: string;
  try {
    baselineSnapshot = gitSnapshot();
    cases = await loadCases();
  } catch (err) {
    console.error(`FAIL: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(`--- Саботажный стенд: ${cases.length} случа(й/ев) ---\n`);

  const { disqualified, skipped } = runGreenPhase(cases);

  console.log('--- Случаи ---\n');

  const results: CaseResult[] = [];
  for (const c of cases) {

    const result = disqualified.has(c.id)
      ? {
          id: c.id,
          gate: c.gate,
          describe: c.describe,
          passed: false,
          verdict: disqualified.get(c.id) as string,
        }
      : await runCase(c);
    results.push(result);
    console.log(`${result.passed ? 'OK  ' : 'FAIL'}  ${result.id}  [${result.gate}]`);
    console.log(`      ломаем: ${result.describe}`);
    console.log(`      вердикт: ${result.verdict}\n`);
  }

  const failed = results.filter((r) => !r.passed);

  let dirty = false;
  try {
    const after = gitSnapshot();
    if (after !== baselineSnapshot) {
      dirty = true;
      console.error(
        'FAIL: стенд оставил следы в рабочем дереве — саботаж вышел за пределы временных файлов.\n' +
          `  было:\n${baselineSnapshot || '    (чисто)'}\n  стало:\n${after || '    (чисто)'}`
      );
    }
  } catch (err) {
    dirty = true;
    console.error(`FAIL: ${(err as Error).message}`);
  }

  const skippedCases = skipped.flatMap((g) => g.cases);
  console.log(
    `Эталоны: ${cases.length - skippedCases.length}/${cases.length} случа(ев) сверены с успешным прогоном своего гейта.`
  );
  if (skippedCases.length > 0) {

    console.log(
      `Не сверены (${skippedCases.length}) — дорогой эталон. Покрыть: npm run check:sabotage:full`
    );
    for (const g of skipped) {
      console.log(`  цена: ${g.run.costly}`);
      for (const c of g.cases) console.log(`      ${c.id}  [${c.gate}]`);
    }
  }
  console.log(
    `Итог: ${results.length - failed.length}/${results.length} случа(ев) доказали падение своего гейта.`
  );
  if (failed.length > 0) {
    console.error(
      `FAIL: ${failed.length} случа(й/ев) не доказан(ы): ${failed.map((f) => f.id).join(', ')}.\n` +
        '  Гейт, который не падает на своём саботаже, не проверяет ничего.'
    );
  }
  if (failed.length > 0 || dirty) process.exit(1);
  console.log('PASS: каждая зарегистрированная проверка доказана падением.');
}

await main();
