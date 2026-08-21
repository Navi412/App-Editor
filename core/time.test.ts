import { describe, expect, it } from "vitest";
import {
  TICKS_PER_SECOND,
  frameDurationTicks,
  secondsToTicks,
  sourceFrameIndexToTicks,
  ticksToSeconds,
  ticksToSourceFrameIndex,
  type FrameRate,
} from "./time";

const FPS_30: FrameRate = { numerator: 30, denominator: 1 };
const FPS_NTSC_30: FrameRate = { numerator: 30000, denominator: 1001 };
const FPS_25: FrameRate = { numerator: 25, denominator: 1 };
const FPS_NTSC_60: FrameRate = { numerator: 60000, denominator: 1001 };

describe("secondsToTicks / ticksToSeconds", () => {
  it("hace un round-trip exacto para segundos enteros", () => {
    expect(secondsToTicks(1)).toBe(TICKS_PER_SECOND);
    expect(ticksToSeconds(TICKS_PER_SECOND)).toBe(1);
  });

  it("redondea de forma consistente en ambas direcciones", () => {
    const ticks = secondsToTicks(12.345);
    expect(ticksToSeconds(ticks)).toBeCloseTo(12.345, 6);
  });
});

describe("frameDurationTicks", () => {
  it("da un valor exacto para tasas enteras", () => {
    expect(frameDurationTicks(FPS_30)).toBe(TICKS_PER_SECOND / 30);
    expect(frameDurationTicks(FPS_25)).toBe(TICKS_PER_SECOND / 25);
  });

  it("da un valor razonable (con redondeo) para tasas NTSC", () => {
    // 600000/1001 * 30000/30000... duración real ~20020 ticks
    expect(frameDurationTicks(FPS_NTSC_30)).toBe(20020);
  });
});

describe("sourceFrameIndexToTicks / ticksToSourceFrameIndex", () => {
  it("hace round-trip exacto para tasas enteras en muchos índices", () => {
    for (const index of [0, 1, 29, 30, 599, 1000]) {
      const ticks = sourceFrameIndexToTicks(index, FPS_30);
      expect(ticksToSourceFrameIndex(ticks, FPS_30)).toBe(index);
    }
  });

  it("hace round-trip exacto para tasas NTSC (30000/1001) en muchos índices", () => {
    for (const index of [0, 1, 29, 30, 300, 1000, 12345]) {
      const ticks = sourceFrameIndexToTicks(index, FPS_NTSC_30);
      expect(ticksToSourceFrameIndex(ticks, FPS_NTSC_30)).toBe(index);
    }
  });

  it("hace round-trip exacto para 60000/1001", () => {
    for (const index of [0, 1, 59, 60, 3000, 7777]) {
      const ticks = sourceFrameIndexToTicks(index, FPS_NTSC_60);
      expect(ticksToSourceFrameIndex(ticks, FPS_NTSC_60)).toBe(index);
    }
  });

  it("el índice 0 siempre cae en el tick 0", () => {
    expect(sourceFrameIndexToTicks(0, FPS_NTSC_30)).toBe(0);
  });
});
