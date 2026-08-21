import { describe, expect, it } from "vitest";
import type { Sample } from "mp4box";
import { inferFrameRate } from "./sourceFile";

function fakeSample(duration: number): Sample {
  return { duration } as Sample;
}

describe("inferFrameRate", () => {
  it("usa la duración de muestra más común como denominador", () => {
    const samples = [fakeSample(1001), fakeSample(1001), fakeSample(1001), fakeSample(999)];
    expect(inferFrameRate(samples, 30000)).toEqual({ numerator: 30000, denominator: 1001 });
  });

  it("da 30000/1001 para NTSC constante", () => {
    const samples = Array.from({ length: 10 }, () => fakeSample(1001));
    expect(inferFrameRate(samples, 30000)).toEqual({ numerator: 30000, denominator: 1001 });
  });

  it("da un valor por defecto razonable con una lista vacía", () => {
    expect(inferFrameRate([], 30000)).toEqual({ numerator: 30, denominator: 1 });
  });
});
