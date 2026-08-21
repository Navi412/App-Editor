import { describe, expect, it } from "vitest";
import { secondsToTicks } from "./time";
import {
  appendClip,
  clipDurationTicks,
  clipStartTicks,
  removeClip,
  reorderClip,
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
    sourceId,
    sourceInTicks: secondsToTicks(inSec),
    sourceOutTicks: secondsToTicks(outSec),
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
