
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSENT_STORAGE_KEY,
  CONSENT_TTL_MS,
  readConsentChoice,
  writeConsentChoice,
  type ConsentChoice,
} from '../../src/scripts/analytics/consent.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const CHOICES: ConsentChoice[] = ['granted', 'denied'];

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

function record(ageMs: number, choice: ConsentChoice, version: unknown = 1): string {
  return JSON.stringify({ v: version, at: Date.now() - ageMs, c: choice });
}

function storedRecord(storage: FakeStorage): { v?: unknown; at?: unknown; c?: unknown } {
  const raw = storage.getItem(CONSENT_STORAGE_KEY);
  assert.notEqual(raw, null, 'в хранилище нет записи, разбирать нечего');
  return JSON.parse(raw as string) as { v?: unknown; at?: unknown; c?: unknown };
}

function withStorage(storage: FakeStorage, body: () => void): void {
  const restore = installStorage(storage);
  try {
    body();
  } finally {
    restore();
  }
}

test('срок объявлен ровными сутками: 183 дня', () => {
  assert.equal(CONSENT_TTL_MS, 183 * DAY_MS);

  assert.ok(CONSENT_TTL_MS > 150 * DAY_MS && CONSENT_TTL_MS < 200 * DAY_MS);
});

test('ключ прежний: смена ключа обнулила бы решения всех вернувшихся', () => {
  assert.equal(CONSENT_STORAGE_KEY, 'lmn_consent');
});

for (const choice of CHOICES) {
  test(`запись, сделанную только что, читаем как «${choice}»`, () => {
    const storage = createFakeStorage();
    withStorage(storage, () => {
      writeConsentChoice(choice);
      assert.equal(readConsentChoice(), choice);

      const parsed = storedRecord(storage);
      assert.equal(parsed.v, 1);
      assert.equal(parsed.c, choice);
      assert.equal(typeof parsed.at, 'number');

      assert.ok((parsed.at as number) > Date.now() - 60_000);
      assert.ok((parsed.at as number) <= Date.now());
    });
  });
}

test('отсутствующий ключ → null, без исключения', () => {
  withStorage(createFakeStorage(), () => {
    assert.equal(readConsentChoice(), null);
  });
});

test('среда вовсе без хранилища → null и запись без исключения', () => {

  assert.equal(readConsentChoice(), null);
  assert.doesNotThrow(() => writeConsentChoice('granted'));
});

for (const choice of CHOICES) {
  test(`штамп на сутки МЛАДШЕ срока: «${choice}» живо и ключ на месте`, () => {
    const storage = createFakeStorage({
      [CONSENT_STORAGE_KEY]: record(CONSENT_TTL_MS - DAY_MS, choice),
    });
    withStorage(storage, () => {
      assert.equal(readConsentChoice(), choice);
      assert.deepEqual(storage.removals, [], 'живую запись удалили');

      assert.deepEqual(storage.writes, [], 'живую запись переписали при чтении');
    });
  });

  test(`штамп на сутки СТАРШЕ срока: «${choice}» → null и ключ УДАЛЁН`, () => {
    const storage = createFakeStorage({
      [CONSENT_STORAGE_KEY]: record(CONSENT_TTL_MS + DAY_MS, choice),
    });
    withStorage(storage, () => {
      assert.equal(readConsentChoice(), null);

      assert.deepEqual(storage.removals, [CONSENT_STORAGE_KEY]);
      assert.equal(storage.getItem(CONSENT_STORAGE_KEY), null);
    });
  });
}

test('срок у «не надо» ровно тот же, что у «разрешаю», — не короче', () => {
  const offsets = [
    0,
    DAY_MS,
    Math.floor(CONSENT_TTL_MS / 2),
    CONSENT_TTL_MS - DAY_MS,
    CONSENT_TTL_MS + DAY_MS,
    CONSENT_TTL_MS * 2,
  ];

  for (const age of offsets) {
    const outcomes = CHOICES.map((choice) => {
      const storage = createFakeStorage({ [CONSENT_STORAGE_KEY]: record(age, choice) });
      let alive = false;
      let removed = false;
      withStorage(storage, () => {
        alive = readConsentChoice() !== null;
        removed = storage.removals.length > 0;
      });
      return { alive, removed };
    });

    assert.deepEqual(
      outcomes[0],
      outcomes[1],
      `на давности ${Math.round(age / DAY_MS)} сут. «разрешаю» и «не надо» ведут себя по-разному: ` +
        `${JSON.stringify(outcomes[0])} против ${JSON.stringify(outcomes[1])}`,
    );
  }

  const fresh = createFakeStorage({ [CONSENT_STORAGE_KEY]: record(0, 'granted') });
  const stale = createFakeStorage({ [CONSENT_STORAGE_KEY]: record(CONSENT_TTL_MS * 2, 'granted') });
  withStorage(fresh, () => assert.equal(readConsentChoice(), 'granted'));
  withStorage(stale, () => assert.equal(readConsentChoice(), null));
});

