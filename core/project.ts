import type { FrameRate } from "./time";
import type { TextOverlay } from "./textOverlay";
import type { Clip, Resolution, SourceFile, Timeline, Track, TrackKind, VolumeKeyframe } from "./types";

/** Marcador de anotación en la timeline — no afecta al render, solo navegación. */
export interface Marker {
  id: string;
  ticks: number;
  label?: string;
}

/** Un SourceFile más el nombre de archivo original, para poder volver a emparejarlo al cargar el proyecto. */
export interface ProjectSource extends SourceFile {
  fileName: string;
}

/**
 * Forma serializable de un proyecto completo. No incluye los bytes de
 * los vídeos ni del audio — solo referencias (fileName) que /ui usa
 * para pedirle al usuario que los vuelva a seleccionar al cargar
 * (el audio se vuelve a decodificar del mismo archivo, no se guarda
 * aparte). Pura, sin I/O: solo construye/valida datos, así que se
 * testea sin abrir ningún archivo.
 *
 * `tracks` sustituye al `clips` plano de antes de la ampliación de
 * alcance multipista del 2026-08-21 (ver CLAUDE.md) — parseProjectFile
 * sigue aceptando el formato viejo (un único array `clips`) y lo migra
 * a una sola pista de vídeo con posiciones explícitas.
 */
export interface ProjectFile {
  version: 1;
  outputResolution: Resolution;
  outputFrameRate: FrameRate;
  sources: ProjectSource[];
  tracks: Track[];
  markers: Marker[];
  textOverlays: TextOverlay[];
}

export function serializeProject(
  timeline: Timeline,
  sources: ProjectSource[],
  markers: Marker[],
  textOverlays: TextOverlay[],
): ProjectFile {
  return {
    version: 1,
    outputResolution: timeline.outputResolution,
    outputFrameRate: timeline.outputFrameRate,
    sources,
    tracks: timeline.tracks,
    markers,
    textOverlays,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isResolution(value: unknown): value is Resolution {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.width) && isFiniteNumber(v.height);
}

function isFrameRate(value: unknown): value is FrameRate {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.numerator) && isFiniteNumber(v.denominator);
}

/** Acepta fuentes sin `kind` (proyectos guardados antes de que existiera el audio independiente) — se normalizan a "video" en parseProjectFile. */
function isProjectSource(value: unknown): value is Omit<ProjectSource, "kind"> & Partial<Pick<ProjectSource, "kind">> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.fileName !== "string" || !isFiniteNumber(v.durationTicks)) return false;
  if (v.kind !== undefined && v.kind !== "video" && v.kind !== "audio") return false;
  const kind = (v.kind as "video" | "audio" | undefined) ?? "video";
  if (kind === "audio") return true;
  return isFrameRate(v.frameRate) && isFiniteNumber(v.width) && isFiniteNumber(v.height);
}

function normalizeProjectSource(source: Omit<ProjectSource, "kind"> & Partial<Pick<ProjectSource, "kind">>): ProjectSource {
  return { ...source, kind: source.kind ?? "video" };
}

/** `kind` incluye "gap" solo para poder seguir leyendo proyectos guardados antes del 2026-08-21 — se descarta en la migración (ver migrateClipsRipple), no existe en el `ClipKind` actual. */
const LEGACY_CLIP_KINDS = new Set(["clip", "gap", "transition"]);
const TRANSITION_TYPES = new Set(["crossfade", "dipToBlack"]);
const COLOR_FILTER_TYPES = new Set(["grayscale", "sepia", "invert", "warm", "cool", "highContrast"]);

function isVolumeKeyframeArray(value: unknown): value is VolumeKeyframe[] {
  return (
    Array.isArray(value) &&
    value.every((k) => {
      if (typeof k !== "object" || k === null) return false;
      const kv = k as Record<string, unknown>;
      return isFiniteNumber(kv.offsetTicks) && isFiniteNumber(kv.volume);
    })
  );
}

