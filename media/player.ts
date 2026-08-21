import type { Track } from "mp4box";
import { getDecoderDescription } from "./description";
import type { DemuxedTrack } from "./samples";
import { sampleDurationUs, sampleTimestampUs } from "./sampleTime";

/**
 * Reproductor de un único archivo fuente, en tiempo de fuente absoluto
 * (microsegundos), sin conocer /core ni el concepto de clip o
 * timeline recortada — esa traducción vive en /ui (ver DESIGN.md §2:
 * walkTimeline resuelve timeline→(archivo, tiempo), y /ui es quien la
 * llama y convierte el resultado a los microsegundos que este player
 * entiende).
 *
 * Mantiene una ventana acotada de fotogramas decodificados
 * (decode-ahead) en vez de decodificar el archivo entero de golpe —
 * ver DESIGN.md §3.
 */
export interface VideoPlayer {
  readonly videoTrack: Track;
  readonly durationSeconds: number;
  /**
   * Busca el fotograma activo en timeUs (microsegundos, tiempo de la
   * fuente) y lo pinta. Sigue el algoritmo de DESIGN.md §3: localizar
   * el keyframe más cercano ≤ timeUs, decodificar desde ahí en orden
   * de decodificación hasta la muestra objetivo, descartar el resto.
   */
  seekTo(timeUs: number): Promise<void>;
  /** Reproduce hacia delante desde la posición actual hasta endUs (o hasta el final si se omite). */
  play(endUs?: number): void;
  pause(): void;
  destroy(): void;
}

export interface VideoPlayerCallbacks {
  /**
   * Se llama con cada fotograma que toca mostrar. El player cierra el
   * VideoFrame justo después de llamar a este callback, así que debe
   * consumirse (p.ej. dibujarse) de forma síncrona. El player no sabe
   * nada de canvas — quien orquesta decide dónde y cómo pintar (ver
   * media/render.ts para el aspect-fit).
   */
  onFrame?: (frame: VideoFrame) => void;
  onStatus?: (message: string) => void;
  /** Se llama con la posición de reproducción (microsegundos, tiempo de fuente) cada vez que se muestra un fotograma. */
  onTimeUpdate?: (sourceTimeUs: number) => void;
  onEnded?: () => void;
}

