import { frameDurationTicks, secondsToTicks, ticksToSeconds } from "../core/time";
import {
  addTrack,
  addVolumeKeyframe,
  allAudioSchedules,
  appendClip,
  clipDurationTicks,
  clipEndTicks,
  createTransition,
  insertClip,
  moveClipTo,
  moveClipToTrack,
  moveTrack,
  moveVolumeKeyframe,
  NEUTRAL_MASTER_AUDIO,
  nextVideoContentTicks,
  removeClip,
  removeTrack,
  removeVolumeKeyframe,
  renameTrack,
  resolveActiveVideoPosition,
  setClipAudio,
  setClipChromaKey,
  setClipColorFilter,
  setClipColorGrade,
  setClipFlagged,
  setClipVideoHidden,
  setMasterAudio,
  setTrackHidden,
  splitClipAt,
  timelineDurationTicks,
  trimClipIn,
  trimClipInRipple,
  trimClipOut,
  trimClipOutRipple,
} from "../core/timeline";
import { parseProjectFile, serializeProject, type ProjectFile, type ProjectSource } from "../core/project";
import { activeTextOverlaysAt, type TextOverlay } from "../core/textOverlay";
import type {
  ChromaKey,
  Clip,
  ColorFilterType,
  ColorGrade,
  MasterAudio,
  Resolution,
  SourceFile,
  Timeline,
  Track,
  TrackKind,
  TransitionType,
} from "../core/types";
import { NEUTRAL_CHROMA_KEY, NEUTRAL_COLOR_GRADE } from "../core/types";
import { ExportCancelledError, exportTimelineToMp4 } from "../export/exportTimeline";
import { getAppVideoBridge, readFileFromPath } from "./electronBridge";
import { decodeAudioAsset } from "../media/audio";
import { playAudioSlice, type AudioPlaybackHandle } from "../media/audioPlayer";
import { getDecoderDescription } from "../media/description";
import { createMasterAudioChain, type MasterAudioChain } from "../media/masterAudioChain";
import { ColorGradeRenderer } from "../media/colorGradeGL";
import { createVideoPlayer, type VideoPlayer } from "../media/player";
import { colorFilterCss, drawFrameFit } from "../media/render";
import { decodeAllSamples, type DemuxedTrack } from "../media/samples";
import { toSourceFile } from "../media/sourceFile";
import { drawTextOverlays } from "../media/textOverlayRender";
import {
  captureTransitionBoundaryFrames,
  drawTransitionFrame,
  type TransitionBoundaryFrames,
} from "../media/transitionRender";
import { generateThumbnail } from "../media/thumbnail";
import { computeWaveformPeaks, drawWaveformSlice } from "../media/waveform";
import { hydrateIcons, iconMarkup } from "./icons";

