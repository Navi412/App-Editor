import { PREFETCH_SAMPLES } from "./sampleData";
import { baseDecoderConfig, ensureSampleData, type DemuxedTrack, type DemuxedVideoTrack } from "./samples";
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
  readonly videoTrack: DemuxedVideoTrack;
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
  // Tras re-cebar desde el keyframe (primeDecoderIfNeeded), el decoder
  // vuelve a producir los fotogramas ANTERIORES al ya mostrado por el
  // seek. Todos tienen PTS "en el pasado", así que el frame-hold de
  // tick() los iba pintando uno por tick según salían — el vídeo (y el
  // playhead) saltaba atrás al keyframe y avanzaba en rápido hasta el
  // punto de partida. Se descartan sin pintar los anteriores a esto.
  let discardBeforeUs = -Infinity;
  /** PTS del fotograma objetivo del último seekTo() — el umbral de discardBeforeUs al re-cebar. */
  let lastSeekTargetUs = 0;
  // Mientras un seekTo() decodifica desde el keyframe hasta su objetivo,
  // sus fotogramas van aquí en vez de a outputQueue: se queda solo con el
  // mejor candidato y cierra el resto AL MOMENTO. Antes se acumulaban
  // todos hasta el final del flush() — con un keyframe lejano (GOP largo:
  // grabaciones de OBS/cámara) eran cientos de VideoFrame abiertos, y el
  // decoder por hardware (pocos búferes de salida: en Electron se atascaba
  // con 8) se quedaba sin sitio y abortaba el flush sin error visible. El
  // seek fallaba en silencio: vídeo congelado tras un corte o un hueco
  // mientras el audio, programado aparte, seguía sonando.
  let seekSink: ((frame: VideoFrame) => void) | undefined;

  function createDecoder(): VideoDecoder {
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (seekSink) {
          seekSink(frame);
          return;
        }
        // Duplicado del re-cebado (ver discardBeforeUs): se cierra YA, no
        // se deja ocupando un búfer de salida del decoder hasta el tick.
        if (frame.timestamp < discardBeforeUs) {
          frame.close();
          return;
        }
        outputQueue.push(frame);
      },
      error: (error) => {
        callbacks.onStatus?.(`Error de decodificación: ${error.message}`);
      },
    });
    // Sin hardwareAcceleration explícito (decisión revertida — ver
    // CLAUDE.md/git log): este decoder se re-cebra a menudo durante el
    // scrubbing interactivo (cada seek puede necesitar recrear el
    // decoder o re-alimentarlo desde el keyframe más cercano, ver
    // primeDecoderIfNeeded más abajo), y forzar "prefer-hardware" ahí
    // resultó en reproducción/scrubbing MÁS lentos en la práctica —
    // probablemente por el coste de (re)crear una sesión de
    // decodificación por hardware con tanta frecuencia. Se deja que el
    // navegador decida caso por caso.
    decoder.configure(baseDecoderConfig(demuxed));
    return decoder;
  }

  let decoder = createDecoder();

  /** `VideoDecoder.close()` lanza si el decoder ya está cerrado (p.ej. un seek anterior que se rindió a mitad de flush, o un doble destroy()). Cerrarlo "en silencio" evita que ese throw se propague y aborte el seekTo que viene detrás — lo que dejaba el vídeo congelado (solo seguía el audio, ya programado). */
  function closeDecoderQuietly(target: VideoDecoder): void {
    try {
      if (target.state !== "closed") target.close();
    } catch {
      /* ya estaba cerrado */
    }
  }

  // Lectura del disco en curso (ver media/sampleData.ts): feed() no
  // puede esperarla (va en el rAF de tick), así que se pide y, cuando
  // llega, se vuelve a alimentar.
  let dataRequest: Promise<void> | undefined;

  function requestSampleData(index: number): void {
    const loader = demuxed.loader;
    if (!loader || dataRequest) return;
    dataRequest = loader
      .prefetch(index)
      .catch((error: unknown) => {
        callbacks.onStatus?.(`Error leyendo el vídeo del disco: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        dataRequest = undefined;
        if (playing) feed();
      });
  }

  function feed(): void {
    while (
      nextSampleIndex < samples.length &&
      decoder.decodeQueueSize < MAX_DECODE_QUEUE &&
      outputQueue.length < MAX_BUFFERED_FRAMES
    ) {
      const sample = samples[nextSampleIndex]!;
      if (!sample.data) {
        // Sin loader no hay de dónde sacarlos (muestra vacía): se salta,
        // como siempre. Con loader, aún no se ha leído: se espera a él.
        if (!demuxed.loader) {
          nextSampleIndex++;
          continue;
        }
        requestSampleData(nextSampleIndex);
        break;
      }
      nextSampleIndex++;
      decoder.decode(
        new EncodedVideoChunk({
          type: sample.is_sync ? "key" : "delta",
          timestamp: sampleTimestampUs(sample),
          duration: sampleDurationUs(sample),
          data: sample.data,
        }),
      );
    }
    // Leer por delante de la reproducción, para no tener que esperar al
    // disco justo cuando el decoder pide el siguiente fotograma.
    const loader = demuxed.loader;
    const aheadEnd = Math.min(samples.length - 1, nextSampleIndex + PREFETCH_SAMPLES / 2);
    if (loader && playing && nextSampleIndex < samples.length && !loader.isLoaded(nextSampleIndex, aheadEnd)) {
      requestSampleData(nextSampleIndex);
    }
  }

  /**
   * Si el decoder acaba de pasar por un flush() (siempre ocurre al
   * final de un seekTo), el próximo decode() tiene que ser un
   * keyframe. Rebobina nextSampleIndex hasta el keyframe más cercano
   * para que el feed() normal (más abajo) re-alimente desde ahí —
   * NUNCA se vuelca aquí de golpe, sin control de caudal: para un
   * clip que arranca a mitad de un GOP largo (habitual justo después
   * de un hueco o un corte manual), un volcado sin límite satura la
   * cola del decoder de una vez y el resto de feed()/tick() se queda
   * esperando indefinidamente a que esa cola baje — se comprobó en
   * vivo que eso deja la reproducción congelada sin ningún error en
   * consola. Repartir el mismo trabajo en varias llamadas a feed(),
   * cada una acotada por MAX_DECODE_QUEUE/MAX_BUFFERED_FRAMES, evita
   * el atasco. Los fotogramas que esto vuelve a producir son
   * duplicados del ya mostrado por el seek; el frame-hold de tick()
   * los descarta sin pintarlos.
   */
  function primeDecoderIfNeeded(): void {
    if (!decoderNeedsKeyframe) {
      discardBeforeUs = -Infinity;
      return;
    }
    decoderNeedsKeyframe = false;
    discardBeforeUs = lastSeekTargetUs;
    let keyframeIndex = Math.max(0, nextSampleIndex - 1);
    while (keyframeIndex > 0 && !samples[keyframeIndex]!.is_sync) keyframeIndex--;
    nextSampleIndex = keyframeIndex;
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
      if (next.timestamp < discardBeforeUs) {
        next.close();
        continue;
      }
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
    lastSeekTargetUs = sampleTimestampUs(target);

    let keyframeIndex = targetDecodeIndex;
    while (keyframeIndex > 0 && !samples[keyframeIndex]!.is_sync) keyframeIndex--;

    // Los bytes del GOP hasta el objetivo, del disco si aún no están.
    try {
      await ensureSampleData(demuxed, keyframeIndex, targetDecodeIndex);
    } catch (error) {
      callbacks.onStatus?.(`Error leyendo el vídeo del disco: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (generation !== seekGeneration) return; // un seek más nuevo manda

    // Decoder nuevo en vez de reset(): evita depender de que reset()+
    // configure() deje al decoder en un estado limpio equivalente, y
    // el coste de recrearlo es irrelevante a la cadencia humana de un scrub.
    closeDecoderQuietly(decoder);
    const activeDecoder = createDecoder();
    decoder = activeDecoder;
    // Un decoder recién configurado (o recién salido de un flush) EXIGE
    // que el próximo decode() sea un keyframe. Se marca YA, no después
    // del flush: si el flush de abajo se rechaza y se sale antes de
    // tiempo, `play()` tiene que saber igualmente que hay que re-cebar
    // desde un keyframe — sin esto, feed() metía un delta en el decoder
    // limpio y la reproducción se quedaba congelada al reanudar tras un
    // hueco (solo volvía el audio, ya programado por adelantado).
    decoderNeedsKeyframe = true;

    let best: VideoFrame | undefined;
    const sink = (frame: VideoFrame): void => {
      if (frame.timestamp <= effectiveTimeUs && (!best || frame.timestamp > best.timestamp)) {
        best?.close();
        best = frame;
      } else {
        frame.close();
      }
    };
    seekSink = sink;
    const releaseSink = (): void => {
      if (seekSink === sink) seekSink = undefined;
    };

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
      // Un seek más nuevo cerró este decoder a mitad de flush (su seek
      // manda), o un chunk lo dejó en error. Si nadie nos ha
      // adelantado, deja `nextSampleIndex` en el keyframe objetivo para
      // que el próximo feed()/play() arranque desde ahí y no meta un
      // delta en un decoder recién creado.
      releaseSink();
      best?.close();
      if (generation === seekGeneration) nextSampleIndex = keyframeIndex;
      return;
    }
    releaseSink();
    if (generation !== seekGeneration) {
      // un seek más nuevo ya completó mientras este flush estaba en vuelo
      best?.close();
      return;
    }

    if (best) showFrame(best);

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
      closeDecoderQuietly(decoder);
    },
  };
}
