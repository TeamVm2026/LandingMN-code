
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEAD_STATE_KEY,
  LEAD_STATE_TTL_MS,
  readLeadState,
  writeLeadState,
  clearLeadState,
} from '../../src/scripts/lead/state.ts';

const HOUR_MS = 60 * 60 * 1000;

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly writes: { key: string; value: string }[];
  readonly removals: string[];
}

function createFakeStorage(seed: Record<string, string> = {}, onSetItem?: () => void): FakeStorage {
  const store = new Map(Object.entries(seed));
  const writes: { key: string; value: string }[] = [];
  const removals: string[] = [];
  return {
    writes,
    removals,
    getItem(key) {
      const hit = store.get(key);
      return hit === undefined ? null : hit;
    },
    setItem(key, value) {
      if (onSetItem) onSetItem();
      store.set(key, value);
      writes.push({ key, value });
    },
    removeItem(key) {
      store.delete(key);
      removals.push(key);
    },
  };
}

function installStorage(storage: FakeStorage): () => void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage,
  });
  return () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  };
}

function installThrowingStorage(): () => void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
  return () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  };
}

function storedValue(ageMs: number, direction = 'affiliate', version: unknown = 1): string {
  return JSON.stringify({ v: version, at: Date.now() - ageMs, direction });
}

test('ключ и срок объявлены значениями контракта', () => {
  assert.equal(LEAD_STATE_KEY, 'lmn_lead');
  assert.equal(LEAD_STATE_TTL_MS, 72 * HOUR_MS);
});

test('отсутствующий ключ → null, без исключения', () => {
  const restore = installStorage(createFakeStorage());
  try {
    assert.equal(readLeadState(), null);
  } finally {
    restore();
  }
});

test('среда вовсе без хранилища → null, без исключения', () => {

  assert.equal(readLeadState(), null);
});

test('давность 71 час → значение возвращается', () => {
  const restore = installStorage(createFakeStorage({ [LEAD_STATE_KEY]: storedValue(71 * HOUR_MS, 'bank') }));
  try {
    const state = readLeadState();
    assert.notEqual(state, null);
    assert.equal(state?.direction, 'bank');
    assert.equal(state?.v, 1);
  } finally {
    restore();
  }
});

test('давность 73 часа → null', () => {
  const restore = installStorage(createFakeStorage({ [LEAD_STATE_KEY]: storedValue(73 * HOUR_MS) }));
  try {
    assert.equal(readLeadState(), null);
  } finally {
    restore();
  }
});

test('чужая версия v: 2 → null', () => {
  const restore = installStorage(createFakeStorage({ [LEAD_STATE_KEY]: storedValue(HOUR_MS, 'bank', 2) }));
  try {
    assert.equal(readLeadState(), null);
  } finally {
    restore();
  }
});

test('значение без поля v → null', () => {
  const raw = JSON.stringify({ at: Date.now(), direction: 'bank' });
  const restore = installStorage(createFakeStorage({ [LEAD_STATE_KEY]: raw }));
  try {
    assert.equal(readLeadState(), null);
  } finally {
    restore();
  }
});

const BROKEN: [string, string][] = [
  ['не JSON вовсе', 'не json'],
  ['пустая строка', ''],
  ['JSON-массив', JSON.stringify([{ v: 1, at: Date.now(), direction: 'bank' }])],
  ['JSON-строка', JSON.stringify('lmn_lead')],
  ['JSON-null', JSON.stringify(null)],
  ['JSON-число', JSON.stringify(42)],
  ['объект без direction', JSON.stringify({ v: 1, at: Date.now() })],
  ['direction не строка', JSON.stringify({ v: 1, at: Date.now(), direction: 7 })],
  ['at не число', JSON.stringify({ v: 1, at: 'вчера', direction: 'bank' })],
  ['at = NaN после разбора', '{"v":1,"at":null,"direction":"bank"}'],
];

for (const [label, raw] of BROKEN) {
  test(`битое значение (${label}) → null`, () => {
    const restore = installStorage(createFakeStorage({ [LEAD_STATE_KEY]: raw }));
    try {
      assert.equal(readLeadState(), null);
    } finally {
      restore();
    }
  });
}

