
import { registerSink, QUEUE_CAP } from './bus';
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

const LOG_CAP = QUEUE_CAP;

export function maybeRegisterDebugSink(): boolean {
  let asked: string | null = null;

  try {
    asked = new URLSearchParams(window.location.search).get(FLAG_PARAM);
  } catch {

    /* */
  }

  let on = asked === '1';

  try {
    if (on) sessionStorage.setItem(FLAG_KEY, '1');

    else if (asked === '0') sessionStorage.removeItem(FLAG_KEY);
    else on = sessionStorage.getItem(FLAG_KEY) === '1';
  } catch {

    /* */
  }

  if (!on) return false;

  const log: DebugEvent[] = (window.__lmnEvents ??= []);
  registerSink((name, params) => {

    if (log.length >= LOG_CAP) return;
    log.push({ name, params, ts: Date.now() });
  });

  return true;
}
