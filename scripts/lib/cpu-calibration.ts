
export const CPU_REFERENCE_BENCHMARK = 2900;

export const CPU_DEFAULT_MULTIPLIER = 4;

export const CPU_MULTIPLIER_FLOOR = 2;

export const CPU_MULTIPLIER_CEIL = 8;

export interface CpuCalibration {
  multiplier: number;

  source: 'benchmark' | 'override';

  clamped: boolean;
}

export function calibrateCpu(
  benchmarkIndex: number | undefined,
  override?: string,
): CpuCalibration {
  if (override !== undefined && override.trim() !== '') {
    const forced = Number(override);
    if (!Number.isFinite(forced) || forced <= 0) {
      throw new Error(`LH_CPU_MULTIPLIER="${override}" — не положительное число`);
    }
    return { multiplier: forced, source: 'override', clamped: false };
  }
  if (typeof benchmarkIndex !== 'number' || !Number.isFinite(benchmarkIndex) || benchmarkIndex <= 0) {
    throw new Error(
      `benchmarkIndex машины не получен (${String(benchmarkIndex)}) — это отказ калибровки, а не повод мерить на 4×`,
    );
  }
  const raw = (CPU_DEFAULT_MULTIPLIER * benchmarkIndex) / CPU_REFERENCE_BENCHMARK;
  const multiplier = Math.min(CPU_MULTIPLIER_CEIL, Math.max(CPU_MULTIPLIER_FLOOR, raw));
  return {
    multiplier: Math.round(multiplier * 100) / 100,
    source: 'benchmark',
    clamped: multiplier !== raw,
  };
}
