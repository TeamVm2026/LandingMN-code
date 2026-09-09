
import test from 'node:test';
import assert from 'node:assert/strict';

async function freshRegionModule(tag: string): Promise<{
  regionOnce: () => Promise<string | null>;
  detectRegion: (timeoutMs?: number) => Promise<string | null>;
}> {
  return import(`../../src/scripts/analytics/region.ts?fresh=${tag}`);
}

interface FetchStub {
  calls: number;
  release: () => void;
}

function stubNetwork(loc: string | null): FetchStub {
  let unlock: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const stub: FetchStub = { calls: 0, release: () => unlock() };

  (globalThis as { window?: unknown }).window = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  };

  (globalThis as { fetch?: unknown }).fetch = async (): Promise<unknown> => {
    stub.calls += 1;
    await gate;
    return {
      ok: loc !== null,
      status: loc === null ? 404 : 200,
      text: async () => `fl=1\nh=x\nip=203.0.113.7\ncolo=AMS\nloc=${loc}\ntls=TLSv1.3\n`,
    };
  };

  return stub;
}

test('РЕГИОН: два перекрывающихся вызова — один запрос и один ответ', async () => {
  const stub = stubNetwork('DE');
  const { regionOnce } = await freshRegionModule('overlap');

  const first = regionOnce();
  const second = regionOnce();
  stub.release();

  assert.equal(await first, 'DE');
  assert.equal(await second, 'DE');
  assert.equal(stub.calls, 1, 'на два вызова ушло больше одного запроса — склейка не работает');
});

test('РЕГИОН: вызов ПОСЛЕ ответа тоже не создаёт второго запроса', async () => {
  const stub = stubNetwork('MN');
  const { regionOnce } = await freshRegionModule('sequential');

  stub.release();
  assert.equal(await regionOnce(), 'MN');
  assert.equal(await regionOnce(), 'MN');
  assert.equal(stub.calls, 1);
});

test('РЕГИОН: отрицательный ответ запоминается так же, как положительный', async () => {

  const stub = stubNetwork(null);
  const { regionOnce } = await freshRegionModule('negative');

  stub.release();
  assert.equal(await regionOnce(), null);
  assert.equal(await regionOnce(), null);
  assert.equal(stub.calls, 1);
});

test('РЕГИОН: detectRegion остаётся БЕЗ памяти — каждый вызов свой запрос', async () => {

  const stub = stubNetwork('GB');
  const { detectRegion } = await freshRegionModule('direct');

  stub.release();
  assert.equal(await detectRegion(), 'GB');
  assert.equal(await detectRegion(), 'GB');
  assert.equal(stub.calls, 2);
});