// TS no conserva el estrechamiento de `x | null` dentro de `function`
// declarados más abajo (solo dentro de arrow functions/const), así
// que en vez de comprobar una vez y confiar en el estrechamiento,
// estos helpers lanzan de inmediato y devuelven un tipo no-nulable —
// evita repetir guardas en cada función que toca el DOM.
function requireElement<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Falta el elemento ${selector} en index.html`);
  return el;
}

function requireContext(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = target.getContext("2d");
  if (!context) throw new Error("No se pudo obtener el contexto 2D del canvas");
  return context;
}

const fileInput = requireElement<HTMLInputElement>("#file-input");
const undoButton = requireElement<HTMLButtonElement>("#undo-button");
const redoButton = requireElement<HTMLButtonElement>("#redo-button");
const saveProjectButton = requireElement<HTMLButtonElement>("#save-project-button");
const loadProjectButton = requireElement<HTMLButtonElement>("#load-project-button");
const projectFileInput = requireElement<HTMLInputElement>("#project-file-input");
const projectSourcesInput = requireElement<HTMLInputElement>("#project-sources-input");
const projectStatus = requireElement<HTMLParagraphElement>("#project-status");
const timelineScroll = requireElement<HTMLDivElement>("#timeline-scroll");
const timelineContent = requireElement<HTMLDivElement>("#timeline-content");
const timelineRuler = requireElement<HTMLDivElement>("#timeline-ruler");
const timelineTracksContainer = requireElement<HTMLDivElement>("#timeline-tracks");
const timelineTextTrack = requireElement<HTMLDivElement>("#timeline-text-track");
const timelinePlayhead = requireElement<HTMLDivElement>("#timeline-playhead");
const addVideoTrackButton = requireElement<HTMLButtonElement>("#add-video-track-button");
const addAudioTrackButton = requireElement<HTMLButtonElement>("#add-audio-track-button");
const selectClipButton = requireElement<HTMLButtonElement>("#select-clip-button");
const splitButton = requireElement<HTMLButtonElement>("#split-button");
const snapToggleButton = requireElement<HTMLButtonElement>("#snap-toggle-button");
const flagClipButton = requireElement<HTMLButtonElement>("#flag-clip-button");
const masterVolumeInput = requireElement<HTMLInputElement>("#master-volume");
const deleteClipButton = requireElement<HTMLButtonElement>("#delete-clip-button");
const transitionTypeSelect = requireElement<HTMLSelectElement>("#transition-type");
const transitionDurationInput = requireElement<HTMLInputElement>("#transition-duration");
const insertTransitionButton = requireElement<HTMLButtonElement>("#insert-transition-button");
const zoomOutButton = requireElement<HTMLButtonElement>("#zoom-out-button");
const zoomFitButton = requireElement<HTMLButtonElement>("#zoom-fit-button");
const zoomInButton = requireElement<HTMLButtonElement>("#zoom-in-button");
const trimDetails = requireElement<HTMLDetailsElement>("#trim-details");
const outputDetails = requireElement<HTMLDetailsElement>("#output-details");
const masterAudioDetails = requireElement<HTMLDetailsElement>("#master-audio-details");
const markersDetails = requireElement<HTMLDetailsElement>("#markers-details");
const inspectorHint = requireElement<HTMLParagraphElement>("#inspector-hint");
const trimControls = requireElement<HTMLFieldSetElement>("#trim-controls");
const trimInInput = requireElement<HTMLInputElement>("#trim-in");
const trimOutInput = requireElement<HTMLInputElement>("#trim-out");
const applyTrimButton = requireElement<HTMLButtonElement>("#apply-trim");
const clipMutedInput = requireElement<HTMLInputElement>("#clip-muted");
const clipVideoHiddenInput = requireElement<HTMLInputElement>("#clip-video-hidden");
const clipColorFilterSelect = requireElement<HTMLSelectElement>("#clip-color-filter");
const outputControls = requireElement<HTMLFieldSetElement>("#output-controls");
const outputWidthInput = requireElement<HTMLInputElement>("#output-width");
const outputHeightInput = requireElement<HTMLInputElement>("#output-height");
const outputFpsInput = requireElement<HTMLInputElement>("#output-fps");
const applyOutputButton = requireElement<HTMLButtonElement>("#apply-output");
const addMarkerButton = requireElement<HTMLButtonElement>("#add-marker-button");
const markerList = requireElement<HTMLUListElement>("#marker-list");
const textDetails = requireElement<HTMLDetailsElement>("#text-details");
const textEditorEmptyHint = requireElement<HTMLParagraphElement>("#text-editor-empty-hint");
const textEditorFieldset = requireElement<HTMLFieldSetElement>("#text-editor");
const textContentInput = requireElement<HTMLInputElement>("#text-content");
const textStartInput = requireElement<HTMLInputElement>("#text-start");
const textEndInput = requireElement<HTMLInputElement>("#text-end");
const textSizeInput = requireElement<HTMLInputElement>("#text-size");
const textColorInput = requireElement<HTMLInputElement>("#text-color");
const textFontSelect = requireElement<HTMLSelectElement>("#text-font");
const textXInput = requireElement<HTMLInputElement>("#text-x");
const textYInput = requireElement<HTMLInputElement>("#text-y");
const textRotationInput = requireElement<HTMLInputElement>("#text-rotation");
const deleteTextButton = requireElement<HTMLButtonElement>("#delete-text-button");
const addTextButton = requireElement<HTMLButtonElement>("#add-text-button");
const textOverlayList = requireElement<HTMLUListElement>("#text-overlay-list");
const playButton = requireElement<HTMLButtonElement>("#play-button");
const pauseButton = requireElement<HTMLButtonElement>("#pause-button");
const previewWrap = requireElement<HTMLDivElement>("#preview-wrap");
const previewZoomButton = requireElement<HTMLButtonElement>("#preview-zoom-button");
const canvas = requireElement<HTMLCanvasElement>("#preview");
const status = requireElement<HTMLSpanElement>("#status");
const exportQualitySelect = requireElement<HTMLSelectElement>("#export-quality");
const exportResolutionPresetSelect = requireElement<HTMLSelectElement>("#export-resolution-preset");
const exportButton = requireElement<HTMLButtonElement>("#export-button");
const cancelExportButton = requireElement<HTMLButtonElement>("#cancel-export-button");
const exportStatus = requireElement<HTMLParagraphElement>("#export-status");
const exportProgress = requireElement<HTMLProgressElement>("#export-progress");
const exportDownload = requireElement<HTMLParagraphElement>("#export-download");
const scrubTooltip = requireElement<HTMLDivElement>("#scrub-tooltip");
const dropZone = requireElement<HTMLLabelElement>("#drop-zone");
const helpButton = requireElement<HTMLButtonElement>("#help-button");
const appMenuButton = requireElement<HTMLButtonElement>("#app-menu-button");
const appMenuDropdown = requireElement<HTMLDivElement>("#app-menu-dropdown");
const projectNameLabel = requireElement<HTMLSpanElement>("#project-name");
const shortcutsModal = requireElement<HTMLDialogElement>("#shortcuts-modal");
const closeShortcutsModalButton = requireElement<HTMLButtonElement>("#close-shortcuts-modal");
const previewZoomLabel = requireElement<HTMLSpanElement>("#preview-zoom-label");
const gradeLiftRInput = requireElement<HTMLInputElement>("#grade-lift-r");
const gradeLiftGInput = requireElement<HTMLInputElement>("#grade-lift-g");
const gradeLiftBInput = requireElement<HTMLInputElement>("#grade-lift-b");
const gradeGammaRInput = requireElement<HTMLInputElement>("#grade-gamma-r");
const gradeGammaGInput = requireElement<HTMLInputElement>("#grade-gamma-g");
const gradeGammaBInput = requireElement<HTMLInputElement>("#grade-gamma-b");
const gradeGainRInput = requireElement<HTMLInputElement>("#grade-gain-r");
const gradeGainGInput = requireElement<HTMLInputElement>("#grade-gain-g");
const gradeGainBInput = requireElement<HTMLInputElement>("#grade-gain-b");
const gradeSaturationInput = requireElement<HTMLInputElement>("#grade-saturation");
const gradeContrastInput = requireElement<HTMLInputElement>("#grade-contrast");
const gradeInvertInput = requireElement<HTMLInputElement>("#grade-invert");
const applyGradeButton = requireElement<HTMLButtonElement>("#apply-grade");
const resetGradeButton = requireElement<HTMLButtonElement>("#reset-grade");
const chromaEnabledInput = requireElement<HTMLInputElement>("#chroma-enabled");
const chromaColorInput = requireElement<HTMLInputElement>("#chroma-color");
const chromaSimilarityInput = requireElement<HTMLInputElement>("#chroma-similarity");
const chromaSmoothnessInput = requireElement<HTMLInputElement>("#chroma-smoothness");
const applyChromaButton = requireElement<HTMLButtonElement>("#apply-chroma");
const masterAudioControls = requireElement<HTMLFieldSetElement>("#master-audio-controls");
const masterAudioEnabledInput = requireElement<HTMLInputElement>("#master-audio-enabled");
const masterEqLowInput = requireElement<HTMLInputElement>("#master-eq-low");
const masterEqMidInput = requireElement<HTMLInputElement>("#master-eq-mid");
const masterEqHighInput = requireElement<HTMLInputElement>("#master-eq-high");
const masterCompressionAmountInput = requireElement<HTMLInputElement>("#master-compression-amount");
const masterMakeupGainInput = requireElement<HTMLInputElement>("#master-makeup-gain");
const applyMasterAudioButton = requireElement<HTMLButtonElement>("#apply-master-audio");
const mediaBinDetails = requireElement<HTMLDetailsElement>("#media-bin-details");
const mediaBinList = requireElement<HTMLUListElement>("#media-bin-list");
const mainVerticalResizeHandle = requireElement<HTMLDivElement>("#main-vertical-resize");
const timelineSectionEl = requireElement<HTMLDivElement>("#timeline-section");
const mainEl = requireElement<HTMLElement>("main");

hydrateIcons();

// Convierte los ~40 `status.textContent = "..."` repartidos por este
// archivo en un aviso tipo "toast" (breve destello de color al
// cambiar) sin tocar ninguno de esos call sites — ver .flash/
// @keyframes status-flash en styles.css. `offsetWidth` fuerza reflow
// entre quitar y volver a poner la clase para que la animación se
// reinicie aunque el mensaje cambie varias veces seguidas.
new MutationObserver(() => {
  status.classList.remove("flash");
  void status.offsetWidth;
  status.classList.add("flash");
}).observe(status, { childList: true, characterData: true, subtree: true });

const ctx = requireContext(canvas);

// Instancia única para toda la sesión de preview — crear un contexto
// WebGL2 no es gratis, y solo se pinta un fotograma cada vez (nunca
// preview + exportación a la vez, ver runExport/stopPlayback). undefined
// si WebGL2 no está disponible: drawFrameFit se lo salta sin más y el
// preview sigue funcionando igual que antes de esta ampliación, solo
// sin grading/croma.
let previewGradeRenderer: ColorGradeRenderer | undefined;
try {
  previewGradeRenderer = new ColorGradeRenderer();
} catch (error) {
  console.warn("Grading real desactivado (WebGL2 no disponible):", error);
}

interface SourceEntry {
  sourceFile: SourceFile;
  demuxed: DemuxedTrack;
  fileName: string;
  /** Ruta absoluta real del archivo — solo disponible dentro de Electron (ver ui/electronBridge.ts), capturada con getPathForFile en cuanto se obtiene el File. Permite reabrir el proyecto sin volver a pedir el archivo si sigue en el mismo sitio. */
  filePath?: string;
  thumbnail?: string;
  audio?: AudioBuffer;
  waveformPeaks?: Float32Array;
  player?: VideoPlayer;
}

interface MarkerState {
  id: string;
  ticks: number;
}

/** Referencia estable a un clip dentro de una pista concreta — sustituye al índice plano de antes de la ampliación multipista (ver CLAUDE.md, 2026-08-21): un índice de array ya no identifica de forma única "qué clip" ni "en qué pista". */
interface ClipRef {
  trackId: string;
  clipId: string;
}

/**
 * Qué se está reproduciendo/mostrando ahora mismo en el preview — ya
 * no hay un único "playingClipIndex" (índice en un array de una sola
 * pista): puede ser un clip real de una pista de vídeo, una transición
 * de esa misma pista, o un hueco (ninguna pista de vídeo tiene
 * contenido en este instante, pero la reproducción sigue avanzando en
 * silencio/negro hasta que algo vuelva a aparecer o se acabe la
 * timeline). Sustituye por completo al índice de clip plano de antes
 * de la ampliación multipista del 2026-08-21 — ver CLAUDE.md.
 */
type ActiveSegment =
  | { kind: "clip"; trackId: string; clip: Clip }
  | { kind: "transition"; trackId: string; clip: Clip }
  | { kind: "gap"; endTicks: number };

// Antes 400: se notaba escalonada/en bloques al recortar un clip corto
// o hacer zoom, porque el número de cubos disponibles para esa porción
// caía muy por debajo de los píxeles disponibles en pantalla. 3000 es
// suficiente detalle incluso para un clip recortado a una fracción
// pequeña de una fuente larga, sin disparar el coste de memoria
// (Float32Array de 3000*2 = 24KB por fuente).
const WAVEFORM_BUCKET_COUNT = 3000;

const sources = new Map<string, SourceEntry>();
let timeline: Timeline | undefined;
let selectedClip: ClipRef | undefined;
/** Id del overlay de texto seleccionado (en la línea de tiempo o el preview) — mutuamente excluyente con selectedClip, ver selectTextOverlay/selectClipRef. */
let selectedOverlayId: string | undefined;
let activeSegment: ActiveSegment | undefined;
/** Filtro de color del clip cuyo fotograma se está pintando ahora mismo (reproducción o scrub) — lo lee el onFrame de getPlayer más abajo. Separado de activeSegment porque el scrub también necesita pintar el filtro correcto sin considerarse "reproduciendo". */
let activeColorFilter: ColorFilterType | undefined;
/** Igual que activeColorFilter, pero para el grading real/croma (ver core/types.ts) — ampliación de alcance del 2026-08-29. */
let activeColorGrade: ColorGrade | undefined;
let activeChromaKey: ChromaKey | undefined;
let nextSourceNumber = 1;
let nextClipNumber = 1;
let nextTrackNumber = 1;
let nextOverlayNumber = 1;
let markers: MarkerState[] = [];
let textOverlays: TextOverlay[] = [];

// Un único AudioContext para toda la sesión — reproducir un clip crea
// un AudioBufferSourceNode nuevo cada vez (son de un solo uso), pero
// el contexto en sí se comparte. Puede arrancar "suspended" hasta el
// primer gesto del usuario (política de autoplay); se reanuda al
// primer play().
const audioContext = new AudioContext();
// Ganancia de MONITOR: volumen de la previsualización, deslizable desde
// la barra de la línea de tiempo (#master-volume). Es lo último antes de
// audioContext.destination, así que baja/sube toda la mezcla que se OYE
// — pero no se guarda en el proyecto ni interviene en la exportación
// (export/exportTimeline.ts tiene su propio OfflineAudioContext), y no
// toca el volumen por clip. Pedido explícito del 2026-08-30.
const monitorGain = audioContext.createGain();
monitorGain.connect(audioContext.destination);
// TODAS las franjas de audio de la timeline (de cualquier pista no
// oculta, no solo la del clip de vídeo que se ve ahora mismo — ver
// CLAUDE.md) se programan de una sola vez al arrancar la reproducción
// (scheduleAllTrackAudio), así que puede haber muchas activas a la
// vez. Se paran todas juntas al pausar/parar/saltar — nunca se
// reprograman en cada transición de clip/hueco/transición dentro de
// una misma sesión de reproducción, porque ya quedaron programadas
// por adelantado con AudioBufferSourceNode.start(when).
let activeAudioHandles: AudioPlaybackHandle[] = [];
/** Cadena del bus máster de la sesión de reproducción en curso (ver media/masterAudioChain.ts) — se reconstruye en cada scheduleAllTrackAudio con la configuración ACTUAL de timeline.masterAudio, y se desconecta al parar. */
let activeMasterChain: MasterAudioChain | undefined;
/**
 * Reloj del audio programado por adelantado: en cualquier instante,
 * `audioTimelineTicksNow()` = qué tick de la timeline está sonando AHORA
 * mismo. El vídeo (que sí avanza segmento a segmento y puede llegar
 * tarde tras un hueco reproducido en tiempo real, o por lo que tarda un
 * seek/decodificación) se re-ancla a este reloj al empezar cada clip
 * — ver playClipFrom — para que audio y vídeo no queden desincronizados.
 * `undefined` si no hay audio programado.
 */
let audioClock: { baseWhen: number; fromTicks: number } | undefined;

function audioTimelineTicksNow(): number | undefined {
  if (!audioClock) return undefined;
  return audioClock.fromTicks + secondsToTicks(audioContext.currentTime - audioClock.baseWhen);
}

function stopActiveAudio(): void {
  for (const handle of activeAudioHandles) handle.stop();
  activeAudioHandles = [];
  activeMasterChain?.disconnect();
  activeMasterChain = undefined;
  audioClock = undefined;
}

/**
 * Programa TODA la reproducción de audio de la timeline desde
 * `fromTicks` en adelante, de una sola vez, usando allAudioSchedules
 * (core/timeline.ts) — la misma función pura que usa la exportación,
 * así preview y export no pueden divergir en qué suena. A diferencia
 * del vídeo (que avanza de segmento en segmento con VideoPlayer real y
 * eventos), el audio no necesita "avanzar": cada AudioBufferSourceNode
 * se programa ya con su instante de inicio futuro
 * (AudioBufferSourceNode.start(when)), así que basta con llamar a esto
 * una vez al arrancar cada sesión de reproducción (ver
 * playFromPlayhead) — nunca en cada transición interna de segmento.
 */
function scheduleAllTrackAudio(fromTicks: number): void {
  if (!timeline) return;
  activeMasterChain = createMasterAudioChain(audioContext, monitorGain, timeline.masterAudio);
  const baseWhen = audioContext.currentTime;
  audioClock = { baseWhen, fromTicks };
  for (const schedule of allAudioSchedules(timeline, fromTicks)) {
    const entry = sources.get(schedule.sourceId);
    if (!entry?.audio) continue;
    const when = baseWhen + ticksToSeconds(schedule.startTicks - fromTicks);
    activeAudioHandles.push(
      playAudioSlice(
        audioContext,
        activeMasterChain.input,
        entry.audio,
        ticksToSeconds(schedule.sourceStartTicks),
        ticksToSeconds(schedule.durationTicks),
        when,
        schedule.automation,
      ),
    );
  }
}

// Reproducción "sintética" (huecos y transiciones): no hay VideoPlayer
// real detrás, así que un requestAnimationFrame propio avanza el
// playhead y redibuja cada fotograma — ver playSyntheticSegment.
let syntheticAnimationHandle: number | undefined;
let syntheticCleanup: (() => void) | undefined;

// Fotogramas fijos (último del clip anterior / primero del siguiente)
// de cada transición, cacheados por id mientras la timeline no cambie
// — se recalculan solos en el próximo commitTimeline si algo cambia.
const transitionFrameCache = new Map<string, TransitionBoundaryFrames>();

/** Posición del playhead en ticks de la timeline — única fuente de verdad de "dónde estamos". */
let playheadTicks = 0;
let timelineTotalTicks = 0;

/** Píxeles por segundo — el nivel de zoom de la línea de tiempo. */
let pixelsPerSecond = 100;
const MIN_PIXELS_PER_SECOND = 5;
const MAX_PIXELS_PER_SECOND = 800;
const ZOOM_STEP = 1.3;
const SNAP_PIXELS = 8;
/** Imán activado (tecla N / botón N de la barra). Encendido por defecto — el comportamiento de siempre. */
let snappingEnabled = true;
let hasAutoFitted = false;
let previewZoomed100 = false;

// --- Historial (deshacer / rehacer) ---
// Timeline es un dato inmutable (todo /core devuelve una copia nueva),
// así que el historial es solo una pila de snapshots — nunca hace
// falta clonar nada a mano. Cubre también textOverlays y markers (no
// solo la Timeline): un snapshot es el estado completo del proyecto en
// ese instante, para que deshacer deshaga TODO lo último que hiciste,
// sea un recorte, un texto o un marcador — no solo los clips.
interface EditorSnapshot {
  timeline: Timeline;
  textOverlays: TextOverlay[];
  markers: MarkerState[];
}

let historyPast: EditorSnapshot[] = [];
let historyFuture: EditorSnapshot[] = [];
const MAX_HISTORY = 50;

/** Copia superficial de todo el estado editable ahora mismo — timeline es inmutable (no hace falta copiarla), pero textOverlays/markers se mutan in-place en varios sitios, así que sí hay que copiarlos para que un snapshot quede congelado en el tiempo. */
function captureEditorSnapshot(): EditorSnapshot {
  return {
    timeline: requireTimeline(),
    textOverlays: textOverlays.map((overlay) => ({ ...overlay })),
    markers: markers.map((marker) => ({ ...marker })),
  };
}

/** Snapshot con una Timeline concreta (normalmente `dragStartTimeline`, capturada al empezar un arrastre de clip) y el textOverlays/markers actuales — para los arrastres de clip, que solo tocan la Timeline. */
function snapshotWithTimeline(snapshotTimeline: Timeline): EditorSnapshot {
  return {
    timeline: snapshotTimeline,
    textOverlays: textOverlays.map((overlay) => ({ ...overlay })),
    markers: markers.map((marker) => ({ ...marker })),
  };
}

function pushHistory(previous: EditorSnapshot): void {
  historyPast.push(previous);
  if (historyPast.length > MAX_HISTORY) historyPast.shift();
  historyFuture = [];
  updateHistoryButtons();
}

/** Aplica un nuevo estado de la timeline registrando el anterior (con el textOverlays/markers de entonces) en el historial. Usar SIEMPRE en vez de asignar `timeline = ...` directamente. */
function commitTimeline(next: Timeline): void {
  if (timeline) pushHistory(captureEditorSnapshot());
  timeline = next;
  clearTransitionFrameCache();
}

/**
 * Envuelve una mutación de textOverlays/markers (nunca de la Timeline,
 * para eso está commitTimeline) en un solo paso de historial — captura
 * el estado antes, ejecuta `mutate`, y solo empuja el "antes" al
 * historial si algo cambió de verdad (evita ensuciar el historial con
 * pasos que no tocaron nada).
 */
function commitTextEdit(mutate: () => void): void {
  if (!timeline) return;
  const before = captureEditorSnapshot();
  mutate();
  const overlaysChanged = JSON.stringify(before.textOverlays) !== JSON.stringify(textOverlays);
  const markersChanged = JSON.stringify(before.markers) !== JSON.stringify(markers);
  if (overlaysChanged || markersChanged) pushHistory(before);
}

/** Los fotogramas fijos de cada transición dejan de ser válidos en cuanto cambia algo de la timeline (pudo cambiar quién es su vecino). */
function clearTransitionFrameCache(): void {
  for (const frames of transitionFrameCache.values()) {
    frames.fromImage?.close();
    frames.toImage?.close();
  }
  transitionFrameCache.clear();
}

async function transitionFramesFor(tl: Timeline, track: Track, transitionClip: Clip): Promise<TransitionBoundaryFrames> {
  const cached = transitionFrameCache.get(transitionClip.id);
  if (cached) return cached;
  const frames = await captureTransitionBoundaryFrames(
    track,
    transitionClip,
    (sourceId) => sources.get(sourceId)?.demuxed,
    tl.outputResolution.width,
    tl.outputResolution.height,
  );
  transitionFrameCache.set(transitionClip.id, frames);
  return frames;
}

function updateHistoryButtons(): void {
  undoButton.disabled = historyPast.length === 0;
  redoButton.disabled = historyFuture.length === 0;
}

/** Busca la pista+clip de una ClipRef en la timeline actual — undefined si la pista o el clip ya no existen (p.ej. tras deshacer). Centraliza el patrón "buscar pista, luego buscar clip en ella" repetido por toda la UI. */
function findClipRef(ref: ClipRef | undefined): { track: Track; clip: Clip } | undefined {
  if (!ref || !timeline) return undefined;
  const track = timeline.tracks.find((t) => t.id === ref.trackId);
  const clip = track?.clips.find((c) => c.id === ref.clipId);
  return track && clip ? { track, clip } : undefined;
}

function afterHistoryChange(): void {
  stopPlayback();
  if (selectedClip && !findClipRef(selectedClip)) {
    selectedClip = undefined;
  }
  if (selectedOverlayId !== undefined && !findOverlayById(selectedOverlayId)) {
    clearOverlaySelection();
  }
  refreshTimelineLayout();
  renderTextOverlayList(); // renderTextTrack() ya la cubre refreshTimelineLayout(), falta la lista lateral
  syncTextEditorPanel();
  const found = findClipRef(selectedClip);
  if (found) {
    trimInInput.value = String(ticksToSeconds(found.clip.sourceInTicks));
    trimOutInput.value = String(ticksToSeconds(found.clip.sourceOutTicks));
    clipMutedInput.checked = found.clip.muted;
    clipVideoHiddenInput.checked = found.clip.videoHidden ?? false;
    clipColorFilterSelect.value = found.clip.colorFilter ?? "";
  }
  void seekToTimelineTicks(Math.min(playheadTicks, Math.max(timelineTotalTicks - 1, 0)));
  updateHistoryButtons();
}

function applySnapshot(snapshot: EditorSnapshot): void {
  timeline = snapshot.timeline;
  textOverlays = snapshot.textOverlays;
  markers = snapshot.markers;
}

function undo(): void {
  if (!timeline || historyPast.length === 0) return;
  const previous = historyPast.pop()!;
  historyFuture.push(captureEditorSnapshot());
  applySnapshot(previous);
  afterHistoryChange();
}

function redo(): void {
  if (!timeline || historyFuture.length === 0) return;
  const next = historyFuture.pop()!;
  historyPast.push(captureEditorSnapshot());
  applySnapshot(next);
  afterHistoryChange();
}

undoButton.addEventListener("click", undo);
redoButton.addEventListener("click", redo);

function requireTimeline(): Timeline {
  if (!timeline) throw new Error("No hay timeline cargada");
  return timeline;
}

/** Ticks de la timeline correspondientes a un fotograma de `sourceId` con ese timestamp de fuente (en µs). undefined si esa fuente no es la que está sonando/mostrándose ahora mismo. */
function timelineTicksForSourceFrame(sourceId: string, sourceTimeUs: number): number | undefined {
  if (!activeSegment || activeSegment.kind !== "clip" || activeSegment.clip.sourceId !== sourceId) return undefined;
  const clip = activeSegment.clip;
  const sourceTicks = secondsToTicks(sourceTimeUs / 1_000_000);
  return clip.startTicks + Math.max(0, sourceTicks - clip.sourceInTicks);
}

/**
 * Pool acotado de VideoPlayer/VideoDecoder en vivo — ver DESIGN.md §3.
 * Crear un VideoDecoder es caro, y las GPU de consumo limitan cuántas
 * sesiones de decodificación por hardware pueden estar activas a la
 * vez (media/player.ts las pide con hardwareAcceleration:"prefer-hardware")
 * — con muchas fuentes distintas cargadas en el mismo proyecto, sin
 * tope los decoders se irían acumulando sin cerrarse nunca. Orden de
 * "usado más recientemente" en `playerPoolOrder`; al superar
 * PLAYER_POOL_SIZE se cierra el menos usado — nunca el que está
 * sonando o mostrándose ahora mismo (`protectedSourceId`).
 */
const PLAYER_POOL_SIZE = 3;
const playerPoolOrder: string[] = [];

function touchPlayerPool(sourceId: string): void {
  const idx = playerPoolOrder.indexOf(sourceId);
  if (idx !== -1) playerPoolOrder.splice(idx, 1);
  playerPoolOrder.push(sourceId);
}

function evictPlayerPoolIfNeeded(protectedSourceId: string): void {
  while (playerPoolOrder.length > PLAYER_POOL_SIZE) {
    const victimId = playerPoolOrder.find((id) => id !== protectedSourceId);
    if (!victimId) break; // no debería pasar con PLAYER_POOL_SIZE >= 1, pero por si acaso
    playerPoolOrder.splice(playerPoolOrder.indexOf(victimId), 1);
    const victim = sources.get(victimId);
    if (victim?.player) {
      victim.player.destroy();
      delete victim.player;
    }
  }
}

function getPlayer(sourceId: string): VideoPlayer {
  const entry = sources.get(sourceId);
  if (!entry) throw new Error(`Fuente no encontrada: ${sourceId}`);
  touchPlayerPool(sourceId);
  if (!entry.player) {
    evictPlayerPoolIfNeeded(sourceId);
    entry.player = createVideoPlayer(entry.demuxed, {
      onFrame: (frame) => {
        if (!timeline) return;
        drawFrameFit(ctx, frame, timeline.outputResolution, activeColorFilter, activeColorGrade, activeChromaKey, previewGradeRenderer);
        if (textOverlays.length > 0) {
          const ticks = timelineTicksForSourceFrame(sourceId, frame.timestamp) ?? playheadTicks;
          drawActiveTextOverlays(ticks);
        }
      },
      onStatus: (message) => {
        status.textContent = message;
      },
      onTimeUpdate: (sourceTimeUs) => {
        if (!activeSegment || activeSegment.kind !== "clip" || activeSegment.clip.sourceId !== sourceId) return; // fotograma tardío de un player ya no activo
        const clip = activeSegment.clip;
        const sourceTicks = secondsToTicks(sourceTimeUs / 1_000_000);
        setPlayheadTicks(clip.startTicks + Math.max(0, sourceTicks - clip.sourceInTicks));
      },
      onEnded: () => {
        void handleClipEnded(sourceId);
      },
    });
  }
  return entry.player;
}

async function handleClipEnded(sourceId: string): Promise<void> {
  if (!activeSegment || activeSegment.kind !== "clip" || activeSegment.clip.sourceId !== sourceId) return; // señal obsoleta de un player que ya no está activo
  await advanceFrom(clipEndTicks(activeSegment.clip));
}

/** Al terminar el clip/hueco/transición actual (que alcanzó `reachedTicks`), sigue con lo que haya ahí o termina la reproducción. */
async function advanceFrom(reachedTicks: number): Promise<void> {
  if (!timeline) return;
  // Se recalcula la duración total desde `timeline` en vez de leer el
  // caché `timelineTotalTicks`: ese caché solo se refresca en
  // refreshTimelineLayout(), y aunque ya se llama tras mover/recortar
  // clips, calcularlo aquí evita depender de que ningún camino se lo
  // salte (era la causa de "Reproducción terminada" a mitad al llegar a
  // un clip movido más adelante).
  const totalTicks = timelineDurationTicks(timeline);
  if (reachedTicks >= totalTicks) {
    activeSegment = undefined;
    pauseButton.disabled = true;
    await seekToTimelineTicks(0);
    status.textContent = "Reproducción terminada.";
    return;
  }
  await playFromTimelineTicks(reachedTicks);
}

/** Reparte hacia el reproductor real (clip), la reproducción sintética de una transición, o un hueco (negro/silencio hasta que algo vuelva a aparecer), según qué haya en `startTicks`. */
function playFromTimelineTicks(startTicks: number): Promise<void> {
  const tl = requireTimeline();
  const position = resolveActiveVideoPosition(tl, startTicks);
  if (!position) {
    const endTicks = nextVideoContentTicks(tl, startTicks) ?? timelineDurationTicks(tl);
    return playGapFrom(startTicks, Math.max(startTicks, endTicks));
  }
  if (position.clip.kind === "transition") {
    return playTransitionFrom(position.trackId, position.clip, startTicks - position.clip.startTicks);
  }
  return playClipFrom(position.trackId, position.clip, startTicks - position.clip.startTicks);
}

async function playClipFrom(trackId: string, clip: Clip, offsetTicks: number): Promise<void> {
  const player = getPlayer(clip.sourceId);

  // Continuación sin costura: si el clip que acaba de terminar es de la
  // MISMA fuente y este empieza exactamente donde aquel acabó — tanto en
  // la timeline como en el archivo, lo típico tras un corte (C) sin
  // separar los trozos —, el decoder ya está justo en ese punto con los
  // siguientes fotogramas en cola. Un seekTo() aquí tiraba esa cola y
  // decodificaba el GOP entero hasta el corte DOS veces (el seek, y el
  // re-cebado desde keyframe que exige WebCodecs tras su flush()): con
  // keyframes cada varios segundos (grabaciones de OBS/cámara), el vídeo
  // se quedaba parado en el corte mientras seguía el audio.
  const previous = activeSegment;
  if (
    offsetTicks === 0 &&
    previous?.kind === "clip" &&
    previous.clip.sourceId === clip.sourceId &&
    previous.clip.sourceOutTicks === clip.sourceInTicks &&
    clipEndTicks(previous.clip) === clip.startTicks
  ) {
    activeSegment = { kind: "clip", trackId, clip };
    activeColorFilter = clip.colorFilter;
    activeColorGrade = clip.colorGrade;
    activeChromaKey = clip.chromaKey;
    player.play(Math.round(ticksToSeconds(clip.sourceOutTicks) * 1_000_000));
    pauseButton.disabled = false;
    return;
  }

  // Re-ancla el vídeo al reloj del audio (que se programó por adelantado
  // y no espera a nadie): si el audio ya está SONANDO por dentro de este
  // clip más allá de `offsetTicks` — lo típico al cruzar un hueco, que
  // se reproduce en tiempo real y suele terminar un pelín tarde, o por
  // lo que tarde el seek+decodificación de abajo — arranca el vídeo en
  // ese mismo punto en vez de al principio del clip. Sin esto, el vídeo
  // salía del hueco reproduciéndose desde su primer fotograma mientras
  // el audio ya iba por delante: se veía "congelado al empezar el clip"
  // mientras solo avanzaba el sonido.
  const clipDuration = clipDurationTicks(clip);
  const audioTicks = audioTimelineTicksNow();
  let effectiveOffsetTicks = offsetTicks;
  if (audioTicks !== undefined) {
    const audioOffsetInClip = audioTicks - clip.startTicks;
    if (audioOffsetInClip > offsetTicks && audioOffsetInClip < clipDuration) {
      effectiveOffsetTicks = audioOffsetInClip;
    }
  }

  const startUs = Math.round(ticksToSeconds(clip.sourceInTicks + effectiveOffsetTicks) * 1_000_000);
  const endUs = Math.round(ticksToSeconds(clip.sourceOutTicks) * 1_000_000);
  activeSegment = { kind: "clip", trackId, clip };
  activeColorFilter = clip.colorFilter;
  activeColorGrade = clip.colorGrade;
  activeChromaKey = clip.chromaKey;

  await player.seekTo(startUs);
  // El usuario pudo saltar a otro sitio mientras se decodificaba el seek
  // — no arranques la reproducción de un segmento que ya no es el activo.
  if (activeSegment?.kind !== "clip" || activeSegment.clip.id !== clip.id) return;

  player.play(endUs);
  pauseButton.disabled = false;
}

/**
 * Avanza el playhead con un requestAnimationFrame propio (no hay
 * VideoPlayer real detrás) desde `segmentStartTicks` (+`offsetTicks`
 * si se retoma a mitad) hasta `segmentEndTicks`, llamando a
 * `render(ticks)` en cada fotograma. Usado por huecos y transiciones
 * — ver playGapFrom/playTransitionFrom.
 */
function playSyntheticSegment(
  segmentStartTicks: number,
  segmentEndTicks: number,
  offsetTicks: number,
  render: (ticks: number) => void,
  cleanup?: () => void,
): void {
  pauseButton.disabled = false;
  syntheticCleanup = cleanup;

  const wallStartMs = performance.now();
  const startOffsetSeconds = ticksToSeconds(offsetTicks);

  function tick(): void {
    const elapsedSeconds = startOffsetSeconds + (performance.now() - wallStartMs) / 1000;
    const ticks = Math.min(segmentEndTicks, segmentStartTicks + secondsToTicks(elapsedSeconds));
    setPlayheadTicks(ticks);
    render(ticks);
    if (ticks >= segmentEndTicks) {
      syntheticCleanup = undefined;
      cleanup?.();
      void advanceFrom(segmentEndTicks);
      return;
    }
    syntheticAnimationHandle = requestAnimationFrame(tick);
  }
  syntheticAnimationHandle = requestAnimationFrame(tick);
}

function stopSyntheticPlayback(): void {
  if (syntheticAnimationHandle !== undefined) {
    cancelAnimationFrame(syntheticAnimationHandle);
    syntheticAnimationHandle = undefined;
  }
  syntheticCleanup?.();
  syntheticCleanup = undefined;
}

function drawGapFrame(ticks: number): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawActiveTextOverlays(ticks);
}

function playGapFrom(fromTicks: number, toTicks: number): Promise<void> {
  activeSegment = { kind: "gap", endTicks: toTicks };
  playSyntheticSegment(fromTicks, toTicks, 0, drawGapFrame);
  return Promise.resolve();
}

async function playTransitionFrom(trackId: string, clip: Clip, offsetTicks: number): Promise<void> {
  const tl = requireTimeline();
  const track = tl.tracks.find((t) => t.id === trackId);
  if (!track) return;
  activeSegment = { kind: "transition", trackId, clip };

  const frames = await transitionFramesFor(tl, track, clip);
  if (activeSegment.kind !== "transition" || activeSegment.clip.id !== clip.id) return; // el usuario ya saltó a otro sitio mientras decodificábamos

  // El fundido cruzado del audio del clip saliente/entrante (nunca
  // silencio) ya quedó programado con el resto de la timeline al
  // arrancar la sesión de reproducción — ver
  // scheduleAllTrackAudio/playFromPlayhead — así que aquí solo hace
  // falta dibujar los fotogramas fijos.
  const durationTicks = clipDurationTicks(clip);
  playSyntheticSegment(clip.startTicks, clipEndTicks(clip), offsetTicks, (ticks) => {
    const progress = durationTicks > 0 ? (ticks - clip.startTicks) / durationTicks : 0;
    drawTransitionFrame(ctx, canvas.width, canvas.height, clip.transitionType ?? "crossfade", frames, progress);
    drawActiveTextOverlays(ticks);
  });
}

function stopPlayback(): void {
  stopActiveAudio();
  stopSyntheticPlayback();
  if (activeSegment?.kind === "clip") getPlayer(activeSegment.clip.sourceId).pause();
  activeSegment = undefined;
  pauseButton.disabled = true;
}

/**
 * Arranca una sesión de reproducción entera desde el playhead actual:
 * programa de una vez TODO el audio de la timeline desde ahí en
 * adelante (scheduleAllTrackAudio — una sola vez por sesión, nunca en
 * cada transición interna de clip/hueco/transición, ver su doc) y
 * luego reparte el vídeo al primer segmento (playFromTimelineTicks,
 * que sí se vuelve a llamar internamente conforme avanza — ver
 * advanceFrom).
 */
async function playFromPlayhead(): Promise<void> {
  if (!timeline) return;
  if (audioContext.state === "suspended") await audioContext.resume();
  scheduleAllTrackAudio(playheadTicks);
  await playFromTimelineTicks(playheadTicks);
}

function togglePlayPause(): void {
  if (!timeline) return;
  if (activeSegment) stopPlayback();
  else void playFromPlayhead();
}

async function seekToTimelineTicks(ticks: number): Promise<void> {
  if (!timeline) return;
  stopPlayback();
  const position = resolveActiveVideoPosition(timeline, ticks);

  // Se fija ANTES de decodificar/dibujar: el callback onFrame del
  // reproductor (más abajo) usa playheadTicks como último recurso para
  // saber qué overlays de texto están activos (timelineTicksForSourceFrame
  // no puede resolverlo durante un seek suelto, sin reproducción activa).
  // Fijarlo después dejaría ese cálculo usando la posición del seek
  // ANTERIOR mientras este fotograma se dibuja.
  setPlayheadTicks(ticks);

  if (!position) {
    drawGapFrame(ticks);
    return;
  }
  if (position.clip.kind === "transition") {
    const track = timeline.tracks.find((t) => t.id === position.trackId)!;
    const clip = position.clip;
    const durationTicks = clipDurationTicks(clip);
    const progress = durationTicks > 0 ? (ticks - clip.startTicks) / durationTicks : 0;
    const frames = await transitionFramesFor(timeline, track, clip);
    drawTransitionFrame(ctx, canvas.width, canvas.height, clip.transitionType ?? "crossfade", frames, progress);
    drawActiveTextOverlays(ticks);
    return;
  }

  activeColorFilter = position.clip.colorFilter;
  activeColorGrade = position.clip.colorGrade;
  activeChromaKey = position.clip.chromaKey;
  const player = getPlayer(position.sourceId);
  const sourceTimeUs = Math.round(ticksToSeconds(position.sourceTimeTicks) * 1_000_000);
  await player.seekTo(sourceTimeUs);
}

/** Un paso de fotograma hacia delante (1) o hacia atrás (-1), según la frame rate de salida. */
function stepFrame(direction: 1 | -1): void {
  if (!timeline) return;
  const step = frameDurationTicks(timeline.outputFrameRate);
  const next = Math.max(0, Math.min(playheadTicks + direction * step, Math.max(timelineTotalTicks - 1, 0)));
  void seekToTimelineTicks(next);
}

/** Corta el clip seleccionado por el playhead. Con varias pistas ya no hay "el" clip del playhead sin ambigüedad — opera sobre la pista del clip seleccionado (ver selectClipAtPlayhead/selectClipRef para elegirlo primero). */
function splitAtPlayhead(): void {
  if (!timeline || !selectedClip) {
    status.textContent = "Selecciona un clip para cortarlo por el playhead.";
    return;
  }
  stopPlayback();
  let next: Timeline;
  try {
    next = splitClipAt(timeline, selectedClip.trackId, playheadTicks, [`clip-${nextClipNumber++}`, `clip-${nextClipNumber++}`]);
  } catch (error) {
    status.textContent = `No se pudo cortar: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  commitTimeline(next);
  selectedClip = undefined;
  refreshTimelineLayout();
  status.textContent = "Clip cortado en el playhead.";
}

