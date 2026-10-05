import { clipDurationTicks, clipEndTicks, timelineToSourceTicks } from "./timeline";
import type { Clip, ClipTransform, Timeline, TransformKeyframe } from "./types";
import { IDENTITY_TRANSFORM } from "./types";

/**
 * Transformación de un clip de vídeo (posición, escala, rotación,
 * opacidad) y su animación por keyframes — mejora pedida el 2026-10-05.
 * Funciones puras: el dibujo vive en media/render.ts (drawFrameFit con
 * \`transform\`) y es el mismo para preview y exportación.
 */

const FIELDS = ["x", "y", "scale", "rotation", "opacity"] as const;

export function isIdentityTransform(t: ClipTransform): boolean {
  return t.x === 0 && t.y === 0 && t.scale === 1 && t.rotation === 0 && t.opacity === 1;
}

/** Suavizado "ease in-out" (smoothstep): arranca y frena suave, como el de un NLE por defecto. */
function ease(u: number): number {
  return u * u * (3 - 2 * u);
}

function lerpTransform(a: ClipTransform, b: ClipTransform, u: number): ClipTransform {
  const out = { ...a };
  for (const field of FIELDS) out[field] = a[field] + (b[field] - a[field]) * u;
  return out;
}

function stripOffset(keyframe: TransformKeyframe): ClipTransform {
  return { x: keyframe.x, y: keyframe.y, scale: keyframe.scale, rotation: keyframe.rotation, opacity: keyframe.opacity };
}

/**
 * Transformación del clip a \`offsetTicks\` de su inicio (tiempo de
 * timeline). Con keyframes, se interpola entre el anterior y el
 * siguiente (lineal o suavizado según el \`easing\` del de destino); antes
 * del primero / después del último se mantiene su valor. Sin keyframes,
 * la estática (\`transform\`) o la identidad.
 */
export function transformAt(clip: Clip, offsetTicks: number): ClipTransform {
  const keyframes = clip.transformKeyframes;
  if (!keyframes || keyframes.length === 0) return clip.transform ?? IDENTITY_TRANSFORM;
  if (offsetTicks <= keyframes[0]!.offsetTicks) return stripOffset(keyframes[0]!);
  for (let i = 1; i < keyframes.length; i++) {
    const next = keyframes[i]!;
    if (offsetTicks <= next.offsetTicks) {
      const prev = keyframes[i - 1]!;
      const span = next.offsetTicks - prev.offsetTicks;
      const u = span > 0 ? (offsetTicks - prev.offsetTicks) / span : 1;
      return lerpTransform(stripOffset(prev), stripOffset(next), next.easing === "linear" ? u : ease(u));
    }
  }
  return stripOffset(keyframes[keyframes.length - 1]!);
}

/** ¿Tapa este clip, en este instante, por completo lo que tenga debajo? (Opaco, sin croma, sin mover/escalar/rotar.) */
export function clipCoversFrame(clip: Clip, offsetTicks: number): boolean {
  if (clip.kind !== "clip") return true; // las transiciones pintan el fotograma entero
  if (clip.chromaKey?.enabled) return false;
  return isIdentityTransform(transformAt(clip, offsetTicks));
}

function updateClip(timeline: Timeline, trackId: string, clipId: string, update: (clip: Clip) => Clip): Timeline {
  const trackIndex = timeline.tracks.findIndex((t) => t.id === trackId);
  if (trackIndex < 0) throw new RangeError(`Pista no encontrada: ${trackId}`);
  const track = timeline.tracks[trackIndex]!;
  const clipIndex = track.clips.findIndex((c) => c.id === clipId);
  if (clipIndex < 0) throw new RangeError(`Clip no encontrado: ${clipId}`);
  const clip = track.clips[clipIndex]!;
  if (clip.kind !== "clip") throw new RangeError("Solo los clips se pueden transformar");
  const clips = [...track.clips];
  clips[clipIndex] = update(clip);
  const tracks = [...timeline.tracks];
  tracks[trackIndex] = { ...track, clips };
  return { ...timeline, tracks };
}

function normalize(t: ClipTransform): ClipTransform {
  return {
    x: t.x,
    y: t.y,
    scale: Math.max(0.01, t.scale),
    rotation: t.rotation,
    opacity: Math.max(0, Math.min(1, t.opacity)),
  };
}

/**
 * Fija la transformación de un clip en el instante \`offsetTicks\`. Sin
 * keyframes, cambia la estática (y la quita si es la identidad). Con
 * keyframes (modo animación), crea o sustituye el keyframe de ese
 * instante — como el "auto-key" de un NLE: tocar un valor con la
 * animación activada siempre deja un keyframe ahí.
 */
export function setClipTransformAt(
  timeline: Timeline,
  trackId: string,
  clipId: string,
  offsetTicks: number,
  transform: ClipTransform,
): Timeline {
  const value = normalize(transform);
  return updateClip(timeline, trackId, clipId, (clip) => {
    if (!clip.transformKeyframes || clip.transformKeyframes.length === 0) {
      const { transform: _old, ...rest } = clip;
      return isIdentityTransform(value) ? rest : { ...rest, transform: value };
    }
    return { ...clip, transformKeyframes: upsertKeyframe(clip.transformKeyframes, offsetTicks, value) };
  });
}

