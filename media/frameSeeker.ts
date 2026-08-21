import { getDecoderDescription } from "./description";
import { sampleDurationUs, sampleTimestampUs } from "./sampleTime";
import type { DemuxedTrack } from "./samples";
import { yieldToTaskQueue } from "./scheduling";

/**
 * Fuente de fotogramas para exportación: solo soporta avanzar con
 * timestamps NO decrecientes (a diferencia de media/player.ts, que
 * soporta saltos arbitrarios para el scrub interactivo). La
 * exportación siempre recorre un clip de principio a fin en orden, así
 * que puede reusar el mismo VideoDecoder y avanzar la decodificación
 * en línea recta en vez de rebuscar el keyframe más cercano en cada
 * fotograma — eso sería O(n²) para clips con GOPs largos.
 */
export interface FrameSeeker {
  /** Devuelve el fotograma activo en timeUs (frame-hold), o undefined si aún no hay ninguno. Cierra los fotogramas que descarta. */
  next(timeUs: number): Promise<VideoFrame | undefined>;
  destroy(): void;
}

/**
 * Fotogramas de margen que se alimentan más allá del objetivo antes de
 * esperar su salida. decodeQueueSize llegando a 0 NO garantiza que el
 * decoder haya entregado ya el último fotograma pedido — sin nada
 * decodificado por detrás, un fotograma suelto puede quedarse sin
 * emitir nunca (comprobado empíricamente: decodeQueueSize a 0 con el
 * callback de salida sin disparar). Alimentar unos cuantos fotogramas
 * de más empuja al decoder a soltarlo, sin necesidad de flush() (que
 * exigiría un keyframe en el siguiente decode() y rompería la
 * decodificación secuencial).
 */
const LOOKAHEAD_SAMPLES = 6;

export function createForwardFrameSeeker(demuxed: DemuxedTrack): FrameSeeker {
  const { videoTrack, samples } = demuxed;
  const firstSample = samples[0];
  if (!firstSample) {
    throw new Error("La pista de vídeo no tiene fotogramas");
  }
  const decoderDescription = getDecoderDescription(firstSample);

  // Orden de presentación, solo para localizar qué muestra corresponde
  // a timeUs — decodificar siempre respeta el orden de decodificación
  // real de `samples` (necesario para contenido con B-frames, donde
  // cts no es monótono en orden de decodificación).
  const presentationOrder = [...samples].sort(
    (a, b) => sampleTimestampUs(a) - sampleTimestampUs(b),
  );

  const pending: VideoFrame[] = [];
  const decoder = new VideoDecoder({
    output: (frame) => pending.push(frame),
    error: (error) => {
      throw error;
    },
  });
  decoder.configure({
    codec: videoTrack.codec,
    description: decoderDescription,
    ...(videoTrack.video
      ? { codedWidth: videoTrack.video.width, codedHeight: videoTrack.video.height }
      : {}),
  });

  let nextIndex = 0;
  // true justo después del flush() de último recurso: WebCodecs exige
  // que el decode() siguiente a un flush() sea un keyframe, así que
  // antes de seguir alimentando hacia delante hay que re-cebar el
  // decoder desde el keyframe más cercano (mismo patrón que
  // media/player.ts). Los fotogramas que esto vuelve a producir son
  // duplicados de los ya mostrados; el frame-hold de next() los descarta.
  let needsKeyframe = false;

  function primeIfNeeded(): void {
    if (!needsKeyframe) return;
    needsKeyframe = false;
    let keyframeIndex = Math.min(nextIndex, samples.length - 1);
    while (keyframeIndex > 0 && !samples[keyframeIndex]!.is_sync) keyframeIndex--;
    for (let i = keyframeIndex; i < nextIndex; i++) feedSample(i);
  }

  function targetSampleFor(timeUs: number): { index: number; timestampUs: number } {
    let target = presentationOrder[0]!;
    for (const sample of presentationOrder) {
      if (sampleTimestampUs(sample) <= timeUs) target = sample;
      else break;
    }
    return { index: samples.indexOf(target), timestampUs: sampleTimestampUs(target) };
  }

  function feedSample(index: number): void {
    const sample = samples[index]!;
    if (!sample.data) return;
    decoder.decode(
      new EncodedVideoChunk({
        type: sample.is_sync ? "key" : "delta",
        timestamp: sampleTimestampUs(sample),
        duration: sampleDurationUs(sample),
        data: sample.data,
      }),
    );
  }

  async function waitUntil(predicate: () => boolean, maxIterations: number): Promise<boolean> {
    for (let i = 0; i < maxIterations; i++) {
      if (predicate()) return true;
      await yieldToTaskQueue();
    }
    return predicate();
  }

  async function decodeUpTo(timeUs: number): Promise<number> {
    const target = targetSampleFor(timeUs);
    // El primer fotograma de un archivo no siempre tiene timestamp 0
    // (p.ej. si el original tenía un edit list) — comparar contra
    // timeUs a secas podría descartar el propio fotograma objetivo
    // como "no listo". El umbral real nunca es menor que su timestamp.
    const effectiveTimeUs = Math.max(timeUs, target.timestampUs);
    const feedUpTo = Math.min(samples.length - 1, target.index + LOOKAHEAD_SAMPLES);

    primeIfNeeded();

    while (nextIndex <= feedUpTo) {
      feedSample(nextIndex);
      nextIndex++;
    }

    const targetReady = () => pending.some((frame) => frame.timestamp <= effectiveTimeUs);
    const arrived = await waitUntil(targetReady, 2000);
    if (!arrived) {
      // Último recurso: no queda margen de lookahead por delante
      // (normalmente, cerca del final del archivo) y el fotograma
      // sigue sin salir. flush() lo garantiza, a costa de que el
      // decoder exija un keyframe en el siguiente decode() — de ahí
      // needsKeyframe, para no romper la próxima llamada.
      await decoder.flush();
      needsKeyframe = true;
    }
    return effectiveTimeUs;
  }

  return {
    async next(timeUs: number): Promise<VideoFrame | undefined> {
      const effectiveTimeUs = await decodeUpTo(timeUs);

      const ready: VideoFrame[] = [];
      const notReady: VideoFrame[] = [];
      for (const frame of pending.splice(0)) {
        if (frame.timestamp <= effectiveTimeUs) ready.push(frame);
        else notReady.push(frame);
      }
      pending.push(...notReady);

      let shown: VideoFrame | undefined;
      for (const frame of ready) {
        if (!shown || frame.timestamp > shown.timestamp) {
          shown?.close();
          shown = frame;
        } else {
          frame.close();
        }
      }
      return shown;
    },
    destroy(): void {
      for (const frame of pending.splice(0)) frame.close();
      decoder.close();
    },
  };
}
