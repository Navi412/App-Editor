import { frameDurationTicks, secondsToTicks, ticksToSeconds } from "../core/time";
import {
  appendClip,
  clipStartTicks,
  removeClip,
  reorderClip,
  splitClipAt,
  timelineDurationTicks,
  trimClipIn,
  trimClipOut,
  walkTimeline,
} from "../core/timeline";
import { parseProjectFile, serializeProject, type ProjectFile, type ProjectSource } from "../core/project";
import { activeTextOverlaysAt, type TextOverlay } from "../core/textOverlay";
import type { Clip, SourceFile, Timeline } from "../core/types";
import { exportTimelineToMp4 } from "../export/exportTimeline";
import { decodeAudioAsset } from "../media/audio";
import { playAudioSlice, type AudioPlaybackHandle } from "../media/audioPlayer";
import { createVideoPlayer, type VideoPlayer } from "../media/player";
import { drawFrameFit } from "../media/render";
import { decodeAllSamples, type DemuxedTrack } from "../media/samples";
import { toSourceFile } from "../media/sourceFile";
import { drawTextOverlays } from "../media/textOverlayRender";
import { generateThumbnail } from "../media/thumbnail";
import { computeWaveformPeaks, drawWaveformSlice } from "../media/waveform";

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
const timelineTrack = requireElement<HTMLDivElement>("#timeline-track");
const timelineAudioTrack = requireElement<HTMLDivElement>("#timeline-audio-track");
const timelinePlayhead = requireElement<HTMLDivElement>("#timeline-playhead");
const splitButton = requireElement<HTMLButtonElement>("#split-button");
const deleteClipButton = requireElement<HTMLButtonElement>("#delete-clip-button");
const zoomOutButton = requireElement<HTMLButtonElement>("#zoom-out-button");
const zoomFitButton = requireElement<HTMLButtonElement>("#zoom-fit-button");
const zoomInButton = requireElement<HTMLButtonElement>("#zoom-in-button");
const trimControls = requireElement<HTMLFieldSetElement>("#trim-controls");
const trimInInput = requireElement<HTMLInputElement>("#trim-in");
const trimOutInput = requireElement<HTMLInputElement>("#trim-out");
const applyTrimButton = requireElement<HTMLButtonElement>("#apply-trim");
const addMarkerButton = requireElement<HTMLButtonElement>("#add-marker-button");
const markerList = requireElement<HTMLUListElement>("#marker-list");
const textContentInput = requireElement<HTMLInputElement>("#text-content");
const textStartInput = requireElement<HTMLInputElement>("#text-start");
const textEndInput = requireElement<HTMLInputElement>("#text-end");
const textSizeInput = requireElement<HTMLInputElement>("#text-size");
const textColorInput = requireElement<HTMLInputElement>("#text-color");
const textXInput = requireElement<HTMLInputElement>("#text-x");
const textYInput = requireElement<HTMLInputElement>("#text-y");
const addTextButton = requireElement<HTMLButtonElement>("#add-text-button");
const textOverlayList = requireElement<HTMLUListElement>("#text-overlay-list");
const playButton = requireElement<HTMLButtonElement>("#play-button");
const pauseButton = requireElement<HTMLButtonElement>("#pause-button");
const previewWrap = requireElement<HTMLDivElement>("#preview-wrap");
const previewZoomButton = requireElement<HTMLButtonElement>("#preview-zoom-button");
const canvas = requireElement<HTMLCanvasElement>("#preview");
const status = requireElement<HTMLSpanElement>("#status");
const exportButton = requireElement<HTMLButtonElement>("#export-button");
const exportStatus = requireElement<HTMLParagraphElement>("#export-status");
const exportDownload = requireElement<HTMLParagraphElement>("#export-download");
const scrubTooltip = requireElement<HTMLDivElement>("#scrub-tooltip");

const ctx = requireContext(canvas);

interface SourceEntry {
  sourceFile: SourceFile;
  demuxed: DemuxedTrack;
  fileName: string;
  thumbnail?: string;
  audio?: AudioBuffer;
  waveformPeaks?: Float32Array;
  player?: VideoPlayer;
}

interface MarkerState {
  id: string;
  ticks: number;
}

const WAVEFORM_BUCKET_COUNT = 400;

const sources = new Map<string, SourceEntry>();
let timeline: Timeline | undefined;
let selectedClipIndex: number | undefined;
let playingClipIndex: number | undefined;
let nextSourceNumber = 1;
let nextClipNumber = 1;
let nextOverlayNumber = 1;
let markers: MarkerState[] = [];
let textOverlays: TextOverlay[] = [];

// Un único AudioContext para toda la sesión — reproducir un clip crea
// un AudioBufferSourceNode nuevo cada vez (son de un solo uso), pero
// el contexto en sí se comparte. Puede arrancar "suspended" hasta el
// primer gesto del usuario (política de autoplay); se reanuda al
// primer play().
const audioContext = new AudioContext();
let activeAudioHandle: AudioPlaybackHandle | undefined;

