
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');

const PREVIEW_HOST_PATTERN = /(^|\.)pages\.dev$|^localhost$|^127\.0\.0\.1$/;

function readEnv(name: string): string {
  const fromProcess = process.env[name];
  if (typeof fromProcess === 'string') return fromProcess.trim();

  for (const file of ['.env.local', '.env']) {
    const full = path.join(projectRoot, file);
    if (!existsSync(full)) continue;
    for (const line of readFileSync(full, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const at = trimmed.indexOf('=');
      if (at === -1) continue;
      if (trimmed.slice(0, at).trim() !== name) continue;

      let value = trimmed.slice(at + 1).trim();
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
      return value.replace(/^['"]|['"]$/g, '').trim();
    }
  }
  return '';
}

function main(): void {
  const siteUrl = readEnv('PUBLIC_SITE_URL');
  const sitekey = readEnv('PUBLIC_TURNSTILE_SITEKEY');

  let host = '';
  try {
    host = new URL(siteUrl).hostname;
  } catch {
    host = '';
  }
  const isPreview = host === '' || PREVIEW_HOST_PATTERN.test(host);

  console.log('--- Страж конфигурации Turnstile ---');
  console.log(`  домен сборки:              ${host || '(не задан)'} — режим ${isPreview ? 'превью' : 'БОЕВОЙ'}`);
  console.log(`  PUBLIC_TURNSTILE_SITEKEY:  ${sitekey ? 'задан' : '(пусто)'}`);

  if (sitekey) {
    console.log('\nPASS: ключ виджета приходит из окружения и задан.');
    return;
  }

  if (isPreview) {
    console.log(
      '\nПРЕДУПРЕЖДЕНИЕ: PUBLIC_TURNSTILE_SITEKEY пуст — виджета в сборке нет.\n' +
        '  На превью и localhost это ШТАТНОЕ состояние всей Фазы 4: форма проверяется\n' +
        '  без капчи, серверная половина до появления своего секрета отвечает 503.\n' +
        '  Как только PUBLIC_SITE_URL станет боевым доменом, эта проверка начнёт\n' +
        '  валить сборку.',
    );
    console.log('\nPASS (с предупреждением): домен не боевой, выключенный Turnstile допустим.');
    return;
  }

  console.error(
    '\nFAIL: TURNSTILE НА БОЕВОМ ДОМЕНЕ НЕ НАСТРОЕН\n' +
      `      домен ${host}, а PUBLIC_TURNSTILE_SITEKEY пуст — форма запущена в прод\n` +
      '      без единой преграды для ботов. Honeypot отсекает только примитивные\n' +
      '      скрипты, лимит по IP — только залпы с одного адреса; целевой спам с\n' +
      '      ротацией IP не остановит ни то, ни другое, и чат менеджеров зальёт\n' +
      '      мусором вперемешку с настоящими лидами.\n' +
      '\n' +
      '      Отличить это состояние от штатного «выключено на время Фазы 4»\n' +
      '      по внешнему виду сайта НЕВОЗМОЖНО — потому и существует этот гейт.\n' +
      '\n' +
      '      Что сделать: взять Sitekey виджета `landingmn-lead-form`\n' +
      '      (Cloudflare → Turnstile → виджет → Sitekey) и задать\n' +
      '      PUBLIC_TURNSTILE_SITEKEY ПЕРЕМЕННОЙ РЕПОЗИТОРИЯ GITHUB\n' +
      '      (Settings → Secrets and variables → Actions → Variables), откуда её\n' +
      '      берёт .github/workflows/deploy.yml. Не в панели Cloudflare Pages:\n' +
      '      `wrangler pages deploy ./dist` грузит уже собранный каталог, и система\n' +
      '      сборки Cloudflare — единственный потребитель её переменных — не\n' +
      '      запускается. Парный СЕКРЕТ (TURNSTILE_SECRET_KEY) живёт отдельно, в\n' +
      '      секретах проекта Pages: docs/ops.md §3.',
  );
  process.exit(1);
}

main();
