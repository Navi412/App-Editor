import { ticksToSeconds } from "./time";
import type { Clip, Timeline, TransitionType, Track, VolumeKeyframe } from "./types";

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
 * Arrastrar-para-reposicionar en la línea de tiempo: desplaza el clip
 * `clipId` `deltaTicks` respecto a su posición actual (positivo = más
 * tarde, negativo = más temprano). No hay campo de posición que tocar
 * (ver DESIGN.md §1) — mover un clip es siempre una operación sobre el
 * hueco INMEDIATAMENTE ANTERIOR a él (nunca sobre lo que viene
 * después: para abrir/cerrar hueco con el vecino de la derecha se
 * arrastra ESE vecino, no este clip — así el desplazamiento nunca
 * necesita tocar más de un límite a la vez):
 *
 * - Desplazamiento positivo (más tarde): crece el hueco anterior (o
 *   crea uno nuevo si no había, incluso si el clip es el primero de la
 *   pista). Siempre tiene éxito — el resto de la pista, al ser sumas
 *   acumuladas, se desplaza solo más tarde. Mismo efecto que
 *   "Insertar hueco", solo que disparado arrastrando en vez de con un
 *   botón.
 * - Desplazamiento negativo (más temprano): encoge el hueco anterior.
 *   Si se consume entero, se elimina y el resto del desplazamiento
 *   sigue absorbiéndose contra lo que haya ANTES de eso (que puede ser
 *   otro hueco, o un clip real). Contra un clip real hace falta
 *   arrastrar como mínimo su duración completa para "pasar" a través
 *   de él — entonces se intercambian de posición (reordenar); un
 *   desplazamiento menor se recorta a 0 (no se permite solapar
 *   parcialmente un clip real). Si no queda nada antes (es el primer
 *   clip de la pista), se recorta a 0: no se puede ir antes del
 *   principio de la timeline.
 *
 * `newGapId` lo aporta el llamador para que la función siga siendo
 * pura y determinista (mismo patrón que splitClipAt con newIds) —
 * solo se usa cuando el desplazamiento positivo crea un hueco nuevo.
 */
export function moveClipByDelta(
  timeline: Timeline,
  clipId: string,
  deltaTicks: number,
  newGapId: string,
): Timeline {
  const clips = [...timeline.track.clips];
  const index = clips.findIndex((c) => c.id === clipId);
  if (index === -1) return timeline;

  if (deltaTicks > 0) {
    const prevIndex = index - 1;
    if (prevIndex >= 0 && clips[prevIndex]!.kind === "gap") {
      clips[prevIndex] = { ...clips[prevIndex]!, sourceOutTicks: clips[prevIndex]!.sourceOutTicks + deltaTicks };
    } else {
      clips.splice(index, 0, createGap(newGapId, deltaTicks));
    }
    return { ...timeline, track: { ...timeline.track, clips } };
  }

  let remaining = -deltaTicks;
  let cursor = index;
  while (remaining > 0) {
    const prevIndex = cursor - 1;
    if (prevIndex < 0) {
      remaining = 0;
      break;
    }
    if (clips[prevIndex]!.kind === "gap") {
      const gapDuration = clipDurationTicks(clips[prevIndex]!);
      if (remaining < gapDuration) {
        clips[prevIndex] = { ...clips[prevIndex]!, sourceOutTicks: clips[prevIndex]!.sourceOutTicks - remaining };
        remaining = 0;
      } else {
        remaining -= gapDuration;
        clips.splice(prevIndex, 1);
        cursor -= 1;
      }
    } else {
      const neighborDuration = clipDurationTicks(clips[prevIndex]!);
      if (remaining >= neighborDuration) {
        const neighbor = clips[prevIndex]!;
        clips[prevIndex] = clips[cursor]!;
        clips[cursor] = neighbor;
        cursor = prevIndex;
        remaining -= neighborDuration;
      } else {
        remaining = 0;
      }
    }
  }

  return { ...timeline, track: { ...timeline.track, clips } };
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
  clipIndex: number,
  offsetTicks: number,
  volume: number,
): Timeline {
  const clip = timeline.track.clips[clipIndex];
  if (!clip) throw new RangeError(`Índice de clip fuera de rango: ${clipIndex}`);
  const clampedOffset = Math.max(0, Math.min(offsetTicks, clipDurationTicks(clip)));
  const clampedVolume = Math.max(0, Math.min(1, volume));
  const keyframe: VolumeKeyframe = { offsetTicks: clampedOffset, volume: clampedVolume };
  const next = [...(clip.volumeKeyframes ?? []), keyframe].sort((a, b) => a.offsetTicks - b.offsetTicks);
  const clips = [...timeline.track.clips];
  clips[clipIndex] = { ...clip, volumeKeyframes: next };
  return { ...timeline, track: { ...timeline.track, clips } };
}

