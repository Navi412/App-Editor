import type { Sample, Track } from "mp4box";
import { secondsToTicks, type FrameRate } from "../core/time";
import type { SourceFile } from "../core/types";

/**
 * mp4box no expone una frame rate racional explícita por pista, así
 * que se infiere de la duración más común entre las muestras (moda),
 * combinada con el timescale de la pista. Para contenido a frame rate
 * constante (el caso normal) esto da una fracción exacta —
 * timescale=30000, duración de muestra=1001 ⇒ 30000/1001 (NTSC) — en
 * vez de aproximar con un decimal.
 */
export function inferFrameRate(samples: Sample[], timescale: number): FrameRate {
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

/** Convierte los metadatos de mp4box.js al SourceFile puro que entiende /core. */
export function toSourceFile(id: string, videoTrack: Track, samples: Sample[]): SourceFile {
  return {
    id,
    frameRate: inferFrameRate(samples, videoTrack.timescale),
    width: videoTrack.video?.width ?? 0,
    height: videoTrack.video?.height ?? 0,
    durationTicks: secondsToTicks(videoTrack.duration / videoTrack.timescale),
  };
}