const MAX_BUFFERED_FRAMES = 6;
const MAX_DECODE_QUEUE = 4;

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${secs}`;
}

export function createVideoPlayer(
  demuxed: DemuxedTrack,
  callbacks: VideoPlayerCallbacks = {},
): VideoPlayer {
  const { videoTrack, samples } = demuxed;
  const firstSample = samples[0];
  if (!firstSample) {
    throw new Error("La pista de vídeo no tiene fotogramas");
  }

  // Vista por orden de presentación, usada solo para localizar la
  // muestra activa en un seek — decodificar siempre se hace sobre
  // `samples` (orden de decodificación), nunca sobre esta vista.
  const presentationOrder = [...samples].sort(
    (a, b) => sampleTimestampUs(a) - sampleTimestampUs(b),
  );

  const decoderDescription = getDecoderDescription(firstSample);

  const durationSeconds = videoTrack.duration / videoTrack.timescale;
  const outputQueue: VideoFrame[] = [];
  let nextSampleIndex = 0;
  let playing = false;
  let rafHandle = 0;
  let wallClockStartMs = 0;
  let startPositionUs = 0;
  let playbackPositionUs = 0;
  let currentEndUs: number | undefined;
  // Un scrub rápido puede disparar varios seekTo() solapados: cada
  // llamada cierra el decoder que la anterior podría estar usando en
  // su await flush(), lo que la rechaza. Esta generación deja que solo
  // la llamada más reciente termine de aplicar su resultado — gana el
  // último seek, que es la semántica correcta para un scrub.
  let seekGeneration = 0;
  // WebCodecs exige que el decode() inmediatamente posterior a un
  // flush() (o a configure()) sea un keyframe — seekTo() termina con
  // un flush(), así que la reproducción no puede simplemente continuar
  // alimentando la siguiente muestra en orden; hay que "re-cebar" el
  // decoder desde el keyframe más cercano antes de retomar el feed
  // normal. Ver primeDecoderIfNeeded más abajo.
  let decoderNeedsKeyframe = false;

  function createDecoder(): VideoDecoder {
    const decoder = new VideoDecoder({
      output: (frame) => outputQueue.push(frame),
      error: (error) => {
        callbacks.onStatus?.(`Error de decodificación: ${error.message}`);
      },
    });
    decoder.configure({
      codec: videoTrack.codec,
      description: decoderDescription,
      // Sin hardwareAcceleration explícito (decisión revertida — ver
      // CLAUDE.md/git log): este decoder se re-cebra a menudo durante el
      // scrubbing interactivo (cada seek puede necesitar recrear el
      // decoder o re-alimentarlo desde el keyframe más cercano, ver
      // primeDecoderIfNeeded más abajo), y forzar "prefer-hardware" ahí
      // resultó en reproducción/scrubbing MÁS lentos en la práctica —
      // probablemente por el coste de (re)crear una sesión de
      // decodificación por hardware con tanta frecuencia. Se deja que el
      // navegador decida caso por caso.
      ...(videoTrack.video
        ? { codedWidth: videoTrack.video.width, codedHeight: videoTrack.video.height }
        : {}),
    });
    return decoder;
  }

  let decoder = createDecoder();

  function feed(): void {
    while (
      nextSampleIndex < samples.length &&
      decoder.decodeQueueSize < MAX_DECODE_QUEUE &&
      outputQueue.length < MAX_BUFFERED_FRAMES
    ) {
      const sample = samples[nextSampleIndex]!;
      nextSampleIndex++;
      if (!sample.data) continue;
      decoder.decode(
        new EncodedVideoChunk({
          type: sample.is_sync ? "key" : "delta",
          timestamp: sampleTimestampUs(sample),
          duration: sampleDurationUs(sample),
          data: sample.data,
        }),
      );
    }
  }

  /**
   * Si el decoder acaba de pasar por un flush() (siempre ocurre al
   * final de un seekTo), el próximo decode() tiene que ser un
   * keyframe. Re-alimenta desde el keyframe más cercano hasta
   * nextSampleIndex-1 (sin flush esta vez) para dejar el decoder listo
   * para continuar hacia delante con feed() normal. Los fotogramas que
   * esto vuelve a producir son duplicados del ya mostrado por el seek;
   * el frame-hold de tick() los descarta sin pintarlos.
   */
  function primeDecoderIfNeeded(): void {
    if (!decoderNeedsKeyframe) return;
    decoderNeedsKeyframe = false;
    const resumeIndex = nextSampleIndex;
    let keyframeIndex = Math.max(0, resumeIndex - 1);
    while (keyframeIndex > 0 && !samples[keyframeIndex]!.is_sync) keyframeIndex--;
    for (let i = keyframeIndex; i < resumeIndex; i++) {
      const sample = samples[i]!;
      if (!sample.data) continue;
      decoder.decode(
        new EncodedVideoChunk({
          type: sample.is_sync ? "key" : "delta",
          timestamp: sampleTimestampUs(sample),
          duration: sampleDurationUs(sample),
          data: sample.data,
        }),
      );
    }
  }

  function showFrame(frame: VideoFrame): void {
    callbacks.onFrame?.(frame);
    playbackPositionUs = frame.timestamp;
    frame.close();
    callbacks.onTimeUpdate?.(playbackPositionUs);
    callbacks.onStatus?.(`${formatTime(playbackPositionUs / 1_000_000)} / ${formatTime(durationSeconds)}`);
  }

  function tick(): void {
    if (!playing) return;
    const nowUs = startPositionUs + (performance.now() - wallClockStartMs) * 1000;

    // Frame-hold: se muestra el fotograma más reciente cuyo PTS ya
    // pasó; los que quedaron obsoletos entre tick y tick se cierran
    // sin dibujarlos (ver DESIGN.md §3/§4 — la exportación reutilizará
    // esta misma idea, muestreada a pasos fijos en vez de en tiempo real).
    let shown: VideoFrame | undefined;
    while (outputQueue.length > 0 && outputQueue[0]!.timestamp <= nowUs) {
      const next = outputQueue.shift()!;
      shown?.close();
      shown = next;
    }
    if (shown) showFrame(shown);

    feed();

    const reachedEnd = currentEndUs !== undefined && playbackPositionUs >= currentEndUs;
    const drained =
      nextSampleIndex >= samples.length &&
      outputQueue.length === 0 &&
      decoder.decodeQueueSize === 0;
    if (reachedEnd || drained) {
      playing = false;
      callbacks.onEnded?.();
      return;
    }
    rafHandle = requestAnimationFrame(tick);
  }

  async function seekTo(timeUs: number): Promise<void> {
    const generation = ++seekGeneration;
    playing = false;
    cancelAnimationFrame(rafHandle);
    for (const frame of outputQueue.splice(0)) frame.close();

    let target = presentationOrder[0]!;
    for (const sample of presentationOrder) {
      if (sampleTimestampUs(sample) <= timeUs) target = sample;
      else break;
    }
    const targetDecodeIndex = samples.indexOf(target);
    // El primer fotograma de un archivo no siempre tiene timestamp 0
    // (p.ej. si el original tenía un edit list) — comparar contra
    // timeUs a secas podría descartar el propio fotograma objetivo.
    const effectiveTimeUs = Math.max(timeUs, sampleTimestampUs(target));

    let keyframeIndex = targetDecodeIndex;
    while (keyframeIndex > 0 && !samples[keyframeIndex]!.is_sync) keyframeIndex--;

    // Decoder nuevo en vez de reset(): evita depender de que reset()+
    // configure() deje al decoder en un estado limpio equivalente, y
    // el coste de recrearlo es irrelevante a la cadencia humana de un scrub.
    decoder.close();
    const activeDecoder = createDecoder();
    decoder = activeDecoder;

    for (let i = keyframeIndex; i <= targetDecodeIndex; i++) {
      const sample = samples[i]!;
      if (!sample.data) continue;
      activeDecoder.decode(
        new EncodedVideoChunk({
          type: sample.is_sync ? "key" : "delta",
          timestamp: sampleTimestampUs(sample),
          duration: sampleDurationUs(sample),
          data: sample.data,
        }),
      );
    }

    try {
      await activeDecoder.flush();
    } catch {
      return; // un seek más nuevo cerró este decoder a mitad de flush; el suyo manda
    }
    decoderNeedsKeyframe = true;
    if (generation !== seekGeneration) {
      // un seek más nuevo ya completó mientras este flush estaba en vuelo
      for (const frame of outputQueue.splice(0)) frame.close();
      return;
    }

    let shown: VideoFrame | undefined;
    for (const frame of outputQueue.splice(0)) {
      if (frame.timestamp <= effectiveTimeUs && (!shown || frame.timestamp > shown.timestamp)) {
        shown?.close();
        shown = frame;
      } else {
        frame.close();
      }
    }
    if (shown) showFrame(shown);

    nextSampleIndex = targetDecodeIndex + 1;
  }

  return {
    videoTrack,
    durationSeconds,
    seekTo,
    play(endUs?: number): void {
      if (playing) return;
      currentEndUs = endUs;
      playing = true;
      wallClockStartMs = performance.now();
      startPositionUs = playbackPositionUs;
      primeDecoderIfNeeded();
      feed();
      rafHandle = requestAnimationFrame(tick);
    },
    pause(): void {
      playing = false;
      cancelAnimationFrame(rafHandle);
    },
    destroy(): void {
      playing = false;
      cancelAnimationFrame(rafHandle);
      for (const frame of outputQueue.splice(0)) frame.close();
      decoder.close();
    },
  };
}
