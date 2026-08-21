import { frameDurationTicks, ticksToSeconds } from "../core/time";
import {
  audioHeadCutTicks,
  audioTailCutTicks,
  clipDurationTicks,
  clipStartTicks,
  timelineDurationTicks,
  transitionAudioCues,
  volumeAutomationFrom,
  walkTimeline,
} from "../core/timeline";
import type { Timeline } from "../core/types";
import { activeTextOverlaysAt, type TextOverlay } from "../core/textOverlay";
import { playAudioSlice } from "../media/audioPlayer";
import { drawFrameFit } from "../media/render";
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
  async function transitionFramesFor(clipIndex: number, transitionId: string): Promise<TransitionBoundaryFrames> {
    let frames = transitionFramesCache.get(transitionId);
    if (!frames) {
      frames = await captureTransitionBoundaryFrames(timeline, clipIndex, getSource, width, height);
      transitionFramesCache.set(transitionId, frames);
    }
    return frames;
  }

  try {
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      throwIfAborted(signal);
      const timelineTicks = frameIndex * stepTicks;
      const position = walkTimeline(timeline, timelineTicks);
      if (!position) break;

      if (position.clip.kind === "gap") {
        ctx.clearRect(0, 0, width, height);
      } else if (position.clip.kind === "transition") {
        const frames = await transitionFramesFor(position.clipIndex, position.clip.id);
        const clipStart = clipStartTicks(timeline, position.clipIndex);
        const duration = clipDurationTicks(position.clip);
        const progress = duration > 0 ? (timelineTicks - clipStart) / duration : 0;
        drawTransitionFrame(ctx, width, height, position.clip.transitionType ?? "crossfade", frames, progress);
      } else {
        const sourceTimeUs = Math.round(ticksToSeconds(position.sourceTimeTicks) * 1_000_000);
        const frame = await seekerFor(position.sourceId).next(sourceTimeUs);
        if (frame) {
          drawFrameFit(ctx, frame, { width, height }, position.clip.colorFilter);
          frame.close();
        } else {
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
  }

  return muxer.finalize();
}

/**
 * Renderiza el audio de toda la timeline en una sola pasada de
 * OfflineAudioContext: cada clip se programa a su posición acumulada
 * (mismo criterio de "ripple" que /core) — el propio OfflineAudioContext
 * remuestrea si la fuente no está ya al sample rate del proyecto. Los
 * clips cuya fuente no tiene audio simplemente no conectan nada ahí:
 * queda en silencio, sin desincronizar el resto.
 *
 * Una transición no tiene audio propio, pero tampoco deja un hueco de
 * silencio: la franja de audio que le corresponde se resta de la
 * reproducción normal del clip saliente/entrante (audioHeadCutTicks/
 * audioTailCutTicks) y se reproduce ahí, con fundido cruzado
 * (transitionAudioCues) — mismas funciones puras de /core que usa la
 * reproducción en directo en ui/main.ts, así preview y export nunca
 * pueden divergir en esto.
 */
async function renderExportAudio(timeline: Timeline, getAudio: (sourceId: string) => AudioBuffer | undefined): Promise<AudioBuffer> {
  const totalSeconds = Math.max(ticksToSeconds(timelineDurationTicks(timeline)), 1 / AUDIO_SAMPLE_RATE);
  const totalFrames = Math.max(1, Math.ceil(totalSeconds * AUDIO_SAMPLE_RATE));
  const offline = new OfflineAudioContext(AUDIO_CHANNELS, totalFrames, AUDIO_SAMPLE_RATE);

  const clips = timeline.track.clips;
  let cursorSeconds = 0;
  clips.forEach((clip, index) => {
    const durationSeconds = ticksToSeconds(clipDurationTicks(clip));

    if (clip.kind === "clip") {
      const sourceBuffer = getAudio(clip.sourceId);
      if (sourceBuffer && !clip.muted) {
        const headCutTicks = audioHeadCutTicks(timeline, index);
        const playDurationTicks = clipDurationTicks(clip) - headCutTicks - audioTailCutTicks(timeline, index);
        if (playDurationTicks > 0) {
          playAudioSlice(
            offline,
            sourceBuffer,
            ticksToSeconds(clip.sourceInTicks + headCutTicks),
            ticksToSeconds(playDurationTicks),
            cursorSeconds + ticksToSeconds(headCutTicks),
            volumeAutomationFrom(clip, headCutTicks),
          );
        }
      }
    } else if (clip.kind === "transition") {
      // El export siempre entra en la transición desde su propio
      // inicio (startOffsetTicks=0), nunca a mitad — a diferencia de
      // la reproducción en vivo, que puede retomarla tras un seek.
      for (const cue of transitionAudioCues(timeline, index, 0)) {
        const neighborBuffer = getAudio(clips[cue.clipIndex]?.sourceId ?? "");
        if (!neighborBuffer) continue;
        playAudioSlice(
          offline,
          neighborBuffer,
          ticksToSeconds(cue.sourceStartTicks),
          ticksToSeconds(cue.durationTicks),
          cursorSeconds,
          cue.automation,
        );
      }
    }

    cursorSeconds += durationSeconds;
  });

  return offline.startRendering();
}

async function exportAudioTrack(
  timeline: Timeline,
  getAudio: (sourceId: string) => AudioBuffer | undefined,
  muxer: Mp4Muxer,
  signal: AbortSignal | undefined,
): Promise<void> {
  const hasAnyAudio = timeline.track.clips.some((clip) => getAudio(clip.sourceId) !== undefined);
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
