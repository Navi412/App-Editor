import { frameDurationTicks, ticksToSeconds } from "../core/time";
import {
  allAudioSchedules,
  clipDurationTicks,
  resolveActiveVideoPosition,
  resolveActiveVideoPositionBelow,
  timelineDurationTicks,
} from "../core/timeline";
import { ColorGradeRenderer } from "../media/colorGradeGL";
import type { Clip, Timeline, Track } from "../core/types";
import { activeTextOverlaysAt, type TextOverlay } from "../core/textOverlay";
import { playAudioSlice } from "../media/audioPlayer";
import { createMasterAudioChain } from "../media/masterAudioChain";
import { drawFrameFit, lookForClip } from "../media/render";
import { resolveVideoLayers } from "../core/transform";
import type { DemuxedTrack } from "../media/samples";
import { createForwardFrameSeeker, type FrameSeeker } from "../media/frameSeeker";
import { yieldToTaskQueue } from "../media/scheduling";
import { drawTextOverlays } from "../media/textOverlayRender";
import {
  captureTransitionBoundaryFrames,
  drawTransitionFrame,
  type TransitionBoundaryFrames,
} from "../media/transitionRender";
import { createMp4Muxer, type Mp4Muxer } from "./muxer";

const DEFAULT_BITRATE = 8_000_000;
const KEYFRAME_INTERVAL_SECONDS = 2;
const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_CHANNELS = 2;
const AUDIO_BITRATE = 128_000;
const AUDIO_FRAME_SIZE = 1024;

export class ExportCancelledError extends Error {
  constructor() {
    super("Exportación cancelada");
    this.name = "ExportCancelledError";
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ExportCancelledError();
}

// Candidatos de códec en orden de preferencia (perfil/nivel de mayor a
// menor capacidad). Un nivel alto (p.ej. High 4.0) puede no soportar
// hardware o resoluciones concretas en todos los navegadores —
// isConfigSupported() decide cuál usar en vez de asumirlo.
const CODEC_CANDIDATES = ["avc1.640028", "avc1.4d0028", "avc1.42001f"];
// H.265 (mejora del 2026-10-05): archivos ~40 % más pequeños a igual
// calidad. Main a niveles 4.1/5.0/5.1 (hasta 4K). En Chromium solo hay
// codificador HEVC por hardware, así que puede no estar disponible.
const HEVC_CODEC_CANDIDATES = ["hvc1.1.6.L123.B0", "hvc1.1.6.L150.B0", "hvc1.1.6.L153.B0"];

export type ExportVideoCodec = "avc" | "hevc";

// Se prueba primero CON aceleración por hardware (NVENC/QuickSync/etc. — la
// exportación es la parte más intensiva en cómputo de todo el pipeline, así
// que es donde más se nota) y solo se cae a "no-preference" (el navegador
// decide, puede acabar en software) si ningún candidato de códec soporta
// hardware — mejor exportar más lento que no exportar.
const HARDWARE_PREFERENCES: HardwareAcceleration[] = ["prefer-hardware", "no-preference"];

async function selectSupportedEncoderConfig(
  base: Omit<VideoEncoderConfig, "codec" | "hardwareAcceleration">,
  videoCodec: ExportVideoCodec = "avc",
): Promise<VideoEncoderConfig> {
  const candidates = videoCodec === "hevc" ? HEVC_CODEC_CANDIDATES : CODEC_CANDIDATES;
  for (const hardwareAcceleration of HARDWARE_PREFERENCES) {
    for (const codec of candidates) {
      const config: VideoEncoderConfig = { ...base, codec, hardwareAcceleration };
      try {
        const support = await VideoEncoder.isConfigSupported(config);
        if (support.supported) return config;
      } catch {
        // seguir probando el siguiente candidato
      }
    }
  }
  throw new Error(
    videoCodec === "hevc"
      ? "Este equipo no puede codificar H.265 a esta resolución (necesita codificador por hardware). Exporta en H.264."
      : "Ningún códec H.264 candidato es compatible con este navegador para esta resolución",
  );
}

export interface ExportOptions {
  timeline: Timeline;
  getSource: (sourceId: string) => DemuxedTrack | undefined;
  /** Audio ya decodificado de cada fuente (undefined si esa fuente no tiene audio) — ver DESIGN.md/CLAUDE.md sobre el audio ligado al clip. */
  getAudio?: (sourceId: string) => AudioBuffer | undefined;
  textOverlays?: TextOverlay[];
  onProgress?: (framesDone: number, totalFrames: number) => void;
  bitrate?: number;
  /** Si se aborta, la exportación se detiene lanzando ExportCancelledError en el siguiente punto de comprobación (por fotograma de vídeo, o por bloque de audio). */
  signal?: AbortSignal;
  /** Exportar solo este tramo de la timeline (marcas de entrada/salida, mejora del 2026-10-05). Sin él, la timeline entera. */
  range?: { startTicks: number; endTicks: number };
  /** Códec de vídeo de salida (por defecto H.264). */
  videoCodec?: ExportVideoCodec;
}

/**
 * Exporta la timeline completa a un único MP4 nuevo. No concatena los
 * archivos de origen — decodifica, compone y re-codifica cada
 * fotograma de salida (y remuestrea/recodifica el audio). Ver
 * DESIGN.md §5 sobre por qué no hay atajo.
 *
 * Recorre la timeline en ticks crecientes de principio a fin (nunca
 * hacia atrás), así que cada fuente de vídeo se decodifica de forma
 * secuencial con un único FrameSeeker por fuente — ver media/frameSeeker.ts.
 */
export async function exportTimelineToMp4(options: ExportOptions): Promise<Blob> {
  const { timeline, getSource, getAudio, textOverlays = [], onProgress, signal } = options;
  const { width, height } = timeline.outputResolution;
  const outputFrameRate = timeline.outputFrameRate;
  const timelineTicksTotal = timelineDurationTicks(timeline);
  const rangeStartTicks = Math.max(0, Math.min(options.range?.startTicks ?? 0, timelineTicksTotal));
  const rangeEndTicks = Math.max(rangeStartTicks, Math.min(options.range?.endTicks ?? timelineTicksTotal, timelineTicksTotal));
  const totalTicks = rangeEndTicks - rangeStartTicks;
  const stepTicks = frameDurationTicks(outputFrameRate);
  if (totalTicks <= 0 || stepTicks <= 0) {
    throw new Error(options.range ? "El rango a exportar está vacío" : "La timeline no tiene fotogramas que exportar");
  }
  const totalFrames = Math.ceil(totalTicks / stepTicks);
  const fps = outputFrameRate.numerator / outputFrameRate.denominator;
  const keyframeInterval = Math.max(1, Math.round(KEYFRAME_INTERVAL_SECONDS * fps));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("No se pudo crear el contexto 2D de exportación");
  }

