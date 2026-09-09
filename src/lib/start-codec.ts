
export const PAYLOAD_VERSION = '1';

export const PAYLOAD_MAX = 64;

const SEP = '_';

const TG_ALPHABET = /^[A-Za-z0-9_-]+$/;

const VALUE_ALPHABET = /^[a-z0-9-]*$/;

export const DIRECTIONS = { affiliate: 'a', bank: 'b', teamcash: 't', none: 'x' } as const;
export const LOCALES = { mn: 'm', ru: 'r', en: 'e' } as const;

export const LIMITS = { source: 12, campaign: 20, click: 10 } as const;

export type Direction = keyof typeof DIRECTIONS;
export type Locale = keyof typeof LOCALES;

export interface StartPayload {

  source: string;
  direction: Direction;
  locale: Locale;

  campaign: string;

  click: string;
}

export function normalizeToken(raw: string, max: number): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)

    .replace(/-+$/g, '');
}

function guardField(name: 'source' | 'campaign' | 'click', value: string, max: number): string {
  if (!VALUE_ALPHABET.test(value)) {
    throw new Error(`start-codec: поле ${name} вне алфавита [a-z0-9-]: ${JSON.stringify(value)}`);
  }
  if (value.length > max) {
    throw new Error(`start-codec: поле ${name} длиннее ${max}: ${JSON.stringify(value)}`);
  }
  return value;
}

export function encodeStart(p: StartPayload): string {
  const source = guardField('source', p.source, LIMITS.source);
  const campaign = guardField('campaign', p.campaign, LIMITS.campaign);
  const click = guardField('click', p.click, LIMITS.click);

  const dir = (DIRECTIONS as Record<string, string | undefined>)[p.direction];
  const loc = (LOCALES as Record<string, string | undefined>)[p.locale];
  if (dir === undefined) {
    throw new Error(`start-codec: неизвестное направление ${JSON.stringify(p.direction)}`);
  }
  if (loc === undefined) {
    throw new Error(`start-codec: неизвестная локаль ${JSON.stringify(p.locale)}`);
  }

  const parts = [PAYLOAD_VERSION, source, dir, loc, campaign, click];

  while (parts.length > 4 && parts[parts.length - 1] === '') parts.pop();

  const out = parts.join(SEP);
  if (out.length > PAYLOAD_MAX) {
    throw new Error(`start-codec: payload ${out.length} символ(ов) > ${PAYLOAD_MAX}: ${out}`);
  }
  if (!TG_ALPHABET.test(out)) {
    throw new Error(`start-codec: payload вне алфавита Telegram: ${out}`);
  }
  return out;
}

export function decodeStart(raw: string): StartPayload | null {
  if (!raw || raw.length > PAYLOAD_MAX || !TG_ALPHABET.test(raw)) return null;

  const parts = raw.split(SEP);

  if (parts[0] !== PAYLOAD_VERSION) return null;
  if (parts.length < 4) return null;

  const direction = (Object.keys(DIRECTIONS) as Direction[]).find((k) => DIRECTIONS[k] === parts[2]);
  const locale = (Object.keys(LOCALES) as Locale[]).find((k) => LOCALES[k] === parts[3]);
  if (!direction || !locale) return null;

  const source = parts[1] ?? '';
  const campaign = parts[4] ?? '';
  const click = parts[5] ?? '';

  if (!VALUE_ALPHABET.test(source) || source.length > LIMITS.source) return null;
  if (!VALUE_ALPHABET.test(campaign) || campaign.length > LIMITS.campaign) return null;
  if (!VALUE_ALPHABET.test(click) || click.length > LIMITS.click) return null;

  return { source, direction, locale, campaign, click };
}
