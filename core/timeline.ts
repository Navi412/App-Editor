import { ticksToSeconds } from "./time";
import type {
  ChromaKey,
  Clip,
  ColorFilterType,
  ColorGrade,
  MasterAudio,
  Timeline,
  Track,
  TrackKind,
  TransitionType,
  VolumeKeyframe,
} from "./types";

/**
 * Todas las funciones de este módulo son puras: reciben una Timeline y
 * devuelven una Timeline nueva (o un valor derivado), nunca mutan sus
 * argumentos. No dependen de WebCodecs, mp4box ni del DOM — deben
 * poder testearse sin abrir un solo archivo de vídeo real.
 */

export function clipDurationTicks(clip: Clip): number {
  return clip.sourceOutTicks - clip.sourceInTicks;
}

/** Instante (exclusivo) en el que termina el clip en la timeline de su pista. */
export function clipEndTicks(clip: Clip): number {
  return clip.startTicks + clipDurationTicks(clip);
}

/** Duración de una pista: el final del clip que termina más tarde (nunca la suma — puede haber huecos, ver Clip.startTicks). */
export function trackDurationTicks(track: Track): number {
  return track.clips.reduce((max, clip) => Math.max(max, clipEndTicks(clip)), 0);
}

/** Duración de la timeline completa: la pista más larga de todas. */
export function timelineDurationTicks(timeline: Timeline): number {
  return timeline.tracks.reduce((max, track) => Math.max(max, trackDurationTicks(track)), 0);
}

function requireTrackIndex(timeline: Timeline, trackId: string): number {
  const index = timeline.tracks.findIndex((t) => t.id === trackId);
  if (index === -1) throw new RangeError(`Pista no encontrada: ${trackId}`);
  return index;
}

function requireClipIndex(track: Track, clipId: string): number {
  const index = track.clips.findIndex((c) => c.id === clipId);
  if (index === -1) throw new RangeError(`Clip no encontrado: ${clipId}`);
  return index;
}

function updateTrack(timeline: Timeline, trackId: string, update: (track: Track) => Track): Timeline {
  const index = requireTrackIndex(timeline, trackId);
  const tracks = [...timeline.tracks];
  tracks[index] = update(tracks[index]!);
  return { ...timeline, tracks };
}

function sortByStart(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.startTicks - b.startTicks);
}

function clipsOverlap(a: Clip, b: Clip): boolean {
  return a.startTicks < clipEndTicks(b) && b.startTicks < clipEndTicks(a);
}

/** Clip que cubre `ticks` en `track` (o undefined si cae en un hueco o fuera de la pista). El rango de cada clip es semiabierto: [startTicks, clipEndTicks). */
export function findClipAtTicks(track: Track, ticks: number): Clip | undefined {
  if (ticks < 0) return undefined;
  return track.clips.find((c) => ticks >= c.startTicks && ticks < clipEndTicks(c));
}

export interface TimelinePosition {
  clip: Clip;
  /** Índice del clip dentro de `track.clips` (las pistas se mantienen ordenadas por startTicks tras cada mutación, ver updateTrack). */
  clipIndex: number;
  trackId: string;
  sourceId: string;
  /** Instante correspondiente dentro del SourceFile referenciado por el clip. */
  sourceTimeTicks: number;
}

/**
 * Resuelve qué hay que dibujar en el instante `timelineTicks`: recorre
 * las pistas de vídeo no ocultas de arriba a abajo (índice más alto
 * primero, ver doc de Timeline.tracks) y devuelve la primera que tenga
 * un clip en ese instante — composición por capas opacas, sin mezcla
 * alfa. `null` si ninguna pista de vídeo tiene contenido ahí (negro).
 *
 * Es el reemplazo de walkTimeline del modelo single-track: tanto la
 * previsualización como la exportación llaman a esta misma función
 * para el vídeo — ver DESIGN.md §2.
 */
export function resolveActiveVideoPosition(timeline: Timeline, timelineTicks: number): TimelinePosition | null {
  if (timelineTicks < 0) return null;
  for (let i = timeline.tracks.length - 1; i >= 0; i--) {
    const track = timeline.tracks[i]!;
    if (track.kind !== "video" || track.hidden) continue;
    const clipIndex = track.clips.findIndex((c) => timelineTicks >= c.startTicks && timelineTicks < clipEndTicks(c));
    if (clipIndex === -1) continue;
    const clip = track.clips[clipIndex]!;
    // videoHidden: el clip sigue ahí (su audio suena igual, ver
    // allAudioSchedules, que nunca consulta este campo) pero no
    // participa en la composición de vídeo — como si esta pista no
    // tuviera contenido en este instante, se sigue mirando hacia abajo.
    if (clip.videoHidden) continue;
    return {
      clip,
      clipIndex,
      trackId: track.id,
      sourceId: clip.sourceId,
      sourceTimeTicks: clip.sourceInTicks + (timelineTicks - clip.startTicks),
    };
  }
  return null;
}