/** Quita el punto de volumen en `keyframeIndex`. Sin efecto si el índice no existe. */
export function removeVolumeKeyframe(timeline: Timeline, clipIndex: number, keyframeIndex: number): Timeline {
  const clip = timeline.track.clips[clipIndex];
  if (!clip) throw new RangeError(`Índice de clip fuera de rango: ${clipIndex}`);
  const existing = clip.volumeKeyframes ?? [];
  if (keyframeIndex < 0 || keyframeIndex >= existing.length) return timeline;
  const next = existing.filter((_, i) => i !== keyframeIndex);
  const { volumeKeyframes: _removed, ...clipWithoutKeyframes } = clip;
  const updatedClip: Clip = next.length > 0 ? { ...clipWithoutKeyframes, volumeKeyframes: next } : clipWithoutKeyframes;
  const clips = [...timeline.track.clips];
  clips[clipIndex] = updatedClip;
  return { ...timeline, track: { ...timeline.track, clips } };
}

/**
 * Mueve el punto de volumen en `keyframeIndex` a un nuevo instante/
 * ganancia. Se recorta para no cruzar a sus vecinos inmediatos —
 * mantiene el array ordenado sin tener que reordenar índices durante
 * el arrastre.
 */
export function moveVolumeKeyframe(
  timeline: Timeline,
  clipIndex: number,
  keyframeIndex: number,
  newOffsetTicks: number,
  newVolume: number,
): Timeline {
  const clip = timeline.track.clips[clipIndex];
  if (!clip) throw new RangeError(`Índice de clip fuera de rango: ${clipIndex}`);
  const existing = clip.volumeKeyframes ?? [];
  if (keyframeIndex < 0 || keyframeIndex >= existing.length) return timeline;
  const prevBound = keyframeIndex > 0 ? existing[keyframeIndex - 1]!.offsetTicks : 0;
  const nextBound =
    keyframeIndex < existing.length - 1 ? existing[keyframeIndex + 1]!.offsetTicks : clipDurationTicks(clip);
  const clampedOffset = Math.max(prevBound, Math.min(newOffsetTicks, nextBound));
  const clampedVolume = Math.max(0, Math.min(1, newVolume));
  const next = [...existing];
  next[keyframeIndex] = { offsetTicks: clampedOffset, volume: clampedVolume };
  const clips = [...timeline.track.clips];
  clips[clipIndex] = { ...clip, volumeKeyframes: next };
  return { ...timeline, track: { ...timeline.track, clips } };
}

// --- Audio durante una transición ---
// Una transición no reproduce vídeo propio (congela fotogramas, ver
// DESIGN.md §"Huecos y transiciones"), pero SÍ debería fundir el audio
// del clip saliente con el del entrante en vez de dejar silencio — ver
// CLAUDE.md. La franja de audio que le corresponde a la transición se
// RESTA de la reproducción normal del clip vecino (nunca se duplica ni
// se deja en silencio): el vecino suena `fadeDurationTicks` menos por
// ese lado, y esa misma franja se reproduce, con fundido, durante la
// transición.