/** Posición del playhead en ticks de la timeline — única fuente de verdad de "dónde estamos". */
let playheadTicks = 0;
let timelineTotalTicks = 0;
let dragFromIndex: number | undefined;

/** Píxeles por segundo — el nivel de zoom de la línea de tiempo. */
let pixelsPerSecond = 100;
const MIN_PIXELS_PER_SECOND = 5;
const MAX_PIXELS_PER_SECOND = 800;
const ZOOM_STEP = 1.3;
const SNAP_PIXELS = 8;
let hasAutoFitted = false;
let previewZoomed100 = false;

// --- Historial (deshacer / rehacer) ---
// Timeline es un dato inmutable (todo /core devuelve una copia nueva),
// así que el historial es solo una pila de snapshots — nunca hace
// falta clonar nada a mano.
let historyPast: Timeline[] = [];
let historyFuture: Timeline[] = [];
const MAX_HISTORY = 50;

function pushHistory(previous: Timeline): void {
  historyPast.push(previous);
  if (historyPast.length > MAX_HISTORY) historyPast.shift();
  historyFuture = [];
  updateHistoryButtons();
}

/** Aplica un nuevo estado de la timeline registrando el anterior en el historial. Usar SIEMPRE en vez de asignar `timeline = ...` directamente. */
function commitTimeline(next: Timeline): void {
  if (timeline) pushHistory(timeline);
  timeline = next;
}

function updateHistoryButtons(): void {
  undoButton.disabled = historyPast.length === 0;
  redoButton.disabled = historyFuture.length === 0;
}

function afterHistoryChange(): void {
  stopPlayback();
  if (selectedClipIndex !== undefined && (!timeline || selectedClipIndex >= timeline.track.clips.length)) {
    selectedClipIndex = undefined;
  }
  refreshTimelineLayout();
  if (selectedClipIndex !== undefined && timeline) {
    const clip = timeline.track.clips[selectedClipIndex]!;
    trimInInput.value = String(ticksToSeconds(clip.sourceInTicks));
    trimOutInput.value = String(ticksToSeconds(clip.sourceOutTicks));
  }
  void seekToTimelineTicks(Math.min(playheadTicks, Math.max(timelineTotalTicks - 1, 0)));
  updateHistoryButtons();
}

function undo(): void {
  if (!timeline || historyPast.length === 0) return;
  const previous = historyPast.pop()!;
  historyFuture.push(timeline);
  timeline = previous;
  afterHistoryChange();
}

function redo(): void {
  if (!timeline || historyFuture.length === 0) return;
  const next = historyFuture.pop()!;
  historyPast.push(timeline);
  timeline = next;
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
  if (!timeline || playingClipIndex === undefined) return undefined;
  const clip = timeline.track.clips[playingClipIndex];
  if (!clip || clip.sourceId !== sourceId) return undefined;
  const sourceTicks = secondsToTicks(sourceTimeUs / 1_000_000);
  const start = clipStartTicks(timeline, playingClipIndex);
  return start + Math.max(0, sourceTicks - clip.sourceInTicks);
}

function getPlayer(sourceId: string): VideoPlayer {
  const entry = sources.get(sourceId);
  if (!entry) throw new Error(`Fuente no encontrada: ${sourceId}`);
  if (!entry.player) {
    entry.player = createVideoPlayer(entry.demuxed, {
      onFrame: (frame) => {
        if (!timeline) return;
        drawFrameFit(ctx, frame, timeline.outputResolution);
        if (textOverlays.length > 0) {
          const ticks = timelineTicksForSourceFrame(sourceId, frame.timestamp) ?? playheadTicks;
          const active = activeTextOverlaysAt(textOverlays, ticks);
          if (active.length > 0) drawTextOverlays(ctx, active, canvas.width, canvas.height);
        }
      },
      onStatus: (message) => {
        status.textContent = message;
      },
      onTimeUpdate: (sourceTimeUs) => {
        if (!timeline || playingClipIndex === undefined) return;
        const clip = timeline.track.clips[playingClipIndex];
        if (!clip || clip.sourceId !== sourceId) return; // fotograma tardío de un player ya no activo
        const sourceTicks = secondsToTicks(sourceTimeUs / 1_000_000);
        const start = clipStartTicks(timeline, playingClipIndex);
        setPlayheadTicks(start + Math.max(0, sourceTicks - clip.sourceInTicks));
      },
      onEnded: () => {
        void handleClipEnded(sourceId);
      },
    });
  }
  return entry.player;
}

