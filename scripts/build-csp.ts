
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  BASE_DIRECTIVES,
  COMPANION_SOURCES,
  ENFORCE_HEADER,
  ORIGIN_POLICY,
  REPORT_ONLY_HEADER,
  buildPolicy,
  crossCheckManifest,
  isDir,
  readManifestOrigins,
  scanBuild,
} from './lib/csp-sources.ts';

const projectRoot = path.resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at !== -1 ? argv[at + 1] : undefined;
}
function resolveArg(value: string | undefined, fallback: string): string {
  if (value === undefined) return path.join(projectRoot, fallback);
  return path.isAbsolute(value) ? value : path.join(projectRoot, value);
}

const distDir = resolveArg(argValue('--dist'), 'dist');
const manifestFile = resolveArg(argValue('--manifest'), path.join('docs', 'external-links.md'));
const distLabel = path.relative(projectRoot, distDir).replace(/\\/g, '/') || 'dist';

const ALL_PAGES_BLOCK = '/*';

const problems: string[] = [];
function fail(mark: string, detail: string): void {
  problems.push(`${mark}: ${detail}`);
  console.error(`  FAIL [csp] ${detail} (${mark})`);
}

function insertIntoBlock(text: string, line: string): string | null {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === ALL_PAGES_BLOCK);
  if (at === -1) return null;

  let end = at + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end++;

  const cleaned = lines.filter(
    (l, i) => !(i > at && i < end && l.trim().toLowerCase().startsWith(`${REPORT_ONLY_HEADER.toLowerCase()}:`)),
  );
  const shift = lines.length - cleaned.length;
  cleaned.splice(end - shift, 0, `  ${line}`);
  return cleaned.join('\n');
}

function main(): void {
  if (!isDir(distDir)) {
    fail('СБОРКИ НЕТ', `каталога ${distLabel} нет — сначала astro build`);
    return report();
  }

  const scan = scanBuild(distDir);

  if (scan.docs.length === 0) {
    fail('ОБХОД ПУСТ', `в ${distLabel} ни одного .html — собирать политику не из чего`);
    return report();
  }
  if (scan.inlineScripts.length === 0) {
    fail(
      'ОБХОД ПУСТ',
      'ни одного инлайн-скрипта в сборке — перехват меток атрибуции исчез либо разбор сломан ' +
        '(check:perf утверждает, что он ровно один и весит 1442 Б)',
    );
    return report();
  }

  const manifestOrigins = readManifestOrigins(manifestFile);
  if (manifestOrigins.length === 0) {
    fail('МАНИФЕСТ НЕ РАЗОБРАН', `в ${path.relative(projectRoot, manifestFile)} нет таблицы оригенов`);
    return report();
  }
  for (const problem of crossCheckManifest(manifestOrigins)) fail('МАНИФЕСТ', problem);

  const known = new Set(Object.keys(ORIGIN_POLICY));
  const unknown = new Map<string, OriginPlace>();
  for (const use of scan.uses) {
    if (use.origin === scan.siteOrigin) continue;
    if (known.has(use.origin)) continue;
    if (!unknown.has(use.origin)) unknown.set(use.origin, { place: use.place, from: use.from });
  }
  for (const [origin, where] of unknown) {
    fail(
      'ОРИГЕН НЕ ЗАЯВЛЕН',
      `${origin} встречается в сборке (${where.from}, ${where.place}), но решения о нём нет — ` +
        'заявите хост в docs/external-links.md и опишите директивы в scripts/lib/csp-sources.ts',
    );
  }
  if (problems.length > 0) return report();

  const policy = buildPolicy({
    scriptHashes: scan.inlineScripts.map((b) => b.hash),
    styleHashes: scan.inlineStyles.map((b) => b.hash),
    manifestOrigins,
    styleAttrsFound: scan.styleAttrs.reduce((sum, s) => sum + s.count, 0),
  });

  if (policy.value.includes(`${ENFORCE_HEADER}:`)) {
    fail('ENFORCE ЗАПРЕЩЁН', 'в значении политики оказалось имя enforce-заголовка');
    return report();
  }

  const headersFile = path.join(distDir, '_headers');
  if (!existsSync(headersFile)) {
    fail('НЕТ _headers', `${distLabel}/_headers отсутствует — public/_headers не скопирован сборкой`);
    return report();
  }
  const before = readFileSync(headersFile, 'utf8');

  const line = `${REPORT_ONLY_HEADER}: ${policy.value}`;
  const after = insertIntoBlock(before, line);
  if (after === null) {
    fail('НЕТ БЛОКА', `в ${distLabel}/_headers нет блока "${ALL_PAGES_BLOCK}" — политике некуда встать`);
    return report();
  }
  writeFileSync(headersFile, after, 'utf8');

  console.log(`\nПолитика собрана из ${distLabel} (режим отчётов, enforce НЕ включён).`);
  console.log(`  документов осмотрено: ${scan.docs.length}, чанков: ${scan.assets}`);
  console.log(`  инлайн-скриптов: ${scan.inlineScripts.length}`);
  for (const block of scan.inlineScripts) {
    console.log(`    ${block.hash} — ${block.bytes} Б, документов ${block.files.length}`);
  }
  console.log(`  инлайн-стилей <style>: ${scan.inlineStyles.length}`);
  for (const block of scan.inlineStyles) {
    console.log(`    ${block.hash} — ${block.bytes} Б, документов ${block.files.length}`);
  }
  const attrTotal = scan.styleAttrs.reduce((sum, s) => sum + s.count, 0);
  console.log(
    `  атрибутов style=": ${attrTotal}` +
      (attrTotal === 0
        ? " — послабление style-src-attr 'unsafe-inline' НЕ включено"
        : ` в ${scan.styleAttrs.length} документ(ах): ${scan.styleAttrs.map((s) => s.file).join(', ')}`),
  );
  console.log(`  директив в политике: ${policy.directives.size}`);
  for (const [name, values] of policy.directives) {
    console.log(`    ${name}: ${values.join(' ')}`);
  }

  const external = [...new Set([...manifestOrigins].filter((o) => (ORIGIN_POLICY[o]?.directives.length ?? 0) > 0))];
  const navigation = manifestOrigins.filter((o) => (ORIGIN_POLICY[o]?.directives.length ?? 0) === 0);
  console.log(
    `  оригенов из манифеста: ${manifestOrigins.length} ` +
      `(в политику вошли ${external.length}, не входят ${navigation.length}: ${navigation.join(', ')})`,
  );
  console.log(
    `  спутников, которых в сборке не бывает по построению: ${COMPANION_SOURCES.length} — ` +
      COMPANION_SOURCES.map((c) => c.source).join(', '),
  );
  console.log(`  базовых директив-решений: ${BASE_DIRECTIVES.length}`);
  console.log(
    `  длина заголовка: ${Buffer.byteLength(line, 'utf8')} Б ` +
      `(значение ${Buffer.byteLength(policy.value, 'utf8')} Б)`,
  );
  console.log(`  записано: ${distLabel}/_headers, блок ${ALL_PAGES_BLOCK}`);
}

interface OriginPlace {
  place: string;
  from: string;
}

function report(): void {
  if (problems.length > 0) {
    console.error(`\nПолитика НЕ собрана: нарушений ${problems.length}. Сборка непригодна к выкладке.`);
    process.exit(1);
  }
}

main();
report();
