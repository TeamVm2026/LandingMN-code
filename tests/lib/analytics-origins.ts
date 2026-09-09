
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const GA4_ORIGINS = [
  'https://www.googletagmanager.com',
  'https://www.google-analytics.com',
  'https://region1.google-analytics.com',
];

const CLARITY_ORIGINS = [
  'https://www.clarity.ms',
  'https://scripts.clarity.ms',
  'https://c.clarity.ms',
  'https://b.clarity.ms',
  'https://c.bing.com',
];

function distFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) distFiles(full, out);
    else if (/\.(js|html)$/.test(entry)) out.push(full);
  }
  return out;
}

export function analyticsOriginsInBuild(distDir: string): string[] {
  const shipsProviders = distFiles(distDir).some((file) =>
    /googletagmanager|clarity\.ms/.test(readFileSync(file, 'utf8')),
  );

  return shipsProviders ? [...GA4_ORIGINS, ...CLARITY_ORIGINS] : [];
}