/** Forma de un Clip tal y como puede venir de disco: acepta `kind` "gap" heredado y `startTicks` ausente (clips guardados antes del modelo de posición explícita) — se resuelven en migrateClipsRipple. */
interface RawClip {
  id: string;
  kind?: string;
  sourceId: string;
  startTicks?: number;
  sourceInTicks: number;
  sourceOutTicks: number;
  volume?: number;
  muted?: boolean;
  transitionType?: string;
  volumeKeyframes?: VolumeKeyframe[];
  colorFilter?: string;
}

/** Acepta clips sin `volume`/`muted`/`kind`/`startTicks`/`transitionType`/`volumeKeyframes` (proyectos guardados antes de que existieran esos campos) — se normalizan en migrateClipsRipple. */
function isRawClip(value: unknown): value is RawClip {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.sourceId === "string" &&
    isFiniteNumber(v.sourceInTicks) &&
    isFiniteNumber(v.sourceOutTicks) &&
    (v.startTicks === undefined || isFiniteNumber(v.startTicks)) &&
    (v.volume === undefined || isFiniteNumber(v.volume)) &&
    (v.muted === undefined || typeof v.muted === "boolean") &&
    (v.kind === undefined || (typeof v.kind === "string" && LEGACY_CLIP_KINDS.has(v.kind))) &&
    (v.transitionType === undefined ||
      (typeof v.transitionType === "string" && TRANSITION_TYPES.has(v.transitionType))) &&
    (v.volumeKeyframes === undefined || isVolumeKeyframeArray(v.volumeKeyframes)) &&
    (v.colorFilter === undefined || (typeof v.colorFilter === "string" && COLOR_FILTER_TYPES.has(v.colorFilter)))
  );
}

/**
 * Convierte una lista de RawClip (posiblemente sin `startTicks`, y con
 * `kind: "gap"` heredado) a la lista de Clip final de una pista.
 *
 * Recorre en orden acumulando un cursor exactamente como hacía el
 * modelo "ripple" de antes de la ampliación de alcance del
 * 2026-08-21: cada clip sin `startTicks` propio hereda el cursor
 * (posición acumulada de los anteriores), y el cursor avanza su
 * duración; los `kind: "gap"` heredados participan en ese cálculo
 * (dejan su hueco de sitio a los siguientes) pero no sobreviven al
 * resultado — su hueco pasa a ser, automáticamente, el tramo sin clip
 * entre las posiciones ya calculadas.
 */
function migrateClipsRipple(rawClips: RawClip[]): Clip[] {
  let cursor = 0;
  const clips: Clip[] = [];
  for (const raw of rawClips) {
    const kind = raw.kind === "gap" ? "gap" : (raw.kind ?? "clip");
    const startTicks = raw.startTicks ?? cursor;
    const duration = raw.sourceOutTicks - raw.sourceInTicks;
    if (kind !== "gap") {
      const normalized: Clip = {
        id: raw.id,
        kind: kind === "transition" ? "transition" : "clip",
        sourceId: raw.sourceId,
        startTicks,
        sourceInTicks: raw.sourceInTicks,
        sourceOutTicks: raw.sourceOutTicks,
        volume: raw.volume ?? 1,
        muted: raw.muted ?? false,
      };
      if (raw.transitionType) normalized.transitionType = raw.transitionType as NonNullable<Clip["transitionType"]>;
      if (raw.volumeKeyframes) normalized.volumeKeyframes = raw.volumeKeyframes;
      if (raw.colorFilter) normalized.colorFilter = raw.colorFilter as NonNullable<Clip["colorFilter"]>;
      clips.push(normalized);
    }
    cursor = startTicks + duration;
  }
  return clips;
}

function isMarker(value: unknown): value is Marker {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    isFiniteNumber(v.ticks) &&
    (v.label === undefined || typeof v.label === "string")
  );
}

type LegacyTextOverlay = Omit<TextOverlay, "fontFamily" | "rotationDeg"> &
  Partial<Pick<TextOverlay, "fontFamily" | "rotationDeg">>;

