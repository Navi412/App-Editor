import type { FrameRate } from "./time";
import type { TextOverlay } from "./textOverlay";
import type { Clip, Resolution, SourceFile, Timeline } from "./types";

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
 */
export interface ProjectFile {
  version: 1;
  outputResolution: Resolution;
  outputFrameRate: FrameRate;
  sources: ProjectSource[];
  clips: Clip[];
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
    clips: timeline.track.clips,
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

function isProjectSource(value: unknown): value is ProjectSource {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.fileName === "string" &&
    isFrameRate(v.frameRate) &&
    isFiniteNumber(v.width) &&
    isFiniteNumber(v.height) &&
    isFiniteNumber(v.durationTicks)
  );
}

type LegacyClip = Omit<Clip, "volume" | "muted" | "kind" | "transitionType"> &
  Partial<Pick<Clip, "volume" | "muted" | "kind" | "transitionType">>;

const CLIP_KINDS = new Set(["clip", "gap", "transition"]);
const TRANSITION_TYPES = new Set(["crossfade", "dipToBlack"]);

/** Acepta clips sin `volume`/`muted`/`kind`/`transitionType` (proyectos guardados antes de que existieran esos campos) — se normalizan en parseProjectFile. */
function isClip(value: unknown): value is LegacyClip {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.sourceId === "string" &&
    isFiniteNumber(v.sourceInTicks) &&
    isFiniteNumber(v.sourceOutTicks) &&
    (v.volume === undefined || isFiniteNumber(v.volume)) &&
    (v.muted === undefined || typeof v.muted === "boolean") &&
    (v.kind === undefined || (typeof v.kind === "string" && CLIP_KINDS.has(v.kind))) &&
    (v.transitionType === undefined ||
      (typeof v.transitionType === "string" && TRANSITION_TYPES.has(v.transitionType)))
  );
}

function normalizeClip(clip: LegacyClip): Clip {
  return {
    ...clip,
    volume: clip.volume ?? 1,
    muted: clip.muted ?? false,
    kind: clip.kind ?? "clip",
  };
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

type LegacyTextOverlay = Omit<TextOverlay, "fontFamily"> & Partial<Pick<TextOverlay, "fontFamily">>;

/** Acepta overlays sin `fontFamily` (proyectos guardados antes de que existiera) — se normaliza en parseProjectFile. */
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
    (v.fontFamily === undefined || typeof v.fontFamily === "string")
  );
}

function normalizeTextOverlay(overlay: LegacyTextOverlay): TextOverlay {
  return { ...overlay, fontFamily: overlay.fontFamily ?? "sans-serif" };
}

/** Valida y normaliza un JSON arbitrario a ProjectFile. Lanza con un mensaje claro si no encaja. */
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
  if (!Array.isArray(obj.clips) || !obj.clips.every(isClip)) {
    throw new Error("La lista de clips del proyecto es inválida");
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
    sources: obj.sources,
    clips: obj.clips.map(normalizeClip),
    markers,
    textOverlays,
  };
}
