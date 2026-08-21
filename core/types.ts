import type { FrameRate } from "./time";

/**
 * Metadatos de un archivo de origen. No contiene el archivo en sí ni
 * nada de I/O — eso vive en /media. /core solo necesita saber lo
 * mínimo para hacer aritmética de tiempo sobre él.
 *
 * `kind: "audio"` (fuente de solo audio, p.ej. un mp3/wav importado
 * directamente para una pista de audio — ampliación de alcance pedida
 * explícitamente el 2026-08-21, ver CLAUDE.md) no tiene `frameRate`/
 * `width`/`height`: no hay vídeo que decodificar.
 */
export interface SourceFile {
  id: string;
  kind: "video" | "audio";
  frameRate?: FrameRate;
  width?: number;
  height?: number;
  durationTicks: number;
}

/** "clip" = vídeo o audio real; "transition" = fundido entre el clip anterior y el siguiente de la MISMA pista. Ver DESIGN.md §1. Ya no existe "gap": un hueco es simplemente el tramo sin clip entre dos posiciones (ver `Clip.startTicks`) — ampliación de alcance pedida explícitamente el 2026-08-21, ver CLAUDE.md. */
export type ClipKind = "clip" | "transition";

export type TransitionType = "crossfade" | "dipToBlack";

/** Ver Track.kind. */
export type TrackKind = "video" | "audio";

/**
 * Filtro de color aplicado a un clip entero (todo su rango recortado),
 * como los propios fotogramas de vídeo — no hay keyframes ni variación
 * en el tiempo, a diferencia de `volumeKeyframes`. Ampliación de
 * alcance pedida explícitamente el 2026-08-21 (ver CLAUDE.md).
 */
export type ColorFilterType = "grayscale" | "sepia" | "invert" | "warm" | "cool" | "highContrast";

/**
 * Un punto de volumen dentro de un clip, para subir/bajar el audio
 * "por trozos" en vez de un único volumen fijo para todo el clip. Se
 * interpola linealmente entre puntos consecutivos — ver
 * volumeAtOffsetTicks en timeline.ts. Si un clip no tiene ninguno, su
 * volumen es el escalar plano `Clip.volume` de siempre.
 */
export interface VolumeKeyframe {
  /** Ticks relativos al inicio de ESTE clip (0 = su primer fotograma tras cualquier recorte), no a la timeline global. */
  offsetTicks: number;
  /** Ganancia 0-1 en ese instante. */
  volume: number;
}

/**
 * Un Clip es una referencia a un SourceFile más un rango de tiempo
 * dentro de ese archivo — nunca datos de píxeles copiados.
 *
 * `startTicks` es la posición absoluta de inicio del clip en la
 * timeline de SU pista — ampliación de alcance pedida explícitamente
 * el 2026-08-21 (ver CLAUDE.md), sustituye el modelo "ripple" anterior
 * (donde la posición se derivaba sumando las duraciones de los clips
 * previos en el array). Dos clips de la misma pista nunca se solapan,
 * pero pueden dejar un tramo sin cubrir entre ellos — ese tramo ES el
 * hueco, no hay ningún objeto que lo represente.
 *
 * Una transición es un Clip especial más en el array (no un tipo de
 * dato aparte): `sourceId` va vacío y `sourceOutTicks - sourceInTicks`
 * es su duración. Solo tiene sentido pegada por posición a sus dos
 * vecinos de la misma pista — ver `neighborsOfTransition` en
 * timeline.ts.
 */
export interface Clip {
  id: string;
  /** Por defecto "clip" — ver ClipKind. */
  kind: ClipKind;
  sourceId: string;
  /** Posición de inicio absoluta, en ticks, dentro de la timeline de su pista. */
  startTicks: number;
  /** Punto de entrada, en ticks, dentro del tiempo del SourceFile. Para "transition", siempre 0. */
  sourceInTicks: number;
  /** Punto de salida (exclusivo), en ticks, dentro del tiempo del SourceFile. Para "transition", es su duración. */
  sourceOutTicks: number;
  /** Ganancia de audio del clip, 0-1. Por defecto 1 (sin atenuar). */
  volume: number;
  /** Si está silenciado, el audio del clip no suena ni se exporta, independientemente de `volume` o `volumeKeyframes`. */
  muted: boolean;
  /** Solo relevante si kind === "transition". */
  transitionType?: TransitionType;
  /** Puntos de volumen dentro del clip (orden ascendente por offsetTicks) — ver VolumeKeyframe. undefined/[] = volumen plano (`volume`). */
  volumeKeyframes?: VolumeKeyframe[];
  /** Solo relevante si kind === "clip". undefined = sin filtro (vídeo tal cual). */
  colorFilter?: ColorFilterType;
}

/**
 * Pista de clips con posición explícita (nunca solapados dentro de la
 * misma pista). `kind` determina qué contiene y cómo se compone:
 * "video" participa en la composición por capas opacas (ver
 * `resolveActiveVideoPosition` en timeline.ts); "audio" solo aporta
 * sonido, mezclado con el resto de pistas no ocultas. Ampliación de
 * alcance (multipista) pedida explícitamente el 2026-08-21, ver
 * CLAUDE.md.
 */
export interface Track {
  id: string;
  kind: TrackKind;
  clips: Clip[];
  /** Excluye la pista entera de previsualización/exportación: en vídeo, deja ver las pistas de abajo; en audio, no suena. Icono en la UI: ojo (vídeo) o altavoz/mute (audio) — misma semántica. */
  hidden: boolean;
  /** Nombre puesto por el usuario. undefined = sin personalizar, la UI muestra un nombre automático ("Vídeo N"/"Audio N") — ver trackDisplayName en ui/main.ts. Ampliación de alcance pedida explícitamente el 2026-08-21. */
  name?: string;
}

export interface Resolution {
  width: number;
  height: number;
}

/** El orden del array es el orden de composición de las pistas de vídeo: índice más alto = capa más arriba (tapa a las de índice más bajo donde tenga contenido). Para audio el orden no afecta al sonido (todas se mezclan), solo a cómo se listan en la UI. */
export interface Timeline {
  tracks: Track[];
  outputResolution: Resolution;
  outputFrameRate: FrameRate;
}
