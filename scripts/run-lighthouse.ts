
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { GUARDED_PORTS, occupiedPorts, portGuardMessage, checkBuildFreshness, freshnessGuardMessage } from './lib/preflight.ts';
import { unexpectedConsoleErrors, type ConsoleErrorItem } from './lib/off-cloudflare.ts';
import { calibrateCpu, CPU_REFERENCE_BENCHMARK, CPU_DEFAULT_MULTIPLIER } from './lib/cpu-calibration.ts';

const SEED_LEAD = process.argv.includes('--seed-lead');

const LEAD_STATE_KEY = 'lmn_lead';
const leadStateValue = (): string =>
  JSON.stringify({ v: 1, at: Date.now(), direction: 'bank' });

const projectRoot = path.resolve(import.meta.dirname, '..');

const PORT = Number(process.env.PREVIEW_PORT ?? 4321);
const PATHS: Record<string, string> = { mn: '/', ru: '/ru/', en: '/en/' };

const THRESHOLDS = { perf: 90, a11y: 90, seo: 95, bp: 90, lcpSeconds: 2.5 };

const LH_RUNS = Math.max(1, Number(process.env.LH_RUNS ?? (process.env.CI ? 5 : 1)));

interface LhrLike {
  categories: Record<string, { score: number | null }>;
  audits: Record<string, { numericValue?: number; displayValue?: string; details?: unknown }>;
  environment?: { benchmarkIndex?: number };
  configSettings?: { throttling?: { cpuSlowdownMultiplier?: number; rttMs?: number; throughputKbps?: number } };
}

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

const CLARITY_ID = readEnv('PUBLIC_CLARITY_ID');

function clarityIdInBuild(id: string): boolean {
  const assetsDir = path.join(projectRoot, 'dist', '_astro');
  if (!existsSync(assetsDir)) return false;
  return readdirSync(assetsDir)
    .filter((f) => f.endsWith('.js'))
    .some((f) => readFileSync(path.join(assetsDir, f), 'utf8').includes(id));
}

function clarityRequests(items: { url?: string }[]): number {
  let hits = 0;
  for (const item of items) {
    if (typeof item.url !== 'string') continue;
    try {
      const host = new URL(item.url).hostname;
      if (host === 'clarity.ms' || host.endsWith('.clarity.ms')) hits += 1;
    } catch {
      /* */
    }
  }
  return hits;
}

