
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  COMPANION_SOURCES,
  ENFORCE_HEADER,
  ORIGIN_POLICY,
  REPORT_ONLY_HEADER,
  REPORT_PATH,
  REQUIRED_DIRECTIVES,
  crossCheckManifest,
  isDir,
  parsePolicy,
  readManifestOrigins,
  scanBuild,
  type FetchDirective,
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
const manifestLabel = path.relative(projectRoot, manifestFile).replace(/\\/g, '/');

const MARK_NO_BUILD = 'СБОРКИ НЕТ';
const MARK_EMPTY = 'ОБХОД ПУСТ';
const MARK_NO_POLICY = 'ПОЛИТИКИ НЕТ';
const MARK_ENFORCE = 'ENFORCE В ЧАСТИ A';
const MARK_HASH = 'ХЕШ НЕ В ПОЛИТИКЕ';
const MARK_UNCOVERED = 'ОРИГЕН НЕ ПОКРЫТ';
const MARK_MISSING_SOURCE = 'ОБЪЯВЛЕННЫЙ ИСТОЧНИК ПОТЕРЯН';
const MARK_UNSAFE = 'ПОСЛАБЛЕНИЕ БЕЗ ОСНОВАНИЙ';
const MARK_REQUIRED = 'ДИРЕКТИВА ОТСУТСТВУЕТ';
const MARK_MANIFEST = 'МАНИФЕСТ';
const MARK_REPORT = 'ПРИЁМНИК ОТЧЁТОВ';

interface Failure {
  mark: string;
  detail: string;
}
const failures: Failure[] = [];

function fail(mark: string, detail: string): void {
  failures.push({ mark, detail });
  console.error(`  FAIL [csp] ${detail} (${mark})`);
}

function covers(value: string, origin: string): boolean {
  if (value === origin) return true;
  if (!value.includes('*')) return false;
  const pattern = `^${value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^./]+')}$`;
  return new RegExp(pattern).test(origin);
}

function effectiveValues(policy: Map<string, string[]>, directive: string): string[] {
  const own = policy.get(directive);
  if (own !== undefined) return own;
  return policy.get('default-src') ?? [];
}