test("writeLeadState('bank') кладёт разбираемый JSON, readLeadState читает direction", () => {
  const storage = createFakeStorage();
  const restore = installStorage(storage);
  try {
    writeLeadState('bank');
    assert.equal(storage.writes.length, 1);
    assert.equal(storage.writes[0]?.key, LEAD_STATE_KEY);

    const parsed = JSON.parse(storage.writes[0]!.value) as { v: unknown; at: unknown; direction: unknown };
    assert.equal(parsed.v, 1);
    assert.equal(parsed.direction, 'bank');
    assert.equal(typeof parsed.at, 'number');

    const state = readLeadState();
    assert.equal(state?.direction, 'bank');
  } finally {
    restore();
  }
});

test('clearLeadState удаляет ровно свой ключ, и после него чтение даёт null', () => {
  const storage = createFakeStorage({ [LEAD_STATE_KEY]: storedValue(HOUR_MS), lmn_attr: '{"v":1}' });
  const restore = installStorage(storage);
  try {
    clearLeadState();
    assert.deepEqual(storage.removals, [LEAD_STATE_KEY]);
    assert.equal(readLeadState(), null);
    assert.equal(storage.getItem('lmn_attr'), '{"v":1}');
  } finally {
    restore();
  }
});

test('бросающее на получении объекта хранилище: readLeadState → null', () => {
  const restore = installThrowingStorage();
  try {
    assert.equal(readLeadState(), null);
  } finally {
    restore();
  }
});

test('бросающее на получении объекта хранилище: writeLeadState молчит', () => {
  const restore = installThrowingStorage();
  try {
    assert.doesNotThrow(() => writeLeadState('teamcash'));
  } finally {
    restore();
  }
});

test('бросающее на получении объекта хранилище: clearLeadState молчит', () => {
  const restore = installThrowingStorage();
  try {
    assert.doesNotThrow(() => clearLeadState());
  } finally {
    restore();
  }
});

test('подделка действительно бросает — негативный контроль самой подделки', () => {

  const restore = installThrowingStorage();
  try {
    assert.throws(
      () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        (globalThis as { localStorage?: unknown }).localStorage;
      },
      (err: unknown) => err instanceof DOMException && err.name === 'SecurityError',
    );

    assert.throws(() => typeof (globalThis as { localStorage?: unknown }).localStorage);
  } finally {
    restore();
  }
});

test('QuotaExceededError на setItem: writeLeadState молча возвращается', () => {
  const quota = () => {
    const err = new DOMException('quota', 'QuotaExceededError');
    throw err;
  };
  const storage = createFakeStorage({}, quota);
  const restore = installStorage(storage);
  try {
    assert.doesNotThrow(() => writeLeadState('affiliate'));
    assert.equal(storage.writes.length, 0);

    assert.equal(readLeadState(), null);
  } finally {
    restore();
  }
});

test('бросающий removeItem: clearLeadState молча возвращается', () => {
  const storage = createFakeStorage({ [LEAD_STATE_KEY]: storedValue(HOUR_MS) });
  const angry: FakeStorage = {
    ...storage,
    removeItem() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  };
  const restore = installStorage(angry);
  try {
    assert.doesNotThrow(() => clearLeadState());
  } finally {
    restore();
  }
});

test('лишние поля подложенного значения в результат НЕ переносятся (T-05-15)', () => {
  const raw = JSON.stringify({
    v: 1,
    at: Date.now(),
    direction: 'bank',
    __proto__: { polluted: true },
    html: '<img src=x onerror=alert(1)>',
    token: 'секрет',
  });
  const restore = installStorage(createFakeStorage({ [LEAD_STATE_KEY]: raw }));
  try {
    const state = readLeadState();
    assert.notEqual(state, null);
    assert.deepEqual(Object.keys(state as object).sort(), ['at', 'direction', 'v']);
    assert.equal((state as unknown as Record<string, unknown>).html, undefined);
    assert.equal((state as unknown as Record<string, unknown>).token, undefined);
  } finally {
    restore();
  }
});