// --- Timeline visual: zoom/scroll en píxeles, playhead, pistas, arrastrar para mover/recortar ---

/**
 * Ancho del "gutter" (nombre/ojo-mute/quitar) fijo a la izquierda de
 * cada fila de pista — ver `.timeline-track-gutter` en styles.css,
 * debe coincidir con su `flex-basis`. Los segundos (regla), los
 * marcadores, el playhead y los propios clips se posicionan todos a
 * partir de este desplazamiento, para que la "zona de tiempo" empiece
 * justo después de donde están los canales, no se solape con ellos —
 * pedido explícitamente el 2026-08-21.
 */
const TRACK_GUTTER_WIDTH_PX = 178;

function setPlayheadTicks(ticks: number): void {
  playheadTicks = Math.max(0, Math.min(ticks, Math.max(timelineTotalTicks - 1, 0)));
  updatePlayheadPosition();
}

function updatePlayheadPosition(): void {
  const left = TRACK_GUTTER_WIDTH_PX + ticksToSeconds(playheadTicks) * pixelsPerSecond;
  timelinePlayhead.style.left = `${Math.round(left)}px`;
}

/** Ancho de la ZONA DE TIEMPO en píxeles (sin contar el gutter): la duración a escala, o el ancho visible menos el gutter si es menor (para que siempre rellene el hueco). */
function contentWidthPx(): number {
  const naturalWidth = ticksToSeconds(timelineTotalTicks) * pixelsPerSecond;
  const viewportWidth = Math.max((timelineScroll.clientWidth || 1) - TRACK_GUTTER_WIDTH_PX, 1);
  return Math.max(naturalWidth, viewportWidth);
}

/** Recalcula duración total, ancho de la línea de tiempo, pistas, regla, marcadores y playhead. Llamar tras cualquier cambio estructural. */
function refreshTimelineLayout(): void {
  timelineTotalTicks = timeline ? timelineDurationTicks(timeline) : 0;
  playheadTicks = Math.min(playheadTicks, Math.max(timelineTotalTicks - 1, 0));

  // El ancho total incluye el gutter — la regla y la pista de texto
  // reservan ese mismo hueco con padding-left en CSS (ver
  // .timeline-ruler/.timeline-text-track), así sus marcas quedan
  // alineadas en X con los clips (que empiezan tras el gutter de cada fila).
  const width = Math.round(contentWidthPx()) + TRACK_GUTTER_WIDTH_PX;
  timelineContent.style.width = `${width}px`;
  timelineRuler.style.width = `${width}px`;
  timelineTextTrack.style.width = `${width}px`;

  renderTimelineTracks();
  renderTextTrack();
  renderRuler();
  renderMarkers();
  updatePlayheadPosition();
  renderInspector();
}

/**
 * Encola `fn` para el próximo fotograma, sin repetirla si ya hay una
 * pendiente. `refreshTimelineLayout`/`renderTimelineTracks`/`renderTextTrack`
 * reconstruyen bastante DOM (y, la de audio, redibujan todas las formas
 * de onda) — llamarlas directamente en cada pointermove de un arrastre
 * (que puede disparar muchas más veces por segundo de las que la
 * pantalla puede pintar) satura la cola de eventos del hilo principal
 * y da la sensación de que la app se queda pillada/va a tirones. Con
 * esto, como mucho se repinta una vez por fotograma real — la
 * mutación de datos (`timeline = ...`) sigue siendo siempre síncrona
 * e inmediata, solo se difiere el repintado caro.
 */
function throttleToFrame(fn: () => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn();
    });
  };
}

const scheduleTimelineLayoutRefresh = throttleToFrame(refreshTimelineLayout);
const scheduleTextTrackRender = throttleToFrame(renderTextTrack);

/**
 * Actualiza SOLO la posición/anchura en pantalla de los elementos ya
 * existentes de un clip (su bloque de vídeo y, si tiene, la celda de
 * audio pareja de su misma pista — ambos llevan `data-clip-id`, ver
 * renderVideoLaneClips/renderAudioLaneClips) en vez de reconstruir
 * toda la timeline. Usadas mientras un arrastre de MOVER/REDIMENSIONAR
 * TRANSICIÓN está en curso — esas operaciones nunca cambian el
 * contenido visual de un clip (miniatura, forma de onda), solo dónde
 * o cuánto ocupa, así que no hace falta la reconstrucción cara de
 * refreshTimelineLayout (todas las pistas, todas las formas de onda)
 * en cada fotograma — esa sí se sigue haciendo una vez al soltar (ver
 * selectClipRef en los `onUp` de los arrastres que las usan).
 */
function syncClipLeftInDom(clipId: string, startTicks: number): void {
  const leftPx = Math.round(ticksToSeconds(startTicks) * pixelsPerSecond);
  for (const node of timelineTracksContainer.querySelectorAll<HTMLElement>(`[data-clip-id="${clipId}"]`)) {
    node.style.left = `${leftPx}px`;
  }
}

function syncClipWidthInDom(clipId: string, durationTicks: number): void {
  const widthPx = Math.max(1, ticksToSeconds(durationTicks) * pixelsPerSecond);
  for (const node of timelineTracksContainer.querySelectorAll<HTMLElement>(`[data-clip-id="${clipId}"]`)) {
    node.style.width = `${widthPx}px`;
  }
}

function zoomAt(newPixelsPerSecond: number, anchorClientX: number): void {
  if (!timeline) return;
  const scrollRectBefore = timelineScroll.getBoundingClientRect();
  // El gutter no escala con el zoom (ancho fijo en píxeles) — se resta
  // antes de convertir a segundos y se vuelve a sumar al final, para
  // que el punto bajo el cursor se quede quieto en pantalla.
  const anchorSeconds =
    (anchorClientX - scrollRectBefore.left + timelineScroll.scrollLeft - TRACK_GUTTER_WIDTH_PX) / pixelsPerSecond;
  pixelsPerSecond = Math.max(MIN_PIXELS_PER_SECOND, Math.min(MAX_PIXELS_PER_SECOND, newPixelsPerSecond));
  refreshTimelineLayout();
  timelineScroll.scrollLeft = anchorSeconds * pixelsPerSecond + TRACK_GUTTER_WIDTH_PX - (anchorClientX - scrollRectBefore.left);
}

function zoomToFit(): void {
  if (!timeline) return;
  // Se calcula la duración directamente de `timeline` en vez de leer
  // la variable cacheada `timelineTotalTicks`: en el primer clip
  // añadido esa variable todavía vale 0 (solo se actualiza dentro de
  // refreshTimelineLayout, que aún no se ha llamado la primera vez).
  const totalTicks = timelineDurationTicks(timeline);
  if (totalTicks <= 0) return;
  const viewport = Math.max((timelineScroll.clientWidth || 1) - TRACK_GUTTER_WIDTH_PX, 1);
  const seconds = Math.max(ticksToSeconds(totalTicks), 0.001);
  pixelsPerSecond = Math.max(
    MIN_PIXELS_PER_SECOND,
    Math.min(MAX_PIXELS_PER_SECOND, viewport / seconds),
  );
  refreshTimelineLayout();
  timelineScroll.scrollLeft = 0;
}

function centerOfViewportX(): number {
  const rect = timelineScroll.getBoundingClientRect();
  return rect.left + rect.width / 2;
}

zoomInButton.addEventListener("click", () => zoomAt(pixelsPerSecond * ZOOM_STEP, centerOfViewportX()));
zoomOutButton.addEventListener("click", () => zoomAt(pixelsPerSecond / ZOOM_STEP, centerOfViewportX()));
zoomFitButton.addEventListener("click", zoomToFit);

timelineScroll.addEventListener(
  "wheel",
  (event) => {
    if (!timeline) return;
    if (!(event.ctrlKey || event.metaKey)) return; // sin Ctrl: scroll horizontal normal del navegador
    event.preventDefault();
    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    zoomAt(pixelsPerSecond * factor, event.clientX);
  },
  { passive: false },
);

const NICE_RULER_INTERVALS_SECONDS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];

function pickRulerInterval(): number {
  const minPixelGap = 70;
  for (const interval of NICE_RULER_INTERVALS_SECONDS) {
    if (interval * pixelsPerSecond >= minPixelGap) return interval;
  }
  return NICE_RULER_INTERVALS_SECONDS[NICE_RULER_INTERVALS_SECONDS.length - 1]!;
}

function formatRulerTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds - minutes * 60;
  if (minutes > 0) return `${minutes}:${String(Math.floor(secs)).padStart(2, "0")}`;
  return Number.isInteger(secs) ? `${secs}s` : `${secs.toFixed(2)}s`;
}

function renderRuler(): void {
  timelineRuler.innerHTML = "";
  if (!timeline) return;
  const interval = pickRulerInterval();
  const totalSeconds = ticksToSeconds(timelineTotalTicks);
  // Marcas menores (sin etiqueta, más tenues) a un quinto del intervalo
  // mayor — dan jerarquía a la regla sin abarrotarla de números; ver
  // .ruler-mark.minor en styles.css. Se dibujan primero para que las
  // mayores queden por encima si coincidieran en el mismo punto.
  const minorInterval = interval / 5;
  for (let t = 0; t <= totalSeconds + 1e-6; t += minorInterval) {
    if (Math.abs(t % interval) < 1e-6 || Math.abs((t % interval) - interval) < 1e-6) continue;
    const minorMark = document.createElement("span");
    minorMark.className = "ruler-mark minor";
    minorMark.style.left = `${Math.round(TRACK_GUTTER_WIDTH_PX + t * pixelsPerSecond)}px`;
    timelineRuler.appendChild(minorMark);
  }
  for (let t = 0; t <= totalSeconds + 1e-6; t += interval) {
    const mark = document.createElement("span");
    mark.className = "ruler-mark";
    mark.style.left = `${Math.round(TRACK_GUTTER_WIDTH_PX + t * pixelsPerSecond)}px`;
    mark.textContent = formatRulerTime(t);
    timelineRuler.appendChild(mark);
  }
}

/** Ticks de inicio/fin de cada clip de cualquier pista, más el final de la timeline — puntos de corte "naturales" para el imán del playhead y del arrastre de clips. */
function clipBoundaryTicks(): number[] {
  if (!timeline) return [];
  const bounds = new Set<number>();
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      bounds.add(clip.startTicks);
      bounds.add(clipEndTicks(clip));
    }
  }
  bounds.add(timelineTotalTicks);
  return [...bounds];
}

/** Ajusta `ticks` al candidato más cercano (borde de clip o marcador) si cae dentro del umbral de imán en píxeles. */
function snapTimelineTicks(ticks: number): number {
  if (!snappingEnabled) return ticks;
  const snapThresholdTicks = Math.max(1, secondsToTicks(SNAP_PIXELS / pixelsPerSecond));
  const candidates = [...clipBoundaryTicks(), ...markers.map((marker) => marker.ticks)];
  let best = ticks;
  let bestDelta = snapThresholdTicks;
  for (const candidate of candidates) {
    const delta = Math.abs(ticks - candidate);
    if (delta <= bestDelta) {
      bestDelta = delta;
      best = candidate;
    }
  }
  return best;
}

function ticksAtClientX(clientX: number): number {
  const rect = timelineContent.getBoundingClientRect();
  const seconds = Math.max(0, (clientX - rect.left - TRACK_GUTTER_WIDTH_PX) / pixelsPerSecond);
  const raw = Math.max(0, Math.min(secondsToTicks(seconds), Math.max(timelineTotalTicks - 1, 0)));
  return snapTimelineTicks(raw);
}

function showFloatingTooltip(clientX: number, clientY: number, text: string): void {
  scrubTooltip.hidden = false;
  scrubTooltip.style.left = `${clientX}px`;
  scrubTooltip.style.top = `${clientY}px`;
  scrubTooltip.textContent = text;
}

function hideFloatingTooltip(): void {
  scrubTooltip.hidden = true;
}