/**
 * Como resolveActiveVideoPosition, pero empieza a buscar en la pista de
 * vídeo INMEDIATAMENTE debajo del índice `aboveTrackIndex` de
 * `timeline.tracks`, en vez de desde la más alta de todas — la capa de
 * fondo sobre la que se compone un clip con croma activo, SOLO en la
 * exportación (export/exportTimeline.ts) — ver ChromaKey en types.ts
 * sobre por qué la previsualización en directo no compone dos capas.
 * Ampliación de alcance pedida explícitamente el 2026-08-29.
 */
export function resolveActiveVideoPositionBelow(
  timeline: Timeline,
  timelineTicks: number,
  aboveTrackIndex: number,
): TimelinePosition | null {
  if (timelineTicks < 0) return null;
  for (let i = aboveTrackIndex - 1; i >= 0; i--) {
    const track = timeline.tracks[i]!;
    if (track.kind !== "video" || track.hidden) continue;
    const clipIndex = track.clips.findIndex((c) => timelineTicks >= c.startTicks && timelineTicks < clipEndTicks(c));
    if (clipIndex === -1) continue;
    const clip = track.clips[clipIndex]!;
    if (clip.videoHidden) continue;
    return {
      clip,
      clipIndex,
      trackId: track.id,
      sourceId: clip.sourceId,
      sourceTimeTicks: clip.sourceInTicks + (timelineTicks - clip.startTicks),
    };
  }
  return null;
}

/**
 * Primer instante > `afterTicks` en el que alguna pista de vídeo no
 * oculta vuelve a tener contenido (el `startTicks` de un clip más
 * cercano tras ese punto). `null` si no hay ninguno — útil para saber
 * cuánto dura, en la reproducción en directo, un hueco de vídeo antes
 * de que algo vuelva a mostrarse (ver ui/main.ts, playGapFrom).
 */
export function nextVideoContentTicks(timeline: Timeline, afterTicks: number): number | null {
  let best: number | null = null;
  for (const track of timeline.tracks) {
    if (track.kind !== "video" || track.hidden) continue;
    for (const clip of track.clips) {
      // videoHidden nunca aporta contenido de vídeo — ver resolveActiveVideoPosition.
      if (clip.videoHidden) continue;
      if (clip.startTicks > afterTicks && (best === null || clip.startTicks < best)) {
        best = clip.startTicks;
      }
    }
  }
  return best;
}

/** Añade una pista vacía y visible al final de `timeline.tracks` (capa más arriba de su tipo). */
export function addTrack(timeline: Timeline, id: string, kind: TrackKind): Timeline {
  return { ...timeline, tracks: [...timeline.tracks, { id, kind, clips: [], hidden: false }] };
}

export function removeTrack(timeline: Timeline, trackId: string): Timeline {
  const index = requireTrackIndex(timeline, trackId);
  const tracks = [...timeline.tracks];
  tracks.splice(index, 1);
  return { ...timeline, tracks };
}

/** Excluye/incluye una pista entera de previsualización y exportación — ver doc de Track.hidden. */
export function setTrackHidden(timeline: Timeline, trackId: string, hidden: boolean): Timeline {
  return updateTrack(timeline, trackId, (track) => ({ ...track, hidden }));
}

/** Pone (o, con una cadena vacía/solo espacios, quita) el nombre personalizado de una pista — ver doc de Track.name. */
export function renameTrack(timeline: Timeline, trackId: string, name: string): Timeline {
  return updateTrack(timeline, trackId, (track) => {
    const trimmed = name.trim();
    if (!trimmed) {
      const { name: _removed, ...rest } = track;
      return rest;
    }
    return { ...track, name: trimmed };
  });
}

/**
 * Reordena las capas de composición: "up" acerca la pista a la capa de
 * arriba (índice más alto = tapa a más pistas), "down" la aleja. Sin
 * efecto si ya está en el extremo correspondiente.
 */
export function moveTrack(timeline: Timeline, trackId: string, direction: "up" | "down"): Timeline {
  const index = requireTrackIndex(timeline, trackId);
  const targetIndex = direction === "up" ? index + 1 : index - 1;
  if (targetIndex < 0 || targetIndex >= timeline.tracks.length) return timeline;
  const tracks = [...timeline.tracks];
  const [moved] = tracks.splice(index, 1);
  tracks.splice(targetIndex, 0, moved!);
  return { ...timeline, tracks };
}

/** Añade `clip` al final de la pista `trackId` (después de su último clip — se ignora el `startTicks` de entrada, se recalcula aquí). */
export function appendClip(timeline: Timeline, trackId: string, clip: Clip): Timeline {
  return updateTrack(timeline, trackId, (track) => ({
    ...track,
    clips: [...track.clips, { ...clip, startTicks: trackDurationTicks(track) }],
  }));
}

/** Añade `clip` a la pista `trackId` respetando su `clip.startTicks`. Lanza si se solaparía con otro clip ya existente en esa pista. */
export function insertClip(timeline: Timeline, trackId: string, clip: Clip): Timeline {
  return updateTrack(timeline, trackId, (track) => {
    if (track.clips.some((existing) => clipsOverlap(existing, clip))) {
      throw new RangeError("El clip se solaparía con otro clip existente en la pista");
    }
    return { ...track, clips: sortByStart([...track.clips, clip]) };
  });
}

