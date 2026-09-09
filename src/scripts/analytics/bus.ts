
import type { EventName, EventParams } from './events';

type Sink = (name: EventName, params: EventParams) => void;

const QUEUE_CAP = 50;

export interface Bus {

  setCommonParams(p: EventParams): void;

  track(name: EventName, params?: EventParams): void;

  registerSink(sink: Sink): void;
}

export function createBus(): Bus {
  const queue: [EventName, EventParams][] = [];
  const sinks: Sink[] = [];
  let common: EventParams = {};

  const deliver = (sink: Sink, name: EventName, params: EventParams): void => {
    try {
      sink(name, params);
    } catch {

      /* */
    }
  };

  return {
    setCommonParams(p: EventParams): void {
      common = p;
    },

    track(name: EventName, params: EventParams = {}): void {

      const payload: EventParams = { ...common, ...params };

      if (queue.length < QUEUE_CAP) queue.push([name, payload]);
      for (const sink of sinks) deliver(sink, name, payload);
    },

    registerSink(sink: Sink): void {
      sinks.push(sink);
      for (const [name, payload] of queue) deliver(sink, name, payload);
    },
  };
}

const bus = createBus();

export const setCommonParams: Bus['setCommonParams'] = (p) => bus.setCommonParams(p);
export const track: Bus['track'] = (name, params) => bus.track(name, params);
export const registerSink: Bus['registerSink'] = (sink) => bus.registerSink(sink);
