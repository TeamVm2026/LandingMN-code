
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');

function argValue(name: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) {
    console.error(`FAIL: у аргумента --${name} нет значения`);
    process.exit(1);
  }
  return value;
}

function argValues(name: string, fallback: string[]): string[] {
  const argv = process.argv.slice(2);
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== `--${name}`) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      console.error(`FAIL: у аргумента --${name} нет значения`);
      process.exit(1);
    }
    out.push(value);
  }
  return out.length > 0 ? out : fallback;
}

const configArg = argValue('config', 'astro.config.mjs');
const distArg = argValue('dist', 'dist');
const sourceRoots = argValues('scan-source', ['workers']);

const SECRET_NAME_PATTERN = /(_TOKEN|_SECRET|_KEY|CHAT_ID)$/;

function isSecretName(name: string): boolean {
  if (name.startsWith('PUBLIC_')) return false;
  return SECRET_NAME_PATTERN.test(name);
}

const MARK_A = 'КЛИЕНТСКИЙ КОНТЕКСТ';
const MARK_B = 'СЕКРЕТ В БАНДЛЕ';
const MARK_C = 'ФОРМА СЕКРЕТА В БАНДЛЕ';
const MARK_NO_BUILD = 'СБОРКИ НЕТ';
const MARK_NO_SCHEMA = 'СХЕМА НЕ РАЗОБРАНА';
const MARK_NO_SOURCES = 'ИСХОДНИКИ НЕ ОСМОТРЕНЫ';

const failures: string[] = [];

const rel = (file: string): string => path.relative(projectRoot, file).replace(/\\/g, '/');

function positionOf(text: string, index: number): string {
  const before = text.slice(0, index);
  const line = before.split(/\r?\n/).length;
  const column = index - Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'));
  return `${line}:${column}`;
}