function main(): void {
  if (!isDir(distDir)) {
    fail(MARK_NO_BUILD, `каталога ${distLabel} нет — сначала npm run build`);
    return;
  }

  const headersFile = path.join(distDir, '_headers');
  if (!existsSync(headersFile)) {
    fail(MARK_NO_BUILD, `${distLabel}/_headers отсутствует — сборка неполна`);
    return;
  }
  const headersText = readFileSync(headersFile, 'utf8');

  const headerLines = headersText.split(/\r?\n/).map((l) => l.trim());
  const enforceLines = headerLines.filter(
    (l) => l.toLowerCase().startsWith(`${ENFORCE_HEADER.toLowerCase()}:`),
  );
  if (enforceLines.length > 0) {
    fail(
      MARK_ENFORCE,
      `в ${distLabel}/_headers стоит заголовок ${ENFORCE_HEADER} (режим принуждения). ` +
        'Часть A разрешает ТОЛЬКО режим отчётов: enforce требует живого домена и ручной ' +
        'проверки Turnstile/GA4/Clarity/BeMob кликом (критерий 2, часть B). Процедура — docs/ops.md §13',
    );
  }

  const policyLines = headerLines.filter(
    (l) => l.toLowerCase().startsWith(`${REPORT_ONLY_HEADER.toLowerCase()}:`),
  );
  if (policyLines.length === 0) {
    fail(
      MARK_NO_POLICY,
      `в ${distLabel}/_headers нет заголовка ${REPORT_ONLY_HEADER} — ` +
        'пост-сборочное звено scripts/build-csp.ts не отработало (оно часть `npm run build`)',
    );
    return;
  }
  if (policyLines.length > 1) {
    fail(
      MARK_NO_POLICY,
      `заголовков ${REPORT_ONLY_HEADER} в ${distLabel}/_headers ${String(policyLines.length)}, ` +
        'а должен быть один: браузер применил бы ПЕРЕСЕЧЕНИЕ политик, то есть более строгую, чем собрана',
    );
  }

  const policyValue = policyLines[0].slice(policyLines[0].indexOf(':') + 1).trim();
  const policy = parsePolicy(policyValue);
  if (policy.size === 0) {
    fail(MARK_EMPTY, 'значение политики пусто — разбирать нечего');
    return;
  }

  for (const directive of REQUIRED_DIRECTIVES) {
    if (!policy.has(directive)) {
      fail(MARK_REQUIRED, `в политике нет обязательной директивы ${directive}`);
    }
  }

  const reportValues = policy.get('report-uri') ?? [];
  if (!reportValues.includes(REPORT_PATH)) {
    fail(
      MARK_REPORT,
      `report-uri указывает на «${reportValues.join(' ') || '<пусто>'}», а приёмник живёт по ${REPORT_PATH}`,
    );
  }
  const endpointFile = path.join(projectRoot, 'functions', 'api', 'csp-report.ts');
  if (!existsSync(endpointFile)) {
    fail(
      MARK_REPORT,
      'functions/api/csp-report.ts отсутствует — политика обещает адрес, которого нет: ' +
        'нарушения уходили бы в 404 и не доезжали никуда',
    );
  }

  const scan = scanBuild(distDir);
  if (scan.docs.length === 0) {
    fail(MARK_EMPTY, `в ${distLabel} ни одного .html — проверять политику не на чем`);
    return;
  }
  if (scan.inlineScripts.length === 0) {
    fail(
      MARK_EMPTY,
      'в сборке не найдено ни одного инлайн-скрипта — перехват меток исчез либо разбор сломан ' +
        '(check:perf утверждает, что он ровно один)',
    );
    return;
  }

  const scriptSrc = policy.get('script-src') ?? [];
  for (const block of scan.inlineScripts) {
    if (!scriptSrc.includes(`'${block.hash}'`)) {
      fail(
        MARK_HASH,
        `инлайн-скрипт (${String(block.bytes)} Б, документов ${String(block.files.length)}, ` +
          `первый — ${block.files[0]}) имеет хеш '${block.hash}', которого нет в script-src. ` +
          'Заголовок разошёлся с артефактом: пересоберите (`npm run build`)',
      );
    }
  }
  const styleSrc = policy.get('style-src') ?? [];
  for (const block of scan.inlineStyles) {
    if (!styleSrc.includes(`'${block.hash}'`) && !styleSrc.includes("'unsafe-inline'")) {
      fail(
        MARK_HASH,
        `инлайн-стиль (${String(block.bytes)} Б, первый — ${block.files[0]}) имеет хеш ` +
          `'${block.hash}', которого нет в style-src`,
      );
    }
  }

  const attrTotal = scan.styleAttrs.reduce((sum, s) => sum + s.count, 0);
  const inlineStyleTotal = scan.inlineStyles.length;
  for (const [directive, values] of policy) {
    if (values.includes("'unsafe-eval'")) {
      fail(
        MARK_UNSAFE,
        `${directive} содержит 'unsafe-eval'. Запрещено безусловно: ни один наш скрипт не ` +
          'исполняет строк, а послабление снимает главную защиту от внедрения',
      );
    }
    if (!values.includes("'unsafe-inline'")) continue;

    if (directive === 'script-src' || directive === 'script-src-elem' || directive === 'script-src-attr') {
      fail(
        MARK_UNSAFE,
        `${directive} содержит 'unsafe-inline'. Запрещено безусловно: инлайн-скрипт в сборке ` +
          `ровно ${String(scan.inlineScripts.length)}, и у него ЕСТЬ хеш — послабление здесь не нужно ` +
          'ни для чего, кроме как впустить чужой скрипт',
      );
    } else if (directive === 'style-src' || directive === 'style-src-elem') {
      if (inlineStyleTotal === 0) {
        fail(
          MARK_UNSAFE,
          `${directive} содержит 'unsafe-inline', но инлайн-стилей в сборке НЕ НАЙДЕНО. ` +
            'Послабление без находки — это разрешение впрок, а впрок разрешают ровно то, чем потом пользуются',
        );
      }
    } else if (directive === 'style-src-attr') {
      if (attrTotal === 0) {
        fail(
          MARK_UNSAFE,
          `style-src-attr содержит 'unsafe-inline', но атрибутов style=" в сборке НЕ НАЙДЕНО ` +
            '(проверено по всем документам). Послабление без находки запрещено',
        );
      }
    }
  }

  const manifestOrigins = readManifestOrigins(manifestFile);
  if (manifestOrigins.length === 0) {
    fail(MARK_MANIFEST, `в ${manifestLabel} нет таблицы оригенов — сверять состав политики не с чем`);
  }
  for (const problem of crossCheckManifest(manifestOrigins)) fail(MARK_MANIFEST, problem);

  let declaredSources = 0;
  for (const origin of manifestOrigins) {
    const decision = ORIGIN_POLICY[origin];
    if (decision === undefined) continue;
    for (const directive of decision.directives) {
      declaredSources++;
      if (!(policy.get(directive) ?? []).includes(origin)) {
        fail(
          MARK_MISSING_SOURCE,
          `${origin} объявлен для директивы ${directive}, но в политике его там нет. ` +
            'Похоже, заголовок собран из локальной сборки, где этого хоста нет по env ' +
            '(пустые PUBLIC_TURNSTILE_SITEKEY/PUBLIC_GA_ID/PUBLIC_CLARITY_ID)',
        );
      }
    }
  }
  for (const companion of COMPANION_SOURCES) {
    for (const directive of companion.directives) {
      declaredSources++;
      if (!(policy.get(directive) ?? []).includes(companion.source)) {
        fail(
          MARK_MISSING_SOURCE,
          `${companion.source} объявлен спутником для ${directive} (${companion.why}), но в политике его нет`,
        );
      }
    }
  }

  interface Uncovered {
    directive: FetchDirective | null;
    from: string;
    place: string;
  }
  const uncovered = new Map<string, Uncovered>();
  let checkedUses = 0;
  let navigationUses = 0;

  for (const use of scan.uses) {
    if (use.origin === scan.siteOrigin) continue;
    const decision = ORIGIN_POLICY[use.origin];

    if (decision === undefined) {
      if (!uncovered.has(use.origin)) {
        uncovered.set(use.origin, { directive: use.directive, from: use.from, place: use.place });
      }
      continue;
    }

    if (decision.directives.length === 0) {
      navigationUses++;
      continue;
    }

    checkedUses++;
    if (use.directive === null) {

      const anywhere = decision.directives.some((directive) =>
        effectiveValues(policy, directive).some((value) => covers(value, use.origin)),
      );
      if (!anywhere && !uncovered.has(use.origin)) {
        uncovered.set(use.origin, { directive: null, from: use.from, place: use.place });
      }
      continue;
    }

    const ok = effectiveValues(policy, use.directive).some((value) => covers(value, use.origin));
    if (!ok && !uncovered.has(use.origin)) {
      uncovered.set(use.origin, { directive: use.directive, from: use.from, place: use.place });
    }
  }

  for (const [origin, where] of uncovered) {
    const needed = where.directive ?? 'подходящей директивы';
    fail(
      MARK_UNCOVERED,
      `${origin} встречается в сборке (${where.from}, ${where.place}), но политика его не покрывает — ` +
        `не хватает ${needed}. Заявите хост в ${manifestLabel} и опишите директивы в scripts/lib/csp-sources.ts`,
    );
  }

  if (declaredSources === 0) {
    fail(MARK_EMPTY, 'ни одного объявленного источника — таблица решений о CSP пуста либо не прочитана');
  }
  if (scan.uses.length === 0) {
    fail(MARK_EMPTY, 'в сборке не найдено ни одного внешнего адреса — разбор тегов и чанков сломан');
  }

  console.log(`PASS [обход] ${distLabel} — документов ${String(scan.docs.length)}, чанков ${String(scan.assets)}`);
  console.log(
    `PASS [инлайн] скриптов ${String(scan.inlineScripts.length)} ` +
      `(${scan.inlineScripts.map((b) => `${String(b.bytes)} Б`).join(', ')}), ` +
      `стилей ${String(inlineStyleTotal)} ` +
      `(${scan.inlineStyles.map((b) => `${String(b.bytes)} Б`).join(', ')}), ` +
      `атрибутов style=" ${String(attrTotal)}` +
      (attrTotal === 0 ? '' : ` в ${scan.styleAttrs.map((s) => `${s.file}×${String(s.count)}`).join(', ')}`),
  );
  console.log(
    `PASS [покрытие] употреблений внешних оригенов ${String(scan.uses.length)}: ` +
      `требуют покрытия ${String(checkedUses)}, ` +
      `навигация без покрытия ${String(navigationUses)} (CSP её не ограничивает), ` +
      `объявленных источников в политике ${String(declaredSources)}`,
  );
  console.log(`PASS [режим] ${REPORT_ONLY_HEADER}, режим принуждения отсутствует`);
  console.log(`PASS [директивы] ${String(policy.size)}:`);
  for (const [name, values] of policy) console.log(`    ${name}: ${values.join(' ')}`);
}

main();

const shape =
  `Гейт CSP по ${distLabel}: ` +
  `оригенов в манифесте ${String(readManifestOrigins(manifestFile).length)}, ` +
  `спутников ${String(COMPANION_SOURCES.length)}, ` +
  `нарушений ${String(failures.length)}.`;

if (failures.length > 0) {
  console.error(`\n${shape}`);
  process.exit(1);
}
console.log(`\n${shape}`);
