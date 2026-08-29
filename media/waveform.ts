/**
 * Envolvente min/máx (combinando todos los canales) de un AudioBuffer
 * completo, a una resolución fija — independiente del zoom de la
 * timeline. Se calcula una vez por fuente (como la miniatura de vídeo)
 * y se redibuja barato después, tomando la porción [sliceStart,
 * sliceEnd) que corresponda al recorte del clip en cada momento.
 *
 * Guarda min Y máx por cubo (no solo un pico absoluto simétrico):
 * `[min0, max0, min1, max1, ...]`, longitud `bucketCount * 2` — así
 * drawWaveformSlice puede dibujar la forma de onda real (asimétrica,
 * como cualquier editor de audio de verdad) en vez de barras
 * simétricas tipo vúmetro.
 */
export function computeWaveformPeaks(buffer: AudioBuffer, bucketCount: number): Float32Array {
  const count = Math.max(1, bucketCount);
  const peaks = new Float32Array(count * 2);
  const channelCount = buffer.numberOfChannels;
  const length = buffer.length;
  const bucketSize = Math.max(1, Math.floor(length / count));
  const channelData: Float32Array[] = [];
  for (let channel = 0; channel < channelCount; channel++) {
    channelData.push(buffer.getChannelData(channel));
  }

  for (let bucket = 0; bucket < count; bucket++) {
    const start = bucket * bucketSize;
    const end = Math.min(length, start + bucketSize);
    let min = 0;
    let max = 0;
    for (let i = start; i < end; i++) {
      for (let channel = 0; channel < channelCount; channel++) {
        const value = channelData[channel]![i]!;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    peaks[bucket * 2] = min;
    peaks[bucket * 2 + 1] = max;
  }
  return peaks;
}

/** Subconjunto de CanvasRenderingContext2D que necesitamos para dibujar barras. */
export interface WaveformDrawTarget {
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
}

/** Nº de cubos guardados en `peaks` (min+máx por cubo, ver computeWaveformPeaks). */
function bucketCountOf(peaks: Float32Array): number {
  return Math.max(1, Math.floor(peaks.length / 2));
}

/** Dibuja la porción [sliceStart, sliceEnd) (fracciones 0-1 de los cubos de `peaks`) como la envolvente real min/máx — asimétrica, no barras simétricas tipo vúmetro. */
export function drawWaveformSlice(
  ctx: WaveformDrawTarget,
  peaks: Float32Array,
  sliceStart: number,
  sliceEnd: number,
  width: number,
  height: number,
  color: string,
): void {
  ctx.clearRect(0, 0, width, height);
  const totalBuckets = bucketCountOf(peaks);
  const startIndex = Math.max(0, Math.min(totalBuckets - 1, Math.floor(sliceStart * totalBuckets)));
  const endIndex = Math.max(startIndex + 1, Math.min(totalBuckets, Math.ceil(sliceEnd * totalBuckets)));
  const bucketCount = endIndex - startIndex;
  const barWidth = width / bucketCount;
  const mid = height / 2;
  ctx.fillStyle = color;
  for (let i = 0; i < bucketCount; i++) {
    const bucket = startIndex + i;
    const min = peaks[bucket * 2] ?? 0;
    const max = peaks[bucket * 2 + 1] ?? 0;
    const top = mid - max * mid;
    const bottom = mid - min * mid;
    const barHeight = Math.max(1, bottom - top);
    ctx.fillRect(i * barWidth, top, Math.max(1, barWidth - 1), barHeight);
  }
}
