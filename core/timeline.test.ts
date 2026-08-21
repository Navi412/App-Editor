import { describe, expect, it } from "vitest";
import { secondsToTicks } from "./time";
import {
  appendClip,
  clipDurationTicks,
  clipStartTicks,
  createGap,
  createTransition,
  effectiveClipVolume,
  insertClipAt,
  removeClip,
  reorderClip,
  setClipAudio,
  splitClipAt,
  timelineDurationTicks,
  trimClipIn,
  trimClipOut,
  walkTimeline,
} from "./timeline";
import type { Clip, Timeline } from "./types";

function clip(id: string, sourceId: string, inSec: number, outSec: number): Clip {
  return {
    id,
    kind: "clip",
    sourceId,
    sourceInTicks: secondsToTicks(inSec),
    sourceOutTicks: secondsToTicks(outSec),
    volume: 1,
    muted: false,
  };
}

/** Timeline con dos clips: "a" (0s-2s de sourceA) y "b" (5s-8s de sourceB). */
function twoClipTimeline(): Timeline {
  return {
    track: {
      id: "track-1",
      clips: [clip("a", "source-a", 0, 2), clip("b", "source-b", 5, 8)],
    },
    outputResolution: { width: 1920, height: 1080 },
    outputFrameRate: { numerator: 30, denominator: 1 },
  };
}

describe("clipDurationTicks / timelineDurationTicks", () => {
  it("suma las duraciones de todos los clips de la pista", () => {
    const timeline = twoClipTimeline();
    expect(clipDurationTicks(timeline.track.clips[0]!)).toBe(secondsToTicks(2));
    expect(clipDurationTicks(timeline.track.clips[1]!)).toBe(secondsToTicks(3));
    expect(timelineDurationTicks(timeline)).toBe(secondsToTicks(5));
  });
});

