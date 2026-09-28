
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-placeholders.ts'],
  env: { PUBLIC_SITE_URL: 'https://landingmn.pages.dev' },
  costly: 'нужна собранная dist/ (npm run build) — гейт считает заглушки в готовом HTML',
};

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

function distPath(id: string): string {
  return path.join(tmpDir, `${id}-dist`);
}

function writeFakeDist(id: string, body: string): void {
  const dest = distPath(id);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, 'index.html'), body, 'utf8');
}

function cleanupDist(id: string): void {
  rmSync(distPath(id), { recursive: true, force: true });
}

const WITH_PLACEHOLDER =
  '<!doctype html><html lang="mn"><body>' +
  '<a href="https://t.me/PLACEHOLDER_MANAGER">Telegram</a>' +
  '<a href="https://m.me/PLACEHOLDER_FB_PAGE">Messenger</a>' +
  '</body></html>\n';

const ENV_KEYS = ['PUBLIC_SITE_URL'] as const;
let savedEnv: Record<string, string | undefined> = {};

function setProdDomain(): void {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.PUBLIC_SITE_URL = 'https://partner-melbet.com';
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const previous = savedEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

const placeholdersOnProd: SabotageCase = {
  id: 'placeholders-on-prod-domain',
  gate: 'check:placeholders',
  describe: 'PUBLIC_SITE_URL переключён на боевой домен, а в сборке остались PLACEHOLDER-контакты',
  setup() {
    writeFakeDist(this.id, WITH_PLACEHOLDER);
    setProdDomain();
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-placeholders.ts',
      '--dist',
      argPath(distPath(this.id)),
    ];
  },
  expectOutputContains: 'ЗАГЛУШКИ В БОЕВОЙ СБОРКЕ',
  greenRun: GREEN,
  teardown() {
    restoreEnv();
    cleanupDist(this.id);
  },
};

const missingDist: SabotageCase = {
  id: 'placeholders-missing-dist',
  gate: 'check:placeholders',
  describe: 'каталога сборки нет вовсе — гейт обязан упасть, а не отчитаться «заглушек нет»',
  setup() {
    cleanupDist(this.id);
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-placeholders.ts',
      '--dist',
      argPath(distPath(this.id)),
    ];
  },
  expectOutputContains: 'сначала `npm run build`',
  greenRun: GREEN,
  teardown() {
    cleanupDist(this.id);
  },
};

const GREEN_CLEAN: GreenRun = {
  command: [
    '--experimental-strip-types',
    'scripts/check-placeholders.ts',
    '--dist',
    'scripts/sabotage/fixtures/placeholders-clean-dist',
  ],
  env: { PUBLIC_SITE_URL: 'https://partner-melbet.com' },
};

function prodCase(
  id: string,
  describe: string,
  build: (id: string) => void,
  expectOutputContains = 'ЗАГЛУШКИ В БОЕВОЙ СБОРКЕ'
): SabotageCase {
  return {
    id,
    gate: 'check:placeholders',
    describe,
    setup() {
      build(id);
      setProdDomain();
    },
    command: [
      '--experimental-strip-types',
      'scripts/check-placeholders.ts',
      '--dist',
      argPath(distPath(id)),
    ],
    expectOutputContains,
    greenRun: GREEN_CLEAN,
    teardown() {
      restoreEnv();
      cleanupDist(id);
    },
  };
}

const changeme = prodCase(
  'placeholders-changeme-on-prod',
  'PUBLIC_MESSENGER_URL заполнен временным m.me/changeme и уехал в боевую сборку',
  (id) =>
    writeFakeDist(
      id,
      '<!doctype html><html lang="mn"><body>' +
        '<a href="https://t.me/melbet_mongolia_manager">Telegram</a>' +
        '<a href="https://m.me/changeme">Messenger</a>' +
        '</body></html>\n'
    )
);

const exampleDomain = prodCase(
  'placeholders-example-domain-on-prod',
  'контакт заполнен доменом-примером https://example.com/soon',
  (id) =>
    writeFakeDist(
      id,
      '<!doctype html><html lang="mn"><body>' +
        '<a href="https://example.com/soon">Telegram</a>' +
        '<a href="https://m.me/melbetmongolia">Messenger</a>' +
        '</body></html>\n'
    )
);

const inJsChunk = prodCase(
  'placeholders-in-js-chunk',
  'разметка чистая, а заглушка осталась литералом в отложенном JS-чанке',
  (id) => {
    writeFakeDist(
      id,
      '<!doctype html><html lang="mn"><body>' +
        '<a href="https://t.me/melbet_mongolia_manager">Telegram</a>' +
        '</body></html>\n'
    );
    const astro = path.join(distPath(id), '_astro');
    mkdirSync(astro, { recursive: true });
    writeFileSync(
      path.join(astro, 'providers.sabotage.js'),
      'const messenger="https://m.me/PLACEHOLDER_FB_PAGE";export{messenger};\n',
      'utf8'
    );
  }
);

const emptyDist = prodCase(
  'placeholders-empty-dist',
  'каталог сборки есть, но осматривать в нём нечего — обход не должен считаться успехом',
  (id) => {
    rmSync(distPath(id), { recursive: true, force: true });
    mkdirSync(distPath(id), { recursive: true });
  },
  'СБОРКА НЕ ОСМОТРЕНА'
);

export const cases: SabotageCase[] = [
  placeholdersOnProd,
  missingDist,
  changeme,
  exampleDomain,
  inJsChunk,
  emptyDist,
];
