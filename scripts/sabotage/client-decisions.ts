
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-client-decisions.ts'],
};

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

function copyDir(from: string, to: string, exts?: string[]): string {
  mkdirSync(tmpDir, { recursive: true });
  rmSync(to, { recursive: true, force: true });
  if (!existsSync(from)) throw new Error(`нет каталога ${from} — саботировать нечего`);
  cpSync(from, to, {
    recursive: true,
    filter: (f) => {
      if (!path.extname(f)) return true;
      return !exts || exts.includes(path.extname(f).toLowerCase());
    },
  });
  return to;
}

function copyI18n(id: string): string {
  return copyDir(path.join(projectRoot, 'src', 'i18n'), path.join(tmpDir, `${id}-i18n`));
}

const SRC_EXT = ['.ts', '.js', '.mjs', '.astro', '.json', '.css', '.html'];
function copySrc(id: string): string {
  return copyDir(path.join(projectRoot, 'src'), path.join(tmpDir, `${id}-src`), SRC_EXT);
}

function copyPublic(id: string): string {
  return copyDir(path.join(projectRoot, 'public'), path.join(tmpDir, `${id}-public`));
}

function cleanup(id: string): void {
  for (const suffix of ['-i18n', '-src', '-public', '-empty']) {
    rmSync(path.join(tmpDir, `${id}${suffix}`), { recursive: true, force: true });
  }
}

function patchDict(dir: string, file: string, from: string, to: string): void {
  const target = path.join(dir, file);
  const text = readFileSync(target, 'utf8');
  if (!text.includes(from)) throw new Error(`в копии ${file} нет якоря «${from}»`);
  writeFileSync(target, text.replace(from, to), 'utf8');
}

const cryptoWordBack: SabotageCase = {
  id: 'client-decisions-crypto-word',
  gate: 'check:client-decisions',
  describe: 'в ответ про выплаты (ru) возвращено слово из макета — «криптовалюте»',
  setup() {
    const dir = copyI18n(this.id);
    patchDict(dir, 'ru.json', 'в ₮ или в других валютах', 'в ₮ или в криптовалюте');
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-client-decisions.ts',
      '--i18n',
      argPath(path.join(tmpDir, `${this.id}-i18n`)),
    ];
  },
  expectOutputContains: 'КРИПТОВАЛЮТА-В-ТЕКСТЕ',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const robotoFileDropped: SabotageCase = {
  id: 'client-decisions-roboto-file',
  gate: 'check:client-decisions',
  describe: 'в public/fonts/ положен Roboto-VariableFont.ttf из присланного пакета',
  setup() {
    const dir = copyPublic(this.id);
    const fonts = path.join(dir, 'fonts');
    mkdirSync(fonts, { recursive: true });

    writeFileSync(path.join(fonts, 'Roboto-VariableFont.ttf'), 'не настоящий шрифт', 'utf8');
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-client-decisions.ts',
      '--public',
      argPath(path.join(tmpDir, `${this.id}-public`)),
    ];
  },
  expectOutputContains: 'ЧУЖАЯ-ГАРНИТУРА',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const robotoDeclared: SabotageCase = {
  id: 'client-decisions-roboto-declared',
  gate: 'check:client-decisions',
  describe: '@font-face объявляет Roboto, а --font-sans переписан на него же',
  setup() {
    const dir = copySrc(this.id);
    const tokens = path.join(dir, 'styles', 'tokens.css');
    let css = readFileSync(tokens, 'utf8');
    const anchor = "  --font-sans: 'Manrope', 'Manrope Fallback',";
    if (!css.includes(anchor)) throw new Error('в копии tokens.css нет якоря --font-sans');
    css = css.replace(anchor, "  --font-sans: 'Roboto', 'Manrope', 'Manrope Fallback',");
    css = `@font-face {\n  font-family: 'Roboto';\n  src: url('/fonts/Roboto-VariableFont.ttf') format('truetype');\n}\n${css}`;
    writeFileSync(tokens, css, 'utf8');
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-client-decisions.ts',
      '--src',
      argPath(path.join(tmpDir, `${this.id}-src`)),
    ];
  },
  expectOutputContains: 'ЧУЖАЯ-ГАРНИТУРА',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const tugrikToMnt: SabotageCase = {
  id: 'client-decisions-tugrik-to-mnt',
  gate: 'check:client-decisions',
  describe: 'значок ₮ заменён на MNT в ответе faq.a_currency монгольского словаря',
  setup() {
    const dir = copyI18n(this.id);
    patchDict(dir, 'mn.json', 'танд ₮ болон', 'танд MNT болон');
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-client-decisions.ts',
      '--i18n',
      argPath(path.join(tmpDir, `${this.id}-i18n`)),
    ];
  },
  expectOutputContains: 'ЗНАЧОК-ТУГРИКА-ПОТЕРЯН',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const emptyScan: SabotageCase = {
  id: 'client-decisions-empty-scan',
  gate: 'check:client-decisions',
  describe: 'гейт наведён на ПУСТОЙ каталог словарей — обход не должен считаться успехом',
  setup() {
    mkdirSync(path.join(tmpDir, `${this.id}-empty`), { recursive: true });
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-client-decisions.ts',
      '--i18n',
      argPath(path.join(tmpDir, `${this.id}-empty`)),
      '--bot-i18n',
      argPath(path.join(tmpDir, `${this.id}-empty`)),
    ];
  },
  expectOutputContains: 'СЛОВАРИ НЕ ОСМОТРЕНЫ',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

export const cases: SabotageCase[] = [
  cryptoWordBack,
  robotoFileDropped,
  robotoDeclared,
  tugrikToMnt,
  emptyScan,
];
