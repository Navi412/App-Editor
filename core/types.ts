import type { FrameRate } from "./time";

/**
 * Metadatos de un archivo de origen. No contiene el archivo en sí ni
 * nada de I/O — eso vive en /media. /core solo necesita saber lo
 * mínimo para hacer aritmética de tiempo sobre él.
 */
export interface SourceFile {
  id: string;
  frameRate: FrameRate;
  width: number;
  height: number;
  durationTicks: number;
}

/**
 * Un Clip es una referencia a un SourceFile más un rango de tiempo
 * dentro de ese archivo — nunca datos de píxeles copiados. La posición
 * del clip en la línea de tiempo NO se almacena aquí: se deriva de su
 * posición en Track.clips (modelo "ripple", ver DESIGN.md §1).
 */
export interface Clip {
  id: string;
  sourceId: string;
  /** Punto de entrada, en ticks, dentro del tiempo del SourceFile. */
  sourceInTicks: number;
  /** Punto de salida (exclusivo), en ticks, dentro del tiempo del SourceFile. */
  sourceOutTicks: number;
}

/**
 * Pista de clips ordenados sin huecos. v1 solo usa una Track, pero se
 * modela como su propio tipo pensando en un futuro multipista.
 */
export interface Track {
  id: string;
  clips: Clip[];
}

export interface Resolution {
  width: number;
  height: number;
}

export interface Timeline {
  track: Track;
  outputResolution: Resolution;
  outputFrameRate: FrameRate;
}
