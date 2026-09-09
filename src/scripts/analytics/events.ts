
export const EVENT_NAMES = [
  'language_change',
  'direction_select',
  'messenger_click',
  'form_open',
  'form_submit',
  'form_error',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export type EventParams = Record<string, string | number | undefined>;

export const PROVIDER_OWNED_EVENTS = ['page_view'] as const;

export type ProviderOwnedEvent = (typeof PROVIDER_OWNED_EVENTS)[number];