  // Grading real/croma (ver core/types.ts) — instancia propia de la
  // exportación, independiente de la del preview en vivo (ui/main.ts),
  // igual que cada uno tiene su propio AudioContext/OfflineAudioContext.
  let gradeRenderer: ColorGradeRenderer | undefined;
  try {
    gradeRenderer = new ColorGradeRenderer();
  } catch (error) {
    console.warn("Grading real desactivado en la exportación (WebGL2 no disponible):", error);
  }

  const durationUnits = Math.round(ticksToSeconds(totalTicks) * 1_000_000);
  const videoCodec = options.videoCodec ?? "avc";
  const muxer = createMp4Muxer({ width, height, timescale: 1_000_000, durationUnits, videoCodec });

  const encoderConfig = await selectSupportedEncoderConfig({
    width,
    height,
    bitrate: options.bitrate ?? DEFAULT_BITRATE,
    framerate: fps,
    // Formato "contenedor" (avcC/hvcC fuera de banda), el que espera el muxer.
    // `hevc` aún no está en los tipos DOM de TypeScript.
    ...(videoCodec === "hevc" ? ({ hevc: { format: "hevc" } } as object) : { avc: { format: "avc" } }),
  }, videoCodec);

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => muxer.addChunk(chunk, metadata),
    error: (error) => {
      throw error;
    },
  });
  encoder.configure(encoderConfig);

  // Un lector secuencial por (pista, fuente): con composición por capas,
  // dos pistas pueden usar la misma fuente en instantes distintos a la
  // vez, y un FrameSeeker solo sabe avanzar.
  const seekers = new Map<string, FrameSeeker>();
  function seekerFor(trackId: string, sourceId: string): FrameSeeker {
    const key = `${trackId}|${sourceId}`;
    let seeker = seekers.get(key);
    if (!seeker) {
      const demuxed = getSource(sourceId);
      if (!demuxed) throw new Error(`Fuente no encontrada: ${sourceId}`);
      seeker = createForwardFrameSeeker(demuxed);
      seekers.set(key, seeker);
    }
    return seeker;
  }

  // Los fotogramas fijos que delimitan cada transición se decodifican
  // una sola vez (no uno por cada fotograma de salida dentro de su
  // ventana) y se reutilizan mientras dure el export.
  const transitionFramesCache = new Map<string, TransitionBoundaryFrames>();
  async function transitionFramesFor(track: Track, transitionClip: Clip): Promise<TransitionBoundaryFrames> {
    let frames = transitionFramesCache.get(transitionClip.id);
    if (!frames) {
      frames = await captureTransitionBoundaryFrames(track, transitionClip, getSource, width, height);
      transitionFramesCache.set(transitionClip.id, frames);
    }
    return frames;
  }

  try {
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      throwIfAborted(signal);
      const timelineTicks = rangeStartTicks + frameIndex * stepTicks;

      // Composición por capas (resolveVideoLayers, mejora del 2026-10-05):
      // de abajo a arriba, hasta la primera que tapa el fotograma entero.
      // Lo normal es UNA capa (un clip sin transformar), el dibujo de
      // siempre. El croma ya no es un caso aparte: una capa con croma no
      // tapa, así que la de debajo se pinta antes.
      ctx.clearRect(0, 0, width, height);
      for (const layer of resolveVideoLayers(timeline, timelineTicks)) {
        if (layer.clip.kind === "transition") {
          const track = timeline.tracks.find((t) => t.id === layer.trackId)!;
          const frames = await transitionFramesFor(track, layer.clip);
          const duration = clipDurationTicks(layer.clip);
          const progress = duration > 0 ? layer.offsetTicks / duration : 0;
          drawTransitionFrame(ctx, width, height, layer.clip.transitionType ?? "crossfade", frames, progress);
          continue;
        }
        const sourceTimeUs = Math.round(ticksToSeconds(layer.sourceTimeTicks) * 1_000_000);
        const frame = await seekerFor(layer.trackId, layer.sourceId).next(sourceTimeUs);
        if (!frame) continue;
        drawFrameFit(ctx, frame, { width, height }, lookForClip(layer.clip, timeline.luts), gradeRenderer, false, layer.transform);
        frame.close();
      }

      const activeOverlays = activeTextOverlaysAt(textOverlays, timelineTicks);
      if (activeOverlays.length > 0) {
        drawTextOverlays(ctx, activeOverlays, width, height);
      }

      // Timestamp de salida calculado como producto exacto antes de
      // redondear (mismo principio que sourceFrameIndexToTicks en
      // core/time.ts) para no acumular error de redondeo fotograma a fotograma.
      const outputTimestampUs = Math.round(
        (frameIndex * outputFrameRate.denominator * 1_000_000) / outputFrameRate.numerator,
      );
      const outputFrame = new VideoFrame(canvas, { timestamp: outputTimestampUs });
      encoder.encode(outputFrame, { keyFrame: frameIndex % keyframeInterval === 0 });
      outputFrame.close();

      while (encoder.encodeQueueSize > 2) {
        await yieldToTaskQueue();
      }

      onProgress?.(frameIndex + 1, totalFrames);
    }

    await encoder.flush();

    if (getAudio) {
      await exportAudioTrack(timeline, getAudio, muxer, signal, rangeStartTicks, rangeEndTicks);
    }
  } finally {
    encoder.close();
    for (const seeker of seekers.values()) seeker.destroy();
    for (const frames of transitionFramesCache.values()) {
      frames.fromImage?.close();
      frames.toImage?.close();
    }
    gradeRenderer?.destroy();
  }

  return muxer.finalize();
}