/** Transición básica de `durationTicks` situada en `startTicks` (ver media/transitionRender.ts). Solo tiene efecto de fundido si encaja exactamente entre dos clips reales de la misma pista — ver neighborsOfTransition. */
export function createTransition(
  id: string,
  startTicks: number,
  durationTicks: number,
  transitionType: TransitionType,
): Clip {
  return {
    id,
    kind: "transition",
    sourceId: "",
    startTicks,
    sourceInTicks: 0,
    sourceOutTicks: Math.max(1, durationTicks),
    volume: 1,
    muted: false,
    transitionType,
  };
}

export function removeClip(timeline: Timeline, trackId: string, clipId: string): Timeline {
  return updateTrack(timeline, trackId, (track) => {
    const index = requireClipIndex(track, clipId);
    const clips = [...track.clips];
    clips.splice(index, 1);
    return { ...track, clips };
  });
}

/**
 * Mueve el clip `clipId` de la pista `trackId` a `newStartTicks`. Ya no
 * hay huecos-objeto que crecer/consumir ni reordenar el array (ver
 * DESIGN.md/CLAUDE.md, ampliación de alcance del 2026-08-21): el nuevo
 * inicio se recorta a `>= 0` y a no solapar a sus vecinos inmediatos en
 * la MISMA pista (nunca solapamiento parcial, tampoco "pasar a través"
 * de un vecino — el desplazamiento se topa con él).
 */
export function moveClipTo(timeline: Timeline, trackId: string, clipId: string, newStartTicks: number): Timeline {
  return updateTrack(timeline, trackId, (track) => {
    const index = requireClipIndex(track, clipId);
    const clip = track.clips[index]!;
    const duration = clipDurationTicks(clip);
    const others = track.clips.filter((c) => c.id !== clipId);

    let leftNeighbor: Clip | undefined;
    let rightNeighbor: Clip | undefined;
    for (const other of others) {
      if (clipEndTicks(other) <= clip.startTicks) {
        if (!leftNeighbor || clipEndTicks(other) > clipEndTicks(leftNeighbor)) leftNeighbor = other;
      }
      if (other.startTicks >= clipEndTicks(clip)) {
        if (!rightNeighbor || other.startTicks < rightNeighbor.startTicks) rightNeighbor = other;
      }
    }

    const minStart = leftNeighbor ? clipEndTicks(leftNeighbor) : 0;
    const maxStart = rightNeighbor ? rightNeighbor.startTicks - duration : Infinity;
    const clampedStart = Math.max(0, Math.max(minStart, Math.min(newStartTicks, maxStart)));

    const clips = [...track.clips];
    clips[index] = { ...clip, startTicks: clampedStart };
    return { ...track, clips: sortByStart(clips) };
  });
}

/**
 * Parte el clip que ocupa `timelineTicks` en la pista `trackId` en dos.
 * newIds debe traer los ids de los dos clips resultantes:
 * [idDelPrimerTrozo, idDelSegundoTrozo] — se piden explícitos para que
 * la función siga siendo pura y determinista.
 *
 * Lanza si timelineTicks cae en un hueco o fuera de la pista, o si
 * coincide exactamente con el inicio de un clip (el corte produciría
 * un fragmento de duración cero).
 */
export function splitClipAt(
  timeline: Timeline,
  trackId: string,
  timelineTicks: number,
  newIds: [string, string],
): Timeline {
  return updateTrack(timeline, trackId, (track) => {
    const index = track.clips.findIndex((c) => timelineTicks >= c.startTicks && timelineTicks < clipEndTicks(c));
    if (index === -1) {
      throw new RangeError(`No hay ningún clip en el tick ${timelineTicks} de la pista ${trackId}`);
    }
    const clip = track.clips[index]!;
    if (timelineTicks === clip.startTicks) {
      throw new RangeError(
        "El punto de corte coincide con el inicio del clip; el corte produciría un fragmento de duración cero",
      );
    }

    const [firstId, secondId] = newIds;
    const sourceSplitTicks = clip.sourceInTicks + (timelineTicks - clip.startTicks);
    const firstHalf: Clip = { ...clip, id: firstId, sourceOutTicks: sourceSplitTicks };
    const secondHalf: Clip = {
      ...clip,
      id: secondId,
      sourceInTicks: sourceSplitTicks,
      startTicks: timelineTicks,
    };

    const clips = [...track.clips];
    clips.splice(index, 1, firstHalf, secondHalf);
    return { ...track, clips };
  });
}

/**
 * Ajusta el punto de entrada de un clip. minDurationTicks lo calcula
 * el llamador (normalmente frameDurationTicks() del frame rate de la
 * fuente) — /core no conoce el registro de SourceFile, solo aplica la
 * invariante de que ningún clip puede quedar por debajo de esa
 * duración. No toca `startTicks`: el clip sigue empezando en el mismo
 * punto de la timeline, solo cambia cuánto dura (y por tanto dónde
 * termina) — el hueco que eso deja o cierra es automático.
 */
