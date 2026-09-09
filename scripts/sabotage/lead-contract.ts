
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-lead-contract.ts'],
};

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

function copyWithEdit(source: string, dest: string, from: string | RegExp, to: string): void {
  const original = readFileSync(path.join(projectRoot, source), 'utf8');
  const broken = original.replace(from as string, to);
  if (broken === original) {
    throw new Error(`подстановка в ${source} ничего не изменила — искали «${String(from)}»`);
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, broken, 'utf8');
}

function tmpPath(id: string, name: string): string {
  return path.join(tmpDir, `${id}-${name}`);
}

function cleanup(id: string, name: string): void {
  rmSync(tmpPath(id, name), { recursive: true, force: true });
}

const renamedField: SabotageCase = {
  id: 'lead-contract-renamed-field',
  gate: 'check:lead-contract',
  describe: 'в разметке формы поле contact_channel переименовано в contact_via',
  setup() {
    copyWithEdit(
      'src/components/LeadFormMarkup.astro',
      tmpPath(this.id, 'markup.astro'),
      /name="contact_channel"/g,
      'name="contact_via"',
    );
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-lead-contract.ts',
      '--markup',
      argPath(tmpPath(this.id, 'markup.astro')),
    ];
  },

  expectOutputContains: 'разметка отправляет поле «contact_via»',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id, 'markup.astro');
  },
};

const literalTtl: SabotageCase = {
  id: 'lead-contract-literal-ttl',
  gate: 'check:lead-contract',
  describe: 'LEAD_TTL_SECONDS в контракте вписан числом секунд вместо вычисления из импорта',
  setup() {
    copyWithEdit(
      'src/lib/lead-contract.ts',
      tmpPath(this.id, 'contract.ts'),
      /export const LEAD_TTL_SECONDS = Math\.floor\(ATTRIBUTION_TTL_MS \/ 1000\);/,
      'export const LEAD_TTL_SECONDS = 7776000;',
    );
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-lead-contract.ts',
      '--contract',
      argPath(tmpPath(this.id, 'contract.ts')),
    ];
  },

  expectOutputContains: 'срок хранения числом секунд: «7776000»',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id, 'contract.ts');
  },
};

const ttlInJournal: SabotageCase = {
  id: 'lead-contract-ttl-in-journal',
  gate: 'check:lead-contract',
  describe: 'журнал KV передаёт expirationTtl числом вместо LEAD_TTL_SECONDS',
  setup() {
    const dir = tmpPath(this.id, 'scan');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, 'lead'), { recursive: true });
    writeFileSync(
      path.join(dir, 'lead', 'journal.ts'),
      [
        '// Дубль заявки в KV — страховка от потери сообщения в чате (LEAD-09).',
        "import { LEAD_KEY_PREFIX } from '../../lib/lead-contract.ts';",
        '',
        'export async function journalLead(kv: KVNamespace, id: string, body: string) {',
        '  // Срок хранения заявки: тридцать суток.',
        '  await kv.put(LEAD_KEY_PREFIX + id, body, { expirationTtl: 2592000 });',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-lead-contract.ts',
      '--scan',
      argPath(tmpPath(this.id, 'scan')),
    ];
  },

  expectOutputContains: 'expirationTtl числом вместо LEAD_TTL_SECONDS: «expirationTtl: 2592000»',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id, 'scan');
  },
};

const secondDeclaration: SabotageCase = {
  id: 'lead-contract-second-declaration',
  gate: 'check:lead-contract',
  describe: 'модуль валидации объявляет собственный DIRECTIONS вместо импорта из контракта',
  setup() {
    const dir = tmpPath(this.id, 'scan');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, 'lead'), { recursive: true });
    writeFileSync(
      path.join(dir, 'lead', 'validate.ts'),
      [
        '// Серверная валидация полей заявки.',
        "const DIRECTIONS = ['affiliate', 'bank', 'teamcash'] as const;",
        '',
        'export function isDirection(value: string): boolean {',
        '  return (DIRECTIONS as readonly string[]).includes(value);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-lead-contract.ts',
      '--scan',
      argPath(tmpPath(this.id, 'scan')),
    ];
  },
  expectOutputContains: 'ВТОРОЕ ОБЪЯВЛЕНИЕ КОНТРАКТА',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id, 'scan');
  },
};

const missingAttr: SabotageCase = {
  id: 'lead-contract-missing-attr',
  gate: 'check:lead-contract',
  describe: 'из разметки формы пропало скрытое поле атрибуции attr',
  setup() {
    copyWithEdit(
      'src/components/LeadFormMarkup.astro',
      tmpPath(this.id, 'markup.astro'),
      /\r?\n +<input type="hidden" name=\{ATTRIBUTION_FIELD\} value="" \/>/,
      '',
    );
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-lead-contract.ts',
      '--markup',
      argPath(tmpPath(this.id, 'markup.astro')),
    ];
  },

  expectOutputContains: 'объявляет поле «attr»',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id, 'markup.astro');
  },
};

const missingHoneypot: SabotageCase = {
  id: 'lead-contract-missing-honeypot',
  gate: 'check:lead-contract',
  describe: 'из разметки формы пропало поле-приманка website',
  setup() {
    copyWithEdit(
      'src/components/LeadFormMarkup.astro',
      tmpPath(this.id, 'markup.astro'),
      /\r?\n +<input\r?\n +type="text"\r?\n +name=\{HONEYPOT_FIELD\}[\s\S]*?\/>/,
      '',
    );
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-lead-contract.ts',
      '--markup',
      argPath(tmpPath(this.id, 'markup.astro')),
    ];
  },
  expectOutputContains: 'объявляет поле «website»',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id, 'markup.astro');
  },
};

export const cases: SabotageCase[] = [
  renamedField,
  literalTtl,
  ttlInJournal,
  secondDeclaration,
  missingAttr,
  missingHoneypot,
];