async function handleClipEnded(sourceId: string): Promise<void> {
  if (!timeline || playingClipIndex === undefined) return;
  const clip = timeline.track.clips[playingClipIndex];
  if (!clip || clip.sourceId !== sourceId) return; // señal obsoleta de un player que ya no está activo
  const nextIndex = playingClipIndex + 1;
  if (nextIndex < timeline.track.clips.length) {
    await playClipFrom(nextIndex, 0);
  } else {
    playingClipIndex = undefined;
    pauseButton.disabled = true;
    await seekToTimelineTicks(0);
    status.textContent = "Reproducción terminada.";
  }
}

async function playClipFrom(clipIndex: number, offsetTicks: number): Promise<void> {
  const tl = requireTimeline();
  const clip = tl.track.clips[clipIndex];
  if (!clip) return;
  const player = getPlayer(clip.sourceId);
  const startSeconds = ticksToSeconds(clip.sourceInTicks + offsetTicks);
  const startUs = Math.round(startSeconds * 1_000_000);
  const endUs = Math.round(ticksToSeconds(clip.sourceOutTicks) * 1_000_000);
  playingClipIndex = clipIndex;

  activeAudioHandle?.stop();
  activeAudioHandle = undefined;

  // Se busca el vídeo ANTES de arrancar el audio: seekTo() decodifica
  // de forma asíncrona (unos ms), y Web Audio empieza a sonar de forma
  // prácticamente inmediata en cuanto se programa — si el audio
  // arrancara antes, iría por delante del primer fotograma visible.
  await player.seekTo(startUs);

  const entry = sources.get(clip.sourceId);
  if (entry?.audio) {
    if (audioContext.state === "suspended") await audioContext.resume();
    const durationSeconds = ticksToSeconds(clip.sourceOutTicks) - startSeconds;
    activeAudioHandle = playAudioSlice(audioContext, entry.audio, startSeconds, durationSeconds, audioContext.currentTime);
  }

  player.play(endUs);
  pauseButton.disabled = false;
}

function stopPlayback(): void {
  activeAudioHandle?.stop();
  activeAudioHandle = undefined;
  if (!timeline || playingClipIndex === undefined) return;
  const clip = timeline.track.clips[playingClipIndex];
  if (clip) getPlayer(clip.sourceId).pause();
  playingClipIndex = undefined;
  pauseButton.disabled = true;
}

/** Reproduce desde el playhead actual hasta el final del clip que ocupa esa posición. */
function playFromPlayhead(): void {
  if (!timeline) return;
  const position = walkTimeline(timeline, playheadTicks);
  if (!position) return;
  const clip = timeline.track.clips[position.clipIndex]!;
  const offset = position.sourceTimeTicks - clip.sourceInTicks;
  void playClipFrom(position.clipIndex, offset);
}

function togglePlayPause(): void {
  if (!timeline) return;
  if (playingClipIndex !== undefined) stopPlayback();
  else playFromPlayhead();
}

async function seekToTimelineTicks(ticks: number): Promise<void> {
  if (!timeline) return;
  stopPlayback();
  const position = walkTimeline(timeline, ticks);
  if (!position) return;
  const player = getPlayer(position.sourceId);
  const sourceTimeUs = Math.round(ticksToSeconds(position.sourceTimeTicks) * 1_000_000);
  await player.seekTo(sourceTimeUs);
  setPlayheadTicks(ticks);
}

/** Un paso de fotograma hacia delante (1) o hacia atrás (-1), según la frame rate de salida. */
function stepFrame(direction: 1 | -1): void {
  if (!timeline) return;
  const step = frameDurationTicks(timeline.outputFrameRate);
  const next = Math.max(0, Math.min(playheadTicks + direction * step, Math.max(timelineTotalTicks - 1, 0)));
  void seekToTimelineTicks(next);
}

