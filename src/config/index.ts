import {
  PUBLIC_SITE_URL,
  PUBLIC_MESSENGER_URL,
  PUBLIC_TG_CONTACT_URL,
  PUBLIC_TG_BOT_URL,
  PUBLIC_GA_ID,
  PUBLIC_CLARITY_ID,
  PUBLIC_TURNSTILE_SITEKEY,
} from 'astro:env/client';

export const ANALYTICS_ENABLED = PUBLIC_GA_ID !== '' || PUBLIC_CLARITY_ID !== '';

export const TURNSTILE_ENABLED = PUBLIC_TURNSTILE_SITEKEY !== '';

export const config = Object.freeze({
  siteUrl: PUBLIC_SITE_URL,
  messengerUrl: PUBLIC_MESSENGER_URL,
  tgContactUrl: PUBLIC_TG_CONTACT_URL,

  tgBotUrl: PUBLIC_TG_BOT_URL,

  analytics: Object.freeze({
    gaId: PUBLIC_GA_ID,
    clarityId: PUBLIC_CLARITY_ID,
  }),

  turnstileSitekey: PUBLIC_TURNSTILE_SITEKEY,

  partners: Object.freeze({
    followersAsOf: '2026-08-26',

    people: Object.freeze([
      Object.freeze({ id: 'newsac', name: 'Newsac', followersThousands: 45 }),
      Object.freeze({ id: 'maaraamn', name: 'MaaRaa MN', followersThousands: 184 }),
      Object.freeze({ id: 'zilkenberg', name: 'Zilkenberg', followersThousands: 60 }),
      Object.freeze({ id: 'lexor2k', name: 'Lexor2k', followersThousands: 176 }),
    ]),

    phoneOrder: Object.freeze(['lexor2k', 'newsac', 'maaraamn', 'zilkenberg'] as const),
  }),

  brandChannels: Object.freeze({
    facebook: 'https://facebook.com/worldcuplivemongoliaa',

    instagram: 'https://www.instagram.com/melbet_mongolia_official',
  }),
});
