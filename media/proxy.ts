import { createForwardFrameSeeker } from "./frameSeeker";
import { drawFrameFit } from "./render";
import { sampleDurationUs, sampleTimestampUs } from "./sampleTime";
import type { DemuxedSample, DemuxedTrack } from "./samples";
import { yieldToTaskQueue } from "./scheduling";
import { frameRateOf } from "./sourceFile";

/**
 * Proxies de edición — mejora pedida el 2026-10-05.
 *
 * Una fuente pesada (1440p/4K, o AV1/HEVC/VP9 con keyframes cada varios
 * segundos, como las grabaciones de OBS) hace que cada salto del
 * playhead decodifique cientos de fotogramas grandes. El proxy es una
 * copia ligera solo para el PREVIEW: H.264 a 540p con un keyframe cada
 * medio segundo, generada en segundo plano y guardada en memoria
 * (comprimida: ~19 MB por minuto). La exportación usa SIEMPRE el
 * original.
 *
 * Mismos timestamps de presentación que la fuente, fotograma a
 * fotograma: todo lo que traduce timeline → tiempo de fuente (seek,
 * playhead, frame-hold) funciona igual con el proxy que con el original.
 */

const PROXY_MAX_HEIGHT = 540;
const PROXY_KEYFRAME_SECONDS = 0.5;
const PROXY_BITS_PER_PIXEL_SECOND = 0.12; // ~2,2 Mbps a 960x540@30
/** Fuentes más largas no se proxifican: el proxy en memoria pasaría de ~600 MB. */
export const PROXY_MAX_DURATION_SECONDS = 30 * 60;

/** ¿Merece la pena un proxy para esta fuente? Más de 1080p, o 1080p en un códec caro de decodificar con GOP largo. */
export function shouldCreateProxy(demuxed: DemuxedTrack): boolean {
  const height = demuxed.videoTrack.video?.height ?? 0;
  const durationSeconds = demuxed.videoTrack.duration / demuxed.videoTrack.timescale;
  if (durationSeconds > PROXY_MAX_DURATION_SECONDS) return false;
  if (height > 1080) return true;
  const codec = demuxed.videoTrack.codec;
  const heavyCodec = codec.startsWith("av01") || codec.startsWith("hvc1") || codec.startsWith("hev1") || codec.startsWith("vp09");
  return heavyCodec && height >= 1080;
}

export interface ProxyOptions {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** Tamaño del proxy: altura PROXY_MAX_HEIGHT con la proporción de la fuente, en pares (H.264 4:2:0). */
function proxySize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, PROXY_MAX_HEIGHT / height);
  const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/**
 * Genera el proxy de `source` recorriéndola entera en orden de
 * presentación (un FrameSeeker, decodificación secuencial), escalando
 * cada fotograma y recodificándolo. Devuelve una DemuxedTrack con las
 * muestras en memoria, intercambiable con la original en el player.
 */
export async function createProxy(source: DemuxedTrack, options: ProxyOptions = {}): Promise<DemuxedTrack> {
  const { onProgress, signal } = options;
  const srcW = source.videoTrack.video?.width ?? 0;
  const srcH = source.videoTrack.video?.height ?? 0;
  if (srcW <= 0 || srcH <= 0) throw new Error("La fuente no declara su tamaño");
  const { width, height } = proxySize(srcW, srcH);
  const frameRate = frameRateOf(source);
  const fps = frameRate.numerator / frameRate.denominator;

  const presentation = [...source.samples].sort((a, b) => sampleTimestampUs(a) - sampleTimestampUs(b));
  const total = presentation.length;
  const keyEvery = Math.max(1, Math.round(PROXY_KEYFRAME_SECONDS * fps));

  const samples: DemuxedSample[] = [];
  let codec: string | undefined;
  let description: Uint8Array | undefined;
  let encodeError: unknown;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const config = metadata?.decoderConfig;
      if (config) {
        codec = config.codec;
        if (config.description) {
          const d = config.description;
          description = ArrayBuffer.isView(d)
            ? new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer)
            : new Uint8Array((d as ArrayBuffer).slice(0));
        }
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({
        cts: chunk.timestamp,
        duration: chunk.duration ?? Math.round(1_000_000 / fps),
        timescale: 1_000_000,
        is_sync: chunk.type === "key",
        data,
      });
    },
    error: (error) => {
      encodeError = error;
    },
  });
  const base: VideoEncoderConfig = {
    codec: "avc1.4d001f", // Main 3.1: de sobra para 540p, decodificable en cualquier sitio
    width,
    height,
    bitrate: Math.round(width * height * fps * PROXY_BITS_PER_PIXEL_SECOND),
    framerate: fps,
    latencyMode: "quality",
    avc: { format: "avc" },
  };
  let configured = false;
  for (const hardwareAcceleration of ["prefer-hardware", "no-preference"] as const) {
    const support = await VideoEncoder.isConfigSupported({ ...base, hardwareAcceleration }).catch(() => ({ supported: false }));
    if (support.supported) {
      encoder.configure({ ...base, hardwareAcceleration });
      configured = true;
      break;
    }
  }
  if (!configured) {
    encoder.close();
    throw new Error("No hay codificador H.264 para generar el proxy");
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No se pudo crear el contexto 2D del proxy");
  // Hardware: recorrer la fuente entera por software (AV1 1440p60) iba
  // más lento que tiempo real; aquí no compite con nada interactivo.
  const seeker = createForwardFrameSeeker(source, "prefer-hardware");
  try {
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException("Proxy cancelado", "AbortError");
      if (encodeError) throw encodeError;
      const sample = presentation[i]!;
      const timestampUs = sampleTimestampUs(sample);
      const frame = await seeker.next(timestampUs);
      if (!frame) continue;
      drawFrameFit(ctx, frame, { width, height });
      frame.close();
      const out = new VideoFrame(canvas, { timestamp: timestampUs, duration: sampleDurationUs(sample) });
      encoder.encode(out, { keyFrame: i % keyEvery === 0 });
      out.close();
      while (encoder.encodeQueueSize > 4) await yieldToTaskQueue();
      if (i % 30 === 0) {
        onProgress?.(i, total);
        // Ceder el hilo: el proxy se genera mientras se edita.
        await yieldToTaskQueue();
      }
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
  } finally {
    seeker.destroy();
    if (encoder.state !== "closed") encoder.close();
  }
  if (!codec || samples.length === 0) throw new Error("El proxy no produjo ningún fotograma");
  onProgress?.(total, total);

  return {
    videoTrack: {
      id: source.videoTrack.id,
      codec,
      timescale: 1_000_000,
      duration: Math.round((source.videoTrack.duration / source.videoTrack.timescale) * 1_000_000),
      video: { width, height },
    },
    samples,
    ...(description ? { decoderDescription: description } : {}),
    frameRate,
  };
}