function splitAtPlayhead(): void {
  if (!timeline) return;
  stopPlayback();
  let next: Timeline;
  try {
    next = splitClipAt(timeline, playheadTicks, [`clip-${nextClipNumber++}`, `clip-${nextClipNumber++}`]);
  } catch (error) {
    status.textContent = `No se pudo cortar: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  commitTimeline(next);
  selectedClipIndex = undefined;
  refreshTimelineLayout();
  status.textContent = "Clip cortado en el playhead.";
}

// --- Timeline visual: zoom/scroll en píxeles, playhead, bloques de clip, arrastrar para reordenar ---

function setPlayheadTicks(ticks: number): void {
  playheadTicks = Math.max(0, Math.min(ticks, Math.max(timelineTotalTicks - 1, 0)));
  updatePlayheadPosition();
}

function updatePlayheadPosition(): void {
  const left = ticksToSeconds(playheadTicks) * pixelsPerSecond;
  timelinePlayhead.style.left = `${Math.round(left)}px`;
}

/** Ancho total de la línea de tiempo en píxeles: la duración a escala, o el ancho visible si es menor (para que siempre rellene el hueco). */
function contentWidthPx(): number {
  const naturalWidth = ticksToSeconds(timelineTotalTicks) * pixelsPerSecond;
  const viewportWidth = timelineScroll.clientWidth || 1;
  return Math.max(naturalWidth, viewportWidth);
}

/** Recalcula duración total, ancho de la línea de tiempo, bloques de clip, regla, marcadores y playhead. Llamar tras cualquier cambio estructural. */
function refreshTimelineLayout(): void {
  timelineTotalTicks = timeline ? timelineDurationTicks(timeline) : 0;
  playheadTicks = Math.min(playheadTicks, Math.max(timelineTotalTicks - 1, 0));

  const width = Math.round(contentWidthPx());
  timelineContent.style.width = `${width}px`;
  timelineTrack.style.width = `${width}px`;
  timelineAudioTrack.style.width = `${width}px`;
  timelineRuler.style.width = `${width}px`;

  renderTimeline();
  renderAudioTrack();
  renderRuler();
  renderMarkers();
  updatePlayheadPosition();
}

function zoomAt(newPixelsPerSecond: number, anchorClientX: number): void {
  if (!timeline) return;
  const trackRectBefore = timelineTrack.getBoundingClientRect();
  const anchorSeconds = (anchorClientX - trackRectBefore.left) / pixelsPerSecond;
  pixelsPerSecond = Math.max(MIN_PIXELS_PER_SECOND, Math.min(MAX_PIXELS_PER_SECOND, newPixelsPerSecond));
  refreshTimelineLayout();
  const scrollRect = timelineScroll.getBoundingClientRect();
  timelineScroll.scrollLeft = anchorSeconds * pixelsPerSecond - (anchorClientX - scrollRect.left);
}

function zoomToFit(): void {
  if (!timeline) return;
  // Se calcula la duración directamente de `timeline` en vez de leer
  // la variable cacheada `timelineTotalTicks`: en el primer clip
  // añadido esa variable todavía vale 0 (solo se actualiza dentro de
  // refreshTimelineLayout, que aún no se ha llamado la primera vez).
  const totalTicks = timelineDurationTicks(timeline);
  if (totalTicks <= 0) return;
  const viewport = timelineScroll.clientWidth || 1;
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
  for (let t = 0; t <= totalSeconds + 1e-6; t += interval) {
    const mark = document.createElement("span");
    mark.className = "ruler-mark";
    mark.style.left = `${Math.round(t * pixelsPerSecond)}px`;
    mark.textContent = formatRulerTime(t);
    timelineRuler.appendChild(mark);
  }
}

function ticksAtClientX(clientX: number): number {
  const rect = timelineTrack.getBoundingClientRect();
  const seconds = Math.max(0, (clientX - rect.left) / pixelsPerSecond);
  return Math.max(0, Math.min(secondsToTicks(seconds), Math.max(timelineTotalTicks - 1, 0)));
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
timelineTrack.addEventListener("pointerdown", (event) => {
  // Si el pointerdown empezó sobre un bloque de clip (o su handle de
  // recorte), dejar que ese elemento gestione su propio gesto en vez
  // de interpretarlo como un scrub.
  if ((event.target as HTMLElement).closest(".timeline-clip")) return;
  beginTimelineScrub(event);
});

/** ¿El cursor está sobre la mitad izquierda del bloque (insertar antes) o la derecha (insertar después)? */
function isInsertBefore(block: HTMLElement, clientX: number): boolean {
  const rect = block.getBoundingClientRect();
  return clientX - rect.left < rect.width / 2;
}

/** Índice final tras quitar `fromIndex` e insertar antes/después de `overIndex`. */
function resolveDropTarget(fromIndex: number, overIndex: number, insertBefore: boolean): number {
  let target = insertBefore ? overIndex : overIndex + 1;
  if (fromIndex < target) target -= 1; // el hueco que deja quitar `from` desplaza los índices posteriores
  return target;
}

/**
 * Arrastra el borde izquierdo o derecho de un clip para recortarlo
 * directamente en la timeline, con imán al playhead y a los extremos
 * del archivo de origen. Solo se registra UN paso en el historial de
 * deshacer, al soltar — no uno por cada píxel arrastrado.
 */
function beginTrimDrag(event: PointerEvent, clipIndex: number, handle: "left" | "right"): void {
  if (!timeline) return;
  event.preventDefault();
  event.stopPropagation();

  const dragStartTimeline = timeline;
  const maybeOriginalClip = dragStartTimeline.track.clips[clipIndex];
  if (!maybeOriginalClip) return;
  const originalClip = maybeOriginalClip;
  const entry = sources.get(originalClip.sourceId);
  const sourceDurationTicks = entry?.sourceFile.durationTicks ?? originalClip.sourceOutTicks;
  const minDuration = frameDurationTicks(dragStartTimeline.outputFrameRate);
  const clipStart = clipStartTicks(dragStartTimeline, clipIndex);
  const clipDuration = originalClip.sourceOutTicks - originalClip.sourceInTicks;
  const playheadSourceTicks =
    playheadTicks >= clipStart && playheadTicks < clipStart + clipDuration
      ? originalClip.sourceInTicks + (playheadTicks - clipStart)
      : undefined;
  const startClientX = event.clientX;
  const snapThresholdTicks = Math.max(1, secondsToTicks(SNAP_PIXELS / pixelsPerSecond));

  function snap(value: number, candidates: number[]): number {
    for (const candidate of candidates) {
      if (Math.abs(value - candidate) <= snapThresholdTicks) return candidate;
    }
    return value;
  }

  function onMove(moveEvent: PointerEvent): void {
    const deltaTicks = secondsToTicks((moveEvent.clientX - startClientX) / pixelsPerSecond);
    let appliedValue: number;
    if (handle === "left") {
      const candidates = [0, ...(playheadSourceTicks !== undefined ? [playheadSourceTicks] : [])];
      const snapped = snap(originalClip.sourceInTicks + deltaTicks, candidates);
      appliedValue = Math.max(0, Math.min(snapped, originalClip.sourceOutTicks - minDuration));
      timeline = trimClipIn(dragStartTimeline, clipIndex, appliedValue, minDuration);
    } else {
      const candidates = [
        sourceDurationTicks,
        ...(playheadSourceTicks !== undefined ? [playheadSourceTicks] : []),
      ];
      const snapped = snap(originalClip.sourceOutTicks + deltaTicks, candidates);
      appliedValue = Math.min(sourceDurationTicks, Math.max(snapped, originalClip.sourceInTicks + minDuration));
      timeline = trimClipOut(dragStartTimeline, clipIndex, appliedValue, minDuration);
    }
    refreshTimelineLayout();
    if (selectedClipIndex === clipIndex) {
      const updated = timeline.track.clips[clipIndex]!;
      trimInInput.value = String(ticksToSeconds(updated.sourceInTicks));
      trimOutInput.value = String(ticksToSeconds(updated.sourceOutTicks));
    }
    showFloatingTooltip(
      moveEvent.clientX,
      moveEvent.clientY,
      `${handle === "left" ? "Entrada" : "Salida"}: ${formatRulerTime(ticksToSeconds(appliedValue))}`,
    );
  }

  function onUp(): void {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    hideFloatingTooltip();
    if (timeline && timeline !== dragStartTimeline) {
      pushHistory(dragStartTimeline);
      void seekToTimelineTicks(clipStartTicks(timeline, clipIndex));
      status.textContent = "Recorte aplicado.";
    }
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function renderTimeline(): void {
  timelineTrack.innerHTML = "";
  if (!timeline) return;

  timeline.track.clips.forEach((clip, index) => {
    const entry = sources.get(clip.sourceId);
    const durationTicks = clip.sourceOutTicks - clip.sourceInTicks;

    const block = document.createElement("div");
    block.className = "timeline-clip" + (index === selectedClipIndex ? " selected" : "");
    block.style.width = `${ticksToSeconds(durationTicks) * pixelsPerSecond}px`;
    if (entry?.thumbnail) block.style.backgroundImage = `url(${entry.thumbnail})`;
    block.draggable = true;
    block.dataset.index = String(index);

    const name = document.createElement("span");
    name.className = "clip-name";
    name.textContent = entry?.fileName ?? clip.sourceId;

    const duration = document.createElement("span");
    duration.className = "clip-duration";
    duration.textContent = `${ticksToSeconds(durationTicks).toFixed(2)}s`;

    const removeBtn = document.createElement("button");
    removeBtn.className = "clip-remove";
    removeBtn.type = "button";
    removeBtn.textContent = "×";
    removeBtn.title = "Eliminar clip";
    removeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      removeClipAt(index);
    });

    const leftHandle = document.createElement("div");
    leftHandle.className = "trim-handle trim-handle-left";
    leftHandle.draggable = false;
    leftHandle.title = "Arrastra para recortar la entrada";
    leftHandle.addEventListener("pointerdown", (event) => beginTrimDrag(event, index, "left"));

    const rightHandle = document.createElement("div");
    rightHandle.className = "trim-handle trim-handle-right";
    rightHandle.draggable = false;
    rightHandle.title = "Arrastra para recortar la salida";
    rightHandle.addEventListener("pointerdown", (event) => beginTrimDrag(event, index, "right"));

    block.append(name, duration, removeBtn, leftHandle, rightHandle);

    block.addEventListener("click", () => selectClip(index));

    block.addEventListener("dragstart", (event) => {
      dragFromIndex = index;
      event.dataTransfer?.setData("text/plain", String(index));
      event.dataTransfer!.effectAllowed = "move";
    });
    block.addEventListener("dragover", (event) => {
      event.preventDefault();
      const insertBefore = isInsertBefore(block, event.clientX);
      block.classList.toggle("drag-over-before", insertBefore);
      block.classList.toggle("drag-over-after", !insertBefore);
    });
    block.addEventListener("dragleave", () => {
      block.classList.remove("drag-over-before", "drag-over-after");
    });
    block.addEventListener("drop", (event) => {
      event.preventDefault();
      const insertBefore = isInsertBefore(block, event.clientX);
      block.classList.remove("drag-over-before", "drag-over-after");
      if (dragFromIndex === undefined) return;
      moveClip(dragFromIndex, resolveDropTarget(dragFromIndex, index, insertBefore));
      dragFromIndex = undefined;
    });
    block.addEventListener("dragend", () => {
      dragFromIndex = undefined;
    });

    timelineTrack.appendChild(block);
  });

  deleteClipButton.disabled = selectedClipIndex === undefined;
}

/** Fila de forma de onda bajo los clips de vídeo — mismos anchos/posiciones, para que quede claro que el audio va pegado a cada clip. */
function renderAudioTrack(): void {
  timelineAudioTrack.innerHTML = "";
  if (!timeline) return;

  timeline.track.clips.forEach((clip) => {
    const entry = sources.get(clip.sourceId);
    const durationTicks = clip.sourceOutTicks - clip.sourceInTicks;
    const widthPx = Math.max(1, ticksToSeconds(durationTicks) * pixelsPerSecond);

    const cell = document.createElement("div");
    cell.className = "timeline-audio-cell";
    cell.style.width = `${widthPx}px`;

    if (entry?.waveformPeaks && entry.waveformPeaks.length > 0) {
      const cellCanvas = document.createElement("canvas");
      cellCanvas.width = Math.round(widthPx);
      cellCanvas.height = 32;
      const cellCtx = cellCanvas.getContext("2d");
      if (cellCtx) {
        const sourceDurationTicks = entry.sourceFile.durationTicks || 1;
        const sliceStart = clip.sourceInTicks / sourceDurationTicks;
        const sliceEnd = clip.sourceOutTicks / sourceDurationTicks;
        drawWaveformSlice(
          cellCtx,
          entry.waveformPeaks,
          sliceStart,
          sliceEnd,
          cellCanvas.width,
          cellCanvas.height,
          "#6cc0ff",
        );
      }
      cell.appendChild(cellCanvas);
    } else {
      cell.classList.add("no-audio");
      cell.title = "Este clip no tiene audio";
    }

    timelineAudioTrack.appendChild(cell);
  });
}

function selectClip(index: number): void {
  const clip = timeline?.track.clips[index];
  if (!clip) return;
  selectedClipIndex = index;
  trimInInput.value = String(ticksToSeconds(clip.sourceInTicks));
  trimOutInput.value = String(ticksToSeconds(clip.sourceOutTicks));
  renderTimeline();
}

function moveClip(from: number, to: number): void {
  if (!timeline || to < 0 || to >= timeline.track.clips.length) return;
  commitTimeline(reorderClip(timeline, from, to));
  if (selectedClipIndex === from) selectedClipIndex = to;
  else if (selectedClipIndex === to) selectedClipIndex = from;
  refreshTimelineLayout();
  void seekToTimelineTicks(playheadTicks);
}

function removeClipAt(index: number): void {
  if (!timeline) return;
  if (timeline.track.clips.length === 1) {
    status.textContent = "No se puede eliminar el único clip de la pista.";
    return;
  }
  stopPlayback();
  commitTimeline(removeClip(timeline, index));
  if (selectedClipIndex === index) selectedClipIndex = undefined;
  else if (selectedClipIndex !== undefined && selectedClipIndex > index) selectedClipIndex -= 1;
  refreshTimelineLayout();
  void seekToTimelineTicks(0);
}

function enableEditingControls(): void {
  trimControls.disabled = false;
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

async function addClipFromFile(file: File): Promise<void> {
  status.textContent = `Cargando ${file.name}...`;
  try {
    const { videoTrack, samples } = await decodeAllSamples(file);
    const demuxed = { videoTrack, samples };
    const sourceId = `source-${nextSourceNumber++}`;
    const sourceFile = toSourceFile(sourceId, videoTrack, samples);
    const thumbnail = await generateThumbnail(demuxed).catch((error: unknown) => {
      console.warn("No se pudo generar la miniatura del clip:", error);
      return undefined;
    });
    const { audio, waveformPeaks } = await loadAudioForSource(file);
    sources.set(sourceId, {
      sourceFile,
      demuxed,
      fileName: file.name,
      ...(thumbnail ? { thumbnail } : {}),
      ...(audio ? { audio } : {}),
      ...(waveformPeaks ? { waveformPeaks } : {}),
    });

    const clip: Clip = {
      id: `clip-${nextClipNumber++}`,
      sourceId,
      sourceInTicks: 0,
      sourceOutTicks: sourceFile.durationTicks,
    };

    if (!timeline) {
      commitTimeline({
        track: { id: "track-1", clips: [clip] },
        outputResolution: { width: sourceFile.width, height: sourceFile.height },
        outputFrameRate: sourceFile.frameRate,
      });
      canvas.width = sourceFile.width;
      canvas.height = sourceFile.height;
    } else {
      commitTimeline(appendClip(timeline, clip));
    }

    // `commitTimeline` reasigna `timeline` por efecto secundario, algo
    // que TS no rastrea a través de la llamada — requireTimeline() da
    // una referencia ya no-nulable para el resto de la función.
    const currentTimeline = requireTimeline();
    const newClipIndex = currentTimeline.track.clips.length - 1;
    if (!hasAutoFitted) {
      hasAutoFitted = true;
      zoomToFit();
    } else {
      refreshTimelineLayout();
    }
    enableEditingControls();

    selectClip(newClipIndex);
    await seekToTimelineTicks(clipStartTicks(currentTimeline, newClipIndex));
    status.textContent = `${file.name} añadido — ${sourceFile.width}x${sourceFile.height} @ ${sourceFile.frameRate.numerator}/${sourceFile.frameRate.denominator} fps${audio ? " · con audio" : " · sin audio"}.`;
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

applyTrimButton.addEventListener("click", () => {
  if (!timeline || selectedClipIndex === undefined) {
    status.textContent = "Selecciona un clip de la línea de tiempo primero.";
    return;
  }
  const clip = timeline.track.clips[selectedClipIndex]!;
  const maxOutTicks = sources.get(clip.sourceId)?.sourceFile.durationTicks ?? Number.POSITIVE_INFINITY;
  const minDuration = frameDurationTicks(timeline.outputFrameRate);
  const inTicks = Math.max(0, secondsToTicks(Number(trimInInput.value)));
  const outTicks = Math.min(secondsToTicks(Number(trimOutInput.value)), maxOutTicks);
  let next: Timeline;
  try {
    next = trimClipOut(timeline, selectedClipIndex, outTicks, minDuration);
    next = trimClipIn(next, selectedClipIndex, inTicks, minDuration);
  } catch (error) {
    status.textContent = `Error de recorte: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  commitTimeline(next);
  refreshTimelineLayout();
  void seekToTimelineTicks(clipStartTicks(timeline, selectedClipIndex));
  status.textContent = "Recorte aplicado.";
});

