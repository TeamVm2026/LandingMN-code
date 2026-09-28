
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-craft-contract.ts'],
};

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

function src(id: string): string {
  return path.join(tmpDir, `${id}-src`);
}

function gateCommand(id: string): string[] {
  return ['--experimental-strip-types', 'scripts/check-craft-contract.ts', '--src', argPath(src(id))];
}

const READ_EXT = ['.astro', '.css', '.ts', '.tsx', '.js', '.mjs', '.html', '.json'];
function copySrc(id: string): string {
  const to = src(id);
  mkdirSync(tmpDir, { recursive: true });
  rmSync(to, { recursive: true, force: true });
  const from = path.join(projectRoot, 'src');
  if (!existsSync(from)) throw new Error('нет каталога src — саботировать нечего');
  cpSync(from, to, {
    recursive: true,
    filter: (f) => !path.extname(f) || READ_EXT.includes(path.extname(f).toLowerCase()),
  });
  return to;
}

function patch(dir: string, relFile: string, from: string, to: string): void {
  if (from.includes('\n')) throw new Error(`якорь «${from}» многострочный — см. врезку у patch()`);
  const target = path.join(dir, relFile);
  const text = readFileSync(target, 'utf8');
  if (!text.includes(from)) throw new Error(`в копии ${relFile} нет якоря «${from}»`);
  writeFileSync(target, text.replace(from, to), 'utf8');
}

function cleanup(id: string): void {
  rmSync(src(id), { recursive: true, force: true });
}

const bareEase: SabotageCase = {
  id: 'craft-bare-ease',
  gate: 'check:craft-contract',
  describe: 'в переход вернулось голое ключевое слово ease вместо кривой из набора',
  setup() {
    const dir = copySrc(this.id);
    patch(
      dir,
      path.join('styles', 'tokens.css'),
      ':focus-visible {',
      '.sabotage-perehod { transition: opacity var(--motion-base) ease; } :focus-visible {',
    );
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'statement(s) FAILED',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const focusRingKilled: SabotageCase = {
  id: 'craft-focus-ring-killed',
  gate: 'check:craft-contract',
  describe: 'глобальное кольцо фокуса погашено outline: none — клавиатура слепнет',
  setup() {
    const dir = copySrc(this.id);
    patch(
      dir,
      path.join('styles', 'tokens.css'),
      'outline: 2px solid var(--gold-light);',
      'outline: none;',
    );
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'statement(s) FAILED',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const emptyScan: SabotageCase = {
  id: 'craft-contract-empty-scan',
  gate: 'check:craft-contract',
  describe: 'гейт наведён на ПУСТОЙ корень исходников — обход не должен считаться успехом',
  setup() {
    mkdirSync(src(this.id), { recursive: true });
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'tokens.css not found',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const tokenGlassWithoutFallback: SabotageCase = {
  id: 'craft-token-glass-no-fallback',
  gate: 'check:craft-contract',
  describe: 'у стекла на токене (var(--glass-saturate)) пропал фолбэк prefers-reduced-transparency',
  setup() {
    const dir = copySrc(this.id);
    patch(
      dir,
      path.join('components', 'ConsentControl.astro'),
      '@media (prefers-reduced-transparency: reduce) {',
      '@media (prefers-reduced-transparency: sabotage) {',
    );
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'no fallback in:',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

export const cases: SabotageCase[] = [bareEase, focusRingKilled, emptyScan, tokenGlassWithoutFallback];
