
import { createConnection, createServer } from 'node:net';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const GUARDED_PORTS = [4321, 4331, 8788, 8789] as const;

const PROBE_HOSTS = ['127.0.0.1', '::1'] as const;

function hostAnswers(port: number, host: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    let settled = false;
    const finish = (occupied: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));

    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

function bindRefused(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    let settled = false;
    const finish = (occupied: boolean) => {
      if (settled) return;
      settled = true;
      probe.removeAllListeners();
      resolve(occupied);
    };
    probe.once('error', (error: NodeJS.ErrnoException) => {

      finish(error.code === 'EADDRINUSE');
    });
    probe.listen(port, host, () => {
      probe.close(() => finish(false));
    });
  });
}

export async function portFree(
  port: number,
  hosts: readonly string[] = PROBE_HOSTS,
): Promise<boolean> {
  const connected = await Promise.all(hosts.map((host) => hostAnswers(port, host)));
  if (connected.some(Boolean)) return false;
  const refused = await Promise.all(hosts.map((host) => bindRefused(port, host)));
  return !refused.some(Boolean);
}

export async function occupiedPorts(
  ports: readonly number[] = GUARDED_PORTS,
): Promise<number[]> {
  const flags = await Promise.all(ports.map((port) => portFree(port)));
  return ports.filter((_, i) => !flags[i]);
}

export function portGuardMessage(occupied: number[]): string {
  return (
    `FAIL: port(s) ${occupied.join(', ')} already in use.\n` +
    '      A prior run likely left an orphaned server listening (on Windows, killing the\n' +
    '      parent `npm` process does not kill the underlying `astro preview` process).\n' +
    '      Free the port(s) first, e.g. (PowerShell): Get-Process node | Stop-Process -Force\n' +
    '      then retry.'
  );
}

const DEFAULT_SOURCE_DIRS = ['src', 'public'];
const DEFAULT_SOURCE_FILES = ['astro.config.mjs'];
const DEFAULT_DIST_ENTRY = path.join('dist', 'index.html');

const IGNORED_BASENAMES = new Set(['.DS_Store', 'Thumbs.db']);

function newestMtimeMsUnder(root: string): number {
  if (!existsSync(root)) return 0;
  const rootStat = statSync(root);
  if (!rootStat.isDirectory()) {
    return IGNORED_BASENAMES.has(path.basename(root)) ? 0 : rootStat.mtimeMs;
  }
  let newest = 0;
  const entries = readdirSync(root, { recursive: true }) as string[];
  for (const relative of entries) {
    if (IGNORED_BASENAMES.has(path.basename(relative))) continue;
    const full = path.join(root, relative);
    const stat = statSync(full);
    if (!stat.isDirectory() && stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return newest;
}

export interface FreshnessOptions {

  sourceDirs?: string[];

  sourceFiles?: string[];

  distEntry?: string;
}

export interface FreshnessResult {
  fresh: boolean;
  reason?: string;
  sourceNewestMs?: number;
  distMtimeMs?: number;
}

export function checkBuildFreshness(
  projectRoot: string,
  options: FreshnessOptions = {},
): FreshnessResult {
  const sourceDirs = options.sourceDirs ?? DEFAULT_SOURCE_DIRS;
  const sourceFiles = options.sourceFiles ?? DEFAULT_SOURCE_FILES;
  const distEntry = options.distEntry
    ? path.join(projectRoot, options.distEntry)
    : path.join(projectRoot, DEFAULT_DIST_ENTRY);

  if (!existsSync(distEntry)) {
    return {
      fresh: false,
      reason: `${path.relative(projectRoot, distEntry)} does not exist -- run \`npm run build\` first.`,
    };
  }
  const distMtimeMs = statSync(distEntry).mtimeMs;

  let sourceNewestMs = 0;
  for (const dir of sourceDirs) {
    const t = newestMtimeMsUnder(path.join(projectRoot, dir));
    if (t > sourceNewestMs) sourceNewestMs = t;
  }
  for (const file of sourceFiles) {
    const t = newestMtimeMsUnder(path.join(projectRoot, file));
    if (t > sourceNewestMs) sourceNewestMs = t;
  }

  if (sourceNewestMs > distMtimeMs) {
    return {
      fresh: false,
      reason:
        `dist is STALE -- ${path.relative(projectRoot, distEntry)} ` +
        `(${new Date(distMtimeMs).toISOString()}) is older than the newest watched source file ` +
        `(${new Date(sourceNewestMs).toISOString()}). Run \`npm run build\`.`,
      sourceNewestMs,
      distMtimeMs,
    };
  }
  return { fresh: true, sourceNewestMs, distMtimeMs };
}

export function freshnessGuardMessage(result: FreshnessResult): string {
  return `FAIL: ${result.reason ?? 'stale build'}`;
}

async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);
  const projectRoot = path.resolve(import.meta.dirname, '..', '..');

  if (argv.includes('--freshness')) {
    const at = argv.indexOf('--root');
    const rawRoot = at !== -1 ? argv[at + 1] : undefined;
    if (at !== -1 && !rawRoot) {
      console.error('FAIL: --root требует значения.');
      process.exit(1);
    }
    const root = rawRoot ? (path.isAbsolute(rawRoot) ? rawRoot : path.join(projectRoot, rawRoot)) : projectRoot;
    const result = checkBuildFreshness(root);
    if (!result.fresh) {
      console.error(freshnessGuardMessage(result));
      process.exit(1);
    }
    console.log('OK: dist свежее источников.');
    return;
  }

  const portsFlagAt = argv.indexOf('--ports');
  const portsArg = portsFlagAt !== -1 ? argv[portsFlagAt + 1] : undefined;
  const ports = portsArg ? portsArg.split(',').map((p) => Number(p.trim())) : GUARDED_PORTS;

  const occupied = await occupiedPorts(ports);
  if (occupied.length > 0) {
    console.error(portGuardMessage(occupied));
    process.exit(1);
  }
  console.log(`OK: порт(ы) ${ports.join(', ')} свободны.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
