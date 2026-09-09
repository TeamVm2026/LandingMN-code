
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-turnstile-config.ts'],
  env: {
    PUBLIC_SITE_URL: 'https://partner-melbet.com',
    PUBLIC_TURNSTILE_SITEKEY: '0x4AAAAAAAETALONSITEKEY',
  },
};

const ENV_KEYS = ['PUBLIC_SITE_URL', 'PUBLIC_TURNSTILE_SITEKEY'] as const;
let savedEnv: Record<string, string | undefined> = {};

const missingOnProd: SabotageCase = {
  id: 'turnstile-config-missing-on-prod',
  gate: 'check:turnstile-config',
  describe: 'PUBLIC_SITE_URL переключён на боевой домен, а PUBLIC_TURNSTILE_SITEKEY пуст',
  setup() {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.PUBLIC_SITE_URL = 'https://partner-melbet.com';

    process.env.PUBLIC_TURNSTILE_SITEKEY = '';
  },
  command: ['--experimental-strip-types', 'scripts/check-turnstile-config.ts'],
  expectOutputContains: 'TURNSTILE НА БОЕВОМ ДОМЕНЕ',
  greenRun: GREEN,
  teardown() {
    for (const key of ENV_KEYS) {
      const previous = savedEnv[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  },
};

export const cases: SabotageCase[] = [missingOnProd];
