import { secondsToTicks, type FrameRate } from "../core/time";
import type { SourceFile } from "../core/types";
import type { DemuxedSample, DemuxedTrack } from "./samples";

/**
 * mp4box no expone una frame rate racional explícita por pista, así
 * que se infiere de la duración más común entre las muestras (moda),
 * combinada con el timescale de la pista. Para contenido a frame rate
 * constante (el caso normal) esto da una fracción exacta —
 * timescale=30000, duración de muestra=1001 ⇒ 30000/1001 (NTSC) — en
 * vez de aproximar con un decimal.
 */
export function inferFrameRate(samples: Pick<DemuxedSample, "duration">[], timescale: number): FrameRate {
  if (samples.length === 0) {
    return { numerator: 30, denominator: 1 };
  }

  const counts = new Map<number, number>();
  for (const sample of samples) {
    counts.set(sample.duration, (counts.get(sample.duration) ?? 0) + 1);
  }

  let modeDuration = samples[0]!.duration;
  let modeCount = 0;
  for (const [duration, count] of counts) {
    if (count > modeCount) {
      modeCount = count;
      modeDuration = duration;
    }
  }

  return { numerator: timescale, denominator: modeDuration };
}

/** Frame rates estándar a las que se ajusta una estimación en coma flotante. */
const STANDARD_FRAME_RATES: FrameRate[] = [
  { numerator: 24000, denominator: 1001 },
  { numerator: 24, denominator: 1 },
  { numerator: 25, denominator: 1 },
  { numerator: 30000, denominator: 1001 },
  { numerator: 30, denominator: 1 },
  { numerator: 48, denominator: 1 },
  { numerator: 50, denominator: 1 },
  { numerator: 60000, denominator: 1001 },
  { numerator: 60, denominator: 1 },
  { numerator: 90, denominator: 1 },
  { numerator: 100, denominator: 1 },
  { numerator: 120000, denominator: 1001 },
  { numerator: 120, denominator: 1 },
  { numerator: 144, denominator: 1 },
  { numerator: 240, denominator: 1 },
  { numerator: 10, denominator: 1 },
  { numerator: 12, denominator: 1 },
  { numerator: 15, denominator: 1 },
];

/**
 * Convierte un fps aproximado (Matroska guarda timestamps redondeados
 * al milisegundo, así que la moda de duraciones daría 1000/33) en la
 * frame rate estándar más cercana si está a menos de un 0,5 %; si no,
 * a una fracción con milésimas. Así una grabación a 29,97 sigue siendo
 * 30000/1001 exacto y no 29,97002...
 */
export function snapFrameRate(fps: number): FrameRate {
  if (!Number.isFinite(fps) || fps <= 0) return { numerator: 30, denominator: 1 };
  let best: FrameRate | undefined;
  let bestError = Infinity;
  for (const rate of STANDARD_FRAME_RATES) {
    const error = Math.abs(rate.numerator / rate.denominator - fps) / fps;
    if (error < bestError) {
      bestError = error;
      best = rate;
    }
  }
  if (best && bestError < 0.005) return best;
  return { numerator: Math.round(fps * 1000), denominator: 1000 };
}

/** La frame rate de una fuente: la que ya sepa el demuxer o, si no, la inferida de sus muestras. */
export function frameRateOf(demuxed: DemuxedTrack): FrameRate {
  return demuxed.frameRate ?? inferFrameRate(demuxed.samples, demuxed.videoTrack.timescale);
}

/** Convierte los metadatos del demuxer al SourceFile puro que entiende /core. */
export function toSourceFile(id: string, demuxed: DemuxedTrack): SourceFile {
  const { videoTrack } = demuxed;
  return {
    id,
    kind: "video",
    frameRate: frameRateOf(demuxed),
    width: videoTrack.video?.width ?? 0,
    height: videoTrack.video?.height ?? 0,
    durationTicks: secondsToTicks(videoTrack.duration / videoTrack.timescale),
  };
}
