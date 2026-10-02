import { describe, expect, it } from "vitest";
import {
  buildCurveTable,
  evaluateCurve,
  IDENTITY_CURVES,
  isIdentityCurves,
  normalizeColorGrade,
  normalizeCurve,
  parseCubeLut,
  sampleLut,
  serializeCubeLut,
} from "./color";
import { NEUTRAL_COLOR_GRADE } from "./types";

/** .cube identidad de tamaño 2 (R varía más rápido). */
const IDENTITY_CUBE_2 = `TITLE "Identidad"
# comentario
LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

describe("curvas", () => {
  it("la curva identidad devuelve la entrada", () => {
    const curve = normalizeCurve([]);
    for (const x of [0, 0.25, 0.5, 0.9, 1]) expect(evaluateCurve(curve, x)).toBeCloseTo(x, 9);
  });

  it("pasa exactamente por sus puntos y es monótona (no rebota)", () => {
    const curve = normalizeCurve([
      { x: 0.25, y: 0.1 },
      { x: 0.5, y: 0.8 },
      { x: 0.75, y: 0.82 },
    ]);
    expect(evaluateCurve(curve, 0.5)).toBeCloseTo(0.8, 9);
    expect(evaluateCurve(curve, 0.25)).toBeCloseTo(0.1, 9);
    let previous = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const y = evaluateCurve(curve, i / 100);
      expect(y).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = y;
    }
    // Entre 0.5 y 0.75 los puntos casi coinciden en y: nunca se sale del tramo.
    for (let x = 0.5; x <= 0.75; x += 0.01) {
      expect(evaluateCurve(curve, x)).toBeLessThanOrEqual(0.82 + 1e-9);
    }
  });

  it("normalizeCurve ordena, recorta a [0,1] y añade los extremos", () => {
    expect(
      normalizeCurve([
        { x: 0.5, y: 2 },
        { x: -1, y: 0.2 },
      ]),
    ).toEqual([
      { x: 0, y: 0.2 },
      { x: 0.5, y: 1 },
      { x: 1, y: 1 },
    ]);
  });

  it("buildCurveTable compone cada canal sobre la maestra", () => {
    const table = buildCurveTable({
      ...IDENTITY_CURVES,
      master: [
        { x: 0, y: 0 },
        { x: 1, y: 0.5 },
      ],
      r: [
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ],
    });
    expect(table.length).toBe(256 * 4);
    expect(table[255 * 4]).toBe(255); // R: curva plana a 1
    expect(table[255 * 4 + 1]).toBe(128); // G: solo la maestra (0.5)
    expect(table[3]).toBe(255);
  });

  it("isIdentityCurves", () => {
    expect(isIdentityCurves(undefined)).toBe(true);
    expect(isIdentityCurves(IDENTITY_CURVES)).toBe(true);
    expect(
      isIdentityCurves({
        ...IDENTITY_CURVES,
        g: [
          { x: 0, y: 0.1 },
          { x: 1, y: 1 },
        ],
      }),
    ).toBe(false);
  });
});

describe("normalizeColorGrade", () => {
  it("rellena con neutros los campos de un grading anterior al 2026-10-02", () => {
    const legacy = {
      liftR: 0.1,
      liftG: 0,
      liftB: 0,
      gammaR: 1,
      gammaG: 1,
      gammaB: 1,
      gainR: 1,
      gainG: 1,
      gainB: 1,
      saturation: 1.2,
      contrast: 1,
      invert: false,
    };
    expect(normalizeColorGrade(legacy)).toEqual({ ...NEUTRAL_COLOR_GRADE, liftR: 0.1, saturation: 1.2 });
  });

  it("rechaza lo que no es un grading", () => {
    expect(normalizeColorGrade({ liftR: 0 })).toBeUndefined();
    expect(normalizeColorGrade(null)).toBeUndefined();
  });

  it("descarta curvas identidad y conserva las reales", () => {
    expect(normalizeColorGrade({ ...NEUTRAL_COLOR_GRADE, curves: IDENTITY_CURVES })!.curves).toBeUndefined();
    const curves = {
      ...IDENTITY_CURVES,
      b: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.7 },
        { x: 1, y: 1 },
      ],
    };
    expect(normalizeColorGrade({ ...NEUTRAL_COLOR_GRADE, curves })!.curves).toEqual(curves);
  });
});

describe("LUT .cube", () => {
  it("parsea una LUT identidad con título y comentarios", () => {
    const lut = parseCubeLut(IDENTITY_CUBE_2, "lut-1", "archivo.cube");
    expect(lut.name).toBe("Identidad");
    expect(lut.size).toBe(2);
    expect(lut.data.length).toBe(24);
    expect(sampleLut(lut, [0.3, 0.6, 0.9]).map((v) => Number(v.toFixed(6)))).toEqual([0.3, 0.6, 0.9]);
  });

  it("usa el nombre de archivo si no hay TITLE", () => {
    const lut = parseCubeLut(IDENTITY_CUBE_2.replace(/TITLE.*\n/, ""), "lut-1", "archivo.cube");
    expect(lut.name).toBe("archivo.cube");
  });

  it("reescala DOMAIN_MIN/MAX a 0..1", () => {
    const text = IDENTITY_CUBE_2.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2");
    expect(parseCubeLut(text, "l", "n").data[3]).toBeCloseTo(0.5);
  });

  it("rechaza LUT 1D, tamaños incoherentes y basura", () => {
    expect(() => parseCubeLut("LUT_1D_SIZE 4\n0 0 0", "l", "n")).toThrow(/1D/);
    expect(() => parseCubeLut("LUT_3D_SIZE 2\n0 0 0", "l", "n")).toThrow(/entradas/);
    expect(() => parseCubeLut("hola", "l", "n")).toThrow();
  });

  it("serializeCubeLut → parseCubeLut es ida y vuelta", () => {
    const lut = parseCubeLut(IDENTITY_CUBE_2, "lut-1", "x");
    const again = parseCubeLut(serializeCubeLut(lut), "lut-1", "x");
    expect(again.name).toBe(lut.name);
    expect([...again.data]).toEqual([...lut.data]);
  });
});