splitButton.addEventListener("click", splitAtPlayhead);
deleteClipButton.addEventListener("click", () => {
  if (selectedClipIndex !== undefined) removeClipAt(selectedClipIndex);
});
playButton.addEventListener("click", playFromPlayhead);
pauseButton.addEventListener("click", stopPlayback);

previewZoomButton.addEventListener("click", () => {
  previewZoomed100 = !previewZoomed100;
  previewWrap.classList.toggle("zoomed-100", previewZoomed100);
  previewZoomButton.textContent = previewZoomed100 ? "100%" : "Ajustado";
});

window.addEventListener("resize", () => refreshTimelineLayout());

// --- Marcadores ---

function addMarkerAtPlayhead(): void {
  if (!timeline) return;
  markers.push({ id: `marker-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ticks: playheadTicks });
  markers.sort((a, b) => a.ticks - b.ticks);
  renderMarkers();
}

function removeMarker(id: string): void {
  markers = markers.filter((marker) => marker.id !== id);
  renderMarkers();
}

function renderMarkers(): void {
  timelineRuler.querySelectorAll(".ruler-marker").forEach((el) => el.remove());
  for (const marker of markers) {
    const flag = document.createElement("div");
    flag.className = "ruler-marker";
    flag.style.left = `${Math.round(ticksToSeconds(marker.ticks) * pixelsPerSecond)}px`;
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
// recortar clips sin tener que remapearlos.

function addTextOverlayFromForm(): void {
  if (!timeline) return;
  const text = textContentInput.value.trim();
  if (!text) {
    status.textContent = "Escribe algo de texto antes de añadirlo.";
    return;
  }
  const startTicks = Math.max(0, secondsToTicks(Number(textStartInput.value)));
  const endTicks = secondsToTicks(Number(textEndInput.value));
  if (endTicks <= startTicks) {
    status.textContent = "El fin del texto debe ser posterior al inicio.";
    return;
  }
  textOverlays.push({
    id: `text-${nextOverlayNumber++}`,
    startTicks,
    endTicks,
    text,
    xPercent: Number(textXInput.value),
    yPercent: Number(textYInput.value),
    fontSizePx: Number(textSizeInput.value),
    color: textColorInput.value,
  });
  renderTextOverlayList();
  void seekToTimelineTicks(playheadTicks); // redibuja el preview para que se vea si cae en rango
  status.textContent = "Texto añadido.";
}

function removeTextOverlay(id: string): void {
  textOverlays = textOverlays.filter((overlay) => overlay.id !== id);
  renderTextOverlayList();
  void seekToTimelineTicks(playheadTicks);
}

function renderTextOverlayList(): void {
  textOverlayList.innerHTML = "";
  for (const overlay of textOverlays) {
    const li = document.createElement("li");
    const jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "marker-jump";
    jumpBtn.textContent = `"${overlay.text}" (${formatRulerTime(ticksToSeconds(overlay.startTicks))}–${formatRulerTime(ticksToSeconds(overlay.endTicks))})`;
    jumpBtn.addEventListener("click", () => void seekToTimelineTicks(overlay.startTicks));
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "marker-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "Eliminar texto";
    removeBtn.addEventListener("click", () => removeTextOverlay(overlay.id));
    li.append(jumpBtn, removeBtn);
    textOverlayList.appendChild(li);
  }
}

addTextButton.addEventListener("click", addTextOverlayFromForm);

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
    case "m":
    case "M":
      event.preventDefault();
      if (!addMarkerButton.disabled) addMarkerAtPlayhead();
      break;
    case "Delete":
    case "Backspace":
      if (selectedClipIndex !== undefined) {
        event.preventDefault();
        removeClipAt(selectedClipIndex);
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

exportButton.addEventListener("click", () => {
  if (!timeline) return;
  void runExport(timeline);
});

async function runExport(timelineToExport: Timeline): Promise<void> {
  stopPlayback();
  exportButton.disabled = true;
  exportStatus.textContent = "Exportando...";
  exportDownload.innerHTML = "";
  try {
    const blob = await exportTimelineToMp4({
      timeline: timelineToExport,
      getSource: (sourceId) => sources.get(sourceId)?.demuxed,
      getAudio: (sourceId) => sources.get(sourceId)?.audio,
      textOverlays,
      onProgress: (done, total) => {
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
    console.error(error);
    exportStatus.textContent = `Error de exportación: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    exportButton.disabled = false;
  }
}

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

loadProjectButton.addEventListener("click", () => projectFileInput.click());

projectFileInput.addEventListener("change", () => {
  const file = projectFileInput.files?.[0];
  projectFileInput.value = "";
  if (!file) return;
  void handleProjectFileSelected(file);
});

async function handleProjectFileSelected(file: File): Promise<void> {
  try {
    const text = await file.text();
    const parsed = parseProjectFile(JSON.parse(text));
    pendingProject = parsed;
    const names = parsed.sources.map((source) => source.fileName).join(", ");
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

async function applyPendingProject(project: ProjectFile, files: File[]): Promise<void> {
  const byName = new Map(files.map((file) => [file.name, file]));
  const missing = project.sources.filter((source) => !byName.has(source.fileName));
  if (missing.length > 0) {
    projectStatus.textContent = `Faltan archivos: ${missing.map((s) => s.fileName).join(", ")}. Selecciónalos todos a la vez.`;
    return;
  }

  stopPlayback();
  projectStatus.textContent = "Cargando archivos del proyecto...";
  const newSources = new Map<string, SourceEntry>();
  try {
    for (const projectSource of project.sources) {
      const file = byName.get(projectSource.fileName)!;
      const { videoTrack, samples } = await decodeAllSamples(file);
      const demuxed = { videoTrack, samples };
      const thumbnail = await generateThumbnail(demuxed).catch((error: unknown) => {
        console.warn("No se pudo generar la miniatura del clip:", error);
        return undefined;
      });
      const { audio, waveformPeaks } = await loadAudioForSource(file);
      newSources.set(projectSource.id, {
        sourceFile: {
          id: projectSource.id,
          frameRate: projectSource.frameRate,
          width: projectSource.width,
          height: projectSource.height,
          durationTicks: projectSource.durationTicks,
        },
        demuxed,
        fileName: projectSource.fileName,
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
  for (const [id, entry] of newSources) sources.set(id, entry);

  timeline = {
    track: { id: "track-1", clips: project.clips },
    outputResolution: project.outputResolution,
    outputFrameRate: project.outputFrameRate,
  };
  historyPast = [];
  historyFuture = [];
  updateHistoryButtons();
  markers = project.markers.map((marker) => ({ ...marker }));
  textOverlays = project.textOverlays.map((overlay) => ({ ...overlay }));
  renderTextOverlayList();
  selectedClipIndex = timeline.track.clips.length > 0 ? 0 : undefined;
  playingClipIndex = undefined;
  playheadTicks = 0;

  canvas.width = project.outputResolution.width;
  canvas.height = project.outputResolution.height;

  enableEditingControls();
  nextSourceNumber = newSources.size + 1;
  nextClipNumber = timeline.track.clips.length + 1;

  hasAutoFitted = true;
  zoomToFit();
  if (selectedClipIndex !== undefined) selectClip(selectedClipIndex);
  await seekToTimelineTicks(0);
  projectStatus.textContent = "Proyecto cargado.";
}
