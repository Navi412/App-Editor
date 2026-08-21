import type { Clip, Timeline, TransitionType, Track } from "./types";

/**
 * Todas las funciones de este módulo son puras: reciben una Timeline y
 * devuelven una Timeline nueva (o un valor derivado), nunca mutan sus
 * argumentos. No dependen de WebCodecs, mp4box ni del DOM — deben
 * poder testearse sin abrir un solo archivo de vídeo real.
 */

export function clipDurationTicks(clip: Clip): number {
  return clip.sourceOutTicks - clip.sourceInTicks;
}

export function trackDurationTicks(track: Track): number {
  return track.clips.reduce((sum, clip) => sum + clipDurationTicks(clip), 0);
}

export function timelineDurationTicks(timeline: Timeline): number {
  return trackDurationTicks(timeline.track);
}

/**
 * Posición de inicio de un clip en la timeline (suma de las
 * duraciones de los clips anteriores). Es la operación inversa de
 * walkTimeline a nivel de clip — walkTimeline resuelve "qué clip hay
 * en este tick"; clipStartTicks resuelve "en qué tick empieza este
 * clip". Útil para traducir de vuelta una posición de reproducción
 * dentro de un clip a una posición global de la timeline.
 */
export function clipStartTicks(timeline: Timeline, clipIndex: number): number {
  const clips = timeline.track.clips;
  if (clipIndex < 0 || clipIndex >= clips.length) {
    throw new RangeError(`Índice de clip fuera de rango: ${clipIndex}`);
  }
  let cursor = 0;
  for (let i = 0; i < clipIndex; i++) {
    cursor += clipDurationTicks(clips[i]!);
  }
  return cursor;
}

export interface TimelinePosition {
  clip: Clip;
  clipIndex: number;
  sourceId: string;
  /** Instante correspondiente dentro del SourceFile referenciado por el clip. */
  sourceTimeTicks: number;
}

/**
 * Resuelve una posición de la línea de tiempo a (archivo, tiempo
 * dentro del archivo). Es el corazón de /core: tanto la
 * previsualización como la exportación llaman a esta misma función
 * para saber qué fotograma de qué archivo toca en el instante T — ver
 * DESIGN.md §2.
 *
 * El rango válido de la timeline es semiabierto: [0, duración total).
 * Un `timelineTicks` negativo o >= a la duración total no corresponde
 * a ningún clip y devuelve null.
 */
export function walkTimeline(
  timeline: Timeline,
  timelineTicks: number,
): TimelinePosition | null {
  if (timelineTicks < 0) return null;

  let cursor = 0;
  const clips = timeline.track.clips;
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!;
    const duration = clipDurationTicks(clip);
    if (timelineTicks < cursor + duration) {
      return {
        clip,
        clipIndex: i,
        sourceId: clip.sourceId,
        sourceTimeTicks: clip.sourceInTicks + (timelineTicks - cursor),
      };
    }
    cursor += duration;
  }
  return null;
}

export function appendClip(timeline: Timeline, clip: Clip): Timeline {
  return {
    ...timeline,
    track: { ...timeline.track, clips: [...timeline.track.clips, clip] },
  };
}

/** Inserta `clip` en la posición `index` (recortado a [0, longitud]), desplazando el resto. */
export function insertClipAt(timeline: Timeline, index: number, clip: Clip): Timeline {
  const clips = [...timeline.track.clips];
  const clampedIndex = Math.max(0, Math.min(index, clips.length));
  clips.splice(clampedIndex, 0, clip);
  return { ...timeline, track: { ...timeline.track, clips } };
}

/** Hueco (silencio + negro) de `durationTicks`. Ver DESIGN.md §1: es un Clip especial, no un campo de posición aparte. */
export function createGap(id: string, durationTicks: number): Clip {
  return {
    id,
    kind: "gap",
    sourceId: "",
    sourceInTicks: 0,
    sourceOutTicks: Math.max(1, durationTicks),
    volume: 1,
    muted: false,
  };
}

/** Transición básica de `durationTicks` entre el clip anterior y el siguiente en el array (ver media/transitionRender.ts). */
export function createTransition(id: string, durationTicks: number, transitionType: TransitionType): Clip {
  return {
    id,
    kind: "transition",
    sourceId: "",
    sourceInTicks: 0,
    sourceOutTicks: Math.max(1, durationTicks),
    volume: 1,
    muted: false,
    transitionType,
  };
}

export function removeClip(timeline: Timeline, clipIndex: number): Timeline {
  const clips = timeline.track.clips;
  if (clipIndex < 0 || clipIndex >= clips.length) {
    throw new RangeError(`Índice de clip fuera de rango: ${clipIndex}`);
  }
  const next = [...clips];
  next.splice(clipIndex, 1);
  return { ...timeline, track: { ...timeline.track, clips: next } };
}

/**
 * Mueve un clip de fromIndex a toIndex dentro de la pista. Al ser un
 * modelo "ripple" (sin huecos), reordenar es solo mover el elemento en
 * el array — las posiciones de todos los clips afectados se derivan
 * solas la próxima vez que se calculen.
 */
