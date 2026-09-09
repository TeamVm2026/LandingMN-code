
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-secrets.ts'],
  costly: 'нужна собранная dist/ (npm run build) — две проверки из трёх ищут секреты в бандле',
};

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

function writeFakeDist(id: string, fileName: string, body: string): string {
  const dest = path.join(tmpDir, `${id}-dist`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.join(dest, '_astro'), { recursive: true });
  writeFileSync(path.join(dest, '_astro', fileName), body, 'utf8');
  return dest;
}

function cleanupDist(id: string): void {
  rmSync(path.join(tmpDir, `${id}-dist`), { recursive: true, force: true });
}

const TELEGRAM_TOKEN_SHAPE = /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/;

const TURNSTILE_SECRET_SHAPE = /\b0x[A-Za-z0-9_-]{28,}\b/;

const FAKE_SECRET_VALUE = 'AAHfake-Sabotage-Value-7f3c1a9d2e4b';
const ENV_KEYS = ['TG_BOT_TOKEN'] as const;
let savedEnv: Record<string, string | undefined> = {};

const valueInDist: SabotageCase = {
  id: 'secrets-value-in-dist',
  gate: 'check:secrets',
  describe: 'значение TG_BOT_TOKEN лежит литералом в собранном файле под dist/',
  setup() {
    if (FAKE_SECRET_VALUE.length < 12) {
      throw new Error('подложенное значение короче порога проверки B — случай ничего не докажет');
    }
    if (TELEGRAM_TOKEN_SHAPE.test(FAKE_SECRET_VALUE) || TURNSTILE_SECRET_SHAPE.test(FAKE_SECRET_VALUE)) {
      throw new Error(
        'подложенное значение совпало с формой проверки C — случай перестал доказывать проверку B',
      );
    }
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

    process.env.TG_BOT_TOKEN = FAKE_SECRET_VALUE;
    writeFakeDist(
      this.id,
      'leak.js',
      `const t="${FAKE_SECRET_VALUE}";export{t};\n`,
    );
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-secrets.ts',
      '--dist',
      argPath(path.join(tmpDir, `${this.id}-dist`)),
    ];
  },
  expectOutputContains: 'СЕКРЕТ В БАНДЛЕ',
  greenRun: GREEN,
  teardown() {

    for (const key of ENV_KEYS) {
      const previous = savedEnv[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    cleanupDist(this.id);
  },
};

function fakeConfigDir(id: string): string {
  return path.join(tmpDir, `${id}-config`);
}

const clientContext: SabotageCase = {
  id: 'secrets-client-context',
  gate: 'check:secrets',
  describe: "TG_BOT_TOKEN объявлен в env.schema с context: 'client'",
  setup() {
    const dir = fakeConfigDir(this.id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'astro.config.mjs'),
      [
        "import { defineConfig, envField } from 'astro/config';",
        '',
        'export default defineConfig({',
        '  env: {',
        '    schema: {',
        "      PUBLIC_SITE_URL: envField.string({ context: 'client', access: 'public' }),",
        "      TG_BOT_TOKEN: envField.string({ context: 'client', access: 'public' }),",
        '    },',
        '  },',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );

    writeFakeDist(this.id, 'app.js', 'export const ok=1;\n');
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-secrets.ts',
      '--config',
      argPath(path.join(fakeConfigDir(this.id), 'astro.config.mjs')),
      '--dist',
      argPath(path.join(tmpDir, `${this.id}-dist`)),
    ];
  },
  expectOutputContains: 'КЛИЕНТСКИЙ КОНТЕКСТ',
  greenRun: GREEN,
  teardown() {
    rmSync(fakeConfigDir(this.id), { recursive: true, force: true });
    cleanupDist(this.id);
  },
};

const SHAPE_ID = '123456789';
const SHAPE_TAIL = 'AAFakeSabotageTokenShapeOnly0123456';
const FAKE_TOKEN_SHAPE = `${SHAPE_ID}:${SHAPE_TAIL}`;

const tokenShapeInDist: SabotageCase = {
  id: 'secrets-token-shape-in-dist',
  gate: 'check:secrets',
  describe: 'строка формы токена Telegram лежит в dist/, а окружение пустое — как в CI',
  setup() {

    if (SHAPE_TAIL.length !== 35) {
      throw new Error(`хвост формы токена должен быть 35 символов, а он ${SHAPE_TAIL.length}`);
    }
    if (!TELEGRAM_TOKEN_SHAPE.test(FAKE_TOKEN_SHAPE)) {
      throw new Error('подложенная строка перестала совпадать с формой токена — случай пуст');
    }
    writeFakeDist(this.id, 'inline.js', `const bot="${FAKE_TOKEN_SHAPE}";export{bot};\n`);
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-secrets.ts',
      '--dist',
      argPath(path.join(tmpDir, `${this.id}-dist`)),
    ];
  },
  expectOutputContains: 'ФОРМА СЕКРЕТА В БАНДЛЕ',
  greenRun: GREEN,
  teardown() {
    cleanupDist(this.id);
  },
};

const FAKE_TURNSTILE_SHAPE = '0xSABOTAGEfakeTurnstileSecret000';

const turnstileShapeInDist: SabotageCase = {
  id: 'secrets-turnstile-shape-in-dist',
  gate: 'check:secrets',
  describe: 'строка формы секретного ключа Turnstile лежит в dist/, окружение пустое — как в CI',
  setup() {
    if (!TURNSTILE_SECRET_SHAPE.test(FAKE_TURNSTILE_SHAPE)) {
      throw new Error('подложенная строка перестала совпадать с формой ключа Turnstile — случай пуст');
    }
    if (TELEGRAM_TOKEN_SHAPE.test(FAKE_TURNSTILE_SHAPE)) {
      throw new Error('подложенная строка совпала с формой токена Telegram — случай доказывает не ту ветку');
    }
    writeFakeDist(this.id, 'widget.js', `const s="${FAKE_TURNSTILE_SHAPE}";export{s};\n`);
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-secrets.ts',
      '--dist',
      argPath(path.join(tmpDir, `${this.id}-dist`)),
    ];
  },
  expectOutputContains: 'ФОРМА СЕКРЕТА В БАНДЛЕ',
  greenRun: GREEN,
  teardown() {
    cleanupDist(this.id);
  },
};

export const cases: SabotageCase[] = [
  valueInDist,
  clientContext,
  tokenShapeInDist,
  turnstileShapeInDist,
];
