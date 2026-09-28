
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-encoding.ts'],
};

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

function gateCommand(dir: string): string[] {
  return ['--experimental-strip-types', 'scripts/check-encoding.ts', '--root', argPath(dir)];
}

function root(id: string): string {
  return path.join(tmpDir, `${id}-root`);
}

function cleanup(id: string): void {
  rmSync(root(id), { recursive: true, force: true });
}

const bomInWorkflow: SabotageCase = {
  id: 'encoding-bom-in-workflow',
  gate: 'check:encoding',
  describe: 'PowerShell записал воркфлоу с сигнатурой UTF-8 — гейт обязан её увидеть',
  setup() {
    const dir = path.join(root(this.id), '.github', 'workflows');
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      path.join(dir, 'ci.yml'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('name: CI\n', 'utf8')]),
    );
  },
  get command() {
    return gateCommand(root(this.id));
  },
  expectOutputContains: 'UTF-8 BOM найден',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const emptyScan: SabotageCase = {
  id: 'encoding-empty-scan',
  gate: 'check:encoding',
  describe: 'гейт наведён на ПУСТОЙ корень — обход не должен считаться успехом',
  setup() {
    mkdirSync(root(this.id), { recursive: true });
  },
  get command() {
    return gateCommand(root(this.id));
  },
  expectOutputContains: 'ФАЙЛЫ НЕ ОСМОТРЕНЫ',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

export const cases: SabotageCase[] = [bomInWorkflow, emptyScan];