function beginTimelineScrub(event: PointerEvent): void {
  if (!timeline) return;
  const initialTicks = ticksAtClientX(event.clientX);
  showFloatingTooltip(event.clientX, event.clientY, formatRulerTime(ticksToSeconds(initialTicks)));
  const onMove = (moveEvent: PointerEvent) => {
    const ticks = ticksAtClientX(moveEvent.clientX);
    void seekToTimelineTicks(ticks);
    showFloatingTooltip(moveEvent.clientX, moveEvent.clientY, formatRulerTime(ticksToSeconds(ticks)));
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    hideFloatingTooltip();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  void seekToTimelineTicks(initialTicks);
}

timelineRuler.addEventListener("pointerdown", beginTimelineScrub);

const CLIP_DRAG_CLICK_THRESHOLD_PX = 3;

/**
 * Arrastra el cuerpo de un clip de vídeo para moverlo en el tiempo y,
 * si el cursor pasa a OTRA pista de vídeo, a esa pista (ampliación de
 * alcance pedida explícitamente el 2026-09-30 — antes un clip se quedaba
 * siempre en la pista en la que se creó). Mover dentro de la misma pista
 * es cambiar su `startTicks` (moveClipTo); a otra pista, moveClipToTrack,
 * que lo encaja en el hueco donde cae sin solapar a nadie — si no cabe
 * ahí, el clip se queda de momento en su pista original. Imán a los
 * bordes de los clips de la pista bajo el cursor (y al playhead).
 * Recalcula SIEMPRE desde `dragStartTimeline` (nunca acumula sobre el
 * `timeline` de la iteración anterior), igual que beginTrimDrag — evita
 * que el redondeo de cada paso se acumule. Un solo paso de historial al
 * soltar; un gesto sin apenas movimiento se trata como un simple click
 * de selección, no como un arrastre.
 */
function beginClipMoveDrag(event: PointerEvent, trackId: string, clipId: string): void {
  if (!timeline) return;
  event.preventDefault();
  event.stopPropagation();

  const dragStartTimeline = timeline;
  const maybeDragStartTrack = dragStartTimeline.tracks.find((t) => t.id === trackId);
  const maybeOriginalClip = maybeDragStartTrack?.clips.find((c) => c.id === clipId);
  if (!maybeDragStartTrack || !maybeOriginalClip) return;
  const originalClip = maybeOriginalClip;
  const startClientX = event.clientX;
  const startClientY = event.clientY;
  const snapThresholdTicks = Math.max(1, secondsToTicks(SNAP_PIXELS / pixelsPerSecond));
  const duration = clipDurationTicks(originalClip);
  let moved = false;
  // Pista en la que está el clip AHORA MISMO en `timeline` (y en el DOM).
  let currentTrackId = trackId;

  /** Pista de vídeo bajo el cursor (su carril principal o el de su audio pegado), o undefined. */
  function videoTrackIdAt(clientX: number, clientY: number): string | undefined {
    const lane = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".timeline-track-lane[data-track-id]");
    return lane?.dataset.trackId;
  }

  function onMove(moveEvent: PointerEvent): void {
    const dxPx = moveEvent.clientX - startClientX;
    const dyPx = moveEvent.clientY - startClientY;
    if (!moved && Math.abs(dxPx) <= CLIP_DRAG_CLICK_THRESHOLD_PX && Math.abs(dyPx) <= CLIP_DRAG_CLICK_THRESHOLD_PX) return; // podría ser solo un click
    moved = true;
    if (!timeline) return;

    const hoveredTrackId = videoTrackIdAt(moveEvent.clientX, moveEvent.clientY) ?? currentTrackId;
    const snapTrack = dragStartTimeline.tracks.find((t) => t.id === hoveredTrackId);

    let newStart = Math.max(0, originalClip.startTicks + secondsToTicks(dxPx / pixelsPerSecond));
    if (snappingEnabled && snapTrack) {
      const candidates = [
        playheadTicks,
        ...snapTrack.clips.filter((c) => c.id !== clipId).flatMap((c) => [c.startTicks, clipEndTicks(c)]),
      ];
      for (const candidate of candidates) {
        if (Math.abs(newStart - candidate) <= snapThresholdTicks) {
          newStart = candidate;
          break;
        }
        const endAligned = candidate - duration;
        if (endAligned >= 0 && Math.abs(newStart - endAligned) <= snapThresholdTicks) {
          newStart = endAligned;
          break;
        }
      }
    }

    let next: Timeline;
    let nextTrackId = hoveredTrackId;
    try {
      next = moveClipToTrack(dragStartTimeline, trackId, clipId, hoveredTrackId, newStart);
    } catch {
      // No cabe en la pista bajo el cursor (o no es una pista válida):
      // se queda en su pista original, moviéndose solo en el tiempo.
      next = moveClipTo(dragStartTimeline, trackId, clipId, newStart);
      nextTrackId = trackId;
    }
    timeline = next;

    const updated = timeline.tracks.find((t) => t.id === nextTrackId)?.clips.find((c) => c.id === clipId);
    if (nextTrackId !== currentTrackId) {
      // Cambiar de carril sí exige reconstruir las filas (el bloque del
      // clip y su celda de audio viven dentro del carril de su pista).
      currentTrackId = nextTrackId;
      selectedClip = { trackId: nextTrackId, clipId };
      renderTimelineTracks();
    } else if (updated) {
      syncClipLeftInDom(clipId, updated.startTicks);
    }
    if (updated) {
      showFloatingTooltip(moveEvent.clientX, moveEvent.clientY, formatRulerTime(ticksToSeconds(updated.startTicks)));
    }
  }

  function onUp(): void {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    hideFloatingTooltip();
    if (!moved || !timeline || timeline === dragStartTimeline) {
      selectClipRef(trackId, clipId);
      return;
    }
    pushHistory(snapshotWithTimeline(dragStartTimeline));
    // Durante el arrastre solo se movió el clip en el DOM
    // (syncClipLeftInDom), sin recalcular la duración total de la
    // timeline, la regla ni los anchos. Sin esto, `timelineTotalTicks`
    // se queda con el valor de ANTES de mover: si el clip se movió más
    // adelante, la reproducción cree que la timeline acaba antes de lo
    // que acaba y `advanceFrom` da "Reproducción terminada" al llegar
    // al clip — solo se oía el audio (ya programado) y el vídeo se
    // quedaba parado.
    refreshTimelineLayout();
    selectClipRef(currentTrackId, clipId);
    const updated = timeline.tracks.find((t) => t.id === currentTrackId)?.clips.find((c) => c.id === clipId);
    if (updated) void seekToTimelineTicks(updated.startTicks);
    status.textContent = currentTrackId === trackId ? "Clip movido." : "Clip movido a otra pista.";
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/**
 * Arrastra el cuerpo entero de una transición para alargarla/acortarla.
 * A diferencia de un clip real, una transición no tiene contenido
 * propio que reposicionar — lo único que tiene sentido ajustar
 * arrastrándola es su duración, así que aquí arrastrar SIEMPRE cambia
 * sourceOutTicks (nunca mueve nada, para eso está el clip vecino). Sin
 * el límite de duración de un archivo real que tiene beginTrimDrag
 * (ahí el tope es la duración de la fuente; una transición no tiene
 * fuente) — se puede alargar todo lo que haga falta, export/preview ya
 * recortan solos el fundido a lo que de sí den los clips vecinos si
 * son más cortos (ver transitionAudioCues).
 */
function beginTransitionResizeDrag(event: PointerEvent, trackId: string, clipId: string): void {
  if (!timeline) return;
  event.preventDefault();
  event.stopPropagation();

  const dragStartTimeline = timeline;
  const maybeDragStartTrack = dragStartTimeline.tracks.find((t) => t.id === trackId);
  const maybeOriginalClip = maybeDragStartTrack?.clips.find((c) => c.id === clipId);
  if (!maybeDragStartTrack || !maybeOriginalClip || maybeOriginalClip.kind !== "transition") return;
  const originalClip = maybeOriginalClip;
  const minDuration = frameDurationTicks(dragStartTimeline.outputFrameRate);
  const startClientX = event.clientX;
  let moved = false;

  function onMove(moveEvent: PointerEvent): void {
    const dx = moveEvent.clientX - startClientX;
    if (!moved && Math.abs(dx) <= CLIP_DRAG_CLICK_THRESHOLD_PX) return; // podría ser solo un click de selección
    moved = true;
    if (!timeline) return;
    const deltaTicks = secondsToTicks(dx / pixelsPerSecond);
    const appliedValue = Math.max(minDuration, originalClip.sourceOutTicks + deltaTicks);
    timeline = trimClipOut(dragStartTimeline, trackId, clipId, appliedValue, minDuration);
    const updated = timeline.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
    if (updated) syncClipWidthInDom(clipId, clipDurationTicks(updated));
    showFloatingTooltip(
      moveEvent.clientX,
      moveEvent.clientY,
      `Duración: ${formatRulerTime(ticksToSeconds(appliedValue))}`,
    );
  }

  function onUp(): void {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    hideFloatingTooltip();
    if (!moved) {
      selectClipRef(trackId, clipId);
      return;
    }
    if (timeline && timeline !== dragStartTimeline) {
      pushHistory(snapshotWithTimeline(dragStartTimeline));
      refreshTimelineLayout(); // recalcula duración total/regla tras cambiar la duración de la transición
      selectClipRef(trackId, clipId);
      status.textContent = "Duración de la transición actualizada.";
    }
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/**
 * Arrastra el borde izquierdo o derecho de un clip para recortarlo
 * directamente en la timeline, con imán al playhead y a los extremos
 * del archivo de origen. Solo se registra UN paso en el historial de
 * deshacer, al soltar — no uno por cada píxel arrastrado.
 */
function beginTrimDrag(event: PointerEvent, trackId: string, clipId: string, handle: "left" | "right"): void {
  if (!timeline) return;
  event.preventDefault();
  event.stopPropagation();

  const dragStartTimeline = timeline;
  const maybeDragStartTrack = dragStartTimeline.tracks.find((t) => t.id === trackId);
  const maybeOriginalClip = maybeDragStartTrack?.clips.find((c) => c.id === clipId);
  if (!maybeDragStartTrack || !maybeOriginalClip) return;
  const originalClip = maybeOriginalClip;
  const entry = sources.get(originalClip.sourceId);
  const sourceDurationTicks = entry?.sourceFile.durationTicks ?? originalClip.sourceOutTicks;
  const minDuration = frameDurationTicks(dragStartTimeline.outputFrameRate);
  const clipDuration = originalClip.sourceOutTicks - originalClip.sourceInTicks;
  const playheadSourceTicks =
    playheadTicks >= originalClip.startTicks && playheadTicks < originalClip.startTicks + clipDuration
      ? originalClip.sourceInTicks + (playheadTicks - originalClip.startTicks)
      : undefined;
  const startClientX = event.clientX;
  const snapThresholdTicks = Math.max(1, secondsToTicks(SNAP_PIXELS / pixelsPerSecond));
  // Capturado UNA vez al empezar el gesto (no se relee en cada
  // pointermove) para que soltar/pulsar Mayús a mitad de arrastre no
  // cambie de modo de golpe — pedido explícito del 2026-08-29: Mayús
  // activa el ripple (desplaza el resto de la pista para no dejar
  // hueco), sin tocar el comportamiento por defecto (sin ripple, ver
  // CLAUDE.md 2026-08-21).
  const ripple = event.shiftKey;

  function snap(value: number, candidates: number[]): number {
    if (!snappingEnabled) return value;
    for (const candidate of candidates) {
      if (Math.abs(value - candidate) <= snapThresholdTicks) return candidate;
    }
    return value;
  }

  function onMove(moveEvent: PointerEvent): void {
    const deltaTicks = secondsToTicks((moveEvent.clientX - startClientX) / pixelsPerSecond);
    let appliedValue: number;
    try {
      if (handle === "left") {
        const candidates = [0, ...(playheadSourceTicks !== undefined ? [playheadSourceTicks] : [])];
        const snapped = snap(originalClip.sourceInTicks + deltaTicks, candidates);
        appliedValue = Math.max(0, Math.min(snapped, originalClip.sourceOutTicks - minDuration));
        timeline = (ripple ? trimClipInRipple : trimClipIn)(dragStartTimeline, trackId, clipId, appliedValue, minDuration);
      } else {
        const candidates = [
          sourceDurationTicks,
          ...(playheadSourceTicks !== undefined ? [playheadSourceTicks] : []),
        ];
        const snapped = snap(originalClip.sourceOutTicks + deltaTicks, candidates);
        appliedValue = Math.min(sourceDurationTicks, Math.max(snapped, originalClip.sourceInTicks + minDuration));
        timeline = (ripple ? trimClipOutRipple : trimClipOut)(dragStartTimeline, trackId, clipId, appliedValue, minDuration);
      }
    } catch {
      return; // el ripple dejaría algún clip en negativo — se ignora este tick, se queda en el último válido
    }
    scheduleTimelineLayoutRefresh();
    if (selectedClip && selectedClip.trackId === trackId && selectedClip.clipId === clipId) {
      const updated = timeline.tracks.find((t) => t.id === trackId)!.clips.find((c) => c.id === clipId)!;
      trimInInput.value = String(ticksToSeconds(updated.sourceInTicks));
      trimOutInput.value = String(ticksToSeconds(updated.sourceOutTicks));
    }
    showFloatingTooltip(
      moveEvent.clientX,
      moveEvent.clientY,
      `${handle === "left" ? "Entrada" : "Salida"}: ${formatRulerTime(ticksToSeconds(appliedValue))}${ripple ? " (ripple)" : ""}`,
    );
  }

  function onUp(): void {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    hideFloatingTooltip();
    if (timeline && timeline !== dragStartTimeline) {
      pushHistory(snapshotWithTimeline(dragStartTimeline));
      refreshTimelineLayout(); // recalcula duración total/regla/anchos tras recortar (el scheduleTimelineLayoutRefresh del arrastre puede quedar pendiente)
      const updated = timeline.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
      if (updated) void seekToTimelineTicks(updated.startTicks);
      status.textContent = ripple ? "Recorte aplicado (ripple)." : "Recorte aplicado.";
    }
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function clipLabel(clip: Clip, entry: SourceEntry | undefined): string {
  if (clip.kind === "transition") {
    return clip.transitionType === "dipToBlack" ? "Transición: a negro" : "Transición: fundido";
  }
  return entry?.fileName ?? clip.sourceId;
}

const EFFECT_DND_MIME = "application/x-app-video-effect";

/**
 * Inserta una transición justo antes de `clip` (que debe ser
 * kind:"clip"), recortando su duración lo que haga falta para dejarle
 * sitio: se resta del FINAL de `clip` (trimClipOut) y la transición
 * ocupa exactamente ese tramo recién liberado — así nunca hace falta
 * desplazar ningún otro clip de la pista (ver CLAUDE.md, ampliación de
 * alcance del 2026-08-21: ya no hay ripple automático). Si el clip
 * vecino siguiente no llega exactamente hasta el final de la
 * transición, ese lado simplemente no funde con nada (mismo fallback
 * que si no hubiera vecino, ver neighborsOfTransition en
 * core/timeline.ts). Devuelve el id de la transición creada, o
 * undefined si no se pudo (con el status ya actualizado).
 */
function insertTransitionOnClip(
  trackId: string,
  clip: Clip,
  requestedDurationTicks: number,
  transitionType: TransitionType,
): string | undefined {
  if (!timeline || clip.kind !== "clip") return undefined;
  const minDuration = frameDurationTicks(timeline.outputFrameRate);
  const durationTicks = Math.min(requestedDurationTicks, clipDurationTicks(clip) - minDuration);
  if (durationTicks <= 0) {
    status.textContent = "El clip es demasiado corto para insertar esa transición.";
    return undefined;
  }
  const newOutTicks = clip.sourceOutTicks - durationTicks;
  const transitionStart = clip.startTicks + (newOutTicks - clip.sourceInTicks);
  const transitionId = `transition-${nextClipNumber++}`;
  let next = trimClipOut(timeline, trackId, clip.id, newOutTicks, minDuration);
  next = insertClip(next, trackId, createTransition(transitionId, transitionStart, durationTicks, transitionType));
  commitTimeline(next);
  refreshTimelineLayout();
  selectClipRef(trackId, transitionId);
  void seekToTimelineTicks(transitionStart);
  return transitionId;
}

/**
 * Se dispara al soltar un ítem del panel de efectos sobre un clip de
 * la línea de tiempo. Nunca se aplica a transiciones — no tienen
 * vídeo propio.
 */
function handleEffectDrop(event: DragEvent, trackId: string, clipId: string): void {
  const raw = event.dataTransfer?.getData(EFFECT_DND_MIME);
  if (!raw || !timeline) return;
  event.preventDefault();
  let payload: { kind: string; value: string };
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  const clip = timeline.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
  if (!clip) return;

  if (payload.kind === "transition") {
    if (clip.kind !== "clip") {
      status.textContent = "Suelta la transición sobre un clip de vídeo.";
      return;
    }
    const seconds = Number(transitionDurationInput.value);
    const durationTicks = secondsToTicks(Number.isFinite(seconds) && seconds > 0 ? seconds : 0.5);
    if (insertTransitionOnClip(trackId, clip, durationTicks, payload.value as TransitionType)) {
      status.textContent = "Transición insertada.";
    }
    return;
  }

  if (payload.kind === "colorFilter") {
    if (clip.kind !== "clip") {
      status.textContent = "Los filtros de color solo se pueden aplicar a clips de vídeo.";
      return;
    }
    commitTimeline(setClipColorFilter(timeline, trackId, clipId, payload.value as ColorFilterType));
    refreshTimelineLayout();
    selectClipRef(trackId, clipId);
    void seekToTimelineTicks(playheadTicks); // repinta el preview YA con el filtro nuevo, sin esperar al próximo scrub/play
    status.textContent = "Filtro de color aplicado.";
  }
}

/** Fila de clips de una pista de VÍDEO: miniatura, filtro de color, recorte, arrastrar para mover, transiciones. */
function renderVideoLaneClips(track: Track, lane: HTMLElement): void {
  lane.innerHTML = "";

  for (const clip of track.clips) {
    const entry = sources.get(clip.sourceId);
    const durationTicks = clipDurationTicks(clip);
    const isSelected = selectedClip?.trackId === track.id && selectedClip?.clipId === clip.id;

    const block = document.createElement("div");
    block.className =
      "timeline-clip" +
      (isSelected ? " selected" : "") +
      (clip.kind === "transition" ? " timeline-clip--transition" : "") +
      (clip.kind === "clip" && clip.videoHidden ? " timeline-clip--video-hidden" : "") +
      (clip.kind === "clip" && clip.flagged ? " timeline-clip--flagged" : "");
    block.dataset.clipId = clip.id;
    block.style.left = `${Math.round(ticksToSeconds(clip.startTicks) * pixelsPerSecond)}px`;
    block.style.width = `${Math.max(1, ticksToSeconds(durationTicks) * pixelsPerSecond)}px`;
    if (entry?.thumbnail) block.style.backgroundImage = `url(${entry.thumbnail})`;
    if (clip.kind === "clip") block.style.filter = colorFilterCss(clip.colorFilter);

    // Ver handleEffectDrop: soltar aquí un efecto arrastrado desde el
    // panel de la izquierda lo aplica a ESTE clip — nunca un botón de
    // "aplicar", a petición explícita del usuario.
    block.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types.includes(EFFECT_DND_MIME)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      block.classList.add("drop-target");
    });
    block.addEventListener("dragleave", () => block.classList.remove("drop-target"));
    block.addEventListener("drop", (event) => {
      block.classList.remove("drop-target");
      handleEffectDrop(event, track.id, clip.id);
    });

    const name = document.createElement("span");
    name.className = "clip-name";
    name.textContent = clipLabel(clip, entry);

    const duration = document.createElement("span");
    duration.className = "clip-duration";
    duration.textContent = `${ticksToSeconds(durationTicks).toFixed(2)}s`;

    block.append(name, duration);

    if (clip.kind === "transition") {
      // Una transición no tiene "contenido" que mover — arrastrar su
      // cuerpo entero alarga/acorta su duración directamente, sin
      // tener que acertarle a un borde de 8px. Ver beginTransitionResizeDrag.
      block.title = "Arrastra para alargar o acortar la transición";
      block.addEventListener("pointerdown", (event) => {
        beginTransitionResizeDrag(event, track.id, clip.id);
      });
    } else {
      const leftHandle = document.createElement("div");
      leftHandle.className = "trim-handle trim-handle-left";
      leftHandle.title = "Arrastra para recortar la entrada · Mayús+arrastra para ripple";
      leftHandle.addEventListener("pointerdown", (event) => beginTrimDrag(event, track.id, clip.id, "left"));

      const rightHandle = document.createElement("div");
      rightHandle.className = "trim-handle trim-handle-right";
      rightHandle.title = "Arrastra para recortar la salida · Mayús+arrastra para ripple";
      rightHandle.addEventListener("pointerdown", (event) => beginTrimDrag(event, track.id, clip.id, "right"));

      block.append(leftHandle, rightHandle);

      block.addEventListener("pointerdown", (event) => {
        const targetEl = event.target as HTMLElement;
        if (targetEl.closest(".trim-handle")) return;
        beginClipMoveDrag(event, track.id, clip.id);
      });
    }

    lane.appendChild(block);
  }
}

/**
 * Arrastra verticalmente dentro de la celda de audio de un clip para
 * cambiar su volumen (0-1) — sustituye al slider que antes vivía en el
 * panel lateral, a petición del usuario: el control vive en la propia
 * pista de audio de la línea de tiempo. Un solo paso de historial al
 * soltar, igual que beginTrimDrag.
 */
function beginVolumeDrag(event: PointerEvent, trackId: string, clipId: string, cell: HTMLElement): void {
  if (!timeline) return;
  event.preventDefault();
  event.stopPropagation();

  const dragStartTimeline = timeline;
  const clip = dragStartTimeline.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
  if (!clip) return;
  const wasMuted = clip.muted;
  // La celda no se mueve verticalmente durante el arrastre (apply() ya
  // no reconstruye nada, solo repinta su propia polilínea — ver
  // repaintVolumeVisuals — así que sigue siendo el mismo nodo todo el
  // gesto), así que un único rect capturado al empezar sigue siendo
  // válido durante todo el gesto.
  const cellRect = cell.getBoundingClientRect();

  function volumeFromClientY(clientY: number): number {
    const ratio = 1 - (clientY - cellRect.top) / cellRect.height;
    return Math.max(0, Math.min(1, ratio));
  }

  function apply(clientY: number, clientX: number): void {
    if (!timeline) return;
    const volume = volumeFromClientY(clientY);
    timeline = setClipAudio(timeline, trackId, clipId, volume, wasMuted);
    const updated = timeline.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
    if (updated) repaintVolumeVisuals(cell, trackId, updated);
    showFloatingTooltip(clientX, clientY, `Volumen: ${Math.round(volume * 100)}%`);
  }

  apply(event.clientY, event.clientX);

  function onMove(moveEvent: PointerEvent): void {
    apply(moveEvent.clientY, moveEvent.clientX);
  }

  function onUp(): void {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    hideFloatingTooltip();
    if (timeline && timeline !== dragStartTimeline) {
      pushHistory(snapshotWithTimeline(dragStartTimeline));
      status.textContent = "Volumen del clip actualizado.";
    }
    selectClipRef(trackId, clipId); // el propio gesto (clic o arrastre) selecciona el clip — ver renderAudioLaneClips
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Alt+arrastra dentro de la celda de audio para añadir un punto de
 * volumen ahí mismo y ajustar su altura sin soltar — "subir y bajar el
 * audio por trozos" pedido explícitamente, en vez de un único volumen
 * plano para todo el clip. Recalcula SIEMPRE `addVolumeKeyframe` desde
 * `dragStartTimeline` (nunca acumula), igual que el resto de arrastres
 * de esta pantalla — cada punto intermedio del gesto es "el clip
 * original + un punto nuevo en la posición actual del ratón", así que
 * no hace falta localizar el punto recién creado para seguir moviéndolo.
 */
function beginVolumeKeyframeCreateDrag(event: PointerEvent, trackId: string, clipId: string, cell: HTMLElement): void {
  if (!timeline) return;
  event.preventDefault();
  event.stopPropagation();

  const dragStartTimeline = timeline;
  const clip = dragStartTimeline.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
  if (!clip) return;
  const cellRect = cell.getBoundingClientRect();
  const clipDuration = clipDurationTicks(clip);

  function apply(clientX: number, clientY: number): void {
    if (!timeline) return;
    const offsetTicks = Math.round(((clientX - cellRect.left) / cellRect.width) * clipDuration);
    const volume = Math.max(0, Math.min(1, 1 - (clientY - cellRect.top) / cellRect.height));
    timeline = addVolumeKeyframe(dragStartTimeline, trackId, clipId, offsetTicks, volume);
    const updated = timeline.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
    if (updated) repaintVolumeVisuals(cell, trackId, updated);
    showFloatingTooltip(clientX, clientY, `${Math.round(volume * 100)}%`);
  }

  apply(event.clientX, event.clientY);

  function onMove(moveEvent: PointerEvent): void {
    apply(moveEvent.clientX, moveEvent.clientY);
  }

  function onUp(): void {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    hideFloatingTooltip();
    if (timeline && timeline !== dragStartTimeline) {
      pushHistory(snapshotWithTimeline(dragStartTimeline));
      status.textContent = "Punto de volumen añadido — arrástralo para ajustarlo, Alt+clic para quitarlo.";
    }
    selectClipRef(trackId, clipId); // el propio gesto selecciona el clip — ver renderAudioLaneClips
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/**
 * Arrastra un punto de volumen ya existente para reajustar su
 * instante/ganancia — mismo patrón "recalcula desde dragStartTimeline"
 * que el resto. Un simple click sin apenas movimiento no hace nada
 * (evita un paso de "deshacer" fantasma que no cambió nada visible).
 */
function beginVolumeKeyframeDrag(
  event: PointerEvent,
  trackId: string,
  clipId: string,
  keyframeIndex: number,
  cell: HTMLElement,
): void {
  if (!timeline) return;
  event.preventDefault();
  event.stopPropagation();

  const dragStartTimeline = timeline;
  const clip = dragStartTimeline.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
  if (!clip) return;
  const cellRect = cell.getBoundingClientRect();
  const clipDuration = clipDurationTicks(clip);
  const startClientX = event.clientX;
  const startClientY = event.clientY;
  let moved = false;

  function apply(clientX: number, clientY: number): void {
    if (!timeline) return;
    const offsetTicks = Math.round(((clientX - cellRect.left) / cellRect.width) * clipDuration);
    const volume = Math.max(0, Math.min(1, 1 - (clientY - cellRect.top) / cellRect.height));
    timeline = moveVolumeKeyframe(dragStartTimeline, trackId, clipId, keyframeIndex, offsetTicks, volume);
    const updated = timeline.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
    if (updated) repaintVolumeVisuals(cell, trackId, updated);
    showFloatingTooltip(clientX, clientY, `${Math.round(volume * 100)}%`);
  }

  function onMove(moveEvent: PointerEvent): void {
    if (!moved) {
      const dx = moveEvent.clientX - startClientX;
      const dy = moveEvent.clientY - startClientY;
      if (Math.abs(dx) <= CLIP_DRAG_CLICK_THRESHOLD_PX && Math.abs(dy) <= CLIP_DRAG_CLICK_THRESHOLD_PX) return;
      moved = true;
    }
    apply(moveEvent.clientX, moveEvent.clientY);
  }

  function onUp(): void {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    hideFloatingTooltip();
    if (timeline && timeline !== dragStartTimeline) {
      pushHistory(snapshotWithTimeline(dragStartTimeline));
      status.textContent = "Punto de volumen actualizado.";
    }
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/**
 * Fila de forma de onda de una pista (el audio pegado a los clips de
 * una pista de vídeo, o los clips propios de una pista de audio — la
 * misma función sirve para ambas, ver renderTimelineTracks). Sin
 * puntos de volumen, la celda entera es arrastrable arriba/abajo para
 * el volumen plano de siempre (beginVolumeDrag). Alt+clic (y arrastre)
 * añade un punto de volumen en ese instante — a partir de ahí el
 * volumen se dibuja como una polilínea entre puntos, cada uno
 * arrastrable por separado (beginVolumeKeyframeDrag), y Alt+clic sobre
 * un punto lo quita.
 */

/**
 * (Re)pinta SOLO la polilínea/puntos de volumen de la celda de audio
 * de un clip — la forma de onda (canvas) no depende del volumen, así
 * que no hace falta tocarla. Se usa tanto en el render inicial de la
 * celda (renderAudioLaneClips) como, síncrona y directamente (sin
 * pasar por refreshTimelineLayout), en cada punto de un arrastre de
 * volumen en curso (beginVolumeDrag/beginVolumeKeyframeCreateDrag/
 * beginVolumeKeyframeDrag) — mucho más barato que reconstruir toda la
 * timeline en cada fotograma solo para mover una polilínea. No
 * reengancha el propio `pointerdown` de `cell` (eso se hace una única
 * vez al crearla, leyendo el clip actual en cada evento — ver
 * renderAudioLaneClips).
 */
function repaintVolumeVisuals(cell: HTMLElement, trackId: string, clip: Clip): void {
  const clipDuration = clipDurationTicks(clip) || 1;
  const keyframes = clip.volumeKeyframes ?? [];
  const linePoints =
    keyframes.length > 0
      ? keyframes.map((k) => ({ x: (k.offsetTicks / clipDuration) * 100, y: (1 - k.volume) * 100 }))
      : [
          { x: 0, y: (1 - clip.volume) * 100 },
          { x: 100, y: (1 - clip.volume) * 100 },
        ];

  cell.querySelector(".volume-svg")?.remove();
  cell.querySelectorAll(".volume-point").forEach((el) => el.remove());
  cell.querySelector(".volume-label")?.remove();

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("volume-svg");
  const polyline = document.createElementNS(SVG_NS, "polyline");
  polyline.setAttribute("points", linePoints.map((p) => `${p.x},${p.y}`).join(" "));
  svg.appendChild(polyline);
  cell.appendChild(svg);

  keyframes.forEach((keyframe, keyframeIndex) => {
    const point = document.createElement("div");
    point.className = "volume-point";
    point.style.left = `${(keyframe.offsetTicks / clipDuration) * 100}%`;
    point.style.top = `${(1 - keyframe.volume) * 100}%`;
    point.title = `${Math.round(keyframe.volume * 100)}% — Alt+clic para quitar`;
    point.addEventListener("pointerdown", (event) => {
      if (event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        if (!timeline) return;
        commitTimeline(removeVolumeKeyframe(timeline, trackId, clip.id, keyframeIndex));
        refreshTimelineLayout();
        status.textContent = "Punto de volumen eliminado.";
        return;
      }
      beginVolumeKeyframeDrag(event, trackId, clip.id, keyframeIndex, cell);
    });
    cell.appendChild(point);
  });

  cell.classList.toggle("muted", clip.muted);
  if (keyframes.length === 0) {
    const volumeLabel = document.createElement("span");
    volumeLabel.className = "volume-label";
    volumeLabel.textContent = clip.muted ? "silenciado" : `${Math.round(clip.volume * 100)}%`;
    cell.appendChild(volumeLabel);
  }

  cell.title =
    keyframes.length > 0
      ? "Arrastra un punto para moverlo · Alt+clic para añadir/quitar puntos"
      : "Arrastra arriba/abajo para el volumen del clip · Alt+clic para subirlo/bajarlo por trozos";
}

function renderAudioLaneClips(track: Track, lane: HTMLElement): void {
  lane.innerHTML = "";

  for (const clip of track.clips) {
    if (clip.kind !== "clip") continue; // una transición no tiene audio propio que editar aquí
    const entry = sources.get(clip.sourceId);
    const durationTicks = clipDurationTicks(clip);
    const widthPx = Math.max(1, ticksToSeconds(durationTicks) * pixelsPerSecond);

    const isSelected = selectedClip?.trackId === track.id && selectedClip?.clipId === clip.id;
    const cell = document.createElement("div");
    cell.className = "timeline-audio-cell" + (isSelected ? " selected" : "");
    cell.dataset.clipId = clip.id;
    cell.style.left = `${Math.round(ticksToSeconds(clip.startTicks) * pixelsPerSecond)}px`;
    cell.style.width = `${widthPx}px`;

    const hasAudio = !!entry?.waveformPeaks && entry.waveformPeaks.length > 0;

    if (hasAudio) {
      const cellCanvas = document.createElement("canvas");
      cellCanvas.width = Math.round(widthPx);
      cellCanvas.height = 32;
      const cellCtx = cellCanvas.getContext("2d");
      if (cellCtx) {
        const sourceDurationTicks = entry!.sourceFile.durationTicks || 1;
        const sliceStart = clip.sourceInTicks / sourceDurationTicks;
        const sliceEnd = clip.sourceOutTicks / sourceDurationTicks;
        drawWaveformSlice(
          cellCtx,
          entry!.waveformPeaks!,
          sliceStart,
          sliceEnd,
          cellCanvas.width,
          cellCanvas.height,
          "#3f74d6",
        );
      }
      cell.appendChild(cellCanvas);

      cell.classList.add("has-volume");
      repaintVolumeVisuals(cell, track.id, clip);
    } else {
      cell.classList.add("no-audio");
      cell.title = "Este clip no tiene audio";
    }

    // Selecciona el clip (resalta la celda, habilita borrarlo con Supr —
    // ver el handler de "Delete" — sin ninguna cruz suelta en la
    // interfaz) al soltar tras un simple clic; si además hay arrastre de
    // volumen en curso, ese arrastre selecciona al soltar (ver
    // beginVolumeDrag/beginVolumeKeyframeCreateDrag) para no reconstruir
    // la celda a mitad de gesto. Lee el clip ACTUAL de `timeline` en vez
    // de cerrar sobre el `clip` de este render: este listener se queda
    // pegado a la celda durante arrastres sucesivos (repaintVolumeVisuals
    // no la reconstruye, solo repinta polilínea/puntos — ver su doc), así
    // que "¿ya tiene puntos de volumen?" tiene que responderse en el
    // momento del click, no con el estado de cuando se creó la celda.
    cell.addEventListener("pointerdown", (event) => {
      const targetEl = event.target as HTMLElement;
      if (targetEl.closest(".volume-point")) return; // gestionado por el propio punto
      const currentClip = timeline?.tracks.find((t) => t.id === track.id)?.clips.find((c) => c.id === clip.id);
      if (!currentClip) return;
      if (hasAudio && event.altKey) {
        beginVolumeKeyframeCreateDrag(event, track.id, currentClip.id, cell);
        return;
      }
      if (hasAudio && (currentClip.volumeKeyframes ?? []).length === 0) {
        beginVolumeDrag(event, track.id, currentClip.id, cell);
        return;
      }
      event.preventDefault();
      selectClipRef(track.id, currentClip.id);
    });

    lane.appendChild(cell);
  }
}

/** Nombre a mostrar en el gutter: el que haya puesto el usuario (Track.name), o si no "Vídeo N"/"Audio N" según su posición entre las de su mismo tipo. */
function trackDisplayName(track: Track, allTracks: Track[]): string {
  if (track.name) return track.name;
  const sameKind = allTracks.filter((t) => t.kind === track.kind);
  const position = sameKind.indexOf(track) + 1;
  return `${track.kind === "video" ? "Vídeo" : "Audio"} ${position}`;
}

/** Gutter (nombre editable, ojo/mute, subir/bajar capa, quitar) de la fila principal de una pista. */
function buildTrackGutter(track: Track, allTracks: Track[]): HTMLElement {
  const gutter = document.createElement("div");
  gutter.className = "timeline-track-gutter";

  // Editable directamente (sin botón de "renombrar" aparte, a petición
  // explícita del usuario del 2026-08-21): un input siempre visible que
  // parece una etiqueta hasta que se hace foco en él. Una cadena vacía
  // al confirmar quita el nombre personalizado (vuelve al automático).
  const name = document.createElement("input");
  name.type = "text";
  name.className = "track-name-input";
  name.value = trackDisplayName(track, allTracks);
  name.title = "Haz clic para renombrar la pista";
  name.addEventListener("pointerdown", (event) => event.stopPropagation());
  name.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      name.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      name.value = trackDisplayName(track, allTracks);
      name.blur();
    }
  });
  name.addEventListener("change", () => {
    if (!timeline) return;
    commitTimeline(renameTrack(timeline, track.id, name.value));
    refreshTimelineLayout();
  });

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "track-toggle" + (track.hidden ? " is-off" : "");
  toggle.innerHTML = iconMarkup(
    track.kind === "video" ? (track.hidden ? "eyeOff" : "eye") : track.hidden ? "volumeX" : "volume2",
  );
  toggle.title =
    track.kind === "video"
      ? track.hidden
        ? "Mostrar esta pista de vídeo"
        : "Ocultar esta pista de vídeo"
      : track.hidden
        ? "Reactivar el sonido de esta pista"
        : "Silenciar esta pista";
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!timeline) return;
    commitTimeline(setTrackHidden(timeline, track.id, !track.hidden));
    refreshTimelineLayout();
    void seekToTimelineTicks(playheadTicks);
  });

  gutter.append(name, toggle, buildTrackMenu(track));
  return gutter;
}

/** Cierra el menú "⋮" de pista actualmente abierto (si hay uno) — como mucho uno a la vez. */
let closeOpenTrackMenu: (() => void) | undefined;

/**
 * Botón "⋮" que agrupa subir/bajar de capa y eliminar pista — antes 3
 * botones sueltos siempre visibles en el gutter, consolidados en un
 * menú a petición explícita del 2026-08-29 (acciones poco frecuentes,
 * no necesitan un botón permanente cada una). El desplegable se añade
 * a `document.body` con posición `fixed` calculada desde el botón, en
 * vez de vivir dentro del gutter: `#timeline-scroll` tiene
 * `overflow-y: hidden` (para que el scroll sea solo horizontal, ver su
 * comentario), así que un desplegable posicionado dentro de esa fila
 * quedaría recortado en vez de flotar por encima — comprobado en vivo.
 */
function buildTrackMenu(track: Track): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "track-menu";

  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.innerHTML = iconMarkup("moreVertical");
  menuButton.title = "Más acciones de esta pista";

  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (closeOpenTrackMenu) {
      closeOpenTrackMenu();
      return; // un segundo clic sobre el mismo botón solo cierra
    }

    const dropdown = document.createElement("div");
    dropdown.className = "track-menu-dropdown";

    const up = document.createElement("button");
    up.type = "button";
    up.innerHTML = `${iconMarkup("chevronUp")}<span>Subir de capa</span>`;
    up.title = "Tapa a más pistas de vídeo";
    up.addEventListener("click", () => {
      closeOpenTrackMenu?.();
      if (!timeline) return;
      commitTimeline(moveTrack(timeline, track.id, "up"));
      refreshTimelineLayout();
    });

    const down = document.createElement("button");
    down.type = "button";
    down.innerHTML = `${iconMarkup("chevronDown")}<span>Bajar de capa</span>`;
    down.addEventListener("click", () => {
      closeOpenTrackMenu?.();
      if (!timeline) return;
      commitTimeline(moveTrack(timeline, track.id, "down"));
      refreshTimelineLayout();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.innerHTML = `${iconMarkup("trash")}<span>Eliminar pista</span>`;
    remove.addEventListener("click", () => {
      closeOpenTrackMenu?.();
      if (!timeline) return;
      stopPlayback();
      commitTimeline(removeTrack(timeline, track.id));
      if (selectedClip?.trackId === track.id) selectedClip = undefined;
      refreshTimelineLayout();
      void seekToTimelineTicks(playheadTicks);
    });

    dropdown.append(up, down, remove);

    // La fila de la pista suele estar cerca del borde inferior de la
    // ventana (la línea de tiempo vive abajo del todo) — si no cabe
    // por debajo del botón, se abre hacia arriba en su lugar.
    const buttonRect = menuButton.getBoundingClientRect();
    const estimatedHeight = 116;
    const opensUpward = buttonRect.bottom + estimatedHeight > window.innerHeight;
    dropdown.style.position = "fixed";
    if (opensUpward) {
      dropdown.style.bottom = `${Math.round(window.innerHeight - buttonRect.top + 2)}px`;
    } else {
      dropdown.style.top = `${Math.round(buttonRect.bottom + 2)}px`;
    }
    dropdown.style.right = `${Math.round(window.innerWidth - buttonRect.right)}px`;
    document.body.appendChild(dropdown);

    const closeOnOutsideClick = (outsideEvent: MouseEvent) => {
      if (dropdown.contains(outsideEvent.target as Node)) return;
      close();
    };
    function close(): void {
      dropdown.remove();
      window.removeEventListener("pointerdown", closeOnOutsideClick, true);
      closeOpenTrackMenu = undefined;
    }
    closeOpenTrackMenu = close;
    window.addEventListener("pointerdown", closeOnOutsideClick, true);
  });

  wrap.append(menuButton);
  return wrap;
}

/** Gutter de la fila secundaria (audio pegado) de una pista de vídeo — mismo ancho que el principal para que las columnas encajen, sin controles propios (el ojo/mute de arriba ya cubre esta franja). */
function buildTrackSubGutter(): HTMLElement {
  const gutter = document.createElement("div");
  gutter.className = "timeline-track-gutter timeline-track-gutter--sub";
  const label = document.createElement("span");
  label.className = "track-name";
  label.textContent = "↳ audio";
  gutter.appendChild(label);
  return gutter;
}

const DEFAULT_VIDEO_LANE_HEIGHT_PX = 64;
const DEFAULT_AUDIO_LANE_HEIGHT_PX = 36;
const MIN_LANE_HEIGHT_PX = 20;
const MIN_TIMELINE_SECTION_HEIGHT_PX = 160;
const MIN_MAIN_TOP_HEIGHT_PX = 160;

/**
 * Asa entre el preview/panel de arriba y toda la línea de tiempo de
 * abajo — sube o baja para darle más o menos espacio a la línea de
 * tiempo en conjunto (a diferencia de attachRowResizeHandle, que
 * cambia la altura de UNA fila) — pedido explícito del 2026-08-29.
 * Por defecto `.timeline-section` sigue sin altura propia (crece con
 * el contenido, como siempre); en cuanto se arrastra una vez pasa a
 * tener una altura fija en píxeles, y `#timeline-scroll` (overflow-y:
 * auto, ver styles.css) gana su propio scroll vertical si las pistas
 * ya no caben todas en ese hueco.
 */
function attachMainVerticalResizeHandle(): void {
  mainVerticalResizeHandle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = timelineSectionEl.getBoundingClientRect().height;
    mainVerticalResizeHandle.classList.add("dragging");

    function onMove(moveEvent: PointerEvent): void {
      const delta = startY - moveEvent.clientY; // arrastrar hacia arriba = más espacio para la timeline
      const maxHeight = Math.max(
        MIN_TIMELINE_SECTION_HEIGHT_PX,
        mainEl.clientHeight - MIN_MAIN_TOP_HEIGHT_PX - mainVerticalResizeHandle.clientHeight,
      );
      const next = Math.min(maxHeight, Math.max(MIN_TIMELINE_SECTION_HEIGHT_PX, Math.round(startHeight + delta)));
      timelineSectionEl.style.height = `${next}px`;
    }
    function onUp(): void {
      mainVerticalResizeHandle.classList.remove("dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

attachMainVerticalResizeHandle();

/**
 * Alturas de fila elegidas a mano, por fila — clave `trackId` para la
 * fila principal, `${trackId}:audio` para la de audio pegado de un
 * vídeo. Vive fuera de /core: es una preferencia de la UI de esta
 * sesión, no datos del proyecto (igual que pixelsPerSecond).
 */
const rowHeights = new Map<string, number>();

function laneHeightPx(rowKey: string, fallback: number): number {
  return rowHeights.get(rowKey) ?? fallback;
}

/**
 * Añade al pie del gutter de una fila un asa para cambiar su altura
 * libremente, cada fila por separado — "que cada una se pueda
 * modular en tamaño lo que se quiera", pedido explícitamente el
 * 2026-08-21 (sustituye al único tirador global de antes, que
 * afectaba a todas las pistas de vídeo por igual). Vive en el gutter,
 * no en el lane, para no interferir con arrastrar/seleccionar clips.
 */
function attachRowResizeHandle(gutter: HTMLElement, lane: HTMLElement, rowKey: string): void {
  const handle = document.createElement("div");
  handle.className = "row-resize-handle";
  handle.title = "Arrastra para cambiar la altura de esta pista";
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startHeight = lane.getBoundingClientRect().height;
    handle.classList.add("dragging");

    function onMove(moveEvent: PointerEvent): void {
      const next = Math.max(MIN_LANE_HEIGHT_PX, Math.round(startHeight + (moveEvent.clientY - startY)));
      rowHeights.set(rowKey, next);
      lane.style.height = `${next}px`;
    }
    function onUp(): void {
      handle.classList.remove("dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  gutter.appendChild(handle);
}

/**
 * Dibuja todas las pistas: una fila por pista de vídeo (más su fila de
 * audio pegado justo debajo) y una fila por pista de audio, en orden
 * de composición de arriba abajo (índice más alto de `timeline.tracks`
 * = capa más arriba, ver core/types.ts) — así el orden visual coincide
 * con qué tapa a qué. Ampliación de alcance multipista pedida
 * explícitamente el 2026-08-21, ver CLAUDE.md.
 */
function renderTimelineTracks(): void {
  timelineTracksContainer.innerHTML = "";
  if (!timeline) return;

  // Panel contextual: "Recorte del clip" solo ocupa sitio en el
  // lateral mientras hay un clip seleccionado — pedido explícito del
  // 2026-08-29 (antes se veía siempre, deshabilitado, sin selección).
  trimDetails.hidden = selectedClip === undefined;

  if (timeline.tracks.length === 0) {
    const hint = document.createElement("div");
    hint.className = "timeline-tracks-empty-hint";
    hint.textContent = "Añade una pista para empezar.";
    timelineTracksContainer.appendChild(hint);
    return;
  }

  const allTracks = timeline.tracks;
  for (let i = allTracks.length - 1; i >= 0; i--) {
    const track = allTracks[i]!;
    const group = document.createElement("div");
    group.className = "timeline-track-group";

    const mainRow = document.createElement("div");
    mainRow.className = "timeline-track-row";
    const mainGutter = buildTrackGutter(track, allTracks);
    const mainLane = document.createElement("div");
    mainLane.className = "timeline-track-lane " + (track.kind === "video" ? "timeline-track-lane--video" : "timeline-track-lane--audio");
    mainLane.style.height = `${laneHeightPx(track.id, track.kind === "video" ? DEFAULT_VIDEO_LANE_HEIGHT_PX : DEFAULT_AUDIO_LANE_HEIGHT_PX)}px`;
    if (track.kind === "video") {
      // Destino de "mover clip a otra pista" (ver beginClipMoveDrag).
      mainLane.dataset.trackId = track.id;
      renderVideoLaneClips(track, mainLane);
      mainLane.addEventListener("pointerdown", (event) => {
        if ((event.target as HTMLElement).closest(".timeline-clip")) return;
        beginTimelineScrub(event);
      });
    } else {
      renderAudioLaneClips(track, mainLane);
    }
    attachRowResizeHandle(mainGutter, mainLane, track.id);
    mainRow.append(mainGutter, mainLane);
    group.appendChild(mainRow);

    if (track.kind === "video") {
      const audioRowKey = `${track.id}:audio`;
      const audioRow = document.createElement("div");
      audioRow.className = "timeline-track-row timeline-track-row--sub";
      const subGutter = buildTrackSubGutter();
      const audioLane = document.createElement("div");
      audioLane.className = "timeline-track-lane timeline-track-lane--audio";
      audioLane.dataset.trackId = track.id; // soltar sobre el audio pegado cuenta como su pista de vídeo
      audioLane.style.height = `${laneHeightPx(audioRowKey, DEFAULT_AUDIO_LANE_HEIGHT_PX)}px`;
      renderAudioLaneClips(track, audioLane);
      attachRowResizeHandle(subGutter, audioLane, audioRowKey);
      audioRow.append(subGutter, audioLane);
      group.appendChild(audioRow);
    }

    timelineTracksContainer.appendChild(group);
  }

  deleteClipButton.disabled = selectedClip === undefined;
}

addVideoTrackButton.addEventListener("click", () => {
  if (!timeline) return;
  commitTimeline(addTrack(timeline, `video-${nextTrackNumber++}`, "video"));
  refreshTimelineLayout();
  status.textContent = "Pista de vídeo añadida.";
});

addAudioTrackButton.addEventListener("click", () => {
  if (!timeline) return;
  commitTimeline(addTrack(timeline, `audio-${nextTrackNumber++}`, "audio"));
  refreshTimelineLayout();
  status.textContent = "Pista de audio añadida.";
});

function selectClipRef(trackId: string, clipId: string): void {
  const clip = timeline?.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
  if (!clip) return;
  clearOverlaySelection(); // selección mutuamente excluyente con los overlays de texto
  selectedClip = { trackId, clipId };
  trimInInput.value = String(ticksToSeconds(clip.sourceInTicks));
  trimOutInput.value = String(ticksToSeconds(clip.sourceOutTicks));
  clipMutedInput.checked = clip.muted;
  clipVideoHiddenInput.checked = clip.videoHidden ?? false;
  clipColorFilterSelect.value = clip.colorFilter ?? "";
  syncGradePanel(clip);
  trimDetails.open = true; // al seleccionar un clip, se abre solo el compartimento donde se edita
  renderInspector();
  renderTimelineTracks();
}

/**
 * Muestra en el panel lateral solo lo relevante a la selección actual:
 * un clip (recorte / audio / color / croma), un texto, o —sin nada
 * seleccionado— los ajustes de proyecto (salida, máster, marcadores).
 * "Bin de medios" y "Exportar" son siempre visibles (no dependen de la
 * selección). Ver también syncTextEditorPanel, que delega aquí.
 */
function renderInspector(): void {
  const mode = selectedOverlayId !== undefined ? "text" : selectedClip ? "clip" : "project";
  trimDetails.hidden = mode !== "clip";
  textDetails.hidden = !(mode === "text" || (mode === "project" && textOverlays.length > 0));
  outputDetails.hidden = mode !== "project";
  masterAudioDetails.hidden = mode !== "project";
  markersDetails.hidden = mode !== "project";
  inspectorHint.hidden = mode !== "project" || !timeline;
  syncFlagButton();
}

/** Refleja clip.colorGrade/chromaKey (o los neutros si no tiene) en los campos del panel — llamar al seleccionar un clip. */
function syncGradePanel(clip: Clip): void {
  const grade = clip.colorGrade ?? NEUTRAL_COLOR_GRADE;
  gradeLiftRInput.value = String(grade.liftR);
  gradeLiftGInput.value = String(grade.liftG);
  gradeLiftBInput.value = String(grade.liftB);
  gradeGammaRInput.value = String(grade.gammaR);
  gradeGammaGInput.value = String(grade.gammaG);
  gradeGammaBInput.value = String(grade.gammaB);
  gradeGainRInput.value = String(grade.gainR);
  gradeGainGInput.value = String(grade.gainG);
  gradeGainBInput.value = String(grade.gainB);
  gradeSaturationInput.value = String(grade.saturation);
  gradeContrastInput.value = String(grade.contrast);
  gradeInvertInput.checked = grade.invert;

  const key = clip.chromaKey ?? NEUTRAL_CHROMA_KEY;
  chromaEnabledInput.checked = key.enabled;
  chromaColorInput.value = unitRgbToHex(key.keyR, key.keyG, key.keyB);
  chromaSimilarityInput.value = String(key.similarity);
  chromaSmoothnessInput.value = String(key.smoothness);
  refreshGradeOutputs();
}

/** Cada slider de grading/croma tiene un <output id="<id>-val"> al lado que muestra su valor — se refresca al sincronizar el panel y en cada `input`. */
const GRADE_SLIDER_IDS = [
  "grade-lift-r",
  "grade-lift-g",
  "grade-lift-b",
  "grade-gamma-r",
  "grade-gamma-g",
  "grade-gamma-b",
  "grade-gain-r",
  "grade-gain-g",
  "grade-gain-b",
  "grade-saturation",
  "grade-contrast",
  "chroma-similarity",
  "chroma-smoothness",
];

function refreshGradeOutputs(): void {
  for (const id of GRADE_SLIDER_IDS) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    const out = document.getElementById(`${id}-val`);
    if (input && out) out.textContent = Number(input.value).toFixed(2).replace(/\.?0+$/, "") || "0";
  }
}

/** Lee el grading de los campos del panel (sin tocar la timeline). Compartido por "Aplicar" y la previsualización en vivo. */
function readGradeFromForm(): ColorGrade {
  return {
    liftR: numberOr(gradeLiftRInput.value, 0),
    liftG: numberOr(gradeLiftGInput.value, 0),
    liftB: numberOr(gradeLiftBInput.value, 0),
    gammaR: numberOr(gradeGammaRInput.value, 1),
    gammaG: numberOr(gradeGammaGInput.value, 1),
    gammaB: numberOr(gradeGammaBInput.value, 1),
    gainR: numberOr(gradeGainRInput.value, 1),
    gainG: numberOr(gradeGainGInput.value, 1),
    gainB: numberOr(gradeGainBInput.value, 1),
    saturation: numberOr(gradeSaturationInput.value, 1),
    contrast: numberOr(gradeContrastInput.value, 1),
    invert: gradeInvertInput.checked,
  };
}

/** Lee el croma de los campos del panel (sin tocar la timeline). */
function readChromaFromForm(): ChromaKey {
  const [keyR, keyG, keyB] = hexToUnitRgb(chromaColorInput.value);
  return {
    enabled: chromaEnabledInput.checked,
    keyR,
    keyG,
    keyB,
    similarity: Math.max(0, Math.min(1, Number(chromaSimilarityInput.value) || 0)),
    smoothness: Math.max(0.001, Math.min(1, Number(chromaSmoothnessInput.value) || 0.001)),
  };
}

/**
 * Previsualización en vivo mientras se arrastra un slider de grading o
 * croma: pinta el fotograma actual con los valores del panel SIN
 * escribirlos en el clip (eso solo pasa al pulsar "Aplicar", ver
 * applyGradeSettings/applyChromaSettings). Al reproducir o cambiar de
 * clip, activeColorGrade/activeChromaKey se vuelven a poner desde el
 * valor guardado del clip, así que la previsualización se descarta sola
 * si no se aplica.
 */
const previewGradeLive = throttleToFrame(() => {
  if (!timeline || !selectedClip || activeSegment) return;
  activeColorGrade = readGradeFromForm();
  activeChromaKey = readChromaFromForm();
  void seekToTimelineTicks(playheadTicks);
});

for (const id of GRADE_SLIDER_IDS.concat(["grade-invert", "chroma-enabled", "chroma-color"])) {
  const el = document.getElementById(id);
  el?.addEventListener("input", () => {
    refreshGradeOutputs();
    previewGradeLive();
  });
}

function unitRgbToHex(r: number, g: number, b: number): string {
  const channel = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function hexToUnitRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** `Number(raw) || fallback` trataría un 0 tecleado a propósito (p.ej. gainR=0) como inválido y lo sustituiría por el neutro — este helper solo cae al fallback con NaN de verdad. */
function numberOr(raw: string, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function applyGradeSettings(): void {
  const found = findClipRef(selectedClip);
  if (!timeline || !found) return;
  commitTimeline(setClipColorGrade(timeline, found.track.id, found.clip.id, readGradeFromForm()));
  void seekToTimelineTicks(playheadTicks);
  status.textContent = "Grading aplicado.";
}

function resetGradeSettings(): void {
  const found = findClipRef(selectedClip);
  if (!timeline || !found) return;
  commitTimeline(setClipColorGrade(timeline, found.track.id, found.clip.id, undefined));
  syncGradePanel(requireTimeline().tracks.find((t) => t.id === found.track.id)!.clips.find((c) => c.id === found.clip.id)!);
  void seekToTimelineTicks(playheadTicks);
  status.textContent = "Grading restablecido.";
}

function applyChromaSettings(): void {
  const found = findClipRef(selectedClip);
  if (!timeline || !found) return;
  commitTimeline(setClipChromaKey(timeline, found.track.id, found.clip.id, readChromaFromForm()));
  void seekToTimelineTicks(playheadTicks);
  status.textContent = "Croma aplicado — se compone sobre la pista de abajo solo al exportar.";
}

applyGradeButton.addEventListener("click", applyGradeSettings);
resetGradeButton.addEventListener("click", resetGradeSettings);
applyChromaButton.addEventListener("click", applyChromaSettings);

function removeClipRef(trackId: string, clipId: string): void {
  if (!timeline) return;
  stopPlayback();
  commitTimeline(removeClip(timeline, trackId, clipId));
  if (selectedClip && selectedClip.trackId === trackId && selectedClip.clipId === clipId) {
    selectedClip = undefined;
  }
  refreshTimelineLayout();
  void seekToTimelineTicks(playheadTicks);
}

/** Nombre mostrado junto al título en la cabecera (archivo de proyecto o del primer vídeo). Cadena vacía = se oculta. */
function setProjectName(name: string): void {
  projectNameLabel.textContent = name;
  projectNameLabel.hidden = name.length === 0;
}

function enableEditingControls(): void {
  trimControls.disabled = false;
  outputControls.disabled = false;
  playButton.disabled = false;
  splitButton.disabled = false;
  exportButton.disabled = false;
  saveProjectButton.disabled = false;
  zoomInButton.disabled = false;
  zoomOutButton.disabled = false;
  zoomFitButton.disabled = false;
  addMarkerButton.disabled = false;
  addTextButton.disabled = false;
  previewZoomButton.disabled = false;
  insertTransitionButton.disabled = false;
  selectClipButton.disabled = false;
  snapToggleButton.disabled = false;
  flagClipButton.disabled = false;
  addVideoTrackButton.disabled = false;
  addAudioTrackButton.disabled = false;
  masterAudioControls.disabled = false;
  dropZone.hidden = true; // ya hay proyecto — la zona de "suelta tu vídeo aquí" solo tiene sentido en vacío
}

/** Refleja timeline.masterAudio (o el neutro si no hay ninguno configurado) en los campos del panel — llamar tras crear/cargar un proyecto. */
function syncMasterAudioPanel(): void {
  const master = timeline?.masterAudio ?? NEUTRAL_MASTER_AUDIO;
  masterAudioEnabledInput.checked = master.enabled;
  masterEqLowInput.value = String(master.eqLowDb);
  masterEqMidInput.value = String(master.eqMidDb);
  masterEqHighInput.value = String(master.eqHighDb);
  masterCompressionAmountInput.value = String(master.compressionAmount);
  masterMakeupGainInput.value = String(master.makeupGainDb);
}

/** Lee los campos del panel y los aplica a timeline.masterAudio — botón "Aplicar máster de audio", mismo patrón que applyOutputSettings. */
function applyMasterAudioSettings(): void {
  if (!timeline) return;
  const master: MasterAudio = {
    enabled: masterAudioEnabledInput.checked,
    eqLowDb: Number(masterEqLowInput.value) || 0,
    eqMidDb: Number(masterEqMidInput.value) || 0,
    eqHighDb: Number(masterEqHighInput.value) || 0,
    compressionAmount: Math.max(0, Math.min(100, Number(masterCompressionAmountInput.value) || 0)),
    makeupGainDb: Number(masterMakeupGainInput.value) || 0,
  };
  commitTimeline(setMasterAudio(timeline, master));
  status.textContent = "Máster de audio actualizado.";
}

applyMasterAudioButton.addEventListener("click", applyMasterAudioSettings);

/** Selecciona el clip de vídeo que se ve bajo el playhead ahora mismo (la pista de vídeo más arriba que tenga contenido ahí) — icono "seleccionar" de la caja de herramientas junto a la línea de tiempo. */
function selectClipAtPlayhead(): void {
  if (!timeline) return;
  const position = resolveActiveVideoPosition(timeline, playheadTicks);
  if (!position) {
    status.textContent = "No hay ningún clip en el playhead.";
    return;
  }
  selectClipRef(position.trackId, position.clip.id);
  status.textContent = "Clip seleccionado.";
}

selectClipButton.addEventListener("click", selectClipAtPlayhead);

// --- Imán (N) y bandera de clip (G): botones de una tecla de la barra de la timeline ---

/** Refleja el estado del imán en el botón N. */
function syncSnapButton(): void {
  snapToggleButton.classList.toggle("is-active", snappingEnabled);
  snapToggleButton.setAttribute("aria-pressed", String(snappingEnabled));
}

function toggleSnapping(): void {
  snappingEnabled = !snappingEnabled;
  syncSnapButton();
  status.textContent = snappingEnabled ? "Imán activado." : "Imán desactivado.";
}

/** Refleja en el botón G si el clip seleccionado lleva bandera. */
function syncFlagButton(): void {
  const found = findClipRef(selectedClip);
  flagClipButton.classList.toggle("is-active", !!found?.clip.flagged);
}

function toggleFlagOnSelectedClip(): void {
  const found = findClipRef(selectedClip);
  if (!timeline || !found) {
    status.textContent = "Selecciona un clip para marcarlo con una bandera.";
    return;
  }
  commitTimeline(setClipFlagged(timeline, found.track.id, found.clip.id, !found.clip.flagged));
  refreshTimelineLayout();
  syncFlagButton();
  status.textContent = found.clip.flagged ? "Bandera quitada." : "Clip marcado con bandera.";
}

snapToggleButton.addEventListener("click", toggleSnapping);
flagClipButton.addEventListener("click", toggleFlagOnSelectedClip);
syncSnapButton();

// --- Volumen de monitor (barra deslizante de la timeline) ---
masterVolumeInput.addEventListener("input", () => {
  // Rampa corta para que no "chasquee" al mover el deslizador.
  monitorGain.gain.setTargetAtTime(Number(masterVolumeInput.value), audioContext.currentTime, 0.02);
});

/**
 * Ruta absoluta real de `file`, si estamos dentro de Electron (ver
 * ui/electronBridge.ts) Y `file` viene de un selector/arrastre real del
 * SO — getPathForFile no funciona sobre un File sintético como los que
 * crea readFileFromPath al releer por ruta, así que solo se llama con
 * archivos recién elegidos por el usuario (nunca con uno ya reconstruido
 * desde un `filePath` guardado). undefined en cualquier otro caso,
 * incluida cualquier excepción de la API de Electron.
 */
function getFilePathIfAvailable(file: File): string | undefined {
  try {
    return getAppVideoBridge()?.getPathForFile(file);
  } catch (error) {
    console.warn("No se pudo obtener la ruta absoluta del archivo:", error);
    return undefined;
  }
}

/** Decodifica el audio de un archivo (si tiene) y precalcula los picos de su forma de onda. undefined en ambos si no hay audio decodificable. */
async function loadAudioForSource(
  file: File,
): Promise<{ audio?: AudioBuffer; waveformPeaks?: Float32Array }> {
  const audio = await decodeAudioAsset(file, audioContext).catch((error: unknown) => {
    console.warn("No se pudo decodificar el audio del clip:", error);
    return undefined;
  });
  if (!audio) return {};
  return { audio, waveformPeaks: computeWaveformPeaks(audio, WAVEFORM_BUCKET_COUNT) };
}

/** La pista de vídeo donde debe caer un clip recién añadido: la de más arriba (capa más externa) que ya exista. undefined si aún no hay ninguna. */
function topmostVideoTrackId(tl: Timeline): string | undefined {
  for (let i = tl.tracks.length - 1; i >= 0; i--) {
    if (tl.tracks[i]!.kind === "video") return tl.tracks[i]!.id;
  }
  return undefined;
}

async function addClipFromFile(file: File): Promise<void> {
  status.textContent = `Cargando ${file.name}...`;
  try {
    const { videoTrack, samples } = await decodeAllSamples(file);
    const firstSample = samples[0];
    if (!firstSample) {
      throw new Error("El archivo no tiene ningún fotograma de vídeo");
    }
    // Falla pronto y con un mensaje claro si el códec no es compatible
    // (solo H.264/H.265, ver media/description.ts), en vez de añadir un
    // clip que luego fallará en silencio al reproducirlo o exportarlo.
    getDecoderDescription(firstSample);
    const demuxed = { videoTrack, samples };
    const sourceId = `source-${nextSourceNumber++}`;
    const sourceFile = toSourceFile(sourceId, videoTrack, samples);
    const thumbnail = await generateThumbnail(demuxed).catch((error: unknown) => {
      console.warn("No se pudo generar la miniatura del clip:", error);
      return undefined;
    });
    const { audio, waveformPeaks } = await loadAudioForSource(file);
    const filePath = getFilePathIfAvailable(file);
    sources.set(sourceId, {
      sourceFile,
      demuxed,
      fileName: file.name,
      ...(filePath ? { filePath } : {}),
      ...(thumbnail ? { thumbnail } : {}),
      ...(audio ? { audio } : {}),
      ...(waveformPeaks ? { waveformPeaks } : {}),
    });

    const clip: Clip = {
      id: `clip-${nextClipNumber++}`,
      kind: "clip",
      sourceId,
      startTicks: 0,
      sourceInTicks: 0,
      sourceOutTicks: sourceFile.durationTicks,
      volume: 1,
      muted: false,
    };

    if (!timeline) {
      // El primer clip de todos define la resolución/frame rate de
      // salida del proyecto (siempre de vídeo, ver toSourceFile).
      commitTimeline({
        tracks: [{ id: `video-${nextTrackNumber++}`, kind: "video", hidden: false, clips: [clip] }],
        outputResolution: { width: sourceFile.width!, height: sourceFile.height! },
        outputFrameRate: sourceFile.frameRate!,
      });
      canvas.width = sourceFile.width!;
      canvas.height = sourceFile.height!;
      outputWidthInput.value = String(sourceFile.width);
      outputHeightInput.value = String(sourceFile.height);
      outputFpsInput.value = String(sourceFile.frameRate!.numerator / sourceFile.frameRate!.denominator);
    } else {
      let base = timeline;
      let trackId = topmostVideoTrackId(base);
      if (!trackId) {
        trackId = `video-${nextTrackNumber++}`;
        base = addTrack(base, trackId, "video");
      }
      commitTimeline(appendClip(base, trackId, clip));
    }

    // `commitTimeline` reasigna `timeline` por efecto secundario, algo
    // que TS no rastrea a través de la llamada — requireTimeline() da
    // una referencia ya no-nulable para el resto de la función.
    const currentTimeline = requireTimeline();
    const newTrackId = topmostVideoTrackId(currentTimeline)!;
    if (!hasAutoFitted) {
      hasAutoFitted = true;
      zoomToFit();
    } else {
      refreshTimelineLayout();
    }
    enableEditingControls();
    syncMasterAudioPanel();
    if (projectNameLabel.hidden) setProjectName(file.name);

    selectClipRef(newTrackId, clip.id);
    const placed = currentTimeline.tracks.find((t) => t.id === newTrackId)!.clips.find((c) => c.id === clip.id)!;
    await seekToTimelineTicks(placed.startTicks);
    status.textContent = `${file.name} añadido — ${sourceFile.width}x${sourceFile.height} @ ${sourceFile.frameRate!.numerator}/${sourceFile.frameRate!.denominator} fps${audio ? " · con audio" : " · sin audio"}.`;
    renderMediaBin();
  } catch (error) {
    console.error(error);
    status.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) return;
  void addClipFromFile(file);
});

/**
 * Bin de medios — pedido explícito del 2026-08-29: antes, reutilizar un
 * archivo ya cargado para un segundo clip exigía volver a elegirlo con
 * el selector de archivos (cada carga por `addClipFromFile` crea una
 * `sourceId` nueva). Lista `sources` con miniatura y añade un clip de
 * la fuente elegida al FINAL de la pista de vídeo más arriba, igual que
 * el resto del código (`topmostVideoTrackId`/`appendClip`).
 */
function renderMediaBin(): void {
  mediaBinDetails.hidden = sources.size === 0;
  mediaBinList.innerHTML = "";
  for (const [sourceId, entry] of sources) {
    const li = document.createElement("li");
    li.className = "media-bin-item";

    const thumb = document.createElement("div");
    thumb.className = "media-bin-thumb";
    if (entry.thumbnail) thumb.style.backgroundImage = `url(${entry.thumbnail})`;

    const info = document.createElement("div");
    info.className = "media-bin-info";
    const name = document.createElement("span");
    name.className = "media-bin-name";
    name.textContent = entry.fileName;
    name.title = entry.fileName;
    const meta = document.createElement("span");
    meta.className = "media-bin-meta";
    meta.textContent = `${ticksToSeconds(entry.sourceFile.durationTicks).toFixed(1)}s${entry.sourceFile.width ? ` · ${entry.sourceFile.width}x${entry.sourceFile.height}` : ""}`;
    info.append(name, meta);

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "media-bin-add";
    addButton.innerHTML = iconMarkup("plus");
    addButton.title = "Añadir otro clip de este archivo al final de la pista de vídeo superior";
    addButton.addEventListener("click", () => addClipFromSource(sourceId));

    li.append(thumb, info, addButton);
    mediaBinList.appendChild(li);
  }
}

function addClipFromSource(sourceId: string): void {
  if (!timeline) return;
  const entry = sources.get(sourceId);
  if (!entry) return;

  const clip: Clip = {
    id: `clip-${nextClipNumber++}`,
    kind: "clip",
    sourceId,
    startTicks: 0, // appendClip lo recoloca al final real de la pista
    sourceInTicks: 0,
    sourceOutTicks: entry.sourceFile.durationTicks,
    volume: 1,
    muted: false,
  };

  let base = timeline;
  let trackId = topmostVideoTrackId(base);
  if (!trackId) {
    trackId = `video-${nextTrackNumber++}`;
    base = addTrack(base, trackId, "video");
  }
  commitTimeline(appendClip(base, trackId, clip));
  refreshTimelineLayout();
  selectClipRef(trackId, clip.id);
  const placed = requireTimeline()
    .tracks.find((t) => t.id === trackId)!
    .clips.find((c) => c.id === clip.id)!;
  void seekToTimelineTicks(placed.startTicks);
  status.textContent = `${entry.fileName} añadido de nuevo a la timeline.`;
}

/** Arrastrar un archivo del SO (no confundir con el arrastre interno de efectos, que usa un MIME propio — ver EFFECT_DND_MIME). */
function isFileDrag(event: DragEvent): boolean {
  return !!event.dataTransfer?.types.includes("Files");
}

// Sin esto, soltar el archivo fuera de la zona (o el navegador
// interpretando el drop antes de que llegue a #drop-zone) hace que
// Chrome navegue a él como si fuera una URL — una pantalla en blanco
// muy confusa la primera vez que se prueba arrastrar-y-soltar.
window.addEventListener("dragover", (event) => {
  if (isFileDrag(event)) event.preventDefault();
});
window.addEventListener("drop", (event) => {
  if (isFileDrag(event)) event.preventDefault();
});

dropZone.addEventListener("dragover", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = event.dataTransfer?.files[0];
  if (file) void addClipFromFile(file);
});

applyTrimButton.addEventListener("click", () => {
  const found = findClipRef(selectedClip);
  if (!timeline || !found) {
    status.textContent = "Selecciona un clip de la línea de tiempo primero.";
    return;
  }
  const { track, clip } = found;
  const maxOutTicks = sources.get(clip.sourceId)?.sourceFile.durationTicks ?? Number.POSITIVE_INFINITY;
  const minDuration = frameDurationTicks(timeline.outputFrameRate);
  const inTicks = Math.max(0, secondsToTicks(Number(trimInInput.value)));
  const outTicks = Math.min(secondsToTicks(Number(trimOutInput.value)), maxOutTicks);
  let next: Timeline;
  try {
    next = trimClipOut(timeline, track.id, clip.id, outTicks, minDuration);
    next = trimClipIn(next, track.id, clip.id, inTicks, minDuration);
  } catch (error) {
    status.textContent = `Error de recorte: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  commitTimeline(next);
  refreshTimelineLayout();
  void seekToTimelineTicks(clip.startTicks);
  status.textContent = "Recorte aplicado.";
});

function applyClipMuted(): void {
  const found = findClipRef(selectedClip);
  if (!timeline || !found) return;
  const muted = clipMutedInput.checked;
  commitTimeline(setClipAudio(timeline, found.track.id, found.clip.id, found.clip.volume, muted));
  refreshTimelineLayout();
  status.textContent = muted ? "Clip silenciado." : "Clip audible de nuevo.";
}

clipMutedInput.addEventListener("change", applyClipMuted);

/** Opuesto de applyClipMuted, pero para el vídeo — ver doc de Clip.videoHidden en core/types.ts. */
function applyClipVideoHidden(): void {
  const found = findClipRef(selectedClip);
  if (!timeline || !found) return;
  const videoHidden = clipVideoHiddenInput.checked;
  commitTimeline(setClipVideoHidden(timeline, found.track.id, found.clip.id, videoHidden));
  refreshTimelineLayout();
  void seekToTimelineTicks(playheadTicks); // repinta el preview YA (puede pasar a verse la pista de abajo, o negro)
  status.textContent = videoHidden ? "Vídeo ocultado (solo audio)." : "Vídeo visible de nuevo.";
}

clipVideoHiddenInput.addEventListener("change", applyClipVideoHidden);

function applyClipColorFilter(): void {
  const found = findClipRef(selectedClip);
  if (!timeline || !found) return;
  const value = clipColorFilterSelect.value;
  commitTimeline(setClipColorFilter(timeline, found.track.id, found.clip.id, value ? (value as ColorFilterType) : undefined));
  refreshTimelineLayout();
  void seekToTimelineTicks(playheadTicks);
  status.textContent = value ? "Filtro de color aplicado." : "Filtro de color quitado.";
}

clipColorFilterSelect.addEventListener("change", applyClipColorFilter);

function applyOutputSettings(): void {
  if (!timeline) return;
  const width = Math.round(Number(outputWidthInput.value));
  const height = Math.round(Number(outputHeightInput.value));
  const fps = Number(outputFpsInput.value);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    status.textContent = "Resolución de salida inválida.";
    return;
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    status.textContent = "Fotogramas/s de salida inválidos.";
    return;
  }
  commitTimeline({
    ...timeline,
    outputResolution: { width, height },
    outputFrameRate: { numerator: Math.round(fps * 1000), denominator: 1000 },
  });
  canvas.width = width;
  canvas.height = height;
  refreshTimelineLayout();
  void seekToTimelineTicks(playheadTicks);
  status.textContent = "Configuración de salida aplicada.";
}

applyOutputButton.addEventListener("click", applyOutputSettings);

splitButton.addEventListener("click", splitAtPlayhead);
deleteClipButton.addEventListener("click", () => {
  if (selectedClip) removeClipRef(selectedClip.trackId, selectedClip.clipId);
});

insertTransitionButton.addEventListener("click", () => {
  const found = findClipRef(selectedClip);
  if (!found || found.clip.kind !== "clip") {
    status.textContent = "Selecciona un clip de vídeo (no una transición) para insertar la transición después de él.";
    return;
  }
  const seconds = Number(transitionDurationInput.value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    status.textContent = "Duración de transición inválida.";
    return;
  }
  const transitionType = transitionTypeSelect.value as TransitionType;
  if (insertTransitionOnClip(found.track.id, found.clip, secondsToTicks(seconds), transitionType)) {
    status.textContent = "Transición insertada después del clip seleccionado.";
  }
});

// Panel de efectos (izquierda): cada "carpeta" es estática en el HTML,
// solo hace falta cablear el origen del arrastre una vez — el destino
// (cada clip de la línea de tiempo) se cablea en renderVideoLaneClips(),
// ya que esos elementos se recrean en cada repintado.
document.querySelectorAll<HTMLElement>(".effect-chip").forEach((chip) => {
  chip.addEventListener("dragstart", (event) => {
    const kind = chip.dataset.effectKind;
    const value = chip.dataset.effectValue;
    if (!kind || !value || !event.dataTransfer) return;
    event.dataTransfer.setData(EFFECT_DND_MIME, JSON.stringify({ kind, value }));
    event.dataTransfer.effectAllowed = "copy";
  });
});

playButton.addEventListener("click", playFromPlayhead);
pauseButton.addEventListener("click", stopPlayback);

previewZoomButton.addEventListener("click", () => {
  previewZoomed100 = !previewZoomed100;
  previewWrap.classList.toggle("zoomed-100", previewZoomed100);
  previewZoomLabel.textContent = previewZoomed100 ? "100%" : "Ajustado";
});

window.addEventListener("resize", () => refreshTimelineLayout());

// --- Modal de atajos de teclado (antes sección fija del panel lateral) ---

helpButton.addEventListener("click", () => shortcutsModal.showModal());
closeShortcutsModalButton.addEventListener("click", () => shortcutsModal.close());
shortcutsModal.addEventListener("click", (event) => {
  if (event.target === shortcutsModal) shortcutsModal.close(); // clic en el backdrop
});

// --- Arrastrar/rotar overlays de texto directamente sobre el preview ---

/** Convierte coordenadas de pantalla a coordenadas de píxel del canvas (que puede estar escalado por CSS). */
function canvasPointFromEvent(event: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY };
}

/** Ancho aproximado del texto ya renderizado, para el hit-test de arrastre — mismo font que drawTextOverlay. */
function measureOverlayWidth(overlay: TextOverlay): number {
  ctx.font = `bold ${overlay.fontSizePx}px ${overlay.fontFamily}`;
  return ctx.measureText(overlay.text).width;
}

/** El overlay activo (visible ahora mismo) que hay bajo `point`, si lo hay — el último dibujado (más "encima") gana. Tiene en cuenta la rotación (deshace el giro sobre el punto antes de comparar contra el recuadro). */
function hitTestOverlay(point: { x: number; y: number }): TextOverlay | undefined {
  const active = activeTextOverlaysAt(textOverlays, playheadTicks);
  for (let i = active.length - 1; i >= 0; i--) {
    const overlay = active[i]!;
    const cx = (overlay.xPercent / 100) * canvas.width;
    const cy = (overlay.yPercent / 100) * canvas.height;
    const width = measureOverlayWidth(overlay);
    const height = overlay.fontSizePx * 1.3;
    const rad = (-overlay.rotationDeg * Math.PI) / 180;
    const dx = point.x - cx;
    const dy = point.y - cy;
    const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
    const localY = dx * Math.sin(rad) + dy * Math.cos(rad);
    if (localX >= -width / 2 && localX <= width / 2 && localY >= -height / 2 && localY <= height / 2) {
      return overlay;
    }
  }
  return undefined;
}

/** Distancia del centro del texto al asa de rotación, en píxeles del canvas — un poco más lejos cuanto más grande sea la letra. */
function rotateHandleArmPx(overlay: TextOverlay): number {
  return overlay.fontSizePx / 2 + 28;
}

/** Posición del asa de rotación (ya rotada con el texto), en píxeles del canvas. */
function rotateHandlePosition(overlay: TextOverlay): { x: number; y: number } {
  const cx = (overlay.xPercent / 100) * canvas.width;
  const cy = (overlay.yPercent / 100) * canvas.height;
  const rad = (overlay.rotationDeg * Math.PI) / 180;
  const arm = rotateHandleArmPx(overlay);
  return { x: cx + arm * Math.sin(rad), y: cy - arm * Math.cos(rad) };
}

/** Recuadro de selección (punteado, rotado con el texto) + asa de rotación arriba, para el overlay seleccionado. Solo se llama desde ui/main.ts — nunca desde /media, para que esto no se cuele en el vídeo exportado. */
function drawTextSelectionUI(overlay: TextOverlay): void {
  const cx = (overlay.xPercent / 100) * canvas.width;
  const cy = (overlay.yPercent / 100) * canvas.height;
  const width = measureOverlayWidth(overlay);
  const height = overlay.fontSizePx * 1.3;
  const rad = (overlay.rotationDeg * Math.PI) / 180;
  const arm = rotateHandleArmPx(overlay);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rad);
  ctx.strokeStyle = "#4f8cff";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(-width / 2 - 6, -height / 2 - 4, width + 12, height + 8);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(0, -height / 2 - 4);
  ctx.lineTo(0, -arm);
  ctx.stroke();
  ctx.restore();

  const handle = rotateHandlePosition(overlay);
  ctx.beginPath();
  ctx.fillStyle = "#4f8cff";
  ctx.strokeStyle = "#1b1d23";
  ctx.lineWidth = 1;
  ctx.arc(handle.x, handle.y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

/** Dibuja los overlays de texto activos en `ticks` y, si el seleccionado está entre ellos, su UI de selección/rotación encima. Único punto de entrada desde el resto de ui/main.ts — sustituye a llamar activeTextOverlaysAt+drawTextOverlays sueltos en cada sitio que redibuja el preview. */
function drawActiveTextOverlays(ticks: number): void {
  const active = activeTextOverlaysAt(textOverlays, ticks);
  if (active.length > 0) drawTextOverlays(ctx, active, canvas.width, canvas.height);
  if (selectedOverlayId) {
    const selected = active.find((overlay) => overlay.id === selectedOverlayId);
    if (selected) drawTextSelectionUI(selected);
  }
}

/** ¿Hay un asa de rotación bajo `point`? Solo la del overlay actualmente seleccionado (si está visible ahora mismo). */
function hitTestRotateHandle(point: { x: number; y: number }): TextOverlay | undefined {
  if (!selectedOverlayId) return undefined;
  const overlay = activeTextOverlaysAt(textOverlays, playheadTicks).find((o) => o.id === selectedOverlayId);
  if (!overlay) return undefined;
  const handle = rotateHandlePosition(overlay);
  return Math.hypot(point.x - handle.x, point.y - handle.y) <= 10 ? overlay : undefined;
}

const ROTATE_SNAP_DEGREES = [-180, -135, -90, -45, 0, 45, 90, 135, 180];
const ROTATE_SNAP_THRESHOLD_DEGREES = 4;

/** Captura el estado antes de un gesto de arrastre que va a mutar textOverlays in-place (rotar/mover/recortar) — se compara y se empuja al historial (un solo paso) en finishTextEditGesture, al soltar. */
function beginTextEditGesture(): EditorSnapshot | undefined {
  return timeline ? captureEditorSnapshot() : undefined;
}

function finishTextEditGesture(before: EditorSnapshot | undefined): void {
  if (!before) return;
  if (JSON.stringify(before.textOverlays) !== JSON.stringify(textOverlays)) pushHistory(before);
}

/** Arrastra el asa de rotación en círculo alrededor del centro del texto. Imanta a los ángulos "redondos" (0/45/90...) al pasar cerca. */
function beginTextOverlayRotateDrag(overlay: TextOverlay): void {
  stopPlayback();
  const before = beginTextEditGesture();
  const cx = (overlay.xPercent / 100) * canvas.width;
  const cy = (overlay.yPercent / 100) * canvas.height;

  function angleFromCenter(point: { x: number; y: number }): number {
    const raw = (Math.atan2(point.y - cy, point.x - cx) * 180) / Math.PI + 90;
    let deg = ((raw % 360) + 360) % 360;
    if (deg > 180) deg -= 360;
    for (const snapDeg of ROTATE_SNAP_DEGREES) {
      if (Math.abs(deg - snapDeg) <= ROTATE_SNAP_THRESHOLD_DEGREES) return snapDeg;
    }
    return deg;
  }

  function onMove(moveEvent: PointerEvent): void {
    const deg = angleFromCenter(canvasPointFromEvent(moveEvent));
    overlay.rotationDeg = deg;
    if (selectedOverlayId === overlay.id) textRotationInput.value = String(Math.round(deg));
    void seekToTimelineTicks(playheadTicks);
    showFloatingTooltip(moveEvent.clientX, moveEvent.clientY, `${Math.round(deg)}°`);
  }

  function onUp(): void {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    hideFloatingTooltip();
    finishTextEditGesture(before);
    status.textContent = "Rotación del texto actualizada.";
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function beginTextOverlayDrag(overlay: TextOverlay, startPoint: { x: number; y: number }): void {
  stopPlayback();
  const before = beginTextEditGesture();
  const startXPercent = overlay.xPercent;
  const startYPercent = overlay.yPercent;
  canvas.classList.add("dragging-text");

  function onMove(moveEvent: PointerEvent): void {
    const point = canvasPointFromEvent(moveEvent);
    const deltaXPercent = ((point.x - startPoint.x) / canvas.width) * 100;
    const deltaYPercent = ((point.y - startPoint.y) / canvas.height) * 100;
    overlay.xPercent = Math.max(0, Math.min(100, startXPercent + deltaXPercent));
    overlay.yPercent = Math.max(0, Math.min(100, startYPercent + deltaYPercent));
    void seekToTimelineTicks(playheadTicks);
  }

  function onUp(): void {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    canvas.classList.remove("dragging-text");
    finishTextEditGesture(before);
    syncTextEditorPanel();
    status.textContent = "Posición del texto actualizada.";
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

canvas.addEventListener("pointerdown", (event) => {
  if (!timeline || textOverlays.length === 0) return;
  const point = canvasPointFromEvent(event);

  const rotateTarget = hitTestRotateHandle(point);
  if (rotateTarget) {
    event.preventDefault();
    beginTextOverlayRotateDrag(rotateTarget);
    return;
  }

  const overlay = hitTestOverlay(point);
  if (!overlay) return;
  event.preventDefault();
  selectTextOverlay(overlay.id);
  beginTextOverlayDrag(overlay, point);
});

// --- Marcadores ---

function addMarkerAtPlayhead(): void {
  if (!timeline) return;
  commitTextEdit(() => {
    markers.push({ id: `marker-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ticks: playheadTicks });
    markers.sort((a, b) => a.ticks - b.ticks);
  });
  renderMarkers();
}

function removeMarker(id: string): void {
  commitTextEdit(() => {
    markers = markers.filter((marker) => marker.id !== id);
  });
  renderMarkers();
}

function renderMarkers(): void {
  timelineRuler.querySelectorAll(".ruler-marker").forEach((el) => el.remove());
  for (const marker of markers) {
    const flag = document.createElement("div");
    flag.className = "ruler-marker";
    flag.style.left = `${Math.round(TRACK_GUTTER_WIDTH_PX + ticksToSeconds(marker.ticks) * pixelsPerSecond)}px`;
    flag.title = formatRulerTime(ticksToSeconds(marker.ticks));
    flag.addEventListener("click", (event) => {
      event.stopPropagation();
      void seekToTimelineTicks(marker.ticks);
    });
    timelineRuler.appendChild(flag);
  }

  markerList.innerHTML = "";
  for (const marker of markers) {
    const li = document.createElement("li");
    const jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "marker-jump";
    jumpBtn.textContent = formatRulerTime(ticksToSeconds(marker.ticks));
    jumpBtn.addEventListener("click", () => void seekToTimelineTicks(marker.ticks));
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "marker-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "Eliminar marcador";
    removeBtn.addEventListener("click", () => removeMarker(marker.id));
    li.append(jumpBtn, removeBtn);
    markerList.appendChild(li);
  }
}

addMarkerButton.addEventListener("click", addMarkerAtPlayhead);

// --- Overlays de texto ---
// Viven en coordenadas absolutas de la timeline (como los
// marcadores), no dentro de un Clip — así sobreviven a reordenar o
// recortar clips sin tener que remapearlos. Se seleccionan (en la
// línea de tiempo o haciendo clic sobre ellos en el preview) para
// editarlos o borrarlos — ya no hay una cruz suelta en cada bloque.

function findOverlayById(id: string): TextOverlay | undefined {
  return textOverlays.find((overlay) => overlay.id === id);
}

/** Quita la selección de texto sin tocar la de clip — usar clearOverlaySelection() en vez de esto cuando además haga falta re-renderizar. */
function clearOverlaySelection(): void {
  selectedOverlayId = undefined;
  renderInspector();
}

/** Selecciona un overlay de texto (por id) para editarlo — mutuamente excluyente con la selección de clip. */
function selectTextOverlay(id: string): void {
  if (!findOverlayById(id)) return;
  selectedClip = undefined;
  selectedOverlayId = id;
  renderTimelineTracks(); // por si había un clip resaltado, quitarle el resalte
  renderTextTrack();
  syncTextEditorPanel(); // llama a renderInspector()
  textDetails.open = true; // al seleccionar un texto, se abre solo el compartimento donde se edita
  void seekToTimelineTicks(playheadTicks);
}

/** Crea un texto nuevo en el playhead (2s de duración, valores por defecto) y lo selecciona de inmediato para editarlo — el botón 🔤 de la caja de herramientas. */
function createTextOverlayAtPlayhead(): void {
  if (!timeline) return;
  const startTicks = playheadTicks;
  const endTicks = Math.min(timelineTotalTicks, startTicks + secondsToTicks(2));
  const overlay: TextOverlay = {
    id: `text-${nextOverlayNumber++}`,
    startTicks,
    endTicks: endTicks > startTicks ? endTicks : startTicks + minTextOverlayDurationTicks(),
    text: "Texto",
    xPercent: 50,
    yPercent: 85,
    fontSizePx: 48,
    color: "#ffffff",
    fontFamily: "sans-serif",
    rotationDeg: 0,
  };
  commitTextEdit(() => {
    textOverlays.push(overlay);
  });
  renderTextOverlaysUI();
  selectTextOverlay(overlay.id);
  status.textContent = "Texto añadido — edítalo en el panel de la derecha.";
}

function removeTextOverlay(id: string): void {
  commitTextEdit(() => {
    textOverlays = textOverlays.filter((overlay) => overlay.id !== id);
  });
  if (selectedOverlayId === id) clearOverlaySelection();
  renderTextOverlaysUI();
  syncTextEditorPanel();
  void seekToTimelineTicks(playheadTicks);
}

/** Refresca a la vez la lista del panel lateral y el bloque en la línea de tiempo — llamar tras cualquier cambio a `textOverlays`. */
function renderTextOverlaysUI(): void {
  renderTextOverlayList();
  renderTextTrack();
}

function renderTextOverlayList(): void {
  textOverlayList.innerHTML = "";
  for (const overlay of textOverlays) {
    const li = document.createElement("li");
    const jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "marker-jump";
    if (overlay.id === selectedOverlayId) jumpBtn.classList.add("selected-row");
    jumpBtn.textContent = `"${overlay.text}" (${formatRulerTime(ticksToSeconds(overlay.startTicks))}–${formatRulerTime(ticksToSeconds(overlay.endTicks))})`;
    jumpBtn.addEventListener("click", () => selectTextOverlay(overlay.id));
    li.append(jumpBtn);
    textOverlayList.appendChild(li);
  }
}

/** Muestra/oculta y rellena el editor de texto del panel lateral según haya (o no) un overlay seleccionado. */
function syncTextEditorPanel(): void {
  // Inspector contextual: renderInspector() decide si el compartimento
  // de texto se ve (según haya un texto seleccionado o exista alguno y
  // no haya un clip seleccionado).
  renderInspector();
  const overlay = selectedOverlayId ? findOverlayById(selectedOverlayId) : undefined;
  if (!overlay) {
    textEditorEmptyHint.hidden = false;
    textEditorFieldset.hidden = true;
    return;
  }
  textEditorEmptyHint.hidden = true;
  textEditorFieldset.hidden = false;
  textContentInput.value = overlay.text;
  textStartInput.value = String(ticksToSeconds(overlay.startTicks));
  textEndInput.value = String(ticksToSeconds(overlay.endTicks));
  textSizeInput.value = String(overlay.fontSizePx);
  textColorInput.value = overlay.color;
  textFontSelect.value = overlay.fontFamily;
  textXInput.value = String(Math.round(overlay.xPercent));
  textYInput.value = String(Math.round(overlay.yPercent));
  textRotationInput.value = String(Math.round(overlay.rotationDeg));
}

/** Aplica los campos del editor al overlay seleccionado — enlazado a los eventos input/change de cada campo, así que cada cambio se ve al instante. */
function applySelectedOverlayFromForm(): void {
  if (!selectedOverlayId) return;
  const overlay = findOverlayById(selectedOverlayId);
  if (!overlay) return;

  const text = textContentInput.value.trim();
  if (text) overlay.text = text; // no se deja vacío mientras se escribe

  const minDuration = minTextOverlayDurationTicks();
  const startTicks = Math.max(0, secondsToTicks(Number(textStartInput.value)));
  const endTicksRaw = secondsToTicks(Number(textEndInput.value));
  overlay.startTicks = startTicks;
  overlay.endTicks = endTicksRaw > startTicks ? endTicksRaw : startTicks + minDuration;

  const fontSize = Number(textSizeInput.value);
  if (Number.isFinite(fontSize) && fontSize > 0) overlay.fontSizePx = fontSize;
  overlay.color = textColorInput.value;
  overlay.fontFamily = textFontSelect.value;
  overlay.xPercent = Math.max(0, Math.min(100, Number(textXInput.value) || 0));
  overlay.yPercent = Math.max(0, Math.min(100, Number(textYInput.value) || 0));
  const rotation = Number(textRotationInput.value);
  overlay.rotationDeg = Number.isFinite(rotation) ? rotation : 0;

  renderTextOverlaysUI();
  void seekToTimelineTicks(playheadTicks);
}

/** Aplica el formulario dentro de commitTextEdit — un solo paso de historial por cada "change" (no por cada tecla, ver el listener "input" de más abajo). */
function commitSelectedOverlayFromForm(): void {
  commitTextEdit(applySelectedOverlayFromForm);
}

for (const el of [textStartInput, textEndInput, textSizeInput, textColorInput, textFontSelect, textXInput, textYInput, textRotationInput]) {
  el.addEventListener("change", commitSelectedOverlayFromForm);
}
// "input" aplica en vivo mientras se escribe (sin ensuciar el historial); "change" (al salir del campo) registra un único paso de deshacer para toda la edición.
textContentInput.addEventListener("input", applySelectedOverlayFromForm);
textContentInput.addEventListener("change", commitSelectedOverlayFromForm);

deleteTextButton.addEventListener("click", () => {
  if (!selectedOverlayId) return;
  removeTextOverlay(selectedOverlayId);
  status.textContent = "Texto eliminado.";
});

addTextButton.addEventListener("click", createTextOverlayAtPlayhead);

/** Duración mínima de un texto en la línea de tiempo — un fotograma de salida, igual que el mínimo de recorte de un clip. */
function minTextOverlayDurationTicks(): number {
  return timeline ? Math.max(1, frameDurationTicks(timeline.outputFrameRate)) : 1;
}

/**
 * Arrastra el cuerpo de un bloque de texto en su propia línea (aparte
 * de vídeo/audio) para moverlo en el tiempo sin cambiar su duración.
 * Un simple click sin apenas movimiento no mueve nada — solo
 * selecciona (igual que beginClipMoveDrag para los clips de vídeo).
 * Los overlays de texto no pasan por el historial de deshacer/rehacer
 * de la Timeline (viven fuera de /core, ver comentario más arriba), así
 * que aquí tampoco se registra historial — igual que añadir/quitar uno.
 */
function beginTextOverlayMove(event: PointerEvent, overlay: TextOverlay): void {
  event.preventDefault();
  event.stopPropagation();
  const before = beginTextEditGesture();
  const startClientX = event.clientX;
  const startStart = overlay.startTicks;
  const duration = overlay.endTicks - overlay.startTicks;
  let moved = false;

  function onMove(moveEvent: PointerEvent): void {
    const dx = moveEvent.clientX - startClientX;
    if (!moved && Math.abs(dx) <= CLIP_DRAG_CLICK_THRESHOLD_PX) return;
    moved = true;
    const deltaTicks = secondsToTicks(dx / pixelsPerSecond);
    const newStart = snapTimelineTicks(Math.max(0, startStart + deltaTicks));
    overlay.startTicks = newStart;
    overlay.endTicks = newStart + duration;
    scheduleTextTrackRender();
    void seekToTimelineTicks(playheadTicks);
    showFloatingTooltip(moveEvent.clientX, moveEvent.clientY, formatRulerTime(ticksToSeconds(newStart)));
  }

  function onUp(): void {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    hideFloatingTooltip();
    if (!moved) return;
    finishTextEditGesture(before);
    renderTextOverlayList();
    syncTextEditorPanel();
    status.textContent = "Texto movido en la línea de tiempo.";
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/** Arrastra el borde izquierdo o derecho de un bloque de texto para alargar/acortar su duración — mismo patrón que beginTrimDrag para clips. */
function beginTextOverlayTrim(event: PointerEvent, overlay: TextOverlay, handle: "left" | "right"): void {
  event.preventDefault();
  event.stopPropagation();
  selectTextOverlay(overlay.id);
  const before = beginTextEditGesture();
  const startClientX = event.clientX;
  const startStart = overlay.startTicks;
  const startEnd = overlay.endTicks;
  const minDuration = minTextOverlayDurationTicks();

  function onMove(moveEvent: PointerEvent): void {
    const deltaTicks = secondsToTicks((moveEvent.clientX - startClientX) / pixelsPerSecond);
    if (handle === "left") {
      const candidate = snapTimelineTicks(Math.max(0, Math.min(startStart + deltaTicks, startEnd - minDuration)));
      overlay.startTicks = Math.max(0, Math.min(candidate, startEnd - minDuration));
    } else {
      const candidate = snapTimelineTicks(Math.max(startStart + minDuration, startEnd + deltaTicks));
      overlay.endTicks = Math.max(candidate, startStart + minDuration);
    }
    scheduleTextTrackRender();
    void seekToTimelineTicks(playheadTicks);
    const edgeTicks = handle === "left" ? overlay.startTicks : overlay.endTicks;
    showFloatingTooltip(
      moveEvent.clientX,
      moveEvent.clientY,
      `${handle === "left" ? "Inicio" : "Fin"}: ${formatRulerTime(ticksToSeconds(edgeTicks))}`,
    );
  }

  function onUp(): void {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    hideFloatingTooltip();
    finishTextEditGesture(before);
    renderTextOverlayList();
    syncTextEditorPanel();
    status.textContent = "Duración del texto actualizada.";
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/** Fila propia (aparte de las pistas de vídeo/audio) con un bloque por overlay de texto, en coordenadas absolutas de la timeline — pueden solaparse entre sí, a diferencia de los clips. Clic para seleccionar (editar/borrar en el panel lateral o con Supr), arrastra para mover, bordes para recortar duración. */
function renderTextTrack(): void {
  timelineTextTrack.innerHTML = "";
  if (!timeline) return;

  for (const overlay of textOverlays) {
    const startPx = ticksToSeconds(overlay.startTicks) * pixelsPerSecond;
    const widthPx = Math.max(10, ticksToSeconds(overlay.endTicks - overlay.startTicks) * pixelsPerSecond);

    const block = document.createElement("div");
    block.className = "timeline-text-clip" + (overlay.id === selectedOverlayId ? " selected" : "");
    block.style.left = `${Math.round(TRACK_GUTTER_WIDTH_PX + startPx)}px`;
    block.style.width = `${Math.round(widthPx)}px`;
    block.title = overlay.text;

    const label = document.createElement("span");
    label.className = "text-clip-label";
    label.textContent = overlay.text;
    block.appendChild(label);

    const leftHandle = document.createElement("div");
    leftHandle.className = "trim-handle trim-handle-left";
    leftHandle.title = "Arrastra para ajustar el inicio";
    leftHandle.addEventListener("pointerdown", (event) => beginTextOverlayTrim(event, overlay, "left"));

    const rightHandle = document.createElement("div");
    rightHandle.className = "trim-handle trim-handle-right";
    rightHandle.title = "Arrastra para ajustar el final";
    rightHandle.addEventListener("pointerdown", (event) => beginTextOverlayTrim(event, overlay, "right"));

    block.append(leftHandle, rightHandle);

    block.addEventListener("pointerdown", (event) => {
      const targetEl = event.target as HTMLElement;
      if (targetEl.closest(".trim-handle")) return;
      selectTextOverlay(overlay.id);
      beginTextOverlayMove(event, overlay);
    });

    timelineTextTrack.appendChild(block);
  }
}

// --- Menú de aplicación (nativo en Electron, desplegable propio en el navegador) ---
// El menú no reimplementa ninguna acción: cada una se resuelve haciendo
// click en el control que YA existe en la interfaz, respetando su estado
// `disabled`. El menú nativo de Electron (ver electron/main.cjs) envía
// estas mismas claves de acción vía onMenuAction.
// --- Tema claro / oscuro (pedido explícito del 2026-09-30) ---
// El script en línea de index.html ya dejó puesto data-theme en <html>
// antes del primer pintado; aquí solo se sincroniza el botón y se
// alterna. La preferencia es por equipo (localStorage), no del proyecto.
const THEME_STORAGE_KEY = "appVideo.theme";
const themeToggleButton = requireElement<HTMLButtonElement>("#theme-toggle-button");

function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.setAttribute("content", theme);
  // El icono muestra a qué modo se cambia al pulsar, no el actual.
  themeToggleButton.innerHTML = iconMarkup(theme === "dark" ? "sun" : "moon");
  themeToggleButton.title = theme === "dark" ? "Modo claro" : "Modo oscuro";
}

themeToggleButton.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* sin almacenamiento (modo privado, etc.): el cambio vale para esta sesión */
  }
});
applyTheme(currentTheme());

const MENU_ACTIONS: Record<string, () => void> = {
  "open-video": () => fileInput.click(),
  "load-project": () => loadProjectButton.click(),
  "save-project": () => clickIfEnabled(saveProjectButton),
  export: () => clickIfEnabled(exportButton),
  undo: () => clickIfEnabled(undoButton),
  redo: () => clickIfEnabled(redoButton),
  split: () => clickIfEnabled(splitButton),
  "select-clip": () => clickIfEnabled(selectClipButton),
  "toggle-snap": () => clickIfEnabled(snapToggleButton),
  "flag-clip": () => clickIfEnabled(flagClipButton),
  "delete-clip": () => clickIfEnabled(deleteClipButton),
  "add-marker": () => clickIfEnabled(addMarkerButton),
  "add-text": () => clickIfEnabled(addTextButton),
  "zoom-in": () => clickIfEnabled(zoomInButton),
  "zoom-out": () => clickIfEnabled(zoomOutButton),
  "zoom-fit": () => clickIfEnabled(zoomFitButton),
  "toggle-preview-zoom": () => clickIfEnabled(previewZoomButton),
  "add-video-track": () => clickIfEnabled(addVideoTrackButton),
  "add-audio-track": () => clickIfEnabled(addAudioTrackButton),
  "show-shortcuts": () => shortcutsModal.showModal(),
  "toggle-theme": () => themeToggleButton.click(),
};

function clickIfEnabled(button: HTMLButtonElement): void {
  if (!button.disabled) button.click();
}

function runMenuAction(action: string): void {
  MENU_ACTIONS[action]?.();
}

/** El control cuyo estado `disabled` decide si una acción del menú está disponible — para atenuar el ítem correspondiente del desplegable del navegador. Las acciones sin entrada aquí (abrir vídeo, cargar proyecto, atajos) están siempre disponibles. */
const MENU_ACTION_GATES: Record<string, HTMLButtonElement> = {
  "save-project": saveProjectButton,
  export: exportButton,
  undo: undoButton,
  redo: redoButton,
  split: splitButton,
  "select-clip": selectClipButton,
  "toggle-snap": snapToggleButton,
  "flag-clip": flagClipButton,
  "delete-clip": deleteClipButton,
  "add-marker": addMarkerButton,
  "add-text": addTextButton,
  "zoom-in": zoomInButton,
  "zoom-out": zoomOutButton,
  "zoom-fit": zoomFitButton,
  "toggle-preview-zoom": previewZoomButton,
  "add-video-track": addVideoTrackButton,
  "add-audio-track": addAudioTrackButton,
};

/** Contenido del menú de respaldo del navegador — refleja el menú nativo de electron/main.cjs. Los ids de acción coinciden con las claves de MENU_ACTIONS. */
const APP_MENU: { group: string; items: { label: string; action: string }[] }[] = [
  {
    group: "Archivo",
    items: [
      { label: "Abrir vídeo…", action: "open-video" },
      { label: "Cargar proyecto…", action: "load-project" },
      { label: "Guardar proyecto", action: "save-project" },
      { label: "Exportar a MP4…", action: "export" },
    ],
  },
  {
    group: "Editar",
    items: [
      { label: "Deshacer", action: "undo" },
      { label: "Rehacer", action: "redo" },
      { label: "Seleccionar clip en el playhead (A)", action: "select-clip" },
      { label: "Cortar clip en el playhead (C)", action: "split" },
      { label: "Imán / snapping (N)", action: "toggle-snap" },
      { label: "Bandera en el clip seleccionado (G)", action: "flag-clip" },
      { label: "Eliminar clip seleccionado (Supr)", action: "delete-clip" },
      { label: "Añadir marcador (M)", action: "add-marker" },
      { label: "Añadir texto", action: "add-text" },
    ],
  },
  {
    group: "Ver",
    items: [
      { label: "Acercar la timeline", action: "zoom-in" },
      { label: "Alejar la timeline", action: "zoom-out" },
      { label: "Ajustar la timeline a la ventana", action: "zoom-fit" },
      { label: "Alternar zoom del preview", action: "toggle-preview-zoom" },
      { label: "Modo oscuro / claro", action: "toggle-theme" },
      { label: "Atajos de teclado", action: "show-shortcuts" },
    ],
  },
  {
    group: "Pista",
    items: [
      { label: "Añadir pista de vídeo", action: "add-video-track" },
      { label: "Añadir pista de audio", action: "add-audio-track" },
    ],
  },
];

function buildAppMenuDropdown(): void {
  appMenuDropdown.innerHTML = "";
  for (const { group, items } of APP_MENU) {
    const label = document.createElement("div");
    label.className = "app-menu-group-label";
    label.textContent = group;
    appMenuDropdown.appendChild(label);
    for (const { label: itemLabel, action } of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "app-menu-item";
      button.dataset.action = action;
      button.textContent = itemLabel;
      button.addEventListener("click", () => {
        closeAppMenu();
        runMenuAction(action);
      });
      appMenuDropdown.appendChild(button);
    }
  }
}

function isAppMenuOpen(): boolean {
  return !appMenuDropdown.hidden;
}

function openAppMenu(): void {
  // Refleja el estado disabled actual de cada control en su ítem del menú.
  for (const item of appMenuDropdown.querySelectorAll<HTMLButtonElement>(".app-menu-item")) {
    const gate = MENU_ACTION_GATES[item.dataset.action ?? ""];
    item.disabled = gate ? gate.disabled : false;
  }
  appMenuDropdown.hidden = false;
  appMenuButton.setAttribute("aria-expanded", "true");
}

function closeAppMenu(): void {
  appMenuDropdown.hidden = true;
  appMenuButton.setAttribute("aria-expanded", "false");
}

const appBridge = getAppVideoBridge();
if (appBridge?.onMenuAction) {
  // Electron: hay barra de menú nativa, el botón ☰ sobra.
  appBridge.onMenuAction(runMenuAction);
  appMenuButton.hidden = true;
} else {
  buildAppMenuDropdown();
  appMenuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (isAppMenuOpen()) closeAppMenu();
    else openAppMenu();
  });
  document.addEventListener("click", (event) => {
    if (isAppMenuOpen() && !appMenuDropdown.contains(event.target as Node)) closeAppMenu();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isAppMenuOpen()) closeAppMenu();
  });
}

// --- Atajos de teclado típicos de un editor de vídeo ---
window.addEventListener("keydown", (event) => {
  const target = event.target;
  // No interceptar mientras se escribe en un campo (p.ej. los inputs de recorte).
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === "z") {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === "y") {
    event.preventDefault();
    redo();
    return;
  }

  if (!timeline) return;

  switch (event.key) {
    case " ":
      event.preventDefault();
      togglePlayPause();
      break;
    case "c":
    case "C":
      event.preventDefault();
      if (!splitButton.disabled) splitAtPlayhead();
      break;
    case "a":
    case "A":
      event.preventDefault();
      if (!selectClipButton.disabled) selectClipAtPlayhead();
      break;
    case "n":
    case "N":
      event.preventDefault();
      if (!snapToggleButton.disabled) toggleSnapping();
      break;
    case "g":
    case "G":
      event.preventDefault();
      if (!flagClipButton.disabled) toggleFlagOnSelectedClip();
      break;
    case "m":
    case "M":
      event.preventDefault();
      if (!addMarkerButton.disabled) addMarkerAtPlayhead();
      break;
    // J/K/L: shuttle clásico de NLE, pedido explícito del 2026-08-29.
    // L reproduce hacia delante, K para — ambos reutilizan
    // exactamente lo que ya hacían Espacio/togglePlayPause, sin
    // velocidades ni reproducción hacia atrás real (el decodificador
    // de este proyecto es solo-adelante, ver media/frameSeeker.ts): J
    // retrocede un fotograma cada vez, apoyándose en la repetición de
    // tecla nativa del sistema operativo mientras se mantiene pulsada
    // — igual que ya hace ArrowLeft.
    case "l":
    case "L":
      event.preventDefault();
      if (!activeSegment) void playFromPlayhead();
      break;
    case "k":
    case "K":
      event.preventDefault();
      if (activeSegment) stopPlayback();
      break;
    case "j":
    case "J":
      event.preventDefault();
      if (activeSegment) stopPlayback();
      stepFrame(-1);
      break;
    case "Delete":
    case "Backspace":
      if (selectedOverlayId !== undefined) {
        event.preventDefault();
        removeTextOverlay(selectedOverlayId);
        status.textContent = "Texto eliminado.";
      } else if (selectedClip !== undefined) {
        event.preventDefault();
        removeClipRef(selectedClip.trackId, selectedClip.clipId);
      }
      break;
    case "ArrowLeft":
      event.preventDefault();
      stepFrame(-1);
      break;
    case "ArrowRight":
      event.preventDefault();
      stepFrame(1);
      break;
    case "Home":
      event.preventDefault();
      void seekToTimelineTicks(0);
      break;
    case "End":
      event.preventDefault();
      void seekToTimelineTicks(Math.max(timelineTotalTicks - 1, 0));
      break;
  }
});

// --- Exportar ---

/** Resolución de salida elegida en "Calidad/Resolución" — `base` (la de la timeline) si el preset es "Igual que la timeline", o el WxH del preset si no. Solo afecta a ESTA exportación, no cambia la resolución del proyecto (esa se edita aparte, en "Salida"). */
function resolveExportResolution(base: Resolution): Resolution {
  const preset = exportResolutionPresetSelect.value;
  if (preset === "timeline") return base;
  const [widthStr, heightStr] = preset.split("x");
  const width = Number(widthStr);
  const height = Number(heightStr);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return base;
  return { width, height };
}

exportButton.addEventListener("click", () => {
  if (!timeline) return;
  const outputResolution = resolveExportResolution(timeline.outputResolution);
  const bitrate = Number(exportQualitySelect.value) || undefined;
  void runExport({ ...timeline, outputResolution }, bitrate);
});

let exportAbortController: AbortController | undefined;

async function runExport(timelineToExport: Timeline, bitrate: number | undefined): Promise<void> {
  stopPlayback();
  exportButton.disabled = true;
  cancelExportButton.hidden = false;
  exportAbortController = new AbortController();
  exportStatus.textContent = "Exportando...";
  exportDownload.innerHTML = "";
  exportProgress.hidden = false;
  exportProgress.value = 0;
  try {
    const blob = await exportTimelineToMp4({
      timeline: timelineToExport,
      getSource: (sourceId) => sources.get(sourceId)?.demuxed,
      getAudio: (sourceId) => sources.get(sourceId)?.audio,
      textOverlays,
      ...(bitrate !== undefined ? { bitrate } : {}),
      signal: exportAbortController.signal,
      onProgress: (done, total) => {
        exportProgress.max = total;
        exportProgress.value = done;
        exportStatus.textContent = `Exportando... ${done}/${total} fotogramas`;
      },
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "export.mp4";
    link.textContent = `Descargar export.mp4 (${(blob.size / 1_000_000).toFixed(1)} MB)`;
    exportDownload.appendChild(link);
    exportStatus.textContent = "Exportación completa.";
  } catch (error) {
    if (error instanceof ExportCancelledError) {
      exportStatus.textContent = "Exportación cancelada.";
    } else {
      console.error(error);
      exportStatus.textContent = `Error de exportación: ${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    exportButton.disabled = false;
    cancelExportButton.hidden = true;
    exportProgress.hidden = true;
    exportAbortController = undefined;
  }
}

cancelExportButton.addEventListener("click", () => {
  exportAbortController?.abort();
});

// --- Guardar / cargar proyecto ---
// El JSON no lleva los bytes de vídeo (serían enormes) — solo la
// timeline y el nombre de cada archivo de origen. Al cargar, se le
// pide al usuario que vuelva a seleccionar esos mismos archivos y se
// emparejan por nombre.

function collectProjectSources(): ProjectSource[] {
  return Array.from(sources.entries()).map(([id, entry]) => ({
    ...entry.sourceFile,
    id,
    fileName: entry.fileName,
    ...(entry.filePath ? { filePath: entry.filePath } : {}),
  }));
}

saveProjectButton.addEventListener("click", () => {
  if (!timeline) return;
  const project = serializeProject(timeline, collectProjectSources(), markers, textOverlays);
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  projectStatus.innerHTML = "";
  const link = document.createElement("a");
  link.href = url;
  link.download = "proyecto.json";
  link.textContent = "Descargar proyecto.json";
  projectStatus.appendChild(link);
});

let pendingProject: ProjectFile | undefined;
/** Fuentes ya releídas por ruta (sin intervención del usuario) para el `pendingProject` actual — ver handleProjectFileSelected. Vacío si no hay puente de Electron o ninguna fuente tenía `filePath`. */
let pendingAutoResolvedSources: Map<string, File> = new Map();

loadProjectButton.addEventListener("click", () => projectFileInput.click());

projectFileInput.addEventListener("change", () => {
  const file = projectFileInput.files?.[0];
  projectFileInput.value = "";
  if (!file) return;
  void handleProjectFileSelected(file);
});

/** Intenta releer cada fuente con `filePath` guardado directamente por ruta (Electron, ver ui/electronBridge.ts) — sin molestar al usuario. Las que no tengan ruta, no existan ya ahí, o fallen al leerse, quedan fuera del resultado. */
async function autoResolveProjectSources(sources: ProjectSource[]): Promise<Map<string, File>> {
  const resolved = new Map<string, File>();
  const bridge = getAppVideoBridge();
  if (!bridge) return resolved;
  for (const source of sources) {
    if (!source.filePath) continue;
    try {
      if (await bridge.fileExists(source.filePath)) {
        resolved.set(source.id, await readFileFromPath(bridge, source.filePath, source.fileName));
      }
    } catch (error) {
      console.warn(`No se pudo releer ${source.fileName} por ruta guardada:`, error);
    }
  }
  return resolved;
}

async function handleProjectFileSelected(file: File): Promise<void> {
  try {
    const text = await file.text();
    const parsed = parseProjectFile(JSON.parse(text));
    setProjectName(file.name);
    pendingProject = parsed;
    pendingAutoResolvedSources = await autoResolveProjectSources(parsed.sources);

    const missing = parsed.sources.filter((source) => !pendingAutoResolvedSources.has(source.id));
    if (missing.length === 0) {
      await applyPendingProject(parsed, []);
      return;
    }
    const names = missing.map((source) => source.fileName).join(", ");
    projectStatus.textContent = `Proyecto leído. Vuelve a seleccionar estos archivos (mismo nombre): ${names}`;
    projectSourcesInput.click();
  } catch (error) {
    console.error(error);
    projectStatus.textContent = `Error al leer el proyecto: ${error instanceof Error ? error.message : String(error)}`;
  }
}

projectSourcesInput.addEventListener("change", () => {
  const files = Array.from(projectSourcesInput.files ?? []);
  projectSourcesInput.value = "";
  if (!pendingProject || files.length === 0) return;
  void applyPendingProject(pendingProject, files);
});

/** `manualFiles` son solo los que el usuario acaba de re-seleccionar a mano (emparejados por nombre); los que ya se resolvieron por ruta guardada están en `pendingAutoResolvedSources` (ver handleProjectFileSelected) y se fusionan aquí por sourceId. */
async function applyPendingProject(project: ProjectFile, manualFiles: File[]): Promise<void> {
  const manualByName = new Map(manualFiles.map((file) => [file.name, file]));
  const byId = new Map(pendingAutoResolvedSources);
  const missing: ProjectSource[] = [];
  for (const source of project.sources) {
    if (byId.has(source.id)) continue;
    const manual = manualByName.get(source.fileName);
    if (manual) byId.set(source.id, manual);
    else missing.push(source);
  }
  if (missing.length > 0) {
    projectStatus.textContent = `Faltan archivos: ${missing.map((s) => s.fileName).join(", ")}. Selecciónalos todos a la vez.`;
    return;
  }

  stopPlayback();
  projectStatus.textContent = "Cargando archivos del proyecto...";
  const newSources = new Map<string, SourceEntry>();
  try {
    for (const projectSource of project.sources) {
      const file = byId.get(projectSource.id)!;
      const { videoTrack, samples } = await decodeAllSamples(file);
      const firstSample = samples[0];
      if (!firstSample) {
        throw new Error(`${projectSource.fileName} no tiene ningún fotograma de vídeo`);
      }
      getDecoderDescription(firstSample);
      const demuxed = { videoTrack, samples };
      const thumbnail = await generateThumbnail(demuxed).catch((error: unknown) => {
        console.warn("No se pudo generar la miniatura del clip:", error);
        return undefined;
      });
      const { audio, waveformPeaks } = await loadAudioForSource(file);
      // Si ya sabíamos la ruta (por el proyecto guardado o por acabar de
      // releerlo por ruta), se conserva tal cual — getFilePathIfAvailable
      // no funcionaría sobre el File sintético que devuelve
      // readFileFromPath. Solo se intenta capturar una ruta NUEVA para
      // archivos re-seleccionados a mano (File real de un <input>), así
      // la próxima recarga también los resuelve solos.
      const filePath = projectSource.filePath ?? getFilePathIfAvailable(file);
      newSources.set(projectSource.id, {
        sourceFile: {
          id: projectSource.id,
          kind: projectSource.kind,
          durationTicks: projectSource.durationTicks,
          ...(projectSource.frameRate ? { frameRate: projectSource.frameRate } : {}),
          ...(projectSource.width !== undefined ? { width: projectSource.width } : {}),
          ...(projectSource.height !== undefined ? { height: projectSource.height } : {}),
        },
        demuxed,
        fileName: projectSource.fileName,
        ...(filePath ? { filePath } : {}),
        ...(thumbnail ? { thumbnail } : {}),
        ...(audio ? { audio } : {}),
        ...(waveformPeaks ? { waveformPeaks } : {}),
      });
    }
  } catch (error) {
    console.error(error);
    projectStatus.textContent = `Error al decodificar los archivos: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }

  for (const entry of sources.values()) entry.player?.destroy();
  sources.clear();
  playerPoolOrder.length = 0;
  for (const [id, entry] of newSources) sources.set(id, entry);
  clearTransitionFrameCache();

  timeline = {
    tracks: project.tracks,
    outputResolution: project.outputResolution,
    outputFrameRate: project.outputFrameRate,
    ...(project.masterAudio ? { masterAudio: project.masterAudio } : {}),
  };
  historyPast = [];
  historyFuture = [];
  updateHistoryButtons();
  markers = project.markers.map((marker) => ({ ...marker }));
  textOverlays = project.textOverlays.map((overlay) => ({ ...overlay }));
  clearOverlaySelection();
  renderTextOverlaysUI();
  syncTextEditorPanel();
  const firstClipRef = (() => {
    for (const track of timeline.tracks) {
      const first = track.clips[0];
      if (first) return { trackId: track.id, clipId: first.id };
    }
    return undefined;
  })();
  selectedClip = firstClipRef;
  activeSegment = undefined;
  playheadTicks = 0;

  canvas.width = project.outputResolution.width;
  canvas.height = project.outputResolution.height;
  outputWidthInput.value = String(project.outputResolution.width);
  outputHeightInput.value = String(project.outputResolution.height);
  outputFpsInput.value = String(project.outputFrameRate.numerator / project.outputFrameRate.denominator);

  enableEditingControls();
  syncMasterAudioPanel();
  nextSourceNumber = newSources.size + 1;
  nextTrackNumber = timeline.tracks.length + 1;
  nextClipNumber = timeline.tracks.reduce((sum, track) => sum + track.clips.length, 0) + 1;

  hasAutoFitted = true;
  zoomToFit();
  if (selectedClip) selectClipRef(selectedClip.trackId, selectedClip.clipId);
  await seekToTimelineTicks(0);
  renderMediaBin();
  projectStatus.textContent = "Proyecto cargado.";
}