/** Acepta overlays sin `fontFamily`/`rotationDeg` (proyectos guardados antes de que existieran) — se normalizan en parseProjectFile. */
function isTextOverlay(value: unknown): value is LegacyTextOverlay {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    isFiniteNumber(v.startTicks) &&
    isFiniteNumber(v.endTicks) &&
    typeof v.text === "string" &&
    isFiniteNumber(v.xPercent) &&
    isFiniteNumber(v.yPercent) &&
    isFiniteNumber(v.fontSizePx) &&
    typeof v.color === "string" &&
    (v.fontFamily === undefined || typeof v.fontFamily === "string") &&
    (v.rotationDeg === undefined || isFiniteNumber(v.rotationDeg))
  );
}

function normalizeTextOverlay(overlay: LegacyTextOverlay): TextOverlay {
  return { ...overlay, fontFamily: overlay.fontFamily ?? "sans-serif", rotationDeg: overlay.rotationDeg ?? 0 };
}

interface RawTrack {
  id: string;
  kind: TrackKind;
  hidden?: boolean;
  clips: RawClip[];
}

function isRawTrack(value: unknown): value is RawTrack {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    (v.kind === "video" || v.kind === "audio") &&
    (v.hidden === undefined || typeof v.hidden === "boolean") &&
    Array.isArray(v.clips) &&
    v.clips.every(isRawClip)
  );
}

function normalizeTrack(raw: RawTrack): Track {
  return { id: raw.id, kind: raw.kind, hidden: raw.hidden ?? false, clips: migrateClipsRipple(raw.clips) };
}

/**
 * Valida y normaliza un JSON arbitrario a ProjectFile. Lanza con un
 * mensaje claro si no encaja.
 *
 * Acepta dos formas para el vídeo: `tracks` (formato actual, multipista)
 * o, por compatibilidad con proyectos guardados antes del 2026-08-21,
 * un `clips` plano — que se migra a una única pista de vídeo (ver
 * migrateClipsRipple).
 */
export function parseProjectFile(data: unknown): ProjectFile {
  if (typeof data !== "object" || data === null) {
    throw new Error("El archivo no es un proyecto JSON válido");
  }
  const obj = data as Record<string, unknown>;

  if (obj.version !== 1) {
    throw new Error("Versión de proyecto no soportada");
  }
  if (!isResolution(obj.outputResolution)) {
    throw new Error("outputResolution del proyecto inválido");
  }
  if (!isFrameRate(obj.outputFrameRate)) {
    throw new Error("outputFrameRate del proyecto inválido");
  }
  if (!Array.isArray(obj.sources) || !obj.sources.every(isProjectSource)) {
    throw new Error("La lista de fuentes del proyecto es inválida");
  }

  let tracks: Track[];
  if (Array.isArray(obj.tracks)) {
    if (!obj.tracks.every(isRawTrack)) {
      throw new Error("La lista de pistas del proyecto es inválida");
    }
    tracks = obj.tracks.map(normalizeTrack);
  } else if (Array.isArray(obj.clips)) {
    if (!obj.clips.every(isRawClip)) {
      throw new Error("La lista de clips del proyecto es inválida");
    }
    tracks = [{ id: "video-1", kind: "video", hidden: false, clips: migrateClipsRipple(obj.clips) }];
  } else {
    throw new Error("El proyecto no tiene pistas ni clips");
  }

  const markers =
    Array.isArray(obj.markers) && obj.markers.every(isMarker) ? obj.markers : [];
  const textOverlays =
    Array.isArray(obj.textOverlays) && obj.textOverlays.every(isTextOverlay)
      ? obj.textOverlays.map(normalizeTextOverlay)
      : [];

  return {
    version: 1,
    outputResolution: obj.outputResolution,
    outputFrameRate: obj.outputFrameRate,
    sources: obj.sources.map(normalizeProjectSource),
    tracks,
    markers,
    textOverlays,
  };
}