/**
 * Renderiza el audio de toda la timeline en una sola pasada de
 * OfflineAudioContext: cada franja de allAudioSchedules (ver
 * core/timeline.ts) se programa directamente en su `startTicks` — el
 * propio OfflineAudioContext remuestrea si la fuente no está ya al
 * sample rate del proyecto. allAudioSchedules ya recorre TODAS las
 * pistas no ocultas (el audio pegado a los clips de las pistas de
 * vídeo Y los clips propios de las pistas de audio, ver CLAUDE.md —
 * ampliación de alcance multipista del 2026-08-21) y ya resuelve el
 * fundido cruzado de las transiciones — misma función pura de /core
 * que usa la reproducción en directo en ui/main.ts, así preview y
 * export nunca pueden divergir en qué suena. Las franjas cuya fuente
 * no tiene audio simplemente no conectan nada ahí: quedan en silencio,
 * sin desincronizar el resto.
 */
async function renderExportAudio(timeline: Timeline, getAudio: (sourceId: string) => AudioBuffer | undefined): Promise<AudioBuffer> {
  const totalSeconds = Math.max(ticksToSeconds(timelineDurationTicks(timeline)), 1 / AUDIO_SAMPLE_RATE);
  const totalFrames = Math.max(1, Math.ceil(totalSeconds * AUDIO_SAMPLE_RATE));
  const offline = new OfflineAudioContext(AUDIO_CHANNELS, totalFrames, AUDIO_SAMPLE_RATE);
  const masterChain = createMasterAudioChain(offline, offline.destination, timeline.masterAudio);

  for (const schedule of allAudioSchedules(timeline)) {
    const sourceBuffer = getAudio(schedule.sourceId);
    if (!sourceBuffer) continue;
    playAudioSlice(
      offline,
      masterChain.input,
      sourceBuffer,
      ticksToSeconds(schedule.sourceStartTicks),
      ticksToSeconds(schedule.durationTicks),
      ticksToSeconds(schedule.startTicks),
      schedule.automation,
      schedule.playbackRate,
    );
  }

  return offline.startRendering();
}

