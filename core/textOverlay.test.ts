import { describe, expect, it } from "vitest";
import { activeTextOverlaysAt, type TextOverlay } from "./textOverlay";

function overlay(id: string, startTicks: number, endTicks: number): TextOverlay {
  return { id, startTicks, endTicks, text: id, xPercent: 50, yPercent: 90, fontSizePx: 32, color: "#fff" };
}

describe("activeTextOverlaysAt", () => {
  it("incluye un overlay cuyo rango contiene el instante", () => {
    const overlays = [overlay("a", 0, 100)];
    expect(activeTextOverlaysAt(overlays, 50)).toEqual(overlays);
  });

  it("excluye el instante justo en endTicks (exclusivo)", () => {
    const overlays = [overlay("a", 0, 100)];
    expect(activeTextOverlaysAt(overlays, 100)).toEqual([]);
  });

  it("incluye el instante justo en startTicks (inclusive)", () => {
    const overlays = [overlay("a", 50, 100)];
    expect(activeTextOverlaysAt(overlays, 50)).toEqual(overlays);
  });

  it("devuelve varios overlays solapados en el mismo instante", () => {
    const overlays = [overlay("a", 0, 100), overlay("b", 20, 200)];
    expect(activeTextOverlaysAt(overlays, 50).map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("devuelve vacío si ninguno está activo", () => {
    const overlays = [overlay("a", 0, 10)];
    expect(activeTextOverlaysAt(overlays, 500)).toEqual([]);
  });
});
