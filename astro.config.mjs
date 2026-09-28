
import { loadEnv } from 'vite';
import { defineConfig, envField } from 'astro/config';
import sitemap from '@astrojs/sitemap';

const {
  PUBLIC_SITE_URL,
  PUBLIC_GA_ID = '',
  PUBLIC_CLARITY_ID = '',
  PUBLIC_TURNSTILE_SITEKEY = '',
} = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), '');

const BUILD_FLAGS = {
  __LANDINGMN_ANALYTICS_ON__: JSON.stringify(PUBLIC_GA_ID !== '' || PUBLIC_CLARITY_ID !== ''),
  __LANDINGMN_TURNSTILE_ON__: JSON.stringify(PUBLIC_TURNSTILE_SITEKEY !== ''),
};

export default defineConfig({
  output: 'static',
  site: PUBLIC_SITE_URL,

  compressHTML: true,

  trailingSlash: 'always',
  integrations: [
    sitemap({

      i18n: {
        defaultLocale: 'mn',
        locales: { mn: 'mn', ru: 'ru', en: 'en' },
      },

      filter: (page) => !page.includes('/404') && !page.includes('/thanks'),
    }),
  ],
  build: {

    format: 'preserve',
  },
  vite: {

    define: BUILD_FLAGS,
    build: {

      cssMinify: 'esbuild',

      assetsInlineLimit: (filePath) => {
        if (/\.(avif|webp|png|jpe?g|gif)$/i.test(filePath)) return false;
        return undefined;
      },
    },
  },
  i18n: {
    defaultLocale: 'mn',
    locales: ['mn', 'ru', 'en'],
    routing: {
      prefixDefaultLocale: false,
    },

  },
  env: {
    schema: {
      PUBLIC_SITE_URL: envField.string({ context: 'client', access: 'public' }),

      PUBLIC_MESSENGER_URL: envField.string({ context: 'client', access: 'public' }),
      PUBLIC_TG_CONTACT_URL: envField.string({ context: 'client', access: 'public' }),

      PUBLIC_TG_BOT_URL: envField.string({
        context: 'client',
        access: 'public',
        optional: true,
        default: '',
      }),

      PUBLIC_GA_ID: envField.string({
        context: 'client',
        access: 'public',
        optional: true,
        default: '',
      }),
      PUBLIC_CLARITY_ID: envField.string({
        context: 'client',
        access: 'public',
        optional: true,
        default: '',
      }),

      PUBLIC_TURNSTILE_SITEKEY: envField.string({
        context: 'client',
        access: 'public',
        optional: true,
        default: '',
      }),
    },
  },
});