function resolveChromePath(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const roots = [
    path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright'),
    path.join(process.env.HOME ?? '', '.cache', 'ms-playwright'),
    '/root/.cache/ms-playwright',
  ].filter((p) => p.length > 0 && existsSync(p));

  for (const base of roots) {
    for (const dir of readdirSync(base).filter((d) => d.startsWith('chromium-'))) {
      const candidate = [
        path.join(base, dir, 'chrome-win', 'chrome.exe'),
        path.join(base, dir, 'chrome-linux', 'chrome'),
        path.join(base, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      ].find((c) => existsSync(c));
      if (candidate) return candidate;
    }
  }
  return undefined;
}

async function waitReady(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://localhost:${PORT}/`);
      if (r.ok) return;
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('preview-сервер не поднялся за отведённое время');
}

async function main(): Promise<void> {
  const freshness = checkBuildFreshness(projectRoot);
  if (!freshness.fresh) {
    console.error(freshnessGuardMessage(freshness));
    process.exit(1);
  }

  const guardedPorts = GUARDED_PORTS.map((port) => (port === 4321 ? PORT : port));
  const occupied = await occupiedPorts(guardedPorts);
  if (occupied.length > 0) {
    console.error(portGuardMessage(occupied));
    process.exit(1);
  }

  const chromePath = resolveChromePath();
  if (!chromePath) {
    console.error('FAIL: не найден Chrome. Задать CHROME_PATH вручную.');
    process.exit(1);
  }
  console.log(`Chrome: ${chromePath}`);

  const clarityArmed = CLARITY_ID.length > 0;
  const clarityBuilt = clarityArmed && clarityIdInBuild(CLARITY_ID);
  if (clarityArmed && !clarityBuilt) {

    console.error(
      'FAIL: PUBLIC_CLARITY_ID задан, но идентификатора нет в dist/_astro/*.js.\n' +
        '      Сборка сделана БЕЗ Clarity, а прогон считает, что он включён —\n' +
        '      число досталось бы не той конфигурации. Пересоберите с тем же\n' +
        '      окружением, с каким запускаете прогон (или перекройте переменную\n' +
        '      пустым значением и здесь тоже).',
    );
    process.exit(1);
  }
  console.log(
    clarityBuilt
      ? `Clarity в сборке: ДА (${CLARITY_ID}) — прогон обязан увидеть запрос к clarity.ms`
      : 'Clarity в сборке: нет (пусто = выключено) — требование запроса к clarity.ms не применяется',
  );

  const server = spawn(
    process.execPath,
    [
      path.join('node_modules', 'astro', 'bin', 'astro.mjs'),
      'preview',
      '--port',
      String(PORT),
      '--host',
      '127.0.0.1',
    ],
    {
      cwd: projectRoot,
      stdio: 'ignore',
    },
  );

  let failures = 0;
  try {
    await waitReady();

    const lighthouse = (await import('lighthouse')).default;
    const chromeLauncher = await import('chrome-launcher');
    const chrome = await chromeLauncher.launch({
      chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
      chromePath,
    });

    const { throttling: lhThrottling } = await import('lighthouse/core/config/constants.js');
    const calibrationRun = await lighthouse(
      `http://localhost:${PORT}/`,
      { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance'] } as never,
      undefined as never,
    );
    const benchmarkIndex = (calibrationRun?.lhr as LhrLike | undefined)?.environment?.benchmarkIndex;
    const cpu = calibrateCpu(benchmarkIndex, process.env.LH_CPU_MULTIPLIER);

    const throttlingSettings = { ...lhThrottling.mobileSlow4G, cpuSlowdownMultiplier: cpu.multiplier };
    console.log(
      `Процессор: benchmarkIndex ${benchmarkIndex === undefined ? '—' : Math.round(benchmarkIndex)}` +
        (cpu.source === 'override'
          ? ` → множитель ${cpu.multiplier}× ЗАДАН ВРУЧНУЮ (LH_CPU_MULTIPLIER)`
          : ` → множитель ${cpu.multiplier}× (опора ${CPU_REFERENCE_BENCHMARK} = ${CPU_DEFAULT_MULTIPLIER}×; без калибровки было бы ${CPU_DEFAULT_MULTIPLIER}×)`) +
        (cpu.clamped ? ' — ⚠️ УПЁРСЯ В ГРАНИЦУ, машина вне диапазона честной эмуляции' : ''),
    );

    let clearCache: (() => Promise<void>) | undefined;

    if (SEED_LEAD) {
      const { chromium } = await import('playwright');
      const browser = await chromium.connectOverCDP(`http://localhost:${chrome.port}`);
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      const seedPage = await ctx.newPage();
      await seedPage.goto(`http://localhost:${PORT}/`);
      const written = await seedPage.evaluate(
        ({ key, value }: { key: string; value: string }) => {
          window.localStorage.setItem(key, value);
          return window.localStorage.getItem(key);
        },
        { key: LEAD_STATE_KEY, value: leadStateValue() },
      );

      const holder = await ctx.newPage();
      const cdp = await ctx.newCDPSession(holder);
      clearCache = async () => {
        await cdp.send('Network.clearBrowserCache');
      };
      await clearCache();
      await seedPage.close();

      if (written === null) throw new Error('lmn_lead НЕ записан — замер был бы фикцией');
      console.log(`  seed: ${LEAD_STATE_KEY} = ${written}`);
    }

    console.log('\nLighthouse mobile (эмуляция среднего Android, медленный 4G):');
    try {
      for (const [locale, p] of Object.entries(PATHS)) {

        const samples: {
          perf: number;
          a11y: number;
          bp: number;
          seo: number;
          lcpSeconds: number;
          cls: string;
          tbt: string;
          clarityHits: number;
          lhr: LhrLike;
        }[] = [];

        for (let attempt = 1; attempt <= LH_RUNS; attempt++) {
          if (clearCache) await clearCache();

          const result = await lighthouse(
            `http://localhost:${PORT}${p}`,
            {
              port: chrome.port,
              output: 'json',
              logLevel: 'error',

              ...(SEED_LEAD ? { disableStorageReset: true } : {}),
              throttling: throttlingSettings,
            } as never,
            undefined as never
          );
          if (!result) throw new Error(`Lighthouse не вернул результат для ${locale}`);
          const r = result.lhr as LhrLike;
          const applied = r.configSettings?.throttling;
          if (
            applied?.cpuSlowdownMultiplier !== cpu.multiplier ||
            applied?.rttMs !== lhThrottling.mobileSlow4G.rttMs ||
            applied?.throughputKbps !== lhThrottling.mobileSlow4G.throughputKbps
          ) {
            throw new Error(
              `Lighthouse применил не те настройки замедления (${JSON.stringify(applied)}), ` +
                `ожидались процессор ${cpu.multiplier}× и сеть мобильного 4G — это отказ прибора, а не замер`,
            );
          }
          const rc = r.categories;
          const ra = r.audits;

          const raw = ra['largest-contentful-paint']?.numericValue;
          if (typeof raw !== 'number' || !Number.isFinite(raw)) {
            throw new Error(
              `Lighthouse не отдал LCP для ${locale} (прогон ${attempt} из ${LH_RUNS}). ` +
                'Это отказ измерения, а не хороший результат.',
            );
          }

          let hits = 0;
          if (clarityBuilt) {
            const netItems =
              ((ra['network-requests']?.details as { items?: { url?: string }[] } | undefined)
                ?.items ?? []);
            hits = clarityRequests(netItems);
          }

          samples.push({
            perf: Math.round((rc.performance.score ?? 0) * 100),
            a11y: Math.round((rc.accessibility.score ?? 0) * 100),
            bp: Math.round((rc['best-practices'].score ?? 0) * 100),
            seo: Math.round((rc.seo.score ?? 0) * 100),
            lcpSeconds: raw / 1000,
            cls: ra['cumulative-layout-shift'].displayValue ?? '',
            tbt: ra['total-blocking-time'].displayValue ?? '',
            clarityHits: hits,
            lhr: r,
          });
        }

        const ordered = [...samples].sort((x, y) => x.perf - y.perf);
        const median = ordered[Math.floor(ordered.length / 2)]!;

        if (LH_RUNS > 1) {
          console.log(
            `  ${locale}: повторы perf ${samples.map((s) => s.perf).join(' / ')}` +
              `  LCP ${samples.map((s) => s.lcpSeconds.toFixed(2)).join(' / ')}с` +
              `  → медиана perf ${median.perf}`,
          );
        }

        const lhr = median.lhr;
        const audits = lhr.audits;

        const perf = median.perf;
        const a11y = median.a11y;
        const bp = median.bp;
        const seo = median.seo;

        const lcpSeconds = median.lcpSeconds;
        const cls = median.cls;
        const tbt = median.tbt;

        const bad: string[] = [];
        if (perf < THRESHOLDS.perf) bad.push(`perf ${perf} < ${THRESHOLDS.perf}`);
        if (a11y < THRESHOLDS.a11y) bad.push(`a11y ${a11y} < ${THRESHOLDS.a11y}`);
        if (seo < THRESHOLDS.seo) bad.push(`seo ${seo} < ${THRESHOLDS.seo}`);
        if (bp < THRESHOLDS.bp) bad.push(`bp ${bp} < ${THRESHOLDS.bp}`);
        if (lcpSeconds > THRESHOLDS.lcpSeconds) bad.push(`LCP ${lcpSeconds.toFixed(2)}с > ${THRESHOLDS.lcpSeconds}с`);

        const consoleItems =
          ((audits['errors-in-console']?.details as { items?: ConsoleErrorItem[] } | undefined)
            ?.items ?? []);
        const ours = unexpectedConsoleErrors(consoleItems);
        for (const item of ours) {
          bad.push(
            `ошибка в консоли: ${(item.description ?? '').slice(0, 90)} (${item.sourceLocation?.url ?? 'без адреса'})`,
          );
        }
        const ignored = consoleItems.length - ours.length;

        let clarityHits = 0;
        if (clarityBuilt) {
          clarityHits = Math.max(...samples.map((s) => s.clarityHits));
          if (clarityHits === 0) {
            throw new Error(
              `Lighthouse не увидел ни одного запроса к clarity.ms на локали ${locale}, ` +
                `хотя PUBLIC_CLARITY_ID задан (${CLARITY_ID}) и лежит в dist/. ` +
                'Это отказ измерения, а не хороший результат: best-practices, снятый ' +
                'без загруженного тега, ничего не говорит о его сторонних cookies.',
            );
          }
        }

        if (bad.length > 0) failures++;

        console.log(
          `  ${bad.length === 0 ? 'PASS' : 'FAIL'} ${locale}: perf ${perf} / a11y ${a11y} / bp ${bp} / seo ${seo}` +
            `  |  LCP ${lcpSeconds.toFixed(2)}с  CLS ${cls}  TBT ${tbt}` +

            (ignored > 0 ? `  |  консоль: ${ignored} шт. вне Cloudflare (см. scripts/lib/off-cloudflare.ts)` : '') +

            (clarityBuilt ? `  |  clarity.ms: ${clarityHits} запрос(ов)` : '') +
            (bad.length > 0 ? `  <-- ${bad.join('; ')}` : '')
        );

        writeFileSync(path.join(projectRoot, `lighthouse-${locale}.json`), JSON.stringify(lhr));

        if (SEED_LEAD) {
          const shot = lhr.audits['final-screenshot']?.details as { data?: string } | undefined;
          if (shot?.data) {
            writeFileSync(
              path.join(projectRoot, `lighthouse-seeded-${locale}.jpg`),
              Buffer.from(shot.data.replace(/^data:image\/\w+;base64,/, ''), 'base64'),
            );
          }
        }
      }
    } finally {
      await chrome.kill();
    }
  } finally {
    server.kill('SIGTERM');
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} локал(ь/и) не прошли пороги.`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
