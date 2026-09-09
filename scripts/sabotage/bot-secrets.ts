
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-secrets.ts'],
  costly: 'нужна собранная dist/ (npm run build) — проверки по бандлу без неё не выполняются',
};

function writeFakeDist(id: string): string {
  const dest = path.join(tmpDir, `${id}-dist`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.join(dest, '_astro'), { recursive: true });
  writeFileSync(path.join(dest, '_astro', 'app.js'), 'export const ok=1;\n', 'utf8');
  return dest;
}

const TELEGRAM_TOKEN_SHAPE = /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/;

const FAKE_BOT_TOKEN = `1111111111:${'SABOTAGE_not_a_real_bot_token'.padEnd(35, '0')}`;

const shapeInWorker: SabotageCase = (() => {
  const id = 'secrets-shape-in-worker';
  const sourceDir = path.join(tmpDir, `${id}-src`);

  const leakFile = path.join(sourceDir, 'bot', 'wrangler.jsonc');

  return {
    id,
    gate: 'check:secrets',
    describe:
      'токен бота вписан литералом в wrangler.jsonc воркера — файл отслеживается ' +
      'git-ом, а в dist/ бандл воркера не попадает никогда',
    setup() {
      if (!TELEGRAM_TOKEN_SHAPE.test(FAKE_BOT_TOKEN)) {
        throw new Error(
          `подложенное значение «${FAKE_BOT_TOKEN.slice(0, 11)}…» не совпадает с формой токена ` +
            'проверки C — случай не докажет ничего. Форма в гейте и копия здесь разошлись.',
        );
      }
      rmSync(sourceDir, { recursive: true, force: true });
      mkdirSync(path.dirname(leakFile), { recursive: true });
      writeFileSync(
        leakFile,
        [
          '// workers/bot/wrangler.jsonc',
          '{',
          '  "name": "landingmn-bot",',
          '  "main": "index.ts",',
          '  "compatibility_date": "2026-08-19",',
          '  "vars": {',
          `    "TG_BOT_TOKEN": "${FAKE_BOT_TOKEN}"`,
          '  }',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      writeFakeDist(id);
    },
    get command() {
      return [
        '--experimental-strip-types',
        'scripts/check-secrets.ts',
        '--dist',
        argPath(path.join(tmpDir, `${id}-dist`)),
        '--scan-source',
        argPath(sourceDir),
      ];
    },

    expectOutputContains:
      `ФОРМА СЕКРЕТА В БАНДЛЕ: токен Telegram-бота\n      ${argPath(leakFile)}:`,
    greenRun: GREEN,
    teardown() {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(path.join(tmpDir, `${id}-dist`), { recursive: true, force: true });
    },
  };
})();

const emptySourceScan: SabotageCase = (() => {
  const id = 'secrets-empty-source-scan';
  const emptyDir = path.join(tmpDir, `${id}-src`);

  return {
    id,
    gate: 'check:secrets',
    describe:
      'корень --scan-source не содержит ни одного файла (каталог переименован ' +
      'или опечатка в пути) — обход исходников молча не проверил ничего',
    setup() {
      rmSync(emptyDir, { recursive: true, force: true });
      mkdirSync(emptyDir, { recursive: true });
      writeFakeDist(id);
    },
    get command() {
      return [
        '--experimental-strip-types',
        'scripts/check-secrets.ts',
        '--dist',
        argPath(path.join(tmpDir, `${id}-dist`)),
        '--scan-source',
        argPath(emptyDir),
      ];
    },

    expectOutputContains: 'ИСХОДНИКИ НЕ ОСМОТРЕНЫ: по корням --scan-source осмотрено 0 файлов',
    greenRun: GREEN,
    teardown() {
      rmSync(emptyDir, { recursive: true, force: true });
      rmSync(path.join(tmpDir, `${id}-dist`), { recursive: true, force: true });
    },
  };
})();

export const cases: SabotageCase[] = [shapeInWorker, emptySourceScan];
