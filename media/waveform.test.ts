import { describe, expect, it } from "vitest";
import { computeWaveformPeaks, drawWaveformSlice, type WaveformDrawTarget } from "./waveform";

/** AudioBuffer mínimo para computeWaveformPeaks — solo usa numberOfChannels/length/getChannelData. */
function fakeAudioBuffer(channels: number[][]): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    length: channels[0]!.length,
    getChannelData: (channel: number) => new Float32Array(channels[channel]!),
  } as unknown as AudioBuffer;
}

describe("computeWaveformPeaks", () => {
  it("guarda min y máx por cubo (longitud bucketCount*2), no un pico absoluto simétrico", () => {
    const buffer = fakeAudioBuffer([[0.2, -0.9, 0.1, -0.1]]);
    const peaks = computeWaveformPeaks(buffer, 2);
    expect(peaks.length).toBe(4);
    // cubo 0: [0.2, -0.9] -> min -0.9, máx 0.2
    expect(peaks[0]).toBeCloseTo(-0.9, 5);
    expect(peaks[1]).toBeCloseTo(0.2, 5);
    // cubo 1: [0.1, -0.1] -> min -0.1, máx 0.1
    expect(peaks[2]).toBeCloseTo(-0.1, 5);
    expect(peaks[3]).toBeCloseTo(0.1, 5);
  });

  it("combina todos los canales (min/máx del conjunto, no por canal)", () => {
    const buffer = fakeAudioBuffer([
      [0.05, 0.05],
      [-0.7, 0.6],
    ]);
    const peaks = computeWaveformPeaks(buffer, 1);
    expect(peaks[0]).toBeCloseTo(-0.7, 5);
    expect(peaks[1]).toBeCloseTo(0.6, 5);
  });

  it("nunca genera menos de un cubo aunque se pida bucketCount <= 0", () => {
    const buffer = fakeAudioBuffer([[0.5, -0.5]]);
    expect(computeWaveformPeaks(buffer, 0).length).toBe(2);
  });
});

class RecordingCtx implements WaveformDrawTarget {
  fillStyle: string | CanvasGradient | CanvasPattern = "";
  cleared = false;
  rects: { x: number; y: number; w: number; h: number }[] = [];
  clearRect(): void {
    this.cleared = true;
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rects.push({ x, y, w, h });
  }
}

describe("drawWaveformSlice", () => {
  it("dibuja una barra por cubo dentro del rango [sliceStart, sliceEnd)", () => {
    // 4 cubos: dos silenciosos, uno con excursión positiva, uno con excursión negativa.
    const peaks = new Float32Array([0, 0, 0, 0, 0, 1, -1, 0]);
    const ctx = new RecordingCtx();
    drawWaveformSlice(ctx, peaks, 0, 1, 40, 20, "#fff");
    expect(ctx.cleared).toBe(true);
    expect(ctx.rects).toHaveLength(4);
  });

  it("una excursión solo positiva dibuja la barra por encima de la línea media", () => {
    const peaks = new Float32Array([0, 1]); // un cubo: min 0, máx 1
    const ctx = new RecordingCtx();
    drawWaveformSlice(ctx, peaks, 0, 1, 10, 20, "#fff");
    const [bar] = ctx.rects;
    expect(bar!.y).toBeCloseTo(0, 5); // mid(10) - max(1)*mid(10) = 0
    expect(bar!.h).toBeCloseTo(10, 5); // hasta la línea media
  });

  it("una excursión solo negativa dibuja la barra por debajo de la línea media", () => {
    const peaks = new Float32Array([-1, 0]); // un cubo: min -1, máx 0
    const ctx = new RecordingCtx();
    drawWaveformSlice(ctx, peaks, 0, 1, 10, 20, "#fff");
    const [bar] = ctx.rects;
    expect(bar!.y).toBeCloseTo(10, 5); // top = mid - max*mid = 10
    expect(bar!.h).toBeCloseTo(10, 5); // bottom(20) - top(10)
  });

  it("solo dibuja la porción [sliceStart, sliceEnd) de los cubos", () => {
    const peaks = new Float32Array(8 * 2); // 8 cubos, todos en 0
    const ctx = new RecordingCtx();
    drawWaveformSlice(ctx, peaks, 0.25, 0.5, 20, 20, "#fff");
    // 8 cubos * [0.25, 0.5) -> cubos 2..3 -> 2 barras
    expect(ctx.rects).toHaveLength(2);
  });
});
