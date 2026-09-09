
import { registerSink } from './bus';
import type { EventName, EventParams } from './events';

export interface DebugEvent {
  name: EventName;
  params: EventParams;
  ts: number;
}

declare global {
  interface Window {

    __lmnEvents?: DebugEvent[];
  }
}

const FLAG_KEY = 'lmn_sink';
const FLAG_PARAM = '__sink';

export function maybeRegisterDebugSink(): boolean {
  let on = false;

  try {
    on = new URLSearchParams(window.location.search).get(FLAG_PARAM) === '1';
  } catch {

    /* */
  }

  try {
    if (on) sessionStorage.setItem(FLAG_KEY, '1');
    else on = sessionStorage.getItem(FLAG_KEY) === '1';
  } catch {

    /* */
  }

  if (!on) return false;

  const log: DebugEvent[] = (window.__lmnEvents ??= []);
  registerSink((name, params) => {
    log.push({ name, params, ts: Date.now() });
  });

  return true;
}
