
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');
const fixtureDir = path.join(projectRoot, 'scripts', 'sabotage', 'fixtures', 'mask-safety-green');

const GREEN: GreenRun = {
  command: [
    '--experimental-strip-types',
    'scripts/check-mask-safety.ts',
    '--dist',
    'scripts/sabotage/fixtures/mask-safety-green',
  ],
};

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

function copyFixture(id: string): string {
  const to = path.join(tmpDir, `${id}-dist`);
  mkdirSync(tmpDir, { recursive: true });
  rmSync(to, { recursive: true, force: true });
  if (!existsSync(fixtureDir)) throw new Error(`нет ${argPath(fixtureDir)} — саботировать нечего`);
  cpSync(fixtureDir, to, { recursive: true });
  return to;
}

function appendRule(dir: string, css: string): void {
  const target = path.join(dir, 'idiom.css');
  if (!existsSync(target)) throw new Error('в копии фикстуры нет idiom.css');
  writeFileSync(target, `${readFileSync(target, 'utf8')}\n${css}\n`, 'utf8');
}

function cleanup(id: string): void {
  rmSync(path.join(tmpDir, `${id}-dist`), { recursive: true, force: true });
  rmSync(path.join(tmpDir, `${id}-empty`), { recursive: true, force: true });
}

function gateCommand(dir: string): string[] {
  return ['--experimental-strip-types', 'scripts/check-mask-safety.ts', '--dist', argPath(dir)];
}

const shorthandUnpaired: SabotageCase = {
  id: 'mask-shorthand-unpaired',
  gate: 'check:mask-safety',
  describe: 'растушёвка переписана сокращёнкой `mask:` без парного `-webkit-mask:`',
  setup() {
    const dir = copyFixture(this.id);
    appendRule(dir, '.hero-frame{mask:linear-gradient(#000 60%,transparent 100%)}');
  },
  get command() {
    return gateCommand(path.join(tmpDir, `${this.id}-dist`));
  },
  expectOutputContains: 'НЕПАРНАЯ МАСКА',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const unpairedPerRule: SabotageCase = {
  id: 'mask-unpaired-per-rule',
  gate: 'check:mask-safety',
  describe: 'два правила непарны в разные стороны — глобальные счётчики сходятся, движки слепнут',
  setup() {
    const dir = copyFixture(this.id);
    appendRule(
      dir,
      '.left-only{mask-image:linear-gradient(#000,#0000)}\n' +
        '.right-only{-webkit-mask-image:linear-gradient(#000,#0000)}',
    );
  },
  get command() {
    return gateCommand(path.join(tmpDir, `${this.id}-dist`));
  },
  expectOutputContains: 'НЕПАРНАЯ МАСКА',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const compositeOutsideList: SabotageCase = {
  id: 'mask-composite-outside-list',
  gate: 'check:mask-safety',
  describe: 'композит поставлен слою сцены, чьё имя лишь СОДЕРЖИТ разрешённый огрызок',
  setup() {
    const dir = copyFixture(this.id);
    appendRule(
      dir,
      '.scene-cloud-btn{mask-composite:intersect;-webkit-mask-composite:source-in;' +
        'mask-image:linear-gradient(#000,#0000);-webkit-mask-image:linear-gradient(#000,#0000)}',
    );
  },
  get command() {
    return gateCommand(path.join(tmpDir, `${this.id}-dist`));
  },
  expectOutputContains: 'КОМПОЗИТ ВНЕ СПИСКА',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const emptyScan: SabotageCase = {
  id: 'mask-empty-scan',
  gate: 'check:mask-safety',
  describe: 'гейт наведён на ПУСТОЙ каталог сборки — обход не должен считаться успехом',
  setup() {
    mkdirSync(path.join(tmpDir, `${this.id}-empty`), { recursive: true });
  },
  get command() {
    return gateCommand(path.join(tmpDir, `${this.id}-empty`));
  },
  expectOutputContains: 'МАСКИ НЕ ОСМОТРЕНЫ',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const varInsideMask: SabotageCase = {
  id: 'mask-var-inside-mask',
  gate: 'check:mask-safety',
  describe: 'градиент маски вынесен в токен — WebKit вправе отбросить объявление целиком',
  setup() {
    const dir = copyFixture(this.id);
    appendRule(
      dir,
      '.hero-veil{-webkit-mask-image:var(--hero-fade);mask-image:var(--hero-fade)}',
    );
  },
  get command() {
    return gateCommand(path.join(tmpDir, `${this.id}-dist`));
  },
  expectOutputContains: 'VAR() В МАСКЕ',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

export const cases: SabotageCase[] = [
  shorthandUnpaired,
  unpairedPerRule,
  compositeOutsideList,
  emptyScan,
  varInsideMask,
];
