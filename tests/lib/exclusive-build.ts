
import { mkdirSync, rmdirSync, statSync } from 'node:fs';
import path from 'node:path';

const LOCK_DIR = path.join(import.meta.dirname, '..', '..', '.astro-build-lock');

const STALE_MS = 5 * 60 * 1000;

const POLL_MS = 500;

const WAIT_LIMIT_MS = 170_000;

const sleepSync = (ms: number) => {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
};

export function withExclusiveBuildLock<T>(fn: () => T): T {
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      break;
    } catch {

      try {
        const age = Date.now() - statSync(LOCK_DIR).mtimeMs;
        if (age > STALE_MS) {
          rmdirSync(LOCK_DIR);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > WAIT_LIMIT_MS) {
        throw new Error(
          `Замок сборки ${LOCK_DIR} занят дольше ${WAIT_LIMIT_MS} мс — чужая сборка зависла?`,
        );
      }
      sleepSync(POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(LOCK_DIR);
    } catch {
      /* */
    }
  }
}