/** Ticks que hay que recortar del FINAL del audio normal de `clipIndex` porque el siguiente elemento es una transición que ya se encarga de esa franja (fundido de salida). 0 si no aplica. */
export function audioTailCutTicks(timeline: Timeline, clipIndex: number): number {
  const clip = timeline.track.clips[clipIndex];
  const next = timeline.track.clips[clipIndex + 1];
  if (!clip || !next || next.kind !== "transition") return 0;
  return Math.min(clipDurationTicks(next), clipDurationTicks(clip));
}

/** Ticks que hay que recortar del PRINCIPIO del audio normal de `clipIndex` porque el elemento anterior es una transición que ya se encarga de esa franja (fundido de entrada). 0 si no aplica. */
export function audioHeadCutTicks(timeline: Timeline, clipIndex: number): number {
  const clip = timeline.track.clips[clipIndex];
  const prev = timeline.track.clips[clipIndex - 1];
  if (!clip || !prev || prev.kind !== "transition") return 0;
  return Math.min(clipDurationTicks(prev), clipDurationTicks(clip));
}

/** Un tramo de audio de un clip vecino que hay que reproducir/exportar durante una transición, ya con su rampa de fundido lista. */
export interface TransitionAudioCue {
  /** Índice del clip (saliente o entrante) cuyo audio hay que sonar. */
  clipIndex: number;
  /** Punto de entrada dentro de la FUENTE de ese clip. */
  sourceStartTicks: number;
  /** Cuánto de esa fuente suena. */
  durationTicks: number;
  /** Rampa de ganancia lista para scheduleGain/playAudioSlice — offsetSeconds ya relativos al inicio de ESTE cue. */
  automation: VolumeAutomationPoint[];
}

/**
 * Qué audio hay que reproducir durante una transición, empezando en
 * `startOffsetTicks` dentro de ELLA (0 = su inicio; útil si se hace
 * seek/se retoma a mitad). El fundido de cada lado dura
 * `min(duración de la transición, duración del propio vecino)` — si
 * el vecino es más corto que la transición, su fundido se completa
 * antes de que la transición termine visualmente. Ninguno de los dos
 * cues se genera si ese lado no tiene un clip real con audio (p.ej.
 * transición al principio/final de la timeline, o vecino silenciado).
 */
export function transitionAudioCues(
  timeline: Timeline,
  transitionIndex: number,
  startOffsetTicks: number,
): TransitionAudioCue[] {
  const clips = timeline.track.clips;
  const transitionClip = clips[transitionIndex];
  if (!transitionClip) return [];
  const totalDuration = clipDurationTicks(transitionClip);
  if (startOffsetTicks >= totalDuration) return [];

  const cues: TransitionAudioCue[] = [];
  const from = clips[transitionIndex - 1];
  const to = clips[transitionIndex + 1];

  if (from && from.kind === "clip" && !from.muted) {
    const fadeDuration = Math.min(totalDuration, clipDurationTicks(from));
    if (startOffsetTicks < fadeDuration) {
      const remainingTicks = fadeDuration - startOffsetTicks;
      const baseGain = effectiveClipVolume(from);
      cues.push({
        clipIndex: transitionIndex - 1,
        sourceStartTicks: from.sourceOutTicks - fadeDuration + startOffsetTicks,
        durationTicks: remainingTicks,
        automation: [
          { offsetSeconds: 0, volume: baseGain * (1 - startOffsetTicks / fadeDuration) },
          { offsetSeconds: ticksToSeconds(remainingTicks), volume: 0 },
        ],
      });
    }
  }

  if (to && to.kind === "clip" && !to.muted) {
    const fadeDuration = Math.min(totalDuration, clipDurationTicks(to));
    if (startOffsetTicks < fadeDuration) {
      const remainingTicks = fadeDuration - startOffsetTicks;
      const baseGain = effectiveClipVolume(to);
      cues.push({
        clipIndex: transitionIndex + 1,
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
