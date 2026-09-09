
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-analytics-config.ts'],
  env: {
    PUBLIC_SITE_URL: 'https://partner-melbet.com',
    PUBLIC_GA_ID: 'G-ETALON0000',
    PUBLIC_CLARITY_ID: 'etalonclarity',
  },
};

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');

const CLARITY_REL = path.join('scripts', 'analytics', 'clarity.ts');
const CLARITY_REAL = path.join(projectRoot, 'src', CLARITY_REL);

const CONSENT_LINE =
  "clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' });";

const INSERT_LINE = 'document.head.appendChild(tag);';

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

function plantClarity(destSrc: string, mutate?: (text: string) => string): void {
  if (!existsSync(CLARITY_REAL)) {
    throw new Error(`нет src/${CLARITY_REL.replace(/\\/g, '/')} — саботировать нечего`);
  }
  const text = readFileSync(CLARITY_REAL, 'utf8');
  const dest = path.join(destSrc, CLARITY_REL);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, mutate ? mutate(text) : text, 'utf8');
}

function writeFakeSrc(id: string, fileName: string, body: string): string {
  const dest = path.join(tmpDir, `${id}-src`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.join(dest, 'components'), { recursive: true });
  writeFileSync(path.join(dest, 'components', fileName), body, 'utf8');
  plantClarity(dest);
  return dest;
}

function writeSrcWithoutClarity(id: string): string {
  const dest = path.join(tmpDir, `${id}-src`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.join(dest, 'components'), { recursive: true });
  writeFileSync(
    path.join(dest, 'components', 'Harmless.astro'),
    ['---', "const id = import.meta.env.PUBLIC_GA_ID;", '---', '<span data-id={id}></span>', ''].join('\n'),
    'utf8',
  );
  return dest;
}

function writeClaritySrc(id: string, mutate: (text: string) => string): string {
  const dest = path.join(tmpDir, `${id}-src`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  plantClarity(dest, mutate);
  return dest;
}

function cleanupSrc(id: string): void {
  rmSync(path.join(tmpDir, `${id}-src`), { recursive: true, force: true });
}

function replaceAnchor(text: string, anchor: string, replacement: string): string {
  if (!text.includes(anchor)) {
    throw new Error(`якорь не найден в копии clarity.ts: «${anchor}»`);
  }
  return text.replace(anchor, replacement);
}

const ENV_KEYS = ['PUBLIC_SITE_URL', 'PUBLIC_GA_ID'] as const;
let savedEnv: Record<string, string | undefined> = {};

const prodWithoutId: SabotageCase = {
  id: 'analytics-config-missing-id-on-prod',
  gate: 'check:analytics-config',
  describe: 'PUBLIC_SITE_URL переключён на боевой домен, а PUBLIC_GA_ID пуст',
  setup() {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.PUBLIC_SITE_URL = 'https://partner-melbet.com';
    process.env.PUBLIC_GA_ID = '';
  },
  command: ['--experimental-strip-types', 'scripts/check-analytics-config.ts'],
  expectOutputContains: 'ID АНАЛИТИКИ НЕ ЗАДАН НА БОЕВОМ ДОМЕНЕ',
  greenRun: GREEN,
  teardown() {
    for (const key of ENV_KEYS) {
      const previous = savedEnv[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  },
};

const gaLiteralInSrc: SabotageCase = {
  id: 'analytics-config-ga-literal-in-src',
  gate: 'check:analytics-config',
  describe: 'Measurement ID GA4 вписан литералом в компонент вместо переменной окружения',
  setup() {
    writeFakeSrc(
      this.id,
      'Analytics.astro',
      ['---', "const id = 'G-ABC1234567';", '---', '<span data-id={id}></span>', ''].join('\n'),
    );
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-analytics-config.ts',
      '--src',
      argPath(path.join(tmpDir, `${this.id}-src`)),
    ];
  },
  expectOutputContains: 'ИДЕНТИФИКАТОР ЛИТЕРАЛОМ В ИСХОДНИКАХ',
  greenRun: GREEN,
  teardown() {
    cleanupSrc(this.id);
  },
};

const clarityLiteralInSrc: SabotageCase = {
  id: 'analytics-config-clarity-literal-in-src',
  gate: 'check:analytics-config',
  describe: 'адрес тега Clarity собран со статическим ID вместо подстановки',
  setup() {
    writeFakeSrc(
      this.id,
      'Clarity.astro',
      [
        '---',
        "const src = 'https://www.clarity.ms/tag/abcdefghij';",
        '---',
        '<script is:inline src={src}></script>',
        '',
      ].join('\n'),
    );
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-analytics-config.ts',
      '--src',
      argPath(path.join(tmpDir, `${this.id}-src`)),
    ];
  },
  expectOutputContains: 'ИДЕНТИФИКАТОР ЛИТЕРАЛОМ В ИСХОДНИКАХ',
  greenRun: GREEN,
  teardown() {
    cleanupSrc(this.id);
  },
};

const consentAfterTag: SabotageCase = {
  id: 'analytics-config-clarity-consent-after-tag',
  gate: 'check:analytics-config',
  describe: 'вызов consentv2 переставлен после document.head.appendChild(tag)',
  setup() {
    writeClaritySrc(this.id, (text) => {

      const without = replaceAnchor(text, CONSENT_LINE, 'void 0;');

      return replaceAnchor(without, INSERT_LINE, `${INSERT_LINE}\n  ${CONSENT_LINE}`);
    });
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-analytics-config.ts',
      '--src',
      argPath(path.join(tmpDir, `${this.id}-src`)),
    ];
  },
  expectOutputContains: 'СОГЛАСИЕ CLARITY НЕ ПЕРЕДАНО ДО ТЕГА',
  greenRun: GREEN,
  teardown() {
    cleanupSrc(this.id);
  },
};

