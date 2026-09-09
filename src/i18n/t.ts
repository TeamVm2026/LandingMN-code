
import mn from './mn.json' with { type: 'json' };
import ru from './ru.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };

export const dictionaries = { mn, ru, en } as const;

export type Locale = keyof typeof dictionaries;

type DotPaths<T> = {
  [K in keyof T & string]: T[K] extends string
    ? `${K}`
    : `${K}.${DotPaths<T[K]>}`;
}[keyof T & string];

export type TranslationKey = DotPaths<typeof mn>;

export function t(locale: Locale, key: TranslationKey): string {
  const dict = dictionaries[locale];
  const value: unknown = key
    .split('.')
    .reduce<unknown>((acc, segment) => {
      if (acc && typeof acc === 'object' && segment in acc) {
        return (acc as Record<string, unknown>)[segment];
      }
      return undefined;
    }, dict);
  if (typeof value !== 'string') {

    throw new Error(`Missing i18n key "${key}" for locale "${locale}"`);
  }
  return value;
}