export function trimClipIn(
  timeline: Timeline,
  trackId: string,
  clipId: string,
  newSourceInTicks: number,
  minDurationTicks: number,
): Timeline {
  return updateTrack(timeline, trackId, (track) => {
    const index = requireClipIndex(track, clipId);
    const clip = track.clips[index]!;
    if (newSourceInTicks < 0) {
      throw new RangeError("sourceInTicks no puede ser negativo");
    }
    if (clip.sourceOutTicks - newSourceInTicks < minDurationTicks) {
      throw new RangeError("El recorte dejaría el clip por debajo de la duración mínima");
    }
    const clips = [...track.clips];
    clips[index] = { ...clip, sourceInTicks: newSourceInTicks };
    return { ...track, clips };
  });
}

/** Ajusta el punto de salida de un clip. Ver trimClipIn para minDurationTicks y por qué no toca `startTicks`. */
export function trimClipOut(
  timeline: Timeline,
  trackId: string,
  clipId: string,
  newSourceOutTicks: number,
  minDurationTicks: number,
): Timeline {
  return updateTrack(timeline, trackId, (track) => {
    const index = requireClipIndex(track, clipId);
    const clip = track.clips[index]!;
    if (newSourceOutTicks - clip.sourceInTicks < minDurationTicks) {
      throw new RangeError("El recorte dejaría el clip por debajo de la duración mínima");
    }
    const clips = [...track.clips];
    clips[index] = { ...clip, sourceOutTicks: newSourceOutTicks };
    return { ...track, clips };
  });
}

/**
 * Desplaza en `deltaTicks` el `startTicks` de todos los clips de
 * `track` que empiecen en o después de `fromTicks` — el ripple en sí,
 * compartido por trimClipInRipple/trimClipOutRipple. Lanza si algún
 * clip acabaría en una posición negativa.
 */
function rippleShiftFrom(track: Track, fromTicks: number, deltaTicks: number): Clip[] {
  if (deltaTicks === 0) return track.clips;
  return track.clips.map((c) => {
    if (c.startTicks < fromTicks) return c;
    const shiftedStart = c.startTicks + deltaTicks;
    if (shiftedStart < 0) {
      throw new RangeError("El ripple dejaría un clip en una posición negativa");
    }
    return { ...c, startTicks: shiftedStart };
  });
}

/**
 * Como trimClipIn, pero además desplaza todos los clips de la MISMA
 * pista que empiecen en o después del final ORIGINAL del clip
 * recortado, por la misma diferencia que cambia ese final — así el
 * recorte no abre ni cierra un hueco (ripple clásico de un NLE).
 * trimClipIn/trimClipOut (sin ripple) siguen siendo el comportamiento
 * por defecto — decisión deliberada del 2026-08-21, ver CLAUDE.md; esta
 * variante es opt-in (Mayús+arrastre en la UI), ampliación de alcance
 * pedida explícitamente el 2026-08-29.
 */
export function trimClipInRipple(
  timeline: Timeline,
  trackId: string,
  clipId: string,
  newSourceInTicks: number,
  minDurationTicks: number,
): Timeline {
  return updateTrack(timeline, trackId, (track) => {
    const index = requireClipIndex(track, clipId);
    const clip = track.clips[index]!;
    if (newSourceInTicks < 0) {
      throw new RangeError("sourceInTicks no puede ser negativo");
    }
    if (clip.sourceOutTicks - newSourceInTicks < minDurationTicks) {
      throw new RangeError("El recorte dejaría el clip por debajo de la duración mínima");
    }
    const originalEndTicks = clipEndTicks(clip);
    const newEndTicks = clip.startTicks + (clip.sourceOutTicks - newSourceInTicks);
    const shifted = rippleShiftFrom(track, originalEndTicks, newEndTicks - originalEndTicks);
    const clips = shifted.map((c) => (c.id === clipId ? { ...c, sourceInTicks: newSourceInTicks } : c));
    return { ...track, clips };
  });
}

/** Como trimClipOut, con el mismo ripple que trimClipInRipple — ver su doc. */
export function trimClipOutRipple(
  timeline: Timeline,
  trackId: string,
  clipId: string,
  newSourceOutTicks: number,
  minDurationTicks: number,
): Timeline {
  return updateTrack(timeline, trackId, (track) => {
    const index = requireClipIndex(track, clipId);
    const clip = track.clips[index]!;
    if (newSourceOutTicks - clip.sourceInTicks < minDurationTicks) {
      throw new RangeError("El recorte dejaría el clip por debajo de la duración mínima");
    }
    const originalEndTicks = clipEndTicks(clip);
    const newEndTicks = clip.startTicks + (newSourceOutTicks - clip.sourceInTicks);
    const shifted = rippleShiftFrom(track, originalEndTicks, newEndTicks - originalEndTicks);
    const clips = shifted.map((c) => (c.id === clipId ? { ...c, sourceOutTicks: newSourceOutTicks } : c));
    return { ...track, clips };
  });
}