function upsertKeyframe(keyframes: TransformKeyframe[], offsetTicks: number, value: ClipTransform): TransformKeyframe[] {
  const existing = keyframes.find((k) => k.offsetTicks === offsetTicks);
  const keyframe: TransformKeyframe = { ...value, offsetTicks, ...(existing?.easing ? { easing: existing.easing } : {}) };
  return [...keyframes.filter((k) => k.offsetTicks !== offsetTicks), keyframe].sort((a, b) => a.offsetTicks - b.offsetTicks);
}

/**
 * Pone (o quita, si ya hay uno justo ahí) un keyframe de transformación
 * en \`offsetTicks\`, con el valor que el clip tiene en ese instante. El
 * primer keyframe convierte la transformación estática en animada.
 */
export function toggleTransformKeyframe(timeline: Timeline, trackId: string, clipId: string, offsetTicks: number): Timeline {
  return updateClip(timeline, trackId, clipId, (clip) => {
    const offset = Math.max(0, Math.min(offsetTicks, clipDurationTicks(clip)));
    const keyframes = clip.transformKeyframes ?? [];
    if (keyframes.some((k) => k.offsetTicks === offset)) {
      const remaining = keyframes.filter((k) => k.offsetTicks !== offset);
      const { transformKeyframes: _old, ...rest } = clip;
      if (remaining.length > 0) return { ...rest, transformKeyframes: remaining };
      // Sin keyframes: se queda quieto en el valor que tenía ese último keyframe.
      const last = stripOffset(keyframes[0]!);
      const { transform: _t, ...bare } = rest;
      return isIdentityTransform(last) ? bare : { ...bare, transform: last };
    }
    const value = transformAt(clip, offset);
    const { transform: _static, ...rest } = clip;
    return { ...rest, transformKeyframes: upsertKeyframe(keyframes, offset, value) };
  });
}

/** Quita toda la animación y deja la transformación estática del instante \`offsetTicks\`. */
export function clearTransformKeyframes(timeline: Timeline, trackId: string, clipId: string, offsetTicks: number): Timeline {
  return updateClip(timeline, trackId, clipId, (clip) => {
    const value = transformAt(clip, offsetTicks);
    const { transformKeyframes: _k, transform: _t, ...rest } = clip;
    return isIdentityTransform(value) ? rest : { ...rest, transform: value };
  });
}

/** Reparte los keyframes de un clip cortado en `splitOffsetTicks` entre sus dos mitades, con un keyframe en el borde para que no salte. */
export function splitTransformKeyframes(
  clip: Clip,
  splitOffsetTicks: number,
): { first?: TransformKeyframe[]; second?: TransformKeyframe[] } {
  const keyframes = clip.transformKeyframes;
  if (!keyframes || keyframes.length === 0) return {};
  const atSplit = transformAt(clip, splitOffsetTicks);
  const first = [...keyframes.filter((k) => k.offsetTicks < splitOffsetTicks), { ...atSplit, offsetTicks: splitOffsetTicks }];
  const second = [
    { ...atSplit, offsetTicks: 0 },
    ...keyframes.filter((k) => k.offsetTicks > splitOffsetTicks).map((k) => ({ ...k, offsetTicks: k.offsetTicks - splitOffsetTicks })),
  ];
  return { first, second };
}

/** Una capa de vídeo a pintar en un instante: qué clip, de qué pista, qué instante de su fuente y con qué transformación. */
export interface VideoLayer {
  trackId: string;
  clip: Clip;
  sourceId: string;
  sourceTimeTicks: number;
  /** Instante dentro del clip (tiempo de timeline desde su inicio). */
  offsetTicks: number;
  transform: ClipTransform;
}

/**
 * Las capas de vídeo que se ven en `timelineTicks`, de ABAJO a ARRIBA
 * (orden de pintado). Se recorren las pistas de vídeo de arriba a abajo
 * y se para en la primera capa que tapa el fotograma entero (opaca, sin
 * croma, sin transformar — clipCoversFrame): lo que haya debajo no se
 * ve y no hace falta decodificarlo. En el caso de siempre (un clip sin
 * transformar) devuelve UNA capa, la misma que resolveActiveVideoPosition.
 * Vacío = negro. Única lógica de composición: la usan preview y export.
 */
export function resolveVideoLayers(timeline: Timeline, timelineTicks: number): VideoLayer[] {
  const layers: VideoLayer[] = [];
  if (timelineTicks < 0) return layers;
  for (let i = timeline.tracks.length - 1; i >= 0; i--) {
    const track = timeline.tracks[i]!;
    if (track.kind !== "video" || track.hidden) continue;
    const clip = track.clips.find((c) => timelineTicks >= c.startTicks && timelineTicks < clipEndTicks(c));
    if (!clip || clip.videoHidden) continue;
    const offsetTicks = timelineTicks - clip.startTicks;
    layers.push({
      trackId: track.id,
      clip,
      sourceId: clip.sourceId,
      sourceTimeTicks: clip.kind === "clip" ? timelineToSourceTicks(clip, timelineTicks) : 0,
      offsetTicks,
      transform: clip.kind === "clip" ? transformAt(clip, offsetTicks) : IDENTITY_TRANSFORM,
    });
    if (clipCoversFrame(clip, offsetTicks)) break;
  }
  return layers.reverse();
}
