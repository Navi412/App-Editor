import { describe, expect, it } from "vitest";
import { secondsToTicks } from "./time";
import {
  addVolumeKeyframe,
  appendClip,
  audioHeadCutTicks,
  audioTailCutTicks,
  clipDurationTicks,
  clipStartTicks,
  createGap,
  createTransition,
  effectiveClipVolume,
  insertClipAt,
  moveClipByDelta,
  moveVolumeKeyframe,
  removeClip,
  removeVolumeKeyframe,
  reorderClip,
  setClipAudio,
  setClipColorFilter,
  splitClipAt,
  timelineDurationTicks,
  transitionAudioCues,
  trimClipIn,
  trimClipOut,
  volumeAtOffsetTicks,
  volumeAutomationFrom,
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

describe("setClipColorFilter", () => {
  it("añade el filtro al clip indicado, sin tocar los demás", () => {
    const timeline = twoClipTimeline();
    const next = setClipColorFilter(timeline, 0, "grayscale");
    expect(next.track.clips[0]!.colorFilter).toBe("grayscale");
    expect(next.track.clips[1]!.colorFilter).toBeUndefined();
  });

  it("con undefined quita el filtro en vez de dejarlo puesto", () => {
    const timeline = setClipColorFilter(twoClipTimeline(), 0, "sepia");
    const next = setClipColorFilter(timeline, 0, undefined);
    expect(next.track.clips[0]!.colorFilter).toBeUndefined();
    expect("colorFilter" in next.track.clips[0]!).toBe(false);
  });

  it("lanza con un índice fuera de rango", () => {
    const timeline = twoClipTimeline();
    expect(() => setClipColorFilter(timeline, 5, "invert")).toThrow(RangeError);
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

describe("moveClipByDelta", () => {
  it("un desplazamiento positivo crea un hueco nuevo delante del clip si no había", () => {
    const timeline = twoClipTimeline();
    const next = moveClipByDelta(timeline, "b", secondsToTicks(1), "gap-1");
    expect(next.track.clips.map((c) => c.id)).toEqual(["a", "gap-1", "b"]);
    expect(clipDurationTicks(next.track.clips[1]!)).toBe(secondsToTicks(1));
    expect(timelineDurationTicks(next)).toBe(timelineDurationTicks(timeline) + secondsToTicks(1));
  });

  it("un desplazamiento positivo crece un hueco ya existente delante del clip", () => {
    const timeline = insertClipAt(twoClipTimeline(), 1, createGap("gap-1", secondsToTicks(1)));
    const next = moveClipByDelta(timeline, "b", secondsToTicks(0.5), "gap-unused");
    expect(next.track.clips.map((c) => c.id)).toEqual(["a", "gap-1", "b"]);
    expect(clipDurationTicks(next.track.clips[1]!)).toBe(secondsToTicks(1.5));
  });

  it("un desplazamiento negativo encoge el hueco delante del clip", () => {
    const timeline = insertClipAt(twoClipTimeline(), 1, createGap("gap-1", secondsToTicks(1)));
    const next = moveClipByDelta(timeline, "b", -secondsToTicks(0.4), "gap-unused");
    expect(next.track.clips.map((c) => c.id)).toEqual(["a", "gap-1", "b"]);
    expect(clipDurationTicks(next.track.clips[1]!)).toBe(secondsToTicks(0.6));
  });

  it("un desplazamiento negativo que consume el hueco entero lo elimina y deja los clips pegados", () => {
    const timeline = insertClipAt(twoClipTimeline(), 1, createGap("gap-1", secondsToTicks(1)));
    const next = moveClipByDelta(timeline, "b", -secondsToTicks(1), "gap-unused");
    expect(next.track.clips.map((c) => c.id)).toEqual(["a", "b"]);
    expect(timelineDurationTicks(next)).toBe(timelineDurationTicks(twoClipTimeline()));
  });

  it("un desplazamiento negativo menor que el vecino real (sin hueco de por medio) se recorta a 0", () => {
    const timeline = twoClipTimeline(); // "a" (2s) y "b" (3s), pegados, sin hueco
    const next = moveClipByDelta(timeline, "b", -secondsToTicks(1), "gap-unused");
    expect(next.track.clips.map((c) => c.id)).toEqual(["a", "b"]);
    expect(next.track.clips).toEqual(timeline.track.clips);
  });

  it("un desplazamiento negativo igual o mayor que el vecino real reordena (pasa a través de él)", () => {
    const timeline: Timeline = {
      track: {
        id: "track-1",
        clips: [clip("a", "source-a", 0, 2), clip("b", "source-b", 0, 3), clip("c", "source-c", 0, 4)],
      },
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    const next = moveClipByDelta(timeline, "c", -secondsToTicks(3), "gap-unused");
    expect(next.track.clips.map((c) => c.id)).toEqual(["a", "c", "b"]);
    expect(timelineDurationTicks(next)).toBe(timelineDurationTicks(timeline));
  });

  it("no se puede desplazar antes del principio de la timeline: se recorta a 0", () => {
    const timeline = twoClipTimeline();
    const next = moveClipByDelta(timeline, "a", -secondsToTicks(1), "gap-unused");
    expect(next.track.clips).toEqual(timeline.track.clips);
  });

  it("un desplazamiento positivo del primer clip crea un hueco delante de todo", () => {
    const timeline = twoClipTimeline();
    const next = moveClipByDelta(timeline, "a", secondsToTicks(0.5), "gap-1");
    expect(next.track.clips.map((c) => c.id)).toEqual(["gap-1", "a", "b"]);
    expect(clipDurationTicks(next.track.clips[0]!)).toBe(secondsToTicks(0.5));
  });

  it("un id de clip inexistente devuelve la timeline sin cambios", () => {
    const timeline = twoClipTimeline();
    const next = moveClipByDelta(timeline, "no-existe", secondsToTicks(1), "gap-1");
    expect(next).toBe(timeline);
  });
});

describe("volumen por trozos (VolumeKeyframe)", () => {
  it("volumeAtOffsetTicks sin puntos es el volumen plano del clip (0 si está silenciado)", () => {
    const a = clip("a", "source-a", 0, 2);
    expect(volumeAtOffsetTicks(a, secondsToTicks(1))).toBe(1);
    expect(volumeAtOffsetTicks({ ...a, muted: true }, secondsToTicks(1))).toBe(0);
  });

  it("volumeAtOffsetTicks interpola linealmente entre dos puntos", () => {
    const a: Clip = {
      ...clip("a", "source-a", 0, 2),
      volumeKeyframes: [
        { offsetTicks: secondsToTicks(0.5), volume: 0 },
        { offsetTicks: secondsToTicks(1.5), volume: 1 },
      ],
    };
    expect(volumeAtOffsetTicks(a, secondsToTicks(1))).toBeCloseTo(0.5, 5);
    expect(volumeAtOffsetTicks(a, secondsToTicks(0.5))).toBeCloseTo(0, 5);
    expect(volumeAtOffsetTicks(a, secondsToTicks(1.5))).toBeCloseTo(1, 5);
  });

  it("volumeAtOffsetTicks se mantiene plano fuera del primer/último punto", () => {
    const a: Clip = {
      ...clip("a", "source-a", 0, 2),
      volumeKeyframes: [
        { offsetTicks: secondsToTicks(0.5), volume: 0.2 },
        { offsetTicks: secondsToTicks(1.5), volume: 0.8 },
      ],
    };
    expect(volumeAtOffsetTicks(a, 0)).toBeCloseTo(0.2, 5);
    expect(volumeAtOffsetTicks(a, secondsToTicks(2))).toBeCloseTo(0.8, 5);
  });

  it("volumeAtOffsetTicks es 0 si el clip está silenciado, aunque tenga puntos", () => {
    const a: Clip = {
      ...clip("a", "source-a", 0, 2),
      muted: true,
      volumeKeyframes: [{ offsetTicks: secondsToTicks(1), volume: 1 }],
    };
    expect(volumeAtOffsetTicks(a, secondsToTicks(1))).toBe(0);
  });

  it("addVolumeKeyframe inserta ordenado y recorta offset/volumen a rango", () => {
    const timeline = twoClipTimeline();
    let next = addVolumeKeyframe(timeline, 0, secondsToTicks(1.5), 0.5);
    next = addVolumeKeyframe(next, 0, secondsToTicks(0.5), 2); // volumen fuera de rango -> se recorta a 1
    next = addVolumeKeyframe(next, 0, -secondsToTicks(1), -1); // offset/volumen negativos -> se recortan a 0
    const keyframes = next.track.clips[0]!.volumeKeyframes!;
    expect(keyframes.map((k) => k.offsetTicks)).toEqual([0, secondsToTicks(0.5), secondsToTicks(1.5)]);
    expect(keyframes[0]!.volume).toBe(0);
    expect(keyframes[1]!.volume).toBe(1);
    expect(keyframes[2]!.volume).toBe(0.5);
  });

  it("removeVolumeKeyframe quita el punto y deja volumeKeyframes undefined si no queda ninguno", () => {
    const timeline = addVolumeKeyframe(twoClipTimeline(), 0, secondsToTicks(1), 0.5);
    const next = removeVolumeKeyframe(timeline, 0, 0);
    expect(next.track.clips[0]!.volumeKeyframes).toBeUndefined();
  });

  it("removeVolumeKeyframe con un índice inexistente no cambia nada", () => {
    const timeline = addVolumeKeyframe(twoClipTimeline(), 0, secondsToTicks(1), 0.5);
    const next = removeVolumeKeyframe(timeline, 0, 5);
    expect(next).toBe(timeline);
  });

  it("moveVolumeKeyframe se recorta para no cruzar a sus vecinos", () => {
    let timeline = addVolumeKeyframe(twoClipTimeline(), 0, secondsToTicks(0.5), 0.2);
    timeline = addVolumeKeyframe(timeline, 0, secondsToTicks(1.5), 0.8);
    // Intenta mover el primer punto (0.5s) más allá del segundo (1.5s) -> se recorta a 1.5s.
    const next = moveVolumeKeyframe(timeline, 0, 0, secondsToTicks(3), 0.9);
    const keyframes = next.track.clips[0]!.volumeKeyframes!;
    expect(keyframes[0]!.offsetTicks).toBe(secondsToTicks(1.5));
    expect(keyframes[0]!.volume).toBe(0.9);
    expect(keyframes[1]!.offsetTicks).toBe(secondsToTicks(1.5));
  });

  it("volumeAutomationFrom sin puntos devuelve un único punto con el volumen plano", () => {
    const a = clip("a", "source-a", 0, 2);
    const points = volumeAutomationFrom(a, 0);
    expect(points).toEqual([{ offsetSeconds: 0, volume: 1 }]);
  });

  it("volumeAutomationFrom empezando a mitad de una rampa arranca ya en el valor interpolado", () => {
    const a: Clip = {
      ...clip("a", "source-a", 0, 2),
      volumeKeyframes: [
        { offsetTicks: secondsToTicks(0.5), volume: 0 },
        { offsetTicks: secondsToTicks(1.5), volume: 1 },
      ],
    };
    const points = volumeAutomationFrom(a, secondsToTicks(1));
    expect(points[0]!.offsetSeconds).toBe(0);
    expect(points[0]!.volume).toBeCloseTo(0.5, 5);
    expect(points[1]!.offsetSeconds).toBeCloseTo(0.5, 5); // 1.5s - 1s
    expect(points[1]!.volume).toBeCloseTo(1, 5);
  });

  it("volumeAutomationFrom en un clip silenciado devuelve solo un punto a volumen 0", () => {
    const a: Clip = {
      ...clip("a", "source-a", 0, 2),
      muted: true,
      volumeKeyframes: [{ offsetTicks: secondsToTicks(1), volume: 1 }],
    };
    expect(volumeAutomationFrom(a, 0)).toEqual([{ offsetSeconds: 0, volume: 0 }]);
  });
});

/** "a" (3s) — transición de 0.5s — "b" (4s), sin huecos. */
function transitionTimeline(): Timeline {
  return {
    track: {
      id: "track-1",
      clips: [
        clip("a", "source-a", 0, 3),
        createTransition("t1", secondsToTicks(0.5), "crossfade"),
        clip("b", "source-b", 0, 4),
      ],
    },
    outputResolution: { width: 1920, height: 1080 },
    outputFrameRate: { numerator: 30, denominator: 1 },
  };
}

describe("audio durante una transición", () => {
  it("audioTailCutTicks/audioHeadCutTicks recortan la duración de la transición cuando el vecino es más largo", () => {
    const timeline = transitionTimeline();
    expect(audioTailCutTicks(timeline, 0)).toBe(secondsToTicks(0.5)); // "a", antes de la transición
    expect(audioHeadCutTicks(timeline, 2)).toBe(secondsToTicks(0.5)); // "b", después de la transición
  });

  it("audioTailCutTicks/audioHeadCutTicks son 0 si no hay transición al lado", () => {
    const timeline = transitionTimeline();
    expect(audioHeadCutTicks(timeline, 0)).toBe(0); // "a" no tiene nada antes
    expect(audioTailCutTicks(timeline, 2)).toBe(0); // "b" no tiene nada después
  });

  it("el recorte se limita a la duración del propio vecino si es más corto que la transición", () => {
    const timeline: Timeline = {
      track: {
        id: "track-1",
        clips: [clip("a", "source-a", 0, 0.3), createTransition("t1", secondsToTicks(0.5), "crossfade")],
      },
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    expect(audioTailCutTicks(timeline, 0)).toBe(secondsToTicks(0.3));
  });

  it("transitionAudioCues desde el principio genera un cue por cada vecino con fundido cruzado 1->0 y 0->1", () => {
    const timeline = transitionTimeline();
    const cues = transitionAudioCues(timeline, 1, 0);
    expect(cues).toHaveLength(2);

    const fromCue = cues.find((c) => c.clipIndex === 0)!;
    expect(fromCue.sourceStartTicks).toBe(secondsToTicks(2.5)); // 3s - 0.5s
    expect(fromCue.durationTicks).toBe(secondsToTicks(0.5));
    expect(fromCue.automation[0]!.volume).toBeCloseTo(1, 5);
    expect(fromCue.automation[1]!.volume).toBeCloseTo(0, 5);

    const toCue = cues.find((c) => c.clipIndex === 2)!;
    expect(toCue.sourceStartTicks).toBe(0);
    expect(toCue.durationTicks).toBe(secondsToTicks(0.5));
    expect(toCue.automation[0]!.volume).toBeCloseTo(0, 5);
    expect(toCue.automation[1]!.volume).toBeCloseTo(1, 5);
  });

  it("transitionAudioCues a mitad de la transición arranca ya en la ganancia interpolada", () => {
    const timeline = transitionTimeline();
    const cues = transitionAudioCues(timeline, 1, secondsToTicks(0.25));
    const fromCue = cues.find((c) => c.clipIndex === 0)!;
    expect(fromCue.durationTicks).toBe(secondsToTicks(0.25));
    expect(fromCue.sourceStartTicks).toBe(secondsToTicks(2.75)); // 3s - 0.5s + 0.25s
    expect(fromCue.automation[0]!.volume).toBeCloseTo(0.5, 5);
  });

  it("transitionAudioCues no genera cue para un lado sin clip real (principio/final de timeline)", () => {
    const timeline: Timeline = {
      track: {
        id: "track-1",
        clips: [createTransition("t1", secondsToTicks(0.5), "crossfade"), clip("b", "source-b", 0, 4)],
      },
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    const cues = transitionAudioCues(timeline, 0, 0);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.clipIndex).toBe(1);
  });

  it("transitionAudioCues no genera cue para un vecino silenciado", () => {
    const timeline = transitionTimeline();
    const muted = { ...timeline, track: { ...timeline.track, clips: [...timeline.track.clips] } };
    muted.track.clips[0] = { ...muted.track.clips[0]!, muted: true };
    const cues = transitionAudioCues(muted, 1, 0);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.clipIndex).toBe(2);
  });

  it("transitionAudioCues devuelve vacío si el offset ya supera la duración de la transición", () => {
    const timeline = transitionTimeline();
    expect(transitionAudioCues(timeline, 1, secondsToTicks(1))).toEqual([]);
  });
});