/** Ganancia de audio (0-1, se recorta a ese rango) y silencio de un clip. */
export function setClipAudio(
  timeline: Timeline,
  trackId: string,
  clipId: string,
  volume: number,
  muted: boolean,
): Timeline {
  return updateTrack(timeline, trackId, (track) => {
    const index = requireClipIndex(track, clipId);
    const clip = track.clips[index]!;
    const clampedVolume = Math.max(0, Math.min(1, volume));
    const clips = [...track.clips];
    clips[index] = { ...clip, volume: clampedVolume, muted };
    return { ...track, clips };
  });
}

/** Oculta (o vuelve a mostrar, con false) el vídeo de un clip sin tocar su audio — ver doc de Clip.videoHidden. */
export function setClipVideoHidden(timeline: Timeline, trackId: string, clipId: string, videoHidden: boolean): Timeline {
  return updateTrack(timeline, trackId, (track) => {
    const index = requireClipIndex(track, clipId);
    const clip = track.clips[index]!;
    const clips = [...track.clips];
    if (videoHidden) {
      clips[index] = { ...clip, videoHidden: true };
    } else {
      const { videoHidden: _removed, ...rest } = clip;
      clips[index] = rest;
    }
    return { ...track, clips };
  });
}

/** Marca/desmarca la bandera de un clip (estilo Resolve, tecla G) — solo visual, sin efecto en reproducción/exportación. */
export function setClipFlagged(timeline: Timeline, trackId: string, clipId: string, flagged: boolean): Timeline {
  return updateTrack(timeline, trackId, (track) => {
    const index = requireClipIndex(track, clipId);
    const clip = track.clips[index]!;
    const { flagged: _previous, ...rest } = clip;
    const clips = [...track.clips];
    clips[index] = flagged ? { ...rest, flagged: true } : rest;
    return { ...track, clips };
  });
}

/** Cambia (o quita, con undefined) el filtro de color de un clip. Ver ColorFilterType. */
export function setClipColorFilter(
  timeline: Timeline,
  trackId: string,
  clipId: string,
  colorFilter: ColorFilterType | undefined,
): Timeline {
  return updateTrack(timeline, trackId, (track) => {
    const index = requireClipIndex(track, clipId);
    const clip = track.clips[index]!;
    const { colorFilter: _previous, ...rest } = clip;
    const clips = [...track.clips];
    clips[index] = colorFilter ? { ...rest, colorFilter } : rest;
    return { ...track, clips };
  });
}

/** Cambia (o quita, con undefined) el grading real de un clip. Ver ColorGrade. */
export function setClipColorGrade(
  timeline: Timeline,
  trackId: string,
  clipId: string,
  colorGrade: ColorGrade | undefined,
): Timeline {
  return updateTrack(timeline, trackId, (track) => {
    const index = requireClipIndex(track, clipId);
    const clip = track.clips[index]!;
    const { colorGrade: _previous, ...rest } = clip;
    const clips = [...track.clips];
    clips[index] = colorGrade ? { ...rest, colorGrade } : rest;
    return { ...track, clips };
  });
}

/** true si `grade` no cambiaría nada visible (equivalente a no tener grading) — evita levantar WebGL para nada, ver media/colorGradeGL.ts. */
export function isNeutralColorGrade(grade: ColorGrade): boolean {
  return (
    grade.liftR === 0 &&
    grade.liftG === 0 &&
    grade.liftB === 0 &&
    grade.gammaR === 1 &&
    grade.gammaG === 1 &&
    grade.gammaB === 1 &&
    grade.gainR === 1 &&
    grade.gainG === 1 &&
    grade.gainB === 1 &&
    grade.saturation === 1 &&
    grade.contrast === 1 &&
    !grade.invert
  );
}

/** Cambia (o quita, con undefined) el croma de un clip. Ver ChromaKey. */
export function setClipChromaKey(
  timeline: Timeline,
  trackId: string,
  clipId: string,
  chromaKey: ChromaKey | undefined,
): Timeline {
  return updateTrack(timeline, trackId, (track) => {
    const index = requireClipIndex(track, clipId);
    const clip = track.clips[index]!;
    const { chromaKey: _previous, ...rest } = clip;
    const clips = [...track.clips];
    clips[index] = chromaKey ? { ...rest, chromaKey } : rest;
    return { ...track, clips };
  });
}

/** Ganancia efectiva de un clip para reproducción/exportación: 0 si está silenciado. */
export function effectiveClipVolume(clip: Clip): number {
  return clip.muted ? 0 : clip.volume;
}

/**
 * Ganancia de audio de un clip en un instante concreto DENTRO de él
 * (`offsetTicks`, 0 = su inicio tras cualquier recorte). Sin puntos de
 * volumen es simplemente `effectiveClipVolume` (plano, ver
 * setClipAudio). Con puntos, interpola linealmente entre los dos que
 * rodean `offsetTicks` — fuera del primer/último punto se mantiene
 * plano al valor del extremo más cercano. 0 si el clip está
 * silenciado, siempre, independientemente de los puntos.
 */
