import { describe, expect, it } from "vitest";
import { computeFitRect } from "./render";

describe("computeFitRect", () => {
  it("no cambia nada cuando la relación de aspecto ya coincide", () => {
    expect(computeFitRect({ width: 1920, height: 1080 }, { width: 960, height: 540 })).toEqual({
      x: 0,
      y: 0,
      width: 960,
      height: 540,
    });
  });

  it("añade barras verticales (pillarbox) para una fuente más estrecha que el destino", () => {
    // fuente 4:3 en destino 16:9 -> se ajusta por altura, sobra ancho a los lados
    const rect = computeFitRect({ width: 4, height: 3 }, { width: 1600, height: 900 });
    expect(rect.height).toBe(900);
    expect(rect.width).toBeCloseTo(1200, 5);
    expect(rect.x).toBeCloseTo(200, 5);
    expect(rect.y).toBe(0);
  });

  it("añade barras horizontales (letterbox) para una fuente más ancha que el destino", () => {
    // fuente 21:9 en destino 16:9 -> se ajusta por ancho, sobra alto arriba/abajo
    const rect = computeFitRect({ width: 2560, height: 1080 }, { width: 1600, height: 900 });
    expect(rect.width).toBe(1600);
    expect(rect.height).toBeCloseTo(675, 5);
    expect(rect.x).toBe(0);
    expect(rect.y).toBeCloseTo(112.5, 5);
  });

  it("devuelve el rectángulo completo del destino si la fuente no tiene dimensiones válidas", () => {
    expect(computeFitRect({ width: 0, height: 0 }, { width: 800, height: 600 })).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });
});
