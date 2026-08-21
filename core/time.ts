/**
 * Unidad de tiempo canónica de todo el proyecto: ticks enteros a
 * TICKS_PER_SECOND por segundo. Ver DESIGN.md §0 para la justificación
 * de por qué 600_000 y por qué el redondeo en tasas NTSC (/1001) es
 * seguro. Ningún otro módulo debe definir su propia unidad de tiempo.
 */
export const TICKS_PER_SECOND = 600_000;

export interface FrameRate {
  numerator: number;
  denominator: number;
}

export function secondsToTicks(seconds: number): number {
  return Math.round(seconds * TICKS_PER_SECOND);
}

export function ticksToSeconds(ticks: number): number {
  return ticks / TICKS_PER_SECOND;
}

/** Duración de un fotograma de una fuente, en ticks. */
export function frameDurationTicks(frameRate: FrameRate): number {
  return Math.round(
    (frameRate.denominator / frameRate.numerator) * TICKS_PER_SECOND,
  );
}

/**
 * Convierte un índice de fotograma de una fuente (0-based) a ticks.
 * Es la única forma permitida de obtener un valor en ticks a partir de
 * un número de fotograma — nunca se multiplica frameDurationTicks()
 * por el índice, porque eso acumula el error de redondeo del
 * fotograma; esta fórmula calcula el producto exacto antes de redondear.
 */
export function sourceFrameIndexToTicks(
  frameIndex: number,
  frameRate: FrameRate,
): number {
  return Math.round(
    (frameIndex * frameRate.denominator * TICKS_PER_SECOND) /
      frameRate.numerator,
  );
}

/**
 * Convierte ticks al índice de fotograma de una fuente (0-based) que
 * está activo en ese instante. Es el inverso de
 * sourceFrameIndexToTicks — ver DESIGN.md §0 sobre por qué este
 * redondeo nunca es ambiguo.
 */
export function ticksToSourceFrameIndex(
  ticks: number,
  frameRate: FrameRate,
): number {
  return Math.round(
    (ticks * frameRate.numerator) / (frameRate.denominator * TICKS_PER_SECOND),
  );
}
