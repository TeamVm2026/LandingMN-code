
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-dead-tokens.ts'],
};

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

function root(id: string): string {
  return path.join(tmpDir, `${id}-root`);
}

function gateCommand(id: string): string[] {
  return ['--experimental-strip-types', 'scripts/check-dead-tokens.ts', '--root', argPath(root(id))];
}

const READ_EXT = ['.astro', '.css', '.ts', '.tsx', '.js', '.mjs', '.html'];
function copyTree(id: string): string {
  const to = root(id);
  mkdirSync(tmpDir, { recursive: true });
  rmSync(to, { recursive: true, force: true });
  for (const dir of ['src', 'functions']) {
    const from = path.join(projectRoot, dir);
    if (!existsSync(from)) throw new Error(`нет каталога ${dir} — саботировать нечего`);
    cpSync(from, path.join(to, dir), {
      recursive: true,
      filter: (f) => !path.extname(f) || READ_EXT.includes(path.extname(f).toLowerCase()),
    });
  }
  return to;
}

function patchTokens(dir: string, from: string, to: string): void {
  const target = path.join(dir, 'src', 'styles', 'tokens.css');
  const text = readFileSync(target, 'utf8');
  if (!text.includes(from)) throw new Error(`в копии tokens.css нет якоря «${from}»`);
  writeFileSync(target, text.replace(from, to), 'utf8');
}

function cleanup(id: string): void {
  rmSync(root(id), { recursive: true, force: true });
}

const declaredUnused: SabotageCase = {
  id: 'dead-token-declared-unused',
  gate: 'check:dead-tokens',
  describe: 'в tokens.css остался токен без единого потребителя — призрак прежнего рецепта',
  setup() {
    const dir = copyTree(this.id);
    patchTokens(
      dir,
      ':root {',
      ':root {\n  --sabotage-prizrak-prezhnego-recepta: 4px;',
    );
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'Мёртвых токенов',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const staleAllowance: SabotageCase = {
  id: 'dead-token-stale-allowance',
  gate: 'check:dead-tokens',
  describe: 'разрешённый --gold-area удалён из tokens.css — запись в ALLOWED_UNUSED осиротела',
  setup() {
    const dir = copyTree(this.id);
    patchTokens(dir, '--gold-area:', '--sabotage-pereimenovan-zadnim-chislom:');
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'Устаревших исключений',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

export const cases: SabotageCase[] = [declaredUnused, staleAllowance];
