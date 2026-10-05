import { describe, expect, it } from "vitest";
import { parseProjectFile, serializeProject } from "./project";
import { secondsToTicks } from "./time";
import { splitClipAt } from "./timeline";
import {
  clearTransformKeyframes,
  resolveVideoLayers,
  setClipTransformAt,
  toggleTransformKeyframe,
  transformAt,
} from "./transform";
import { IDENTITY_TRANSFORM, type Clip, type Timeline } from "./types";

function clip(id: string, sourceId: string, startSec: number, durationSec: number): Clip {
  return {
    id,
    kind: "clip",
    sourceId,
    startTicks: secondsToTicks(startSec),
    sourceInTicks: 0,
    sourceOutTicks: secondsToTicks(durationSec),
    volume: 1,
    muted: false,
  };
}

/** Dos pistas de vídeo: "fondo" (abajo) y "encima" (arriba), las dos de 0 a 4 s. */
function layered(): Timeline {
  return {
    tracks: [
      { id: "v1", kind: "video", hidden: false, clips: [clip("fondo", "s1", 0, 4)] },
      { id: "v2", kind: "video", hidden: false, clips: [clip("encima", "s2", 0, 4)] },
    ],
    outputResolution: { width: 1920, height: 1080 },
    outputFrameRate: { numerator: 30, denominator: 1 },
  };
}

const t = (sec: number) => secondsToTicks(sec);

describe("transformAt", () => {
  it("sin transformación es la identidad; con estática, la estática", () => {
    const tl = layered();
    expect(transformAt(tl.tracks[1]!.clips[0]!, 0)).toEqual(IDENTITY_TRANSFORM);
    const moved = setClipTransformAt(tl, "v2", "encima", 0, { ...IDENTITY_TRANSFORM, scale: 0.5 });
    expect(transformAt(moved.tracks[1]!.clips[0]!, t(3)).scale).toBe(0.5);
  });

  it("interpola entre keyframes con suavizado, y mantiene los extremos fuera de ellos", () => {
    let tl = layered();
    tl = toggleTransformKeyframe(tl, "v2", "encima", t(1)); // identidad en 1 s
    tl = setClipTransformAt(tl, "v2", "encima", t(3), { ...IDENTITY_TRANSFORM, x: 0.4, opacity: 0 });
    const c = tl.tracks[1]!.clips[0]!;
    expect(c.transformKeyframes).toHaveLength(2);
    expect(transformAt(c, t(0)).x).toBe(0);
    expect(transformAt(c, t(2)).x).toBeCloseTo(0.2); // punto medio: el suavizado es simétrico
    expect(transformAt(c, t(1.5)).x).toBeLessThan(0.1); // arranca despacio (lineal daría 0.1)
    expect(transformAt(c, t(3.5))).toMatchObject({ x: 0.4, opacity: 0 });
  });

  it("quitar el último keyframe deja la transformación quieta en su valor", () => {
    let tl = layered();
    tl = setClipTransformAt(tl, "v2", "encima", 0, { ...IDENTITY_TRANSFORM, rotation: 30 });
    tl = toggleTransformKeyframe(tl, "v2", "encima", t(1));
    expect(tl.tracks[1]!.clips[0]!.transform).toBeUndefined();
    tl = toggleTransformKeyframe(tl, "v2", "encima", t(1));
    const c = tl.tracks[1]!.clips[0]!;
    expect(c.transformKeyframes).toBeUndefined();
    expect(c.transform?.rotation).toBe(30);
    const cleared = clearTransformKeyframes(toggleTransformKeyframe(tl, "v2", "encima", 0), "v2", "encima", 0);
    expect(cleared.tracks[1]!.clips[0]!.transformKeyframes).toBeUndefined();
  });

  it("cortar reparte la animación sin que salte en el corte", () => {
    let tl = layered();
    tl = toggleTransformKeyframe(tl, "v2", "encima", 0);
    tl = setClipTransformAt(tl, "v2", "encima", t(4), { ...IDENTITY_TRANSFORM, scale: 2 });
    const before = transformAt(tl.tracks[1]!.clips[0]!, t(1.5)).scale;
    const cut = splitClipAt(tl, "v2", t(1.5), ["a", "b"]);
    const [a, b] = cut.tracks[1]!.clips;
    expect(transformAt(a!, t(1.5)).scale).toBeCloseTo(before);
    expect(transformAt(b!, 0).scale).toBeCloseTo(before);
    expect(transformAt(b!, t(2.5)).scale).toBeCloseTo(2);
  });
});

describe("resolveVideoLayers", () => {
  it("un clip sin transformar tapa todo: una sola capa", () => {
    const layers = resolveVideoLayers(layered(), t(1));
    expect(layers.map((l) => l.clip.id)).toEqual(["encima"]);
  });

  it("si la capa de arriba no tapa (escala, opacidad o croma), se pinta también la de abajo, primero", () => {
    const small = setClipTransformAt(layered(), "v2", "encima", 0, { ...IDENTITY_TRANSFORM, scale: 0.3, x: 0.3 });
    expect(resolveVideoLayers(small, t(1)).map((l) => l.clip.id)).toEqual(["fondo", "encima"]);
    const faded = setClipTransformAt(layered(), "v2", "encima", 0, { ...IDENTITY_TRANSFORM, opacity: 0.5 });
    expect(resolveVideoLayers(faded, t(1)).map((l) => l.clip.id)).toEqual(["fondo", "encima"]);
  });

  it("solo donde la animación deja ver la de abajo", () => {
    let tl = toggleTransformKeyframe(layered(), "v2", "encima", 0);
    tl = setClipTransformAt(tl, "v2", "encima", t(2), { ...IDENTITY_TRANSFORM, opacity: 0 });
    expect(resolveVideoLayers(tl, 0).map((l) => l.clip.id)).toEqual(["encima"]);
    expect(resolveVideoLayers(tl, t(1)).map((l) => l.clip.id)).toEqual(["fondo", "encima"]);
  });
});

describe("transformación en el proyecto guardado", () => {
  it("sobrevive a guardar y cargar", () => {
    let tl = toggleTransformKeyframe(layered(), "v2", "encima", 0);
    tl = setClipTransformAt(tl, "v2", "encima", t(2), { ...IDENTITY_TRANSFORM, y: -0.25 });
    tl = setClipTransformAt(tl, "v1", "fondo", 0, { ...IDENTITY_TRANSFORM, rotation: 90 });
    const videoMeta = { frameRate: { numerator: 30, denominator: 1 }, width: 1920, height: 1080 };
    const sources = [
      { id: "s1", kind: "video" as const, durationTicks: t(4), fileName: "a.mp4", ...videoMeta },
      { id: "s2", kind: "video" as const, durationTicks: t(4), fileName: "b.mp4", ...videoMeta },
    ];
    const parsed = parseProjectFile(JSON.parse(JSON.stringify(serializeProject(tl, sources, [], []))));
    expect(parsed.tracks[1]!.clips[0]!.transformKeyframes).toEqual(tl.tracks[1]!.clips[0]!.transformKeyframes);
    expect(parsed.tracks[0]!.clips[0]!.transform).toEqual(tl.tracks[0]!.clips[0]!.transform);
  });
});
