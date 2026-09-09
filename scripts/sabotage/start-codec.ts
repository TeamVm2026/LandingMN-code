
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-start-codec.ts'],
};

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const codecPath = path.join(projectRoot, 'src', 'lib', 'start-codec.ts');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');

function readCodec(): string {
  if (!existsSync(codecPath)) throw new Error('нет src/lib/start-codec.ts — саботировать нечего');
  return readFileSync(codecPath, 'utf8');
}

function replaceOnce(src: string, anchor: string, replacement: string): string {
  const first = src.indexOf(anchor);
  if (first === -1) throw new Error(`якорь не найден в кодеке: ${JSON.stringify(anchor)}`);
  if (src.indexOf(anchor, first + anchor.length) !== -1) {
    throw new Error(`якорь встречается больше одного раза: ${JSON.stringify(anchor)}`);
  }
  return src.slice(0, first) + replacement + src.slice(first + anchor.length);
}

function tmpModulePath(id: string): string {
  return path.join(tmpDir, `${id}.ts`);
}

function writeSabotagedModule(id: string, source: string): void {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(tmpModulePath(id), source, 'utf8');
}

function cleanupModule(id: string): void {
  rmSync(tmpModulePath(id), { force: true });
}

function gateCommand(id: string): string[] {
  const target = path.relative(projectRoot, tmpModulePath(id)).replace(/\\/g, '/');
  return ['--experimental-strip-types', 'scripts/check-start-codec.ts', '--module', target];
}

const directionLetterChanged: SabotageCase = {
  id: 'codec-direction-letter-changed',
  gate: 'check:start-codec',
  describe: "буква направления teamcash сменилась с 't' на 'c' — круговой тест этого не видит",
  setup() {
    writeSabotagedModule(this.id, replaceOnce(readCodec(), "teamcash: 't'", "teamcash: 'c'"));
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'ЗОЛОТЫЕ ВЕКТОРЫ',
  greenRun: GREEN,
  teardown() {
    cleanupModule(this.id);
  },
};

const campaignLimitRaised: SabotageCase = {
  id: 'codec-campaign-limit-raised',
  gate: 'check:start-codec',
  describe: 'лимит кампании поднят с 20 до 40 — payload перестаёт влезать в 64 символа Telegram',
  setup() {
    writeSabotagedModule(this.id, replaceOnce(readCodec(), 'campaign: 20', 'campaign: 40'));
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'ДЛИНА ИЛИ АЛФАВИТ',
  greenRun: GREEN,
  teardown() {
    cleanupModule(this.id);
  },
};

const separatorChanged: SabotageCase = {
  id: 'codec-separator-changed',
  gate: 'check:start-codec',
  describe: "разделитель позиций сменён с '_' на '-' — все розданные ссылки перестают разбираться",
  setup() {
    writeSabotagedModule(this.id, replaceOnce(readCodec(), "const SEP = '_';", "const SEP = '-';"));
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'ЗОЛОТЫЕ ВЕКТОРЫ',
  greenRun: GREEN,
  teardown() {
    cleanupModule(this.id);
  },
};

const throwReplacedWithSlice: SabotageCase = {
  id: 'codec-throw-replaced-with-slice',
  gate: 'check:start-codec',
  describe: 'проверка поля заменена на молчаливое усечение normalizeToken вместо исключения',
  setup() {
    const anchor =
      "function guardField(name: 'source' | 'campaign' | 'click', value: string, max: number): string {";
    writeSabotagedModule(
      this.id,
      replaceOnce(readCodec(), anchor, `${anchor}\n  return normalizeToken(value, max);`),
    );
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'БРОСАЕТ НА ВХОДЕ ВНЕ АЛФАВИТА',
  greenRun: GREEN,
  teardown() {
    cleanupModule(this.id);
  },
};

const copyPath = path.join(projectRoot, 'src', 'lib', 'start-codec.copy.ts');

const secondCopyInRepo: SabotageCase = {
  id: 'codec-second-copy-in-repo',
  gate: 'check:start-codec',
  describe: 'кодек скопирован в src/lib/start-codec.copy.ts — две копии контракта в одном репозитории',
  setup() {
    writeFileSync(copyPath, readCodec(), 'utf8');
  },
  command: ['--experimental-strip-types', 'scripts/check-start-codec.ts'],
  expectOutputContains: 'ЕДИНСТВЕННОЕ ОБЪЯВЛЕНИЕ',
  greenRun: GREEN,
  teardown() {
    rmSync(copyPath, { force: true });
  },
};

const domainGuardRemoved: SabotageCase = {
  id: 'codec-domain-guard-removed',
  gate: 'check:start-codec',
  describe: 'проверка неизвестного направления/локали снята — payload собирается с пустым полем',
  setup() {
    const anchor = 'if (dir === undefined) {';
    writeSabotagedModule(
      this.id,
      replaceOnce(readCodec(), anchor, 'if (false as boolean) {'),
    );
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'КЛЮЧ ВНЕ ДОМЕНА',
  greenRun: GREEN,
  teardown() {
    cleanupModule(this.id);
  },
};

export const cases: SabotageCase[] = [
  directionLetterChanged,
  campaignLimitRaised,
  separatorChanged,
  throwReplacedWithSlice,
  secondCopyInRepo,
  domainGuardRemoved,
];
