
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-analytics-events.ts'],
};

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const srcDir = path.join(projectRoot, 'src');
const docFile = path.join(projectRoot, 'docs', 'analytics-events.md');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');

const COPY_EXT = ['.ts', '.js', '.mjs', '.astro', '.json'];

function copySrcTree(id: string): string {
  const dest = path.join(tmpDir, `${id}-src`);
  mkdirSync(tmpDir, { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(srcDir, dest, {
    recursive: true,
    filter: (from) => {

      if (!path.extname(from)) return true;
      return COPY_EXT.includes(path.extname(from));
    },
  });
  return dest;
}

function copyDoc(id: string): string {
  const dest = path.join(tmpDir, `${id}-doc.md`);
  mkdirSync(tmpDir, { recursive: true });
  if (!existsSync(docFile)) throw new Error('нет docs/analytics-events.md — саботировать нечего');
  writeFileSync(dest, readFileSync(docFile, 'utf8'), 'utf8');
  return dest;
}

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

function cleanup(id: string): void {
  rmSync(path.join(tmpDir, `${id}-src`), { recursive: true, force: true });
  rmSync(path.join(tmpDir, `${id}-doc.md`), { force: true });
}

function addDocRow(docCopy: string, row: string): void {
  const marker = '<!-- events-table:end -->';
  const text = readFileSync(docCopy, 'utf8');
  const at = text.indexOf(marker);
  if (at === -1) throw new Error(`в копии документа нет маркера ${marker}`);
  writeFileSync(docCopy, `${text.slice(0, at)}${row}\n\n${text.slice(at)}`, 'utf8');
}

function addCodeLine(srcCopy: string, line: string): void {
  const target = path.join(srcCopy, 'scripts', 'interactive.ts');
  if (!existsSync(target)) throw new Error('в копии дерева нет scripts/interactive.ts');
  appendFileSync(target, `\n${line}\n`, 'utf8');
}

const undocumentedEvent: SabotageCase = {
  id: 'analytics-undocumented-event',
  gate: 'check:analytics-events',
  describe: "в код добавлено track('foo_bar'), в документ — ничего",
  setup() {
    const srcCopy = copySrcTree(this.id);
    addCodeLine(srcCopy, "track('foo_bar', { placement: 'hero' });");
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-analytics-events.ts',
      '--src',
      argPath(path.join(tmpDir, `${this.id}-src`)),
    ];
  },
  expectOutputContains: 'СОБЫТИЕ БЕЗ ДОКУМЕНТАЦИИ',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const documentedButMissing: SabotageCase = {
  id: 'analytics-documented-but-missing',
  gate: 'check:analytics-events',
  describe: 'в документ вписано событие checkout_start, которого нет в коде',
  setup() {
    const docCopy = copyDoc(this.id);
    addDocRow(docCopy, '| `checkout_start` | человек начал оформление | `step` | `1` · `2` | — |');
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-analytics-events.ts',
      '--doc',
      argPath(path.join(tmpDir, `${this.id}-doc.md`)),
    ];
  },
  expectOutputContains: 'ДОКУМЕНТИРОВАНО, НО НЕ СУЩЕСТВУЕТ',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const LONG_EVENT = `form_open_${'x'.repeat(35)}`;

const nameOverGa4Limit: SabotageCase = {
  id: 'analytics-name-over-ga4-limit',
  gate: 'check:analytics-events',
  describe: `событие названо ${LONG_EVENT.length} символами при лимите GA4 в 40`,
  setup() {
    const srcCopy = copySrcTree(this.id);
    addCodeLine(srcCopy, `track('${LONG_EVENT}', { placement: 'hero' });`);
    const docCopy = copyDoc(this.id);
    addDocRow(docCopy, `| \`${LONG_EVENT}\` | тестовое | \`placement\` | \`hero\` | — |`);
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-analytics-events.ts',
      '--src',
      argPath(path.join(tmpDir, `${this.id}-src`)),
      '--doc',
      argPath(path.join(tmpDir, `${this.id}-doc.md`)),
    ];
  },
  expectOutputContains: 'ЛИМИТ ИМЕНИ GA4',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const directProviderCall: SabotageCase = {
  id: 'analytics-direct-provider-call',
  gate: 'check:analytics-events',
  describe: 'в отложенный модуль вписан прямой вызов window.gtag вместо шины',
  setup() {
    const srcCopy = copySrcTree(this.id);
    addCodeLine(srcCopy, "window.gtag('event', 'messenger_click', { channel: 'telegram' });");
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-analytics-events.ts',
      '--src',
      argPath(path.join(tmpDir, `${this.id}-src`)),
    ];
  },
  expectOutputContains: 'ПРЯМОЕ ОБРАЩЕНИЕ К ПРОВАЙДЕРУ',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

export const cases: SabotageCase[] = [
  undocumentedEvent,
  documentedButMissing,
  nameOverGa4Limit,
  directProviderCall,
];
