
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-i18n-completeness.ts'],
};

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const i18nDir = path.join(projectRoot, 'src', 'i18n');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');
const LOCALES = ['mn', 'ru', 'en'] as const;

type Dict = Record<string, unknown>;

function copyDicts(id: string): string {
  const dest = path.join(tmpDir, `${id}-i18n`);
  mkdirSync(dest, { recursive: true });
  for (const locale of LOCALES) {
    const from = path.join(i18nDir, `${locale}.json`);
    writeFileSync(path.join(dest, `${locale}.json`), readFileSync(from, 'utf8'), 'utf8');
  }
  return dest;
}

function deleteKey(dir: string, locale: string, dotted: string): void {
  const file = path.join(dir, `${locale}.json`);
  const dict = JSON.parse(readFileSync(file, 'utf8')) as Dict;
  const segments = dotted.split('.');
  const last = segments.pop()!;
  let node: Dict = dict;
  for (const segment of segments) {
    const next = node[segment];
    if (!next || typeof next !== 'object') {
      throw new Error(`в копии ${locale}.json нет пути ${dotted} (споткнулись на "${segment}")`);
    }
    node = next as Dict;
  }
  if (!(last in node)) throw new Error(`в копии ${locale}.json нет ключа ${dotted}`);
  delete node[last];
  writeFileSync(file, JSON.stringify(dict, null, 2), 'utf8');
}

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

function cleanup(id: string): void {
  rmSync(path.join(tmpDir, `${id}-i18n`), { recursive: true, force: true });
}

const requiredKeyGone: SabotageCase = {
  id: 'i18n-required-key-removed-everywhere',
  gate: 'check:i18n',
  describe:
    'заголовок раздела политики об аналитике удалён из mn, ru и en одновременно — словари симметричны, содержимого нет',
  setup() {
    const dir = copyDicts(this.id);
    for (const locale of LOCALES) deleteKey(dir, locale, 'pages.privacy_sections.3.heading');
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-i18n-completeness.ts',
      '--dir',
      argPath(path.join(tmpDir, `${this.id}-i18n`)),
    ];
  },
  expectOutputContains: 'ОБЯЗАТЕЛЬНЫЙ КЛЮЧ ОТСУТСТВУЕТ',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const partialTranslation: SabotageCase = {
  id: 'i18n-section-only-in-mn',
  gate: 'check:i18n',
  describe: 'тело раздела об аналитике осталось только в mn, из ru и en удалено',
  setup() {
    const dir = copyDicts(this.id);
    deleteKey(dir, 'ru', 'pages.privacy_sections.3.body');
    deleteKey(dir, 'en', 'pages.privacy_sections.3.body');
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-i18n-completeness.ts',
      '--dir',
      argPath(path.join(tmpDir, `${this.id}-i18n`)),
    ];
  },
  expectOutputContains: 'is missing from',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

export const cases: SabotageCase[] = [requiredKeyGone, partialTranslation];
