
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKENS_FILE = join(ROOT, 'src', 'styles', 'tokens.css');
const SCAN_DIRS = ['src', 'functions'];
const EXTENSIONS = ['.astro', '.css', '.ts', '.tsx', '.js', '.mjs', '.html'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.astro']);

const ALLOWED_UNUSED: Record<string, string> = {

  '--bg-soft':
    'пара к --bg в раскладке 60/30/10 (tokens.css §1.1); единственный потребитель — краска страницы — переписан 03.09.2026 на тон, снятый замером стыка с фотографией первого экрана',

  '--gold-area': 'контракт золота UI-SPEC §6.2: крупная золотая площадь обязана брать этот токен; сегодня таких площадей на странице нет',

  '--green': 'состояние успеха, Фаза 4',
  '--blue': 'служебный акцент палитры, зафиксирован UI-SPEC',

  '--panel': 'верхняя ступень лестницы поверхностей (§1.1, доля 30 % палитры); потребители ушли на материал стекла §1.4 31.08.2026',
  '--panel-soft': 'базовая поверхность лестницы высот',
  '--shadow-panel': 'база, от которой считается --shadow-card-warm',

  '--scene-fade':
    'ширина растушёвки сцены; значение раскрыто литералом 4 раза в Hero.astro, потому что var() внутри mask-* запрещён правилом 1 check:mask-safety (WebKit роняет объявление целиком) — токен остаётся единственным названным местом этого числа',
};

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

const tokensSource = stripComments(readFileSync(TOKENS_FILE, 'utf8'));

const declared = new Set<string>();
for (const match of tokensSource.matchAll(/(--[a-z0-9-]+)\s*:/gi)) {
  declared.add(match[1]);
}

const used = new Set<string>();
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const match of text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      used.add(match[1]);
    }
  }
}

const dead: string[] = [];
const staleAllowances: string[] = [];

for (const token of [...declared].sort()) {
  if (used.has(token)) {
    if (token in ALLOWED_UNUSED) staleAllowances.push(`${token} — снова используется`);
    continue;
  }
  if (token in ALLOWED_UNUSED) continue;
  dead.push(token);
}

for (const token of Object.keys(ALLOWED_UNUSED)) {
  if (!declared.has(token)) staleAllowances.push(`${token} — больше не объявлен в tokens.css`);
}

let failed = false;

if (dead.length > 0) {
  failed = true;
  console.error(`Мёртвых токенов: ${dead.length}. Объявлены в tokens.css, не используются нигде:\n`);
  for (const token of dead) console.error(`  ${token}`);
  console.error(
    '\nЛибо удалите их, либо внесите в ALLOWED_UNUSED в scripts/check-dead-tokens.ts' +
      '\nс причиной, по которой токен живёт без потребителей.',
  );
}

if (staleAllowances.length > 0) {
  failed = true;
  console.error(
    `\nУстаревших исключений: ${staleAllowances.length}. Запись в ALLOWED_UNUSED ` +
      'больше не нужна:\n',
  );
  for (const token of staleAllowances) console.error(`  ${token}`);
}

if (failed) process.exit(1);

const allowedAndDeclared = Object.keys(ALLOWED_UNUSED).filter((t) => declared.has(t)).length;
const usedAndDeclared = [...declared].filter((t) => used.has(t)).length;
console.log(
  `Dead-token check passed: ${declared.size} токен(ов) объявлено, ` +
    `${usedAndDeclared} использованы, ${allowedAndDeclared} разрешены явно.`,
);
