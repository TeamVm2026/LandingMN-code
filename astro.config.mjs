
import { loadEnv } from 'vite';
import { defineConfig, envField } from 'astro/config';
import sitemap from '@astrojs/sitemap';

const { PUBLIC_SITE_URL } = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), '');

export default defineConfig({
  output: 'static',
  site: PUBLIC_SITE_URL,

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
    build: {

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
