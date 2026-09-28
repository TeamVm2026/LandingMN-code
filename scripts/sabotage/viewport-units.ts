
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-viewport-units.ts'],
};

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

function src(id: string): string {
  return path.join(tmpDir, `${id}-src`);
}

function gateCommand(id: string): string[] {
  return ['--experimental-strip-types', 'scripts/check-viewport-units.ts', '--src', argPath(src(id))];
}

function writeStyles(id: string, css: string): void {
  const dir = path.join(src(id), 'styles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'tokens.css'), css, 'utf8');
}

function cleanup(id: string): void {
  rmSync(src(id), { recursive: true, force: true });
}

const dvhReturned: SabotageCase = {
  id: 'viewport-dvh-returned',
  gate: 'check:viewport-units',
  describe: 'первому экрану вернули min-height: 100dvh — раскладка снова едет под пальцем',
  setup() {
    writeStyles(this.id, '.hero {\n  min-height: 100dvh;\n}\n');
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'Негодных единиц высоты вьюпорта',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const dvhHiddenInToken: SabotageCase = {
  id: 'viewport-dvh-hidden-in-token',
  gate: 'check:viewport-units',
  describe: 'динамическая единица спрятана в токен --hero-h, свойство берёт его через var()',
  setup() {
    writeStyles(this.id, ':root {\n  --hero-h: 100dvh;\n}\n.hero {\n  min-height: var(--hero-h);\n}\n');
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'Негодных единиц высоты вьюпорта',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const emptyScan: SabotageCase = {
  id: 'viewport-units-empty-scan',
  gate: 'check:viewport-units',
  describe: 'гейт наведён на ПУСТОЙ корень исходников — обход не должен считаться успехом',
  setup() {
    mkdirSync(src(this.id), { recursive: true });
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'ИСХОДНИКИ НЕ ОСМОТРЕНЫ',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

export const cases: SabotageCase[] = [dvhReturned, dvhHiddenInToken, emptyScan];
