
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-motion-safety.ts'],
};

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

function src(id: string): string {
  return path.join(tmpDir, `${id}-src`);
}

function gateCommand(id: string): string[] {
  return ['--experimental-strip-types', 'scripts/check-motion-safety.ts', '--src', argPath(src(id))];
}

function writeTree(id: string, astro: string, css: string): void {
  const components = path.join(src(id), 'components');
  const styles = path.join(src(id), 'styles');
  mkdirSync(components, { recursive: true });
  mkdirSync(styles, { recursive: true });
  writeFileSync(path.join(components, 'Sabotage.astro'), astro, 'utf8');
  writeFileSync(path.join(styles, 'tokens.css'), css, 'utf8');
}

function cleanup(id: string): void {
  rmSync(src(id), { recursive: true, force: true });
}

const timelineReturned: SabotageCase = {
  id: 'motion-animation-timeline-returned',
  gate: 'check:motion-safety',
  describe: 'в стили вернулось animation-timeline: view() — scrub вместо однократного появления',
  setup() {
    writeTree(
      this.id,
      '<div class="reveal"></div>\n<style>\n.reveal { animation: fade linear both; animation-timeline: view(); }\n</style>\n',
      '.ok { color: #fff; }\n',
    );
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'использовано свойство animation-timeline',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const timelineDisguised: SabotageCase = {
  id: 'motion-animation-timeline-disguised',
  gate: 'check:motion-safety',
  describe: 'то же свойство заглавными и с пробелом перед двоеточием — CSS регистронезависим',
  setup() {
    writeTree(
      this.id,
      '<div class="reveal"></div>\n',
      '.reveal { ANIMATION-TIMELINE : view(); }\n',
    );
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'использовано свойство animation-timeline',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const emptyScan: SabotageCase = {
  id: 'motion-safety-empty-scan',
  gate: 'check:motion-safety',
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

export const cases: SabotageCase[] = [timelineReturned, timelineDisguised, emptyScan];
