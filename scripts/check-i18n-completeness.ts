
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');

function dictDirFromArgv(): string {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--dir');
  const value = at !== -1 ? argv[at + 1] : undefined;
  if (!value) return path.join(projectRoot, 'src', 'i18n');
  return path.isAbsolute(value) ? value : path.join(projectRoot, value);
}

type DictSet = 'site' | 'bot';

function dictSetFromArgv(): DictSet {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--set');
  if (at === -1) return 'site';
  const value = argv[at + 1];
  if (value === 'site' || value === 'bot') return value;
  console.error(
    `i18n error: --set принимает только site или bot, получено ${JSON.stringify(value)}.`,
  );
  process.exit(1);
}

const dictDir = dictDirFromArgv();
const dictSet = dictSetFromArgv();

const SITE_REQUIRED_KEYS: Record<string, string> = {
  'pages.privacy_sections.3.heading':
    'раздел политики об аналитике и cookies (ANLT-04/CMPL-01). Без него страница не сообщает ни инструментов, ни получателей, ни срока — то, чего требует ст. 8.1',
  'pages.privacy_sections.3.body':
    'тело того же раздела: состав данных, получатели, срок 90 дней, способ отказа',
  'pages.privacy_sections.4.heading':
    'раздел о правах. ⚠️ ОН ОБЯЗАН ОСТАВАТЬСЯ ПОСЛЕДНИМ: PrivacyPage.astro клеит ссылку «написать в Telegram» к последнему разделу по индексу',
  'pages.privacy_sections.4.body': 'тело раздела о правах — единственное место, где сказано, как связаться',
  'pages.privacy_updated':
    'дата редакции. По ней человек понимает, действующий ли перед ним документ; без неё политика читается как брошенная',

  'consent.text':
    'текст запроса согласия (ЕЭЗ/UK/CH). Без него баннер показывает две кнопки без единого слова о том, на что человек соглашается',
  'consent.accept': 'подпись кнопки «разрешить» — без неё это безымянный прямоугольник',
  'consent.decline':
    'подпись кнопки отказа. Пропажа именно её опаснее всех: остаётся одна подписанная кнопка «разрешить», и выбор превращается в оформление',
  'consent.action_off':
    'подпись ЕДИНСТВЕННОЙ кнопки отзыва согласия на странице политики (план 03-13). Она подставляется первой — сразу после того, как элемент показан тому, кто сбор разрешил. Без неё механизм согласия остаётся без обратного хода: разрешивший видит безымянный прямоугольник и не имеет способа отозвать решение, а раздел политики продолжает обещать ему кнопку, которой нет. Это превращает элемент в декорацию, а текст документа — в неправду',
};

const BOT_REQUIRED_KEYS: Record<string, string> = {
  'reply.handoff':
    'фраза передачи менеджеру. Дословный выбор заказчика 22.08.2026 — «бот с передачей менеджеру»: человек жмёт кнопку на сайте и СРАЗУ получает живого человека. Без этой строки первое сообщение бота ничего не передаёт, и бот превращается ровно в то препятствие перед конверсией, ради отсутствия которого его и завели',
  'reply.manager_button':
    'надпись кнопки, ведущей на менеджера. Её пропажа тише всех: текст ответа на месте, кнопка в разметке на месте — и приезжает к человеку безымянным прямоугольником. Безымянная кнопка уже стоила заказчику непонимания, что это вообще кнопка (круг 8 правок Фазы 2.4)',

  'reply.greeting':
    'первая строка ответа НОВОМУ человеку. Стоит в одном тернарнике с reply.repeat_note; при пропаже сообщение начинается сразу с направления, то есть бот отвечает без приветствия и это выглядит поломкой, а не лаконичностью',
  'reply.repeat_note':
    'первая строка ответа ВЕРНУВШЕМУСЯ человеку — единственное место, где бот показывает, что узнал его (BOT-03, «повторный лид»). При пропаже вернувшийся получает ответ без первой строки, и отличить его от нового становится нечем',
};

