
import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NODE_BUG = 'Unable to deserialize cloned data';
const MAX_RETRIES = 2;

function argValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const pattern = argValue('glob', 'tests/unit/**/*.test.ts');
const files = globSync(pattern, { cwd: ROOT }).map((f) => f.split(String.fromCharCode(92)).join('/')).sort();
if (files.length === 0) {
  console.error(`FAIL: по шаблону ${pattern} не найдено ни одного файла тестов`);
  process.exit(1);
}

function run(list) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...list], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  process.stdout.write(out);
  return { code: r.status ?? 1, out };
}

function nodeBugFiles(out) {
  const lines = out.split(/\r?\n/);
  const nestedFail = lines.some((l) => /^\s+not ok /.test(l));
  if (nestedFail) return [];
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^not ok \d+ - (.+\.test\.ts)\s*$/.exec(lines[i]);
    if (!m) continue;
    const tail = lines.slice(i + 1, i + 12).join('\n');
    if (tail.includes(NODE_BUG)) hits.push(m[1].split(String.fromCharCode(92)).join('/'));
  }
  const totalFails = lines.filter((l) => /^not ok /.test(l)).length;
  return hits.length === totalFails ? hits : [];
}

let { code, out } = run(files);
if (code === 0) process.exit(0);

let suspects = nodeBugFiles(out);
if (suspects.length === 0) {
  console.error('\nFAIL: настоящая краснота модульных тестов — повтор не применяется.');
  process.exit(code);
}

for (let attempt = 1; attempt <= MAX_RETRIES && suspects.length > 0; attempt++) {
  console.error(
    `\n⚠️ Ошибка самого Node (nodejs/node#64061) в ${suspects.length} файл(ах): ` +
      `${suspects.map((f) => relative(ROOT, resolve(ROOT, f)).split(String.fromCharCode(92)).join('/')).join(', ')}. ` +
      `Повтор ТОЛЬКО этих файлов, попытка ${attempt} из ${MAX_RETRIES}.`,
  );
  const again = run(suspects);
  if (again.code === 0) {
    console.error('\nPASS: повтор зелёный; первая краснота была ошибкой Node, а не теста.');
    process.exit(0);
  }
  suspects = nodeBugFiles(again.out);
  if (suspects.length === 0) {
    console.error('\nFAIL: на повторе файл упал настоящей ошибкой теста.');
    process.exit(again.code);
  }
}
console.error(`\nFAIL: ошибка Node повторилась ${MAX_RETRIES} раз(а) подряд — это уже не флейк, разбирать.`);
process.exit(1);
