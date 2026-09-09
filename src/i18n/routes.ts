
export const PAGE_ROUTES = {
  home: {
    mn: '/',
    ru: '/ru/',
    en: '/en/',
  },
  privacy: {
    mn: '/privacy/',
    ru: '/ru/privacy/',
    en: '/en/privacy/',
  },

  notFound: {
    mn: '/404.html',
    ru: '/ru/404.html',
    en: '/en/404.html',
  },

  thanks: {
    mn: '/thanks/',
    ru: '/ru/thanks/',
    en: '/en/thanks/',
  },
} as const satisfies Record<
  'home' | 'privacy' | 'notFound' | 'thanks',
  Record<Locale, string>
>;

export type Locale = 'mn' | 'ru' | 'en';
