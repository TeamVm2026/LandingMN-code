
import { createServer, type Server } from 'node:net';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');
const preflightScript = path.join('scripts', 'lib', 'preflight.ts').replace(/\\/g, '/');

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

const GREEN_PORTS: GreenRun = {
  command: ['--experimental-strip-types', preflightScript, '--ports', '4321,4331'],
};

const GREEN_FRESH: GreenRun = {
  command: ['--experimental-strip-types', preflightScript, '--freshness'],
  costly: 'нужна собранная и СВЕЖАЯ dist/ (npm run build) — иначе эталон красен по существу',
};

function makeBlockerCase(id: string, describe: string, host: string): SabotageCase {
  let blocker: Server | undefined;
  return {
    id,
    gate: 'scripts/lib/preflight.ts (occupiedPorts)',
    describe,
    async setup() {
      blocker = createServer();
      await new Promise<void>((resolve, reject) => {
        blocker!.once('error', reject);
        blocker!.listen(4321, host, () => resolve());
      });
    },
    command: ['--experimental-strip-types', preflightScript, '--ports', '4321,4331'],
    expectOutputContains: 'FAIL: port(s) 4321 already in use',
    greenRun: GREEN_PORTS,
    async teardown() {
      if (!blocker) return;
      await new Promise<void>((resolve) => blocker!.close(() => resolve()));
      blocker = undefined;
    },
  };
}

const occupiedPortIpv6: SabotageCase = makeBlockerCase(
  'preflight-port-occupied-ipv6-loopback',
  'порт 4321 занят на IPv6-loopback [::1] -- воспроизводит реальный astro preview, не проекцию на IPv4',
  '::1',
);

const occupiedPortIpv4Wildcard: SabotageCase = makeBlockerCase(
  'preflight-port-occupied-ipv4-wildcard',
  'порт 4321 занят на IPv4-wildcard 0.0.0.0 -- воспроизводит Windows-специфичный бинд-конфликт координатора',
  '0.0.0.0',
);

function distPath(id: string): string {
  return path.join(tmpDir, `${id}-root`);
}

function writeStaleTree(id: string): void {
  const root = distPath(id);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'public'), { recursive: true });
  mkdirSync(path.join(root, 'dist'), { recursive: true });
  writeFileSync(path.join(root, 'astro.config.mjs'), 'export default {};\n', 'utf8');
  writeFileSync(path.join(root, 'src', 'stub.astro'), '<p>stub</p>\n', 'utf8');
  writeFileSync(path.join(root, 'dist', 'index.html'), '<!doctype html><html></html>\n', 'utf8');

  const distTime = new Date(Date.now() - 60_000);
  const srcTime = new Date(Date.now() - 10_000);
  utimesSync(path.join(root, 'dist', 'index.html'), distTime, distTime);
  utimesSync(path.join(root, 'src', 'stub.astro'), srcTime, srcTime);
}

function cleanupTree(id: string): void {
  rmSync(distPath(id), { recursive: true, force: true });
}

const staleDist: SabotageCase = {
  id: 'preflight-stale-dist',
  gate: 'scripts/lib/preflight.ts (checkBuildFreshness)',
  describe: 'dist/index.html существует, но старше src/ -- сборку забыли пересобрать',
  setup() {
    writeStaleTree(this.id);
  },
  get command() {
    return ['--experimental-strip-types', preflightScript, '--freshness', '--root', argPath(distPath(this.id))];
  },
  expectOutputContains: 'FAIL: dist is STALE',
  greenRun: GREEN_FRESH,
  teardown() {
    cleanupTree(this.id);
  },
};

export const cases: SabotageCase[] = [occupiedPortIpv6, occupiedPortIpv4Wildcard, staleDist];
