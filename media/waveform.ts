/**
 * Picos de amplitud (máximo absoluto por cubo, combinando todos los
 * canales) de un AudioBuffer completo, a una resolución fija —
 * independiente del zoom de la timeline. Se calcula una vez por
 * fuente (como la miniatura de vídeo) y se redibuja barato después,
 * tomando la porción [sliceStart, sliceEnd) que corresponda al
 * recorte del clip en cada momento.
 */
export function computeWaveformPeaks(buffer: AudioBuffer, bucketCount: number): Float32Array {
  const peaks = new Float32Array(Math.max(1, bucketCount));
  const channelCount = buffer.numberOfChannels;
  const length = buffer.length;
  const bucketSize = Math.max(1, Math.floor(length / peaks.length));
  const channelData: Float32Array[] = [];
  for (let channel = 0; channel < channelCount; channel++) {
    channelData.push(buffer.getChannelData(channel));
  }

  for (let bucket = 0; bucket < peaks.length; bucket++) {
    const start = bucket * bucketSize;
    const end = Math.min(length, start + bucketSize);
    let peak = 0;
    for (let i = start; i < end; i++) {
      for (let channel = 0; channel < channelCount; channel++) {
        const value = Math.abs(channelData[channel]![i]!);
        if (value > peak) peak = value;
      }
    }
    peaks[bucket] = peak;
  }
  return peaks;
}

/** Subconjunto de CanvasRenderingContext2D que necesitamos para dibujar barras. */
export interface WaveformDrawTarget {
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
}

/** Dibuja la porción [sliceStart, sliceEnd) (fracciones 0-1 de `peaks`) como barras verticales centradas. */
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
  const startIndex = Math.max(0, Math.min(peaks.length - 1, Math.floor(sliceStart * peaks.length)));
  const endIndex = Math.max(startIndex + 1, Math.min(peaks.length, Math.ceil(sliceEnd * peaks.length)));
  const bucketCount = endIndex - startIndex;
  const barWidth = width / bucketCount;
  const mid = height / 2;
  ctx.fillStyle = color;
  for (let i = 0; i < bucketCount; i++) {
    const peak = peaks[startIndex + i] ?? 0;
    const barHeight = Math.max(1, peak * height);
    ctx.fillRect(i * barWidth, mid - barHeight / 2, Math.max(1, barWidth - 1), barHeight);
  }
}