export function volumeAtOffsetTicks(clip: Clip, offsetTicks: number): number {
  if (clip.muted) return 0;
  const keyframes = clip.volumeKeyframes;
  if (!keyframes || keyframes.length === 0) return clip.volume;
  const first = keyframes[0]!;
  if (offsetTicks <= first.offsetTicks) return first.volume;
  const last = keyframes[keyframes.length - 1]!;
  if (offsetTicks >= last.offsetTicks) return last.volume;
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i]!;
    const b = keyframes[i + 1]!;
    if (offsetTicks >= a.offsetTicks && offsetTicks <= b.offsetTicks) {
      const span = b.offsetTicks - a.offsetTicks;
      const t = span > 0 ? (offsetTicks - a.offsetTicks) / span : 0;
      return a.volume + (b.volume - a.volume) * t;
    }
  }
  return clip.volume;
}

/** Un punto de la rampa de ganancia de Web Audio que hay que reproducir/exportar, en segundos desde que EMPIEZA esta reproducción (no desde el inicio del clip). */
export interface VolumeAutomationPoint {
  offsetSeconds: number;
  volume: number;
}

/**
 * Puntos de automatización de volumen (para GainNode.gain.setValueAtTime
 * + linearRampToValueAtTime, ver media/audioPlayer.ts y
 * export/exportTimeline.ts) para reproducir/exportar `clip` empezando
 * en `startOffsetTicks` dentro de él. El primer punto siempre es el
 * volumen ya interpolado exactamente en `startOffsetTicks` (para que
 * no haya un salto audible si se empieza a mitad de una rampa); los
 * siguientes son cada punto de volumen posterior, en orden.
 */
export function volumeAutomationFrom(clip: Clip, startOffsetTicks: number): VolumeAutomationPoint[] {
  const points: VolumeAutomationPoint[] = [
    { offsetSeconds: 0, volume: volumeAtOffsetTicks(clip, startOffsetTicks) },
  ];
  if (clip.muted) return points;
  for (const keyframe of clip.volumeKeyframes ?? []) {
    if (keyframe.offsetTicks > startOffsetTicks) {
      points.push({
        offsetSeconds: ticksToSeconds(keyframe.offsetTicks - startOffsetTicks),
        volume: keyframe.volume,
      });
    }
  }
  return points;
}

/** Añade un punto de volumen a un clip, manteniendo el array ordenado por offsetTicks. offsetTicks se recorta a [0, duración del clip] y volume a [0,1]. */
export function addVolumeKeyframe(
  timeline: Timeline,
  trackId: string,
  clipId: string,
  offsetTicks: number,
  volume: number,
): Timeline {
  return updateTrack(timeline, trackId, (track) => {
    const index = requireClipIndex(track, clipId);
    const clip = track.clips[index]!;
    const clampedOffset = Math.max(0, Math.min(offsetTicks, clipDurationTicks(clip)));
    const clampedVolume = Math.max(0, Math.min(1, volume));
    const keyframe: VolumeKeyframe = { offsetTicks: clampedOffset, volume: clampedVolume };
    const next = [...(clip.volumeKeyframes ?? []), keyframe].sort((a, b) => a.offsetTicks - b.offsetTicks);
    const clips = [...track.clips];
    clips[index] = { ...clip, volumeKeyframes: next };
    return { ...track, clips };
  });
}

/** Quita el punto de volumen en `keyframeIndex`. Sin efecto si el índice no existe. */
export function removeVolumeKeyframe(
  timeline: Timeline,
  trackId: string,
  clipId: string,
  keyframeIndex: number,
): Timeline {
  return updateTrack(timeline, trackId, (track) => {
    const index = requireClipIndex(track, clipId);
    const clip = track.clips[index]!;
    const existing = clip.volumeKeyframes ?? [];
    if (keyframeIndex < 0 || keyframeIndex >= existing.length) return track;
    const next = existing.filter((_, i) => i !== keyframeIndex);
    const { volumeKeyframes: _removed, ...clipWithoutKeyframes } = clip;
    const updatedClip: Clip = next.length > 0 ? { ...clipWithoutKeyframes, volumeKeyframes: next } : clipWithoutKeyframes;
    const clips = [...track.clips];
    clips[index] = updatedClip;
    return { ...track, clips };
  });
}

/**
 * Mueve el punto de volumen en `keyframeIndex` a un nuevo instante/
 * ganancia. Se recorta para no cruzar a sus vecinos inmediatos —
 * mantiene el array ordenado sin tener que reordenar índices durante
 * el arrastre.
 */
export function moveVolumeKeyframe(
  timeline: Timeline,
  trackId: string,
  clipId: string,
  keyframeIndex: number,
  newOffsetTicks: number,
  newVolume: number,
): Timeline {
  return updateTrack(timeline, trackId, (track) => {
    const index = requireClipIndex(track, clipId);
    const clip = track.clips[index]!;
    const existing = clip.volumeKeyframes ?? [];
    if (keyframeIndex < 0 || keyframeIndex >= existing.length) return track;
    const prevBound = keyframeIndex > 0 ? existing[keyframeIndex - 1]!.offsetTicks : 0;
    const nextBound =
      keyframeIndex < existing.length - 1 ? existing[keyframeIndex + 1]!.offsetTicks : clipDurationTicks(clip);
    const clampedOffset = Math.max(prevBound, Math.min(newOffsetTicks, nextBound));
    const clampedVolume = Math.max(0, Math.min(1, newVolume));
    const next = [...existing];
    next[keyframeIndex] = { offsetTicks: clampedOffset, volume: clampedVolume };
    const clips = [...track.clips];
    clips[index] = { ...clip, volumeKeyframes: next };
    return { ...track, clips };
  });
}

