
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');
const id = 'font-char-outside-subset';
const dictDir = path.join(tmpDir, `${id}-i18n`);

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).split(path.sep).join('/');
}

const GREEN: GreenRun = { command: ['--experimental-strip-types', 'scripts/check-font-coverage.ts'] };

const charOutsideSubset: SabotageCase = {
  id,
  gate: 'check:font',
  describe: 'в mn.json попал иероглиф 字, которого нет в сабсете шрифта: на странице был бы «тофу»',
  setup() {
    rmSync(dictDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    cpSync(path.join(projectRoot, 'src', 'i18n'), dictDir, { recursive: true });
    const file = path.join(dictDir, 'mn.json');
    const dict = JSON.parse(readFileSync(file, 'utf8')) as { hero: { h1: string } };
    dict.hero.h1 = `${dict.hero.h1} 字`;
    writeFileSync(file, JSON.stringify(dict, null, 2), 'utf8');
  },
  command: ['--experimental-strip-types', 'scripts/check-font-coverage.ts', '--i18n', argPath(dictDir)],
  expectOutputContains: 'отсутству(ю)т в сабсете',
  greenRun: GREEN,
  teardown() {
    rmSync(dictDir, { recursive: true, force: true });
  },
};

export const cases: SabotageCase[] = [charOutsideSubset];