const consentGrantedByDefault: SabotageCase = {
  id: 'analytics-config-clarity-consent-granted-by-default',
  gate: 'check:analytics-config',
  describe: "умолчание Clarity выставлено в analytics_Storage: 'granted' вместо 'denied'",
  setup() {
    writeClaritySrc(this.id, (text) =>
      replaceAnchor(
        text,
        CONSENT_LINE,
        CONSENT_LINE.replace("analytics_Storage: 'denied'", "analytics_Storage: 'granted'"),
      ),
    );
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-analytics-config.ts',
      '--src',
      argPath(path.join(tmpDir, `${this.id}-src`)),
    ];
  },
  expectOutputContains: 'УМОЛЧАНИЕ CLARITY НЕ «БЕЗ COOKIES»',
  greenRun: GREEN,
  teardown() {
    cleanupSrc(this.id);
  },
};

const clarityModuleMissing: SabotageCase = {
  id: 'analytics-config-clarity-module-missing',
  gate: 'check:analytics-config',
  describe: 'модуля scripts/analytics/clarity.ts в дереве исходников нет вовсе',
  setup() {
    writeSrcWithoutClarity(this.id);
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-analytics-config.ts',
      '--src',
      argPath(path.join(tmpDir, `${this.id}-src`)),
    ];
  },
  expectOutputContains: 'МОДУЛЬ CLARITY НЕ НАЙДЕН',
  greenRun: GREEN,
  teardown() {
    cleanupSrc(this.id);
  },
};

const clarityTagNotInserted: SabotageCase = {
  id: 'analytics-config-clarity-tag-not-inserted',
  gate: 'check:analytics-config',
  describe: 'вставка тега document.head.appendChild(tag) потеряна, сигнал согласия на месте',
  setup() {
    writeClaritySrc(this.id, (text) =>

      replaceAnchor(text, INSERT_LINE, 'void tag;'),
    );
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-analytics-config.ts',
      '--src',
      argPath(path.join(tmpDir, `${this.id}-src`)),
    ];
  },
  expectOutputContains: 'ТЕГ CLARITY НЕ ВСТАВЛЯЕТСЯ',
  greenRun: GREEN,
  teardown() {
    cleanupSrc(this.id);
  },
};

export const cases: SabotageCase[] = [
  prodWithoutId,
  gaLiteralInSrc,
  clarityLiteralInSrc,
  consentAfterTag,
  consentGrantedByDefault,
  clarityModuleMissing,
  clarityTagNotInserted,
];