const REQUIRED_KEYS: Record<string, string> =
  dictSet === 'bot' ? BOT_REQUIRED_KEYS : SITE_REQUIRED_KEYS;

function findDuplicateKeys(text: string): { path: string; line: number }[] {
  const found: { path: string; line: number }[] = [];
  const stack: { keys: Set<string>; path: string; kind: 'object' | 'array'; lastKey: string | null }[] = [];
  let line = 1;
  let i = 0;
  let pendingKey: string | null = null;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\n') line++;
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          value += text[j]! + (text[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (text[j] === '\n') line++;
        value += text[j]!;
        j++;
      }

      let k = j + 1;
      while (k < text.length && /\s/.test(text[k]!)) k++;
      const top = stack[stack.length - 1];
      if (text[k] === ':' && top && top.kind === 'object') {
        const key = JSON.parse('"' + value + '"') as string;
        const full = top.path ? top.path + '.' + key : key;
        if (top.keys.has(key)) found.push({ path: full, line });
        top.keys.add(key);
        pendingKey = full;
      }
      i = j + 1;
      continue;
    }
    if (ch === '{' || ch === '[') {
      const parent = stack[stack.length - 1];
      const here = pendingKey ?? (parent ? parent.path : '');
      stack.push({ keys: new Set(), path: here, kind: ch === '{' ? 'object' : 'array', lastKey: null });
      pendingKey = null;
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      pendingKey = null;
    } else if (ch === ',') {
      pendingKey = null;
    }
    i++;
  }
  return found;
}

const duplicateReport: string[] = [];

function readDict(locale: string): Record<string, unknown> {
  const file = path.join(dictDir, `${locale}.json`);
  const text = readFileSync(file, 'utf8');
  for (const d of findDuplicateKeys(text)) {
    duplicateReport.push(`${locale}.json, строка ${d.line}: ключ «${d.path}» объявлен повторно`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v as Record<string, unknown>, path));
    } else {
      out[path] = v;
    }
  }
  return out;
}

const localeNames = ['mn', 'ru', 'en'] as const;
const locales: Record<string, Record<string, unknown>> = {};
for (const name of localeNames) locales[name] = flatten(readDict(name));

const allKeys = new Set<string>();
for (const name of localeNames) {
  for (const key of Object.keys(locales[name]!)) allKeys.add(key);
}

let hasError = false;

for (const d of duplicateReport) {
  console.error(`i18n error: ДУБЛЬ КЛЮЧА — ${d}. JSON.parse оставит только последнее значение, остальные молча потеряются.`);
  hasError = true;
}

for (const key of allKeys) {
  for (const name of localeNames) {
    if (!(key in locales[name]!)) {
      console.error(`i18n error: key "${key}" is missing from ${name}.json`);
      hasError = true;
    } else if (typeof locales[name]![key] !== 'string') {
      console.error(`i18n error: key "${key}" in ${name}.json is not a string`);
      hasError = true;
    }
  }
}

for (const [key, reason] of Object.entries(REQUIRED_KEYS)) {
  for (const name of localeNames) {
    const value = locales[name]![key];
    if (typeof value !== 'string' || value.trim() === '') {
      console.error(
        `i18n error: ОБЯЗАТЕЛЬНЫЙ КЛЮЧ ОТСУТСТВУЕТ — "${key}" в ${name}.json (набор ${dictSet}).\n` +
          `  зачем он нужен: ${reason}`,
      );
      hasError = true;
    }
  }
}

if (hasError) {
  console.error(`\ni18n completeness check FAILED — see errors above.`);
  process.exit(1);
}
console.log(
  `i18n completeness check passed: ${allKeys.size} keys × ${localeNames.length} locales, ` +
    `all present; ${Object.keys(REQUIRED_KEYS).length} обязательных ключ(а/ей) на месте ` +
    `(набор ${dictSet}, каталог ${path.relative(projectRoot, dictDir).split(path.sep).join('/') || '.'}).`,
);