/** Bytes que ocupa un proxy en memoria (para mostrarlo y vigilarlo). */
export function proxyBytes(proxy: DemuxedTrack): number {
  return proxy.samples.reduce((sum, sample) => sum + (sample.data?.byteLength ?? 0), 0);
}

// --- Formato del proxy en disco (caché, ver electron/preload.cjs) ---
// [4 bytes: longitud de la cabecera][cabecera JSON UTF-8][description][datos de muestras]
// La cabecera lleva la pista, la frame rate y, por muestra, cts/duración/keyframe/tamaño.

const PROXY_FORMAT_VERSION = 1;

interface ProxyHeader {
  v: number;
  videoTrack: DemuxedTrack["videoTrack"];
  frameRate: NonNullable<DemuxedTrack["frameRate"]> | null;
  descriptionSize: number;
  samples: Array<[cts: number, duration: number, key: 0 | 1, size: number]>;
}

export function serializeProxy(proxy: DemuxedTrack): ArrayBuffer {
  const description = proxy.decoderDescription ?? new Uint8Array(0);
  const header: ProxyHeader = {
    v: PROXY_FORMAT_VERSION,
    videoTrack: proxy.videoTrack,
    frameRate: proxy.frameRate ?? null,
    descriptionSize: description.byteLength,
    samples: proxy.samples.map((s) => [s.cts, s.duration, s.is_sync ? 1 : 0, s.data?.byteLength ?? 0]),
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const dataSize = header.samples.reduce((sum, sample) => sum + sample[3], 0);
  const out = new Uint8Array(4 + headerBytes.byteLength + description.byteLength + dataSize);
  new DataView(out.buffer).setUint32(0, headerBytes.byteLength);
  out.set(headerBytes, 4);
  let offset = 4 + headerBytes.byteLength;
  out.set(description, offset);
  offset += description.byteLength;
  for (const sample of proxy.samples) {
    if (!sample.data) continue;
    out.set(sample.data, offset);
    offset += sample.data.byteLength;
  }
  return out.buffer;
}

/** undefined si el formato no es el esperado (versión antigua, archivo truncado...). */
export function deserializeProxy(buffer: ArrayBuffer): DemuxedTrack | undefined {
  try {
    const bytes = new Uint8Array(buffer);
    const headerSize = new DataView(buffer).getUint32(0);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerSize))) as ProxyHeader;
    if (header.v !== PROXY_FORMAT_VERSION) return undefined;
    let offset = 4 + headerSize;
    const description = bytes.slice(offset, offset + header.descriptionSize);
    offset += header.descriptionSize;
    const samples: DemuxedSample[] = header.samples.map(([cts, duration, key, size]) => {
      const data = bytes.subarray(offset, offset + size);
      offset += size;
      return { cts, duration, timescale: 1_000_000, is_sync: key === 1, data };
    });
    if (offset !== bytes.byteLength) return undefined;
    return {
      videoTrack: header.videoTrack,
      samples,
      ...(description.byteLength > 0 ? { decoderDescription: description } : {}),
      ...(header.frameRate ? { frameRate: header.frameRate } : {}),
    };
  } catch {
    return undefined;
  }
}