const ENV_FIELD_DECL = /(^|[{,;\s])([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*envField\s*\./g;
const CONTEXT_IN_OPTIONS = /context\s*:\s*['"]([A-Za-z]+)['"]/;

const ASTRO_ENV_IMPORT = /import\s*\{([\s\S]*?)\}\s*from\s*['"]astro:env\/(client|server)['"]/g;

const SRC_SCAN_EXT = ['.ts', '.js', '.mjs', '.astro'];
const SRC_SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.astro', '.sabotage-tmp']);

function walkSrc(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SRC_SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkSrc(full, out);
    else if (SRC_SCAN_EXT.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

function checkClientContext(): void {
  const configPath = path.resolve(projectRoot, configArg);
  if (!existsSync(configPath)) {
    console.error(`\nFAIL: нет файла конфигурации ${configArg} — проверять нечего`);
    process.exit(1);
  }

  const text = readFileSync(configPath, 'utf8');
  const declarations: { name: string; index: number }[] = [];
  for (const match of text.matchAll(ENV_FIELD_DECL)) {
    declarations.push({ name: match[2]!, index: match.index! + match[1]!.length });
  }

  if (declarations.length === 0) {
    failures.push(
      `${MARK_NO_SCHEMA}\n` +
        `      в ${rel(configPath)} не найдено ни одного объявления «ИМЯ: envField.…».\n` +
        '      Либо схема исчезла, либо сломался разбор — в обоих случаях проверка A\n' +
        '      перестала проверять что-либо и зелёный прогон ничего не значит.',
    );
  }

  let secretDecls = 0;
  for (const decl of declarations) {
    if (!isSecretName(decl.name)) continue;
    secretDecls++;
    const window = text.slice(decl.index, decl.index + 400);
    const context = CONTEXT_IN_OPTIONS.exec(window)?.[1] ?? '(не указан)';
    if (context === 'client') {
      failures.push(
        `${MARK_A}: ${decl.name} объявлен в env.schema с context: 'client'\n` +
          `      ${rel(configPath)}:${positionOf(text, decl.index)}\n` +
          '      Это НЕ риск, это уже утечка: astro:env с клиентским контекстом подставляет\n' +
          '      значение ЛИТЕРАЛОМ во время сборки, то есть впишет секрет в JS, который\n' +
          '      скачивает посетитель. Удалить объявление. Секреты живут в encrypted-\n' +
          '      переменных проекта Pages и приезжают в context.env в момент запроса.',
      );
    } else {
      failures.push(
        `${MARK_A} в одной правке: ${decl.name} объявлен в env.schema (context: ${context})\n` +
          `      ${rel(configPath)}:${positionOf(text, decl.index)}\n` +
          '      Секрету нечего делать в схеме Astro ни с каким контекстом: функции в\n' +
          "      functions/ читают context.env, а не astro:env. Смена 'server' на 'client'\n" +
          '      это одно слово — и оно превращает объявление в утечку без единого\n' +
          '      предупреждения. Удалить объявление целиком.',
      );
    }
  }

  const srcRoot = path.join(projectRoot, 'src');
  const srcFiles = existsSync(srcRoot) ? walkSrc(srcRoot) : [];
  let imports = 0;
  let secretImports = 0;
  for (const file of srcFiles) {
    const body = readFileSync(file, 'utf8');
    for (const match of body.matchAll(ASTRO_ENV_IMPORT)) {
      imports++;
      const names = match[1]!
        .split(',')
        .map((piece) => piece.trim().split(/\s+as\s+/)[0]!.trim())
        .filter(Boolean);
      for (const name of names) {
        if (!isSecretName(name)) continue;
        secretImports++;
        failures.push(
          `${MARK_A}: ${name} импортируется из astro:env/${match[2]} в ${rel(file)}\n` +
            '      Имя формы секрета не имеет права попадать в src/ вообще: всё, что\n' +
            '      импортировано здесь, проходит сборку Astro и оказывается в бандле.',
        );
      }
    }
  }

  console.log(
    `  A. клиентский контекст: объявлений envField в ${configArg} — ${declarations.length}, ` +
      `из них похожих на секрет — ${secretDecls}`,
  );
  console.log(
    `     импортов из astro:env/* в src/ — ${imports} (файлов просмотрено ${srcFiles.length}), ` +
      `секретных имён среди них — ${secretImports}`,
  );
}

const ENV_FILES = ['.env.local', '.env', '.dev.vars'];

const MIN_VALUE_LENGTH = 12;

function parseEnvFile(file: string): Map<string, string> {
  const values = new Map<string, string>();
  const full = path.join(projectRoot, file);
  if (!existsSync(full)) return values;
  for (const line of readFileSync(full, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at === -1) continue;
    const name = trimmed.slice(0, at).trim();

    let value = trimmed.slice(at + 1).trim();
    const hash = value.indexOf(' #');
    if (hash !== -1) value = value.slice(0, hash).trim();
    values.set(name, value.replace(/^['"]|['"]$/g, '').trim());
  }
  return values;
}

interface SecretValue {
  name: string;
  value: string;
  source: string;
}

function collectSecretValues(): { armed: SecretValue[]; shortNames: string[] } {
  const sources = new Map<string, Map<string, string>>();
  const fromProcess = new Map<string, string>();
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && value.trim() !== '') fromProcess.set(name, value.trim());
  }
  sources.set('process.env', fromProcess);
  for (const file of ENV_FILES) sources.set(file, parseEnvFile(file));

  const names = new Set<string>();
  for (const values of sources.values()) {
    for (const name of values.keys()) if (isSecretName(name)) names.add(name);
  }

  const armed: SecretValue[] = [];
  const shortNames: string[] = [];
  for (const name of [...names].sort()) {

    const seen = new Set<string>();
    let armedForName = 0;
    for (const [source, values] of sources) {
      const value = values.get(name);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      if (value.length < MIN_VALUE_LENGTH) continue;
      armed.push({ name, value, source });
      armedForName++;
    }
    if (armedForName === 0) shortNames.push(name);
  }
  return { armed, shortNames };
}

function checkValuesInBundle(distRoot: string, files: string[], texts: Map<string, string>): void {
  const { armed, shortNames } = collectSecretValues();

  const armedNames = new Set(armed.map((s) => s.name));
  console.log(
    `  B. значенческая: имён по шаблону — ${armedNames.size + shortNames.length}, ` +
      `из них со значением длиной ≥${MIN_VALUE_LENGTH} — ${armedNames.size} ` +
      `(различных значений к поиску — ${armed.length})`,
  );
  if (armed.length > 0) {
    console.log(`     вооружена значениями: ${armed.map((s) => `${s.name} (${s.source})`).join(', ')}`);
  }
  if (shortNames.length > 0) {
    console.log(`     без значения или короче порога: ${shortNames.join(', ')}`);
  }

  if (armed.length === 0) {

    console.log(
      '     значенческая проверка: ПРОВЕРЯТЬ НЕЧЕГО — ни одного значения секрета в окружении.\n' +
        '     Это штатное состояние CI и оно намеренное: боевой токен туда не передаётся вовсе.\n' +
        '     Зелёная B здесь не доказывает НИЧЕГО — доказывают случай саботажа\n' +
        '     secrets-value-in-dist и проверка C ниже, которой окружение не нужно.',
    );
  }

  let hits = 0;
  for (const secret of armed) {
    for (const file of files) {
      const text = texts.get(file)!;
      const at = text.indexOf(secret.value);
      if (at === -1) continue;
      hits++;
      failures.push(
        `${MARK_B}: значение ${secret.name} найдено в собранном файле\n` +
          `      ${rel(file)}:${positionOf(text, at)} (само значение здесь не печатается)\n` +
          '      Этот файл скачивает посетитель. Секрет считается скомпрометированным:\n' +
          '      отозвать и перевыпустить, потом искать, каким путём он туда попал —\n' +
          '      через env.schema (см. проверку A) или литералом в исходнике.',
      );
    }
  }

  const functionsInside = path.join(distRoot, 'functions');
  if (existsSync(functionsInside) && statSync(functionsInside).isDirectory()) {
    failures.push(
      `${MARK_B}: внутри ${distArg}/ лежит каталог functions/\n` +
        '      Серверный код Pages Functions собирает wrangler отдельно и в статику он\n' +
        '      попадать не должен: выложенный как статика, он раздаётся как исходник.',
    );
  }
  const devVarsInside = path.join(distRoot, '.dev.vars');
  if (existsSync(devVarsInside)) {
    failures.push(
      `${MARK_B}: внутри ${distArg}/ лежит файл .dev.vars\n` +
        '      Это файл локальных значений секретов. В раздаваемом каталоге его быть\n' +
        '      не может ни при каких обстоятельствах.',
    );
  }

  console.log(`     файлов просмотрено ${files.length}, вхождений найдено ${hits}`);
}

const TELEGRAM_TOKEN_SHAPE = /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g;

const TURNSTILE_SECRET_SHAPE = /\b0x[A-Za-z0-9_-]{28,}\b/g;

const SHAPES: { name: string; pattern: RegExp }[] = [
  { name: 'токен Telegram-бота', pattern: TELEGRAM_TOKEN_SHAPE },
  { name: 'секретный ключ Turnstile', pattern: TURNSTILE_SECRET_SHAPE },
];

function scanShapes(files: string[], texts: Map<string, string>): number {
  let hits = 0;
  for (const file of files) {
    const text = texts.get(file)!;
    for (const shape of SHAPES) {
      shape.pattern.lastIndex = 0;
      for (const match of text.matchAll(shape.pattern)) {
        hits++;
        failures.push(
          `${MARK_C}: ${shape.name}\n` +
            `      ${rel(file)}:${positionOf(text, match.index!)} — найденная строка здесь НЕ печатается\n` +
            '      Проверка вооружена без единой переменной окружения, поэтому она видит и\n' +
            '      то, чего проверка B увидеть не может: значение, вписанное руками на\n' +
            '      машине, где такой переменной нет. Если это ложное срабатывание —\n' +
            '      СУЖАЙТЕ РЕГУЛЯРКУ ПО ФОРМЕ, не добавляйте исключение по имени файла.',
        );
      }
    }
  }
  return hits;
}

function checkShapesInBundle(files: string[], texts: Map<string, string>): void {
  const hits = scanShapes(files, texts);
  console.log(
    `  C. структурная (окружение не нужно): файлов просмотрено ${files.length}, ` +
      `совпадений по форме ${hits}`,
  );
}

const SOURCE_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.wrangler', '.sabotage-tmp']);

const SOURCE_FILE_MAX_BYTES = 1024 * 1024;

function walkAnyFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SOURCE_SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walkAnyFiles(full, out);
    else if (stat.size <= SOURCE_FILE_MAX_BYTES) out.push(full);
  }
  return out;
}

function checkShapesInSources(): void {
  const files: string[] = [];
  const tried: string[] = [];
  for (const root of sourceRoots) {
    const full = path.resolve(projectRoot, root);
    tried.push(rel(full));
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walkAnyFiles(full, files);
    else files.push(full);
  }

  const texts = new Map<string, string>();
  for (const file of files) {
    try {
      texts.set(file, readFileSync(file, 'utf8'));
    } catch {
      texts.set(file, '');
    }
  }

  const hits = scanShapes(files, texts);

  console.log(
    `  C. структурная по исходникам (${tried.join(', ')}): файлов просмотрено ${files.length}, ` +
      `совпадений по форме ${hits}`,
  );

  if (files.length === 0) {
    failures.push(
      `${MARK_NO_SOURCES}: по корням --scan-source осмотрено 0 файлов\n` +
        `      пробовали: ${tried.join(', ')}\n` +
        '      Ноль осмотренных файлов это НЕ «нечего проверять», а невозможность\n' +
        '      подтвердить, что в исходниках воркера нет вписанного руками секрета:\n' +
        '      сертифицировать отсутствие секрета в файлах, которых гейт не открывал,\n' +
        '      нельзя. Проверьте путь корня — каталог мог переехать или быть\n' +
        '      переименован, и тогда прогон был зелёным, ничего не проверив.',
    );
  }
}

function walkDist(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkDist(full, out);
    else out.push(full);
  }
  return out;
}

function main(): void {
  console.log(
    `--- Страж секретов: критерий 4 (${configArg}, ${distArg}/, исходники: ${sourceRoots.join(', ')}) ---`,
  );
  console.log(`  шаблон имени секрета: ${SECRET_NAME_PATTERN} при явном исключении префикса PUBLIC_`);

  checkClientContext();

  const distRoot = path.resolve(projectRoot, distArg);
  if (!existsSync(distRoot) || !statSync(distRoot).isDirectory()) {
    reportAndExit(
      `${MARK_NO_BUILD}: нет каталога ${distArg}/ — проверки B и C не выполнялись.\n` +
        '      Отсутствие сборки это не «нечего проверять», а невозможность подтвердить\n' +
        '      критерий 4: сертифицировать отсутствие секрета в артефакте, которого нет,\n' +
        '      нельзя. Запустите `npm run build` и повторите. В CI шаг check:secrets\n' +
        '      обязан стоять ПОСЛЕ сборки.',
    );
  }

  const files = walkDist(distRoot);
  if (files.length === 0) {
    reportAndExit(
      `${MARK_NO_BUILD}: каталог ${distArg}/ пуст — проверять нечего, а значит и\n` +
        '      подтверждать нечего. Пустой каталог даёт зелёные B и C ни за что.',
    );
  }

  const texts = new Map<string, string>();
  for (const file of files) {
    try {
      texts.set(file, readFileSync(file, 'utf8'));
    } catch {
      texts.set(file, '');
    }
  }

  checkValuesInBundle(distRoot, files, texts);
  checkShapesInBundle(files, texts);
  checkShapesInSources();

  if (failures.length > 0) {
    console.error(`\nFAIL: страж секретов нашёл ${failures.length} проблем(ы):\n`);
    for (const line of failures) console.error(`  ${line}`);
    console.error(
      '\nКритерий 4 фазы: ни один секрет не встречается в собранном клиентском бандле.\n' +
        'Секреты живут в encrypted-переменных проекта Cloudflare Pages и приезжают в\n' +
        'context.env в момент запроса — ни в схеме astro:env, ни в src/, ни в dist/.',
    );
    process.exit(1);
  }

  console.log(
    '\nPASS: секретов нет — ни по имени в схеме, ни значением в бандле, ни формой ' +
      'ни в бандле, ни в исходниках воркера.',
  );
}

function reportAndExit(message: string): never {
  failures.push(message);
  console.error(`\nFAIL: страж секретов нашёл ${failures.length} проблем(ы):\n`);
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}

main();