export function reorderClip(
  timeline: Timeline,
  fromIndex: number,
  toIndex: number,
): Timeline {
  const clips = timeline.track.clips;
  if (fromIndex < 0 || fromIndex >= clips.length) {
    throw new RangeError(`fromIndex fuera de rango: ${fromIndex}`);
  }
  if (toIndex < 0 || toIndex >= clips.length) {
    throw new RangeError(`toIndex fuera de rango: ${toIndex}`);
  }
  const next = [...clips];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved!);
  return { ...timeline, track: { ...timeline.track, clips: next } };
}

/**
 * Parte el clip que ocupa timelineTicks en dos. newIds debe traer los
 * ids de los dos clips resultantes: [idDelPrimerTrozo, idDelSegundoTrozo].
 * Se piden explícitos (en vez de generarlos aquí con, p.ej., un uuid
 * aleatorio) para que la función siga siendo pura y determinista.
 *
 * Lanza si timelineTicks cae fuera de la timeline, o si coincide
 * exactamente con el inicio de un clip (el corte produciría un
 * fragmento de duración cero).
 */
export function splitClipAt(
  timeline: Timeline,
  timelineTicks: number,
  newIds: [string, string],
): Timeline {
  const position = walkTimeline(timeline, timelineTicks);
  if (!position) {
    throw new RangeError(
      `No hay ningún clip en el tick ${timelineTicks} de la timeline`,
    );
  }
  const { clip, clipIndex, sourceTimeTicks } = position;
  if (sourceTimeTicks === clip.sourceInTicks) {
    throw new RangeError(
      "El punto de corte coincide con el inicio del clip; el corte produciría un fragmento de duración cero",
    );
  }

  const [firstId, secondId] = newIds;
  const firstHalf: Clip = { ...clip, id: firstId, sourceOutTicks: sourceTimeTicks };
  const secondHalf: Clip = { ...clip, id: secondId, sourceInTicks: sourceTimeTicks };

  const clips = [...timeline.track.clips];
  clips.splice(clipIndex, 1, firstHalf, secondHalf);
  return { ...timeline, track: { ...timeline.track, clips } };
}

/**
 * Ajusta el punto de entrada de un clip. minDurationTicks lo calcula
 * el llamador (normalmente frameDurationTicks() del frame rate de la
 * fuente) — /core no conoce el registro de SourceFile, solo aplica la
 * invariante de que ningún clip puede quedar por debajo de esa duración.
 */
export function trimClipIn(
  timeline: Timeline,
  clipIndex: number,
  newSourceInTicks: number,
  minDurationTicks: number,
): Timeline {
  const clip = timeline.track.clips[clipIndex];
  if (!clip) throw new RangeError(`Índice de clip fuera de rango: ${clipIndex}`);
  if (newSourceInTicks < 0) {
    throw new RangeError("sourceInTicks no puede ser negativo");
  }
  if (clip.sourceOutTicks - newSourceInTicks < minDurationTicks) {
    throw new RangeError(
      "El recorte dejaría el clip por debajo de la duración mínima",
    );
  }
  const clips = [...timeline.track.clips];
  clips[clipIndex] = { ...clip, sourceInTicks: newSourceInTicks };
  return { ...timeline, track: { ...timeline.track, clips } };
}

/** Ajusta el punto de salida de un clip. Ver trimClipIn para minDurationTicks. */
export function trimClipOut(
  timeline: Timeline,
  clipIndex: number,
  newSourceOutTicks: number,
  minDurationTicks: number,
): Timeline {
  const clip = timeline.track.clips[clipIndex];
  if (!clip) throw new RangeError(`Índice de clip fuera de rango: ${clipIndex}`);
  if (newSourceOutTicks - clip.sourceInTicks < minDurationTicks) {
    throw new RangeError(
      "El recorte dejaría el clip por debajo de la duración mínima",
    );
  }
  const clips = [...timeline.track.clips];
  clips[clipIndex] = { ...clip, sourceOutTicks: newSourceOutTicks };
  return { ...timeline, track: { ...timeline.track, clips } };
}

/** Ganancia de audio (0-1, se recorta a ese rango) y silencio de un clip. */
export function setClipAudio(
  timeline: Timeline,
  clipIndex: number,
  volume: number,
  muted: boolean,
): Timeline {
  const clip = timeline.track.clips[clipIndex];
  if (!clip) throw new RangeError(`Índice de clip fuera de rango: ${clipIndex}`);
  const clampedVolume = Math.max(0, Math.min(1, volume));
  const clips = [...timeline.track.clips];
  clips[clipIndex] = { ...clip, volume: clampedVolume, muted };
  return { ...timeline, track: { ...timeline.track, clips } };
}

/** Ganancia efectiva de un clip para reproducción/exportación: 0 si está silenciado. */
export function effectiveClipVolume(clip: Clip): number {
  return clip.muted ? 0 : clip.volume;
}
