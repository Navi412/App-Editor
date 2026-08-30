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
 * Corrección de color real (primarias lift/gamma/gain por canal RGB +
 * saturación/contraste/inversión), independiente de `colorFilter`
 * (presets fijos vía CSS filter) — ampliación de alcance pedida
 * explícitamente el 2026-08-29 para acercar el grading a una consola
 * real (fórmula ASC CDL: `out = clamp(in*gain+lift, 0, 1) ^ (1/gamma)`,
 * la misma que usan herramientas de grading profesionales). Ambos
 * mecanismos pueden convivir en el mismo clip — se aplican en orden
 * (grading real primero, filtro CSS después) en media/render.ts.
 * undefined = sin grading (vídeo tal cual, coste cero: ni siquiera se
 * crea el contexto WebGL — ver media/colorGradeGL.ts).
 */
export interface ColorGrade {
  liftR: number;
  liftG: number;
  liftB: number;
  gammaR: number;
  gammaG: number;
  gammaB: number;
  gainR: number;
  gainG: number;
  gainB: number;
  /** 0 = blanco y negro, 1 = neutro, >1 = más saturado. */
  saturation: number;
  /** 1 = neutro, pivota sobre 0.5. */
  contrast: number;
  invert: boolean;
}

export const NEUTRAL_COLOR_GRADE: ColorGrade = {
  liftR: 0,
  liftG: 0,
  liftB: 0,
  gammaR: 1,
  gammaG: 1,
  gammaB: 1,
  gainR: 1,
  gainG: 1,
  gainB: 1,
  saturation: 1,
  contrast: 1,
  invert: false,
};

/**
 * Croma (chroma key) por distancia de color respecto a `keyColor` —
 * ampliación de alcance pedida explícitamente el 2026-08-29. Aplicado
 * en el mismo paso de WebGL que ColorGrade (ver media/colorGradeGL.ts),
 * produce alfa real; solo tiene efecto visible compuesto sobre otra
 * pista en la EXPORTACIÓN (export/exportTimeline.ts resuelve la pista
 * de vídeo inmediatamente inferior y compone debajo) — la
 * previsualización en directo, por el motor de reproducción de un solo
 * decodificador activo a la vez (ver DESIGN.md §3), sigue mostrando
 * solo esta pista con el recorte ya aplicado sobre negro, no compuesto
 * con lo de abajo; limitación documentada, no un olvido.
 */
export interface ChromaKey {
  enabled: boolean;
  /** 0-1. */
  keyR: number;
  keyG: number;
  keyB: number;
  /** 0-1: cuánta distancia de color se considera "el mismo color". */
  similarity: number;
  /** 0-1: anchura del degradado del borde entre opaco y transparente. */
  smoothness: number;
}

export const NEUTRAL_CHROMA_KEY: ChromaKey = {
  enabled: false,
  keyR: 0,
  keyG: 1,
  keyB: 0,
  similarity: 0.4,
  smoothness: 0.1,
};

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
  /**
   * Opuesto simétrico de `muted`, pero para el vídeo: si está a true, el
   * clip no participa en la composición de vídeo (resolveActiveVideoPosition
   * lo salta, como si no estuviera — se ve lo que haya debajo, o negro),
   * pero su audio sigue sonando/exportándose con total normalidad, en su
   * sitio de siempre. Permite "dejar solo audio" de un clip sin moverlo
   * a otra pista (fuera de alcance, ver CLAUDE.md) — ampliación de
   * alcance pedida explícitamente el 2026-08-29. Por defecto false/undefined.
   */
  videoHidden?: boolean;
  /** Solo relevante si kind === "transition". */
  transitionType?: TransitionType;
  /** Puntos de volumen dentro del clip (orden ascendente por offsetTicks) — ver VolumeKeyframe. undefined/[] = volumen plano (`volume`). */
  volumeKeyframes?: VolumeKeyframe[];
  /** Solo relevante si kind === "clip". undefined = sin filtro (vídeo tal cual). */
  colorFilter?: ColorFilterType;
  /** Solo relevante si kind === "clip". undefined = sin grading (vídeo tal cual). Ver ColorGrade. */
  colorGrade?: ColorGrade;
  /** Solo relevante si kind === "clip". undefined = sin croma. Ver ChromaKey. */
  chromaKey?: ChromaKey;
  /**
   * Bandera del clip (estilo DaVinci Resolve: tecla G) — un simple
   * marcador visual "este clip me interesa", sin efecto en la
   * reproducción ni la exportación. undefined/false = sin bandera.
   * Ampliación de alcance pedida explícitamente el 2026-08-30.
   */
  flagged?: boolean;
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

/**
 * Procesado de audio del bus máster (TODA la mezcla final, no un clip
 * ni una pista) — ecualizador de 3 bandas + compresor/limitador,
 * pedido explícitamente el 2026-08-29 para acercar la mezcla a una
 * consola real en vez de solo un fader por clip. `compressionAmount`
 * (0-100) es una simplificación deliberada de umbral+ratio en un único
 * mando — más utilizable que exponer los 4-5 parámetros crudos de
 * DynamicsCompressorNode; ver compressorParamsFromAmount en
 * timeline.ts, que es la única traducción entre ambos. `enabled` en
 * false dispensa por completo del procesado (ver
 * media/masterAudioChain.ts): un proyecto sin `masterAudio` (undefined)
 * se comporta exactamente como antes de esta ampliación.
 */
export interface MasterAudio {
  enabled: boolean;
  /** dB, típicamente -12..12. Shelf grave (~200Hz). */
  eqLowDb: number;
  /** dB, típicamente -12..12. Peaking medio (~1500Hz). */
  eqMidDb: number;
  /** dB, típicamente -12..12. Shelf agudo (~5000Hz). */
  eqHighDb: number;
  /** 0 (sin compresión) .. 100 (máxima). */
  compressionAmount: number;
  /** dB, ganancia de compensación tras comprimir — típicamente 0..12. */
  makeupGainDb: number;
}

/** El orden del array es el orden de composición de las pistas de vídeo: índice más alto = capa más arriba (tapa a las de índice más bajo donde tenga contenido). Para audio el orden no afecta al sonido (todas se mezclan), solo a cómo se listan en la UI. */
export interface Timeline {
  tracks: Track[];
  outputResolution: Resolution;
  outputFrameRate: FrameRate;
  /** undefined = sin procesado de máster (comportamiento de siempre). Ver MasterAudio. */
  masterAudio?: MasterAudio;
}
