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

/** "clip" = vídeo real; "gap" = hueco (silencio/negro); "transition" = fundido entre el clip anterior y el siguiente. Ver DESIGN.md §1. */
export type ClipKind = "clip" | "gap" | "transition";

export type TransitionType = "crossfade" | "dipToBlack";

/**
 * Un Clip es una referencia a un SourceFile más un rango de tiempo
 * dentro de ese archivo — nunca datos de píxeles copiados. La posición
 * del clip en la línea de tiempo NO se almacena aquí: se deriva de su
 * posición en Track.clips (modelo "ripple", ver DESIGN.md §1).
 *
 * Un hueco o una transición son un Clip especial más en el array (no
 * un tipo de dato aparte ni un campo de posición): `sourceId` va vacío
 * y `sourceOutTicks - sourceInTicks` es su duración. Mantiene la misma
 * invariante "sin campo de posición" para todo — ver DESIGN.md §1.
 */
export interface Clip {
  id: string;
  /** Por defecto "clip" — ver ClipKind. */
  kind: ClipKind;
  sourceId: string;
  /** Punto de entrada, en ticks, dentro del tiempo del SourceFile. Para "gap"/"transition", siempre 0. */
  sourceInTicks: number;
  /** Punto de salida (exclusivo), en ticks, dentro del tiempo del SourceFile. Para "gap"/"transition", es su duración. */
  sourceOutTicks: number;
  /** Ganancia de audio del clip, 0-1. Por defecto 1 (sin atenuar). */
  volume: number;
  /** Si está silenciado, el audio del clip no suena ni se exporta, independientemente de `volume`. */
  muted: boolean;
  /** Solo relevante si kind === "transition". */
  transitionType?: TransitionType;
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