describe("walkTimeline", () => {
  it("resuelve un instante dentro del primer clip", () => {
    const timeline = twoClipTimeline();
    const pos = walkTimeline(timeline, secondsToTicks(1));
    expect(pos).not.toBeNull();
    expect(pos!.sourceId).toBe("source-a");
    expect(pos!.sourceTimeTicks).toBe(secondsToTicks(1));
    expect(pos!.clipIndex).toBe(0);
  });

  it("resuelve el instante exacto del límite entre clips como el segundo clip", () => {
    const timeline = twoClipTimeline();
    // El primer clip dura 2s -> tick 2s es el primer instante del segundo clip.
    const pos = walkTimeline(timeline, secondsToTicks(2));
    expect(pos!.clipIndex).toBe(1);
    expect(pos!.sourceId).toBe("source-b");
    // sourceInTicks del clip b es 5s, así que el offset 0 cae en 5s de source-b.
    expect(pos!.sourceTimeTicks).toBe(secondsToTicks(5));
  });

  it("resuelve un instante dentro del segundo clip con el offset correcto", () => {
    const timeline = twoClipTimeline();
    const pos = walkTimeline(timeline, secondsToTicks(3.5));
    expect(pos!.clipIndex).toBe(1);
    // offset 1.5s dentro del segundo clip -> sourceInTicks(5s) + 1.5s
    expect(pos!.sourceTimeTicks).toBe(secondsToTicks(6.5));
  });

  it("devuelve null para un tick negativo", () => {
    const timeline = twoClipTimeline();
    expect(walkTimeline(timeline, -1)).toBeNull();
  });

  it("devuelve null para un tick igual o mayor que la duración total", () => {
    const timeline = twoClipTimeline();
    const total = timelineDurationTicks(timeline);
    expect(walkTimeline(timeline, total)).toBeNull();
    expect(walkTimeline(timeline, total + 1)).toBeNull();
  });

  it("devuelve null en una timeline vacía", () => {
    const empty: Timeline = {
      track: { id: "t", clips: [] },
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    expect(walkTimeline(empty, 0)).toBeNull();
  });
});

describe("appendClip / removeClip", () => {
  it("añade un clip al final sin tocar los demás", () => {
    const timeline = twoClipTimeline();
    const next = appendClip(timeline, clip("c", "source-c", 0, 1));
    expect(next.track.clips.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(timeline.track.clips.map((c) => c.id)).toEqual(["a", "b"]); // no muta
  });

  it("elimina un clip por índice", () => {
    const timeline = twoClipTimeline();
    const next = removeClip(timeline, 0);
    expect(next.track.clips.map((c) => c.id)).toEqual(["b"]);
  });

  it("lanza al eliminar un índice fuera de rango", () => {
    const timeline = twoClipTimeline();
    expect(() => removeClip(timeline, 5)).toThrow(RangeError);
  });
});

describe("reorderClip", () => {
  it("mueve un clip preservando la duración total", () => {
    const timeline = twoClipTimeline();
    const next = reorderClip(timeline, 0, 1);
    expect(next.track.clips.map((c) => c.id)).toEqual(["b", "a"]);
    expect(timelineDurationTicks(next)).toBe(timelineDurationTicks(timeline));
  });

  it("lanza con índices fuera de rango", () => {
    const timeline = twoClipTimeline();
    expect(() => reorderClip(timeline, 0, 9)).toThrow(RangeError);
    expect(() => reorderClip(timeline, -1, 0)).toThrow(RangeError);
  });
});

describe("splitClipAt", () => {
  it("parte un clip en dos que suman la duración original", () => {
    const timeline = twoClipTimeline();
    // Cortar el segundo clip (5s-8s de source-b) 1s después de su inicio en la timeline (tick 3s).
    const next = splitClipAt(timeline, secondsToTicks(3), ["b1", "b2"]);
    const [a, b1, b2] = next.track.clips;
    expect(a!.id).toBe("a");
    expect(b1!.id).toBe("b1");
    expect(b2!.id).toBe("b2");

    // b1: 5s-6s de source-b ; b2: 6s-8s de source-b
    expect(b1!.sourceInTicks).toBe(secondsToTicks(5));
    expect(b1!.sourceOutTicks).toBe(secondsToTicks(6));
    expect(b2!.sourceInTicks).toBe(secondsToTicks(6));
    expect(b2!.sourceOutTicks).toBe(secondsToTicks(8));

    expect(clipDurationTicks(b1!) + clipDurationTicks(b2!)).toBe(
      clipDurationTicks(timeline.track.clips[1]!),
    );
    expect(timelineDurationTicks(next)).toBe(timelineDurationTicks(timeline));
  });

  it("lanza si el punto de corte coincide con el inicio de un clip", () => {
    const timeline = twoClipTimeline();
    // tick 2s es el inicio exacto del segundo clip.
    expect(() => splitClipAt(timeline, secondsToTicks(2), ["x", "y"])).toThrow(
      RangeError,
    );
  });

  it("lanza si el punto de corte está fuera de la timeline", () => {
    const timeline = twoClipTimeline();
    expect(() => splitClipAt(timeline, secondsToTicks(999), ["x", "y"])).toThrow(
      RangeError,
    );
  });
});

describe("trimClipIn / trimClipOut", () => {
  const minDuration = secondsToTicks(0.1);

  it("trimClipIn mueve el punto de entrada respetando la duración mínima", () => {
    const timeline = twoClipTimeline();
    const next = trimClipIn(timeline, 0, secondsToTicks(0.5), minDuration);
    expect(next.track.clips[0]!.sourceInTicks).toBe(secondsToTicks(0.5));
    expect(next.track.clips[0]!.sourceOutTicks).toBe(secondsToTicks(2));
  });

  it("trimClipIn lanza si el resultado queda por debajo de la duración mínima", () => {
    const timeline = twoClipTimeline();
    expect(() =>
      trimClipIn(timeline, 0, secondsToTicks(1.95), minDuration),
    ).toThrow(RangeError);
  });

  it("trimClipIn lanza con sourceInTicks negativo", () => {
    const timeline = twoClipTimeline();
    expect(() => trimClipIn(timeline, 0, -1, minDuration)).toThrow(RangeError);
  });

  it("trimClipOut mueve el punto de salida respetando la duración mínima", () => {
    const timeline = twoClipTimeline();
    const next = trimClipOut(timeline, 1, secondsToTicks(7), minDuration);
    expect(next.track.clips[1]!.sourceOutTicks).toBe(secondsToTicks(7));
    expect(next.track.clips[1]!.sourceInTicks).toBe(secondsToTicks(5));
  });

  it("trimClipOut lanza si el resultado queda por debajo de la duración mínima", () => {
    const timeline = twoClipTimeline();
    expect(() =>
      trimClipOut(timeline, 1, secondsToTicks(5.05), minDuration),
    ).toThrow(RangeError);
  });
});

describe("clipStartTicks", () => {
  it("el primer clip empieza en el tick 0", () => {
    const timeline = twoClipTimeline();
    expect(clipStartTicks(timeline, 0)).toBe(0);
  });

  it("el segundo clip empieza donde termina el primero", () => {
    const timeline = twoClipTimeline();
    expect(clipStartTicks(timeline, 1)).toBe(clipDurationTicks(timeline.track.clips[0]!));
  });

  it("lanza con un índice fuera de rango", () => {
    const timeline = twoClipTimeline();
    expect(() => clipStartTicks(timeline, 2)).toThrow(RangeError);
    expect(() => clipStartTicks(timeline, -1)).toThrow(RangeError);
  });
});

describe("setClipAudio / effectiveClipVolume", () => {
  it("actualiza volumen y muted del clip indicado, sin tocar los demás", () => {
    const timeline = twoClipTimeline();
    const next = setClipAudio(timeline, 0, 0.5, true);
    expect(next.track.clips[0]!.volume).toBe(0.5);
    expect(next.track.clips[0]!.muted).toBe(true);
    expect(next.track.clips[1]!.volume).toBe(1);
    expect(next.track.clips[1]!.muted).toBe(false);
  });

  it("recorta el volumen al rango [0, 1]", () => {
    const timeline = twoClipTimeline();
    expect(setClipAudio(timeline, 0, 1.5, false).track.clips[0]!.volume).toBe(1);
    expect(setClipAudio(timeline, 0, -0.5, false).track.clips[0]!.volume).toBe(0);
  });

  it("lanza con un índice fuera de rango", () => {
    const timeline = twoClipTimeline();
    expect(() => setClipAudio(timeline, 5, 1, false)).toThrow(RangeError);
  });

  it("effectiveClipVolume es 0 si el clip está silenciado, independientemente de volume", () => {
    expect(effectiveClipVolume({ ...clip("a", "s", 0, 1), volume: 0.8, muted: true })).toBe(0);
    expect(effectiveClipVolume({ ...clip("a", "s", 0, 1), volume: 0.8, muted: false })).toBe(0.8);
  });
});

describe("createGap / createTransition / insertClipAt", () => {
  it("createGap produce un clip sin sourceId cuya duración es la pedida", () => {
    const gap = createGap("gap-1", secondsToTicks(2));
    expect(gap.kind).toBe("gap");
    expect(gap.sourceId).toBe("");
    expect(clipDurationTicks(gap)).toBe(secondsToTicks(2));
  });

  it("createGap fuerza una duración mínima de 1 tick", () => {
    expect(clipDurationTicks(createGap("gap-1", 0))).toBe(1);
    expect(clipDurationTicks(createGap("gap-1", -5))).toBe(1);
  });

  it("createTransition produce un clip con su tipo y duración", () => {
    const transition = createTransition("t-1", secondsToTicks(0.5), "crossfade");
    expect(transition.kind).toBe("transition");
    expect(transition.transitionType).toBe("crossfade");
    expect(clipDurationTicks(transition)).toBe(secondsToTicks(0.5));
  });

  it("insertClipAt inserta en la posición pedida sin afectar a los demás clips", () => {
    const timeline = twoClipTimeline();
    const gap = createGap("gap-1", secondsToTicks(1));
    const next = insertClipAt(timeline, 1, gap);
    expect(next.track.clips.map((c) => c.id)).toEqual(["a", "gap-1", "b"]);
    expect(timelineDurationTicks(next)).toBe(timelineDurationTicks(timeline) + secondsToTicks(1));
  });

  it("insertClipAt recorta el índice a [0, longitud]", () => {
    const timeline = twoClipTimeline();
    const gap = createGap("gap-1", secondsToTicks(1));
    expect(insertClipAt(timeline, -5, gap).track.clips.map((c) => c.id)).toEqual(["gap-1", "a", "b"]);
    expect(insertClipAt(timeline, 99, gap).track.clips.map((c) => c.id)).toEqual(["a", "b", "gap-1"]);
  });

  it("un hueco/transición participa normalmente en walkTimeline", () => {
    const timeline = twoClipTimeline();
    const gap = createGap("gap-1", secondsToTicks(1));
    const next = insertClipAt(timeline, 1, gap);
    // "a" dura 2s (0-2s), luego el hueco de 1s (2-3s), luego "b" (3-6s).
    const posInGap = walkTimeline(next, secondsToTicks(2.5));
    expect(posInGap?.clip.kind).toBe("gap");
    const posInB = walkTimeline(next, secondsToTicks(3.5));
    expect(posInB?.sourceId).toBe("source-b");
  });
});
