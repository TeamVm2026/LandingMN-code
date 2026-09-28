
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calibrateCpu,
  CPU_REFERENCE_BENCHMARK,
  CPU_DEFAULT_MULTIPLIER,
  CPU_MULTIPLIER_FLOOR,
  CPU_MULTIPLIER_CEIL,
} from '../../scripts/lib/cpu-calibration.ts';

test('на опорной машине множитель ровно умолчательный', () => {
  const c = calibrateCpu(CPU_REFERENCE_BENCHMARK);
  assert.equal(c.multiplier, CPU_DEFAULT_MULTIPLIER);
  assert.equal(c.source, 'benchmark');
  assert.equal(c.clamped, false);
});

test('множитель пропорционален индексу: медленный раннер мягче, быстрый строже', () => {

  const slow = calibrateCpu(2324);
  const fast = calibrateCpu(3988);
  assert.equal(slow.multiplier, 3.21);
  assert.equal(fast.multiplier, 5.5);
  assert.ok(slow.multiplier < CPU_DEFAULT_MULTIPLIER && fast.multiplier > CPU_DEFAULT_MULTIPLIER);

  assert.ok(Math.abs(2324 / slow.multiplier - 3988 / fast.multiplier) < 2);
});

test('за пределами честной эмуляции множитель упирается в границу и говорит об этом', () => {
  const tooSlow = calibrateCpu(900);
  assert.equal(tooSlow.multiplier, CPU_MULTIPLIER_FLOOR);
  assert.equal(tooSlow.clamped, true);
  const tooFast = calibrateCpu(9000);
  assert.equal(tooFast.multiplier, CPU_MULTIPLIER_CEIL);
  assert.equal(tooFast.clamped, true);
});

test('нет индекса — отказ калибровки КРАСНЫЙ, а не молчаливые 4×', () => {
  for (const bad of [undefined, Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
    assert.throws(() => calibrateCpu(bad), /отказ калибровки/);
  }
});

test('явный множитель из окружения перекрывает индекс, мусор в нём — ошибка', () => {
  const forced = calibrateCpu(2324, '4');
  assert.equal(forced.multiplier, 4);
  assert.equal(forced.source, 'override');

  assert.equal(calibrateCpu(2900, '').source, 'benchmark');
  assert.equal(calibrateCpu(2900, '  ').source, 'benchmark');
  assert.throws(() => calibrateCpu(2900, 'abc'), /не положительное число/);
  assert.throws(() => calibrateCpu(2900, '0'), /не положительное число/);
});