for (const choice of CHOICES) {
  test(`голая строка «${choice}» прежнего формата: решение живо и запись вылечена штампом`, () => {
    const storage = createFakeStorage({ [CONSENT_STORAGE_KEY]: choice });
    withStorage(storage, () => {
      assert.equal(readConsentChoice(), choice);

      assert.equal(storage.writes.length, 1, 'запись прежнего формата не вылечена');
      const parsed = storedRecord(storage);
      assert.equal(parsed.v, 1);
      assert.equal(parsed.c, choice);
      assert.equal(typeof parsed.at, 'number');
      assert.ok((parsed.at as number) > Date.now() - 60_000);

      assert.equal(readConsentChoice(), choice);
      assert.deepEqual(storage.removals, []);
    });
  });
}

test('лечение прежнего формата при НЕДОСТУПНОЙ записи: решение всё равно возвращается', () => {

  const storage = createFakeStorage({ [CONSENT_STORAGE_KEY]: 'denied' }, () => {
    throw new DOMException('quota', 'QuotaExceededError');
  });
  withStorage(storage, () => {
    assert.doesNotThrow(() => readConsentChoice());
  });
});

for (const alien of ['ok', 'no', 'OK', 'yes', 'true', '1', 'accepted', 'granted ', 'Granted']) {
  test(`значение «${alien}» согласием не считается`, () => {
    const storage = createFakeStorage({ [CONSENT_STORAGE_KEY]: alien });
    withStorage(storage, () => {
      assert.equal(readConsentChoice(), null);
      assert.deepEqual(storage.writes, [], 'чужому значению достроили штамп');
    });
  });
}

const BROKEN: [string, string][] = [
  ['мусор вместо JSON', '{не json'],
  ['пустая строка', ''],
  ['массив', JSON.stringify([{ v: 1, at: Date.now(), c: 'granted' }])],
  ['объект без полей', JSON.stringify({})],
  ['объект без решения', JSON.stringify({ v: 1, at: Date.now() })],
  ['объект без штампа', JSON.stringify({ v: 1, c: 'granted' })],
  ['штамп строкой', JSON.stringify({ v: 1, at: String(Date.now()), c: 'granted' })],
  ['штамп null', JSON.stringify({ v: 1, at: null, c: 'granted' })],
  ['чужая версия', JSON.stringify({ v: 2, at: Date.now(), c: 'granted' })],
  ['версия строкой', JSON.stringify({ v: '1', at: Date.now(), c: 'granted' })],
  ['чужое решение', JSON.stringify({ v: 1, at: Date.now(), c: 'ok' })],
  ['решение объектом', JSON.stringify({ v: 1, at: Date.now(), c: { value: 'granted' } })],
  ['null', JSON.stringify(null)],
  ['число', JSON.stringify(42)],
];

for (const [name, raw] of BROKEN) {
  test(`сломанная запись (${name}) → null, без исключения`, () => {
    const storage = createFakeStorage({ [CONSENT_STORAGE_KEY]: raw });
    withStorage(storage, () => {
      assert.equal(readConsentChoice(), null);

      assert.deepEqual(storage.writes, [], `записи «${name}» достроили штамп`);
    });
  });
}

for (const choice of CHOICES) {
  test(`штамп в будущем: «${choice}» живо и запись вылечена текущим моментом`, () => {
    const storage = createFakeStorage({
      [CONSENT_STORAGE_KEY]: record(-100 * 365 * DAY_MS, choice),
    });
    withStorage(storage, () => {
      assert.equal(readConsentChoice(), choice);
      assert.equal(storage.writes.length, 1, 'штамп из будущего не вылечен');

      const parsed = storedRecord(storage);
      assert.equal(parsed.c, choice);
      assert.ok(
        (parsed.at as number) <= Date.now(),
        'после лечения штамп по-прежнему в будущем — потолок подделки не поставлен',
      );

      storage.setItem(
        CONSENT_STORAGE_KEY,
        JSON.stringify({ v: 1, at: Date.now() - CONSENT_TTL_MS - DAY_MS, c: choice }),
      );
      assert.equal(readConsentChoice(), null);
    });
  });
}

test('бросающее ПОЛУЧЕНИЕ хранилища: чтение → null, без исключения', () => {
  const restore = installThrowingStorage();
  try {
    assert.doesNotThrow(() => readConsentChoice());
    assert.equal(readConsentChoice(), null);
  } finally {
    restore();
  }
});

test('бросающее ПОЛУЧЕНИЕ хранилища: запись не бросает и ничего не возвращает', () => {
  const restore = installThrowingStorage();
  try {
    for (const choice of CHOICES) {
      assert.doesNotThrow(() => writeConsentChoice(choice));
      assert.equal(writeConsentChoice(choice), undefined);
    }
  } finally {
    restore();
  }
});

test('забитая квота на записи: writeConsentChoice не бросает', () => {
  const storage = createFakeStorage({}, () => {
    throw new DOMException('quota', 'QuotaExceededError');
  });
  withStorage(storage, () => {
    assert.doesNotThrow(() => writeConsentChoice('granted'));

    assert.equal(readConsentChoice(), null);
  });
});
