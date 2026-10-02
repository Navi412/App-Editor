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

// Se prueba primero CON aceleración por hardware (NVENC/QuickSync/etc. — la
// exportación es la parte más intensiva en cómputo de todo el pipeline, así
// que es donde más se nota) y solo se cae a "no-preference" (el navegador
// decide, puede acabar en software) si ningún candidato de códec soporta
// hardware — mejor exportar más lento que no exportar.
const HARDWARE_PREFERENCES: HardwareAcceleration[] = ["prefer-hardware", "no-preference"];

async function selectSupportedEncoderConfig(
  base: Omit<VideoEncoderConfig, "codec" | "hardwareAcceleration">,
): Promise<VideoEncoderConfig> {
  for (const hardwareAcceleration of HARDWARE_PREFERENCES) {
    for (const codec of CODEC_CANDIDATES) {
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
    "Ningún códec H.264 candidato es compatible con este navegador para esta resolución",
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
  const totalTicks = timelineDurationTicks(timeline);
  const stepTicks = frameDurationTicks(outputFrameRate);
  if (totalTicks <= 0 || stepTicks <= 0) {
    throw new Error("La timeline no tiene fotogramas que exportar");
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
  const muxer = createMp4Muxer({ width, height, timescale: 1_000_000, durationUnits });

  const encoderConfig = await selectSupportedEncoderConfig({
    width,
    height,
    bitrate: options.bitrate ?? DEFAULT_BITRATE,
    framerate: fps,
    avc: { format: "avc" },
  });

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => muxer.addChunk(chunk, metadata),
    error: (error) => {
      throw error;
    },
  });
  encoder.configure(encoderConfig);

  const seekers = new Map<string, FrameSeeker>();
  function seekerFor(sourceId: string): FrameSeeker {
    let seeker = seekers.get(sourceId);
    if (!seeker) {
      const demuxed = getSource(sourceId);
      if (!demuxed) throw new Error(`Fuente no encontrada: ${sourceId}`);
      seeker = createForwardFrameSeeker(demuxed);
      seekers.set(sourceId, seeker);
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
      const timelineTicks = frameIndex * stepTicks;
      const position = resolveActiveVideoPosition(timeline, timelineTicks);

      if (!position) {
        ctx.clearRect(0, 0, width, height);
      } else if (position.clip.kind === "transition") {
        const track = timeline.tracks.find((t) => t.id === position.trackId)!;
        const frames = await transitionFramesFor(track, position.clip);
        const duration = clipDurationTicks(position.clip);
        const progress = duration > 0 ? (timelineTicks - position.clip.startTicks) / duration : 0;
        drawTransitionFrame(ctx, width, height, position.clip.transitionType ?? "crossfade", frames, progress);
      } else {
        // Croma activo: se resuelve y dibuja PRIMERO la pista de vídeo
        // visible inmediatamente inferior (si tiene contenido ahí) como
        // fondo, y el clip con croma se compone encima sin volver a
        // limpiar (clear:false) — únicamente en la exportación, ver
        // ChromaKey en core/types.ts sobre por qué el preview en directo
        // no compone dos capas.
        if (position.clip.chromaKey?.enabled) {
          const aboveTrackIndex = timeline.tracks.findIndex((t) => t.id === position.trackId);
          const below = resolveActiveVideoPositionBelow(timeline, timelineTicks, aboveTrackIndex);
          let drewBackground = false;
          if (below && below.clip.kind === "clip") {
            const belowTimeUs = Math.round(ticksToSeconds(below.sourceTimeTicks) * 1_000_000);
            const belowFrame = await seekerFor(below.sourceId).next(belowTimeUs);
            if (belowFrame) {
              drawFrameFit(ctx, belowFrame, { width, height }, lookForClip(below.clip, timeline.luts), gradeRenderer);
              belowFrame.close();
              drewBackground = true;
            }
          }
          if (!drewBackground) ctx.clearRect(0, 0, width, height);
        }

        const sourceTimeUs = Math.round(ticksToSeconds(position.sourceTimeTicks) * 1_000_000);
        const frame = await seekerFor(position.sourceId).next(sourceTimeUs);
        if (frame) {
          drawFrameFit(
            ctx,
            frame,
            { width, height },
            lookForClip(position.clip, timeline.luts),
            gradeRenderer,
            !position.clip.chromaKey?.enabled, // clear:false si ya se dibujó un fondo encima del que componer
          );
          frame.close();
        } else if (!position.clip.chromaKey?.enabled) {
          ctx.clearRect(0, 0, width, height);
        }
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
      await exportAudioTrack(timeline, getAudio, muxer, signal);
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
    );
  }

  return offline.startRendering();
}

async function exportAudioTrack(
  timeline: Timeline,
  getAudio: (sourceId: string) => AudioBuffer | undefined,
  muxer: Mp4Muxer,
  signal: AbortSignal | undefined,
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

  try {
    for (let start = 0; start < buffer.length; start += AUDIO_FRAME_SIZE) {
      throwIfAborted(signal);
      const frameLength = Math.min(AUDIO_FRAME_SIZE, buffer.length - start);
      const planar = new Float32Array(frameLength * buffer.numberOfChannels);
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        planar.set(channelData[channel]!.subarray(start, start + frameLength), channel * frameLength);
      }
      const timestampUs = Math.round((start / buffer.sampleRate) * 1_000_000);
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