// --- Transiciones: vecindad y audio ---
// Una transición no reproduce vídeo propio (congela fotogramas, ver
// DESIGN.md §"Huecos y transiciones"), pero SÍ debería fundir el audio
// del clip saliente con el del entrante en vez de dejar silencio — ver
// CLAUDE.md. Solo tiene vecinos si encaja EXACTAMENTE entre dos clips
// reales de su misma pista (su inicio coincide con el final de uno, su
// final con el inicio del otro) — ya no hay adyacencia de array que
// asumir, se resuelve por posición.

/** Vecinos reales (kind === "clip") de una transición en su propia pista, por coincidencia exacta de posición. Cualquiera de los dos puede faltar (transición al principio/final de la pista, o separada de su vecino por un hueco). */
export function neighborsOfTransition(track: Track, transitionClip: Clip): { prev: Clip | undefined; next: Clip | undefined } {
  const prev = track.clips.find(
    (c) => c.kind === "clip" && c.id !== transitionClip.id && clipEndTicks(c) === transitionClip.startTicks,
  );
  const next = track.clips.find(
    (c) => c.kind === "clip" && c.id !== transitionClip.id && c.startTicks === clipEndTicks(transitionClip),
  );
  return { prev, next };
}

/** Ticks que hay que recortar del FINAL del audio normal de `clip` porque justo después, en la misma pista, hay una transición que ya se encarga de esa franja (fundido de salida). 0 si no aplica. */
export function audioTailCutTicks(track: Track, clip: Clip): number {
  const next = track.clips.find((c) => c.kind === "transition" && c.startTicks === clipEndTicks(clip));
  if (!next) return 0;
  return Math.min(clipDurationTicks(next), clipDurationTicks(clip));
}

/** Ticks que hay que recortar del PRINCIPIO del audio normal de `clip` porque justo antes, en la misma pista, hay una transición que ya se encarga de esa franja (fundido de entrada). 0 si no aplica. */
export function audioHeadCutTicks(track: Track, clip: Clip): number {
  const prev = track.clips.find((c) => c.kind === "transition" && clipEndTicks(c) === clip.startTicks);
  if (!prev) return 0;
  return Math.min(clipDurationTicks(prev), clipDurationTicks(clip));
}

/** Un tramo de audio de un clip vecino que hay que reproducir/exportar durante una transición, ya con su rampa de fundido lista. */
export interface TransitionAudioCue {
  /** sourceId del clip vecino (saliente o entrante) cuyo audio hay que sonar. */
  sourceId: string;
  /** Punto de entrada dentro de la FUENTE de ese clip vecino. */
  sourceStartTicks: number;
  /** Cuánto de esa fuente suena. */
  durationTicks: number;
  /** Rampa de ganancia lista para scheduleGain/playAudioSlice — offsetSeconds ya relativos al inicio de ESTE cue. */
  automation: VolumeAutomationPoint[];
}

/**
 * Qué audio hay que reproducir durante una transición de `track`,
 * empezando en `startOffsetTicks` dentro de ELLA (0 = su inicio; útil
 * si se hace seek/se retoma a mitad). El fundido de cada lado dura
 * `min(duración de la transición, duración del propio vecino)` — si
 * el vecino es más corto que la transición, su fundido se completa
 * antes de que la transición termine visualmente. Ninguno de los dos
 * cues se genera si ese lado no tiene un vecino real (ver
 * neighborsOfTransition) o si está silenciado.
 */
export function transitionAudioCues(
  track: Track,
  transitionClip: Clip,
  startOffsetTicks: number,
): TransitionAudioCue[] {
  const totalDuration = clipDurationTicks(transitionClip);
  if (startOffsetTicks >= totalDuration) return [];

  const cues: TransitionAudioCue[] = [];
  const { prev: from, next: to } = neighborsOfTransition(track, transitionClip);

  if (from && !from.muted) {
    const fadeDuration = Math.min(totalDuration, clipDurationTicks(from));
    if (startOffsetTicks < fadeDuration) {
      const remainingTicks = fadeDuration - startOffsetTicks;
      const baseGain = effectiveClipVolume(from);
      cues.push({
        sourceId: from.sourceId,
        sourceStartTicks: from.sourceOutTicks - fadeDuration + startOffsetTicks,
        durationTicks: remainingTicks,
        automation: [
          { offsetSeconds: 0, volume: baseGain * (1 - startOffsetTicks / fadeDuration) },
          { offsetSeconds: ticksToSeconds(remainingTicks), volume: 0 },
        ],
      });
    }
  }

  if (to && !to.muted) {
    const fadeDuration = Math.min(totalDuration, clipDurationTicks(to));
    if (startOffsetTicks < fadeDuration) {
      const remainingTicks = fadeDuration - startOffsetTicks;
      const baseGain = effectiveClipVolume(to);
      cues.push({
        sourceId: to.sourceId,
        sourceStartTicks: to.sourceInTicks + startOffsetTicks,
        durationTicks: remainingTicks,
        automation: [
          { offsetSeconds: 0, volume: baseGain * (startOffsetTicks / fadeDuration) },
          { offsetSeconds: ticksToSeconds(remainingTicks), volume: baseGain },
        ],
      });
    }
  }

  return cues;
}

