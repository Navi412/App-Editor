import type { DemuxedSample } from "./samples";

/** mp4box da cts/duration en la escala de tiempo de la pista; WebCodecs los quiere en microsegundos. */
export function sampleTimestampUs(sample: DemuxedSample): number {
  return Math.round((sample.cts / sample.timescale) * 1_000_000);
}

export function sampleDurationUs(sample: DemuxedSample): number {
  return Math.round((sample.duration / sample.timescale) * 1_000_000);
}
