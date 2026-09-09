
import { registerSink } from './bus';
import { CONSENT_REQUIRED_REGIONS, type ConsentChoice } from './consent';

const USER_PROPERTY_VALUE_MAX = 36;

function truncate(props: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    out[key] = value.slice(0, USER_PROPERTY_VALUE_MAX);
  }
  return out;
}

export function initGa4(
  id: string,
  analyticsDefault: ConsentChoice,
  userProps: Record<string, string>,
): void {
  window.dataLayer = window.dataLayer || [];

  function gtag(): void {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer?.push(arguments);
  }
  const send = gtag as (...args: unknown[]) => void;
  window.gtag = send;

  send('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: analyticsDefault,
    ...(analyticsDefault === 'denied' ? { wait_for_update: 500 } : {}),
  });

  send('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    region: [...CONSENT_REQUIRED_REGIONS],
    wait_for_update: 500,
  });

  send('js', new Date());

  send('config', id, {

    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    user_properties: truncate(userProps),
  });

  const tag = document.createElement('script');
  tag.async = true;
  tag.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;

  tag.onload = (): void => {
    registerSink((name, params) => {
      send('event', name, params);
    });
  };

  tag.onerror = (): void => {};

  document.head.appendChild(tag);
}