/** Una franja de audio que hay que reproducir/exportar: qué fuente, qué rango de ELLA, en qué instante ABSOLUTO de la timeline empieza (`startTicks`), y su rampa de volumen ya lista (offsets relativos al inicio de ESTA franja, no del clip). */
export interface AudioSchedule {
  sourceId: string;
  sourceStartTicks: number;
  durationTicks: number;
  startTicks: number;
  automation: VolumeAutomationPoint[];
}

/**
 * Todas las franjas de audio que suenan en la timeline completa desde
 * `fromTicks` en adelante (0, siempre, para exportación; el instante
 * del playhead para retomar la reproducción en vivo a mitad — ver
 * ui/main.ts). Recorre TODAS las pistas no ocultas (el audio pegado a
 * los clips de las pistas de vídeo Y los clips propios de las pistas
 * de audio, ver CLAUDE.md — a diferencia del vídeo, el audio no tiene
 * concepto de "capas que se tapan") y junta tanto el audio normal de
 * cada clip (recortado si hay una transición pegada a un lado, ver
 * audioHeadCutTicks/audioTailCutTicks) como los cues de fundido
 * cruzado de cada transición (transitionAudioCues).
 *
 * Única función que sabe construir esta lista completa: reproducción
 * en directo (ui/main.ts) y exportación (export/exportTimeline.ts) la
 * comparten para que preview y export nunca puedan divergir en qué
 * suena.
 */
export function allAudioSchedules(timeline: Timeline, fromTicks: number = 0): AudioSchedule[] {
  const schedules: AudioSchedule[] = [];
  for (const track of timeline.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.kind === "clip") {
        if (clip.muted) continue;
        const headCutTicks = audioHeadCutTicks(track, clip);
        const playDurationTicks = clipDurationTicks(clip) - headCutTicks - audioTailCutTicks(track, clip);
        if (playDurationTicks <= 0) continue;
        const audioStartTicks = clip.startTicks + headCutTicks;
        const audioEndTicks = audioStartTicks + playDurationTicks;
        if (audioEndTicks <= fromTicks) continue;
        const skipTicks = Math.max(0, fromTicks - audioStartTicks);
        schedules.push({
          sourceId: clip.sourceId,
          sourceStartTicks: clip.sourceInTicks + headCutTicks + skipTicks,
          durationTicks: playDurationTicks - skipTicks,
          startTicks: audioStartTicks + skipTicks,
          automation: volumeAutomationFrom(clip, headCutTicks + skipTicks),
        });
      } else if (clip.kind === "transition") {
        if (clipEndTicks(clip) <= fromTicks) continue;
        const startOffsetTicks = Math.max(0, fromTicks - clip.startTicks);
        for (const cue of transitionAudioCues(track, clip, startOffsetTicks)) {
          schedules.push({
            sourceId: cue.sourceId,
            sourceStartTicks: cue.sourceStartTicks,
            durationTicks: cue.durationTicks,
            startTicks: Math.max(clip.startTicks, fromTicks),
            automation: cue.automation,
          });
        }
      }
    }
  }
  return schedules;
}

/** Sin procesado — comportamiento idéntico al de antes de esta ampliación (ver MasterAudio en core/types.ts). */
export const NEUTRAL_MASTER_AUDIO: MasterAudio = {
  enabled: false,
  eqLowDb: 0,
  eqMidDb: 0,
  eqHighDb: 0,
  compressionAmount: 0,
  makeupGainDb: 0,
};

export function setMasterAudio(timeline: Timeline, masterAudio: MasterAudio): Timeline {
  return { ...timeline, masterAudio };
}

/**
 * Traduce el mando único `compressionAmount` (0-100, ver MasterAudio)
 * a umbral/ratio reales de DynamicsCompressorNode — única función que
 * conoce esta correspondencia, para que la UI (un mando) y el motor de
 * audio (dos parámetros) no puedan divergir. 0 → umbral 0dB/ratio 1
 * (sin compresión audible); 100 → umbral -30dB/ratio 12 (fuerte).
 */
export function compressorParamsFromAmount(amount: number): { thresholdDb: number; ratio: number } {
  const clamped = Math.max(0, Math.min(100, amount));
  return {
    // El propio 0 evita -0 (JS: -(0)*30 === -0, que toEqual distingue de 0).
    thresholdDb: clamped === 0 ? 0 : -(clamped / 100) * 30,
    ratio: 1 + (clamped / 100) * 11,
  };
}