async function exportAudioTrack(
  timeline: Timeline,
  getAudio: (sourceId: string) => AudioBuffer | undefined,
  muxer: Mp4Muxer,
  signal: AbortSignal | undefined,
  rangeStartTicks: number,
  rangeEndTicks: number,
): Promise<void> {
  const hasAnyAudio = allAudioSchedules(timeline).some((schedule) => getAudio(schedule.sourceId) !== undefined);
  if (!hasAnyAudio) return;

  const buffer = await renderExportAudio(timeline, getAudio);
  const support = await AudioEncoder.isConfigSupported({
    codec: "mp4a.40.2",
    sampleRate: buffer.sampleRate,
    numberOfChannels: buffer.numberOfChannels,
    bitrate: AUDIO_BITRATE,
  });
  if (!support.supported) {
    throw new Error("La codificación de audio AAC no está soportada en este navegador");
  }

  const encoder = new AudioEncoder({
    output: (chunk, metadata) => muxer.addAudioChunk(chunk, metadata),
    error: (error) => {
      throw error;
    },
  });
  encoder.configure({
    codec: "mp4a.40.2",
    sampleRate: buffer.sampleRate,
    numberOfChannels: buffer.numberOfChannels,
    bitrate: AUDIO_BITRATE,
  });

  const channelData: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    channelData.push(buffer.getChannelData(channel));
  }

  // Solo el tramo exportado (el render cubre la timeline entera: así las
  // colas de las transiciones y la automatización salen igual que en ella).
  const firstFrame = Math.min(buffer.length, Math.round(ticksToSeconds(rangeStartTicks) * buffer.sampleRate));
  const endFrame = Math.min(buffer.length, Math.round(ticksToSeconds(rangeEndTicks) * buffer.sampleRate));

  try {
    for (let start = firstFrame; start < endFrame; start += AUDIO_FRAME_SIZE) {
      throwIfAborted(signal);
      const frameLength = Math.min(AUDIO_FRAME_SIZE, endFrame - start);
      const planar = new Float32Array(frameLength * buffer.numberOfChannels);
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        planar.set(channelData[channel]!.subarray(start, start + frameLength), channel * frameLength);
      }
      const timestampUs = Math.round(((start - firstFrame) / buffer.sampleRate) * 1_000_000);
      const audioData = new AudioData({
        format: "f32-planar",
        sampleRate: buffer.sampleRate,
        numberOfFrames: frameLength,
        numberOfChannels: buffer.numberOfChannels,
        timestamp: timestampUs,
        data: planar,
      });
      encoder.encode(audioData);
      audioData.close();

      while (encoder.encodeQueueSize > 4) {
        await yieldToTaskQueue();
      }
    }

    await encoder.flush();
  } finally {
    encoder.close();
  }
}
