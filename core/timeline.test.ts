import { describe, expect, it } from "vitest";
import { secondsToTicks } from "./time";
import {
  addTrack,
  addVolumeKeyframe,
  allAudioSchedules,
  appendClip,
  audioHeadCutTicks,
  audioTailCutTicks,
  clipDurationTicks,
  clipEndTicks,
  compressorParamsFromAmount,
  createTransition,
  effectiveClipVolume,
  insertClip,
  isNeutralColorGrade,
  moveClipTo,
  moveTrack,
  moveVolumeKeyframe,
  neighborsOfTransition,
  NEUTRAL_MASTER_AUDIO,
  nextVideoContentTicks,
  removeClip,
  removeTrack,
  removeVolumeKeyframe,
  renameTrack,
  resolveActiveVideoPosition,
  resolveActiveVideoPositionBelow,
  setClipAudio,
  setClipChromaKey,
  setClipColorFilter,
  setClipFlagged,
  setClipColorGrade,
  setClipVideoHidden,
  setMasterAudio,
  setTrackHidden,
  splitClipAt,
  timelineDurationTicks,
  trackDurationTicks,
  transitionAudioCues,
  trimClipIn,
  trimClipInRipple,
  trimClipOut,
  trimClipOutRipple,
  volumeAtOffsetTicks,
  volumeAutomationFrom,
} from "./timeline";
import { NEUTRAL_CHROMA_KEY, NEUTRAL_COLOR_GRADE } from "./types";
import type { Clip, Timeline, Track } from "./types";

function clip(id: string, sourceId: string, startSec: number, inSec: number, outSec: number): Clip {
  return {
    id,
    kind: "clip",
    sourceId,
    startTicks: secondsToTicks(startSec),
    sourceInTicks: secondsToTicks(inSec),
    sourceOutTicks: secondsToTicks(outSec),
    volume: 1,
    muted: false,
  };
}

/** Timeline con una pista de vídeo y dos clips pegados: "a" (0s-2s de sourceA) y "b" (2s-5s, recortado a 5s-8s de sourceB). */
function twoClipTimeline(): Timeline {
  return {
    tracks: [
      {
        id: "video-1",
        kind: "video",
        hidden: false,
        clips: [clip("a", "source-a", 0, 0, 2), clip("b", "source-b", 2, 5, 8)],
      },
    ],
    outputResolution: { width: 1920, height: 1080 },
    outputFrameRate: { numerator: 30, denominator: 1 },
  };
}

describe("clipDurationTicks / clipEndTicks / trackDurationTicks / timelineDurationTicks", () => {
  it("clipEndTicks es startTicks + duración", () => {
    const timeline = twoClipTimeline();
    const [a, b] = timeline.tracks[0]!.clips;
    expect(clipDurationTicks(a!)).toBe(secondsToTicks(2));
    expect(clipEndTicks(a!)).toBe(secondsToTicks(2));
    expect(clipDurationTicks(b!)).toBe(secondsToTicks(3));
    expect(clipEndTicks(b!)).toBe(secondsToTicks(5));
  });

  it("trackDurationTicks/timelineDurationTicks es el final del clip que termina más tarde, no la suma", () => {
    const timeline = twoClipTimeline();
    expect(trackDurationTicks(timeline.tracks[0]!)).toBe(secondsToTicks(5));
    expect(timelineDurationTicks(timeline)).toBe(secondsToTicks(5));
  });

  it("un hueco entre clips no cuenta como duración extra: solo importa dónde termina el último", () => {
    const timeline = twoClipTimeline();
    const withGap = moveClipTo(timeline, "video-1", "b", secondsToTicks(4)); // abre 2s de hueco entre "a" y "b"
    expect(timelineDurationTicks(withGap)).toBe(secondsToTicks(7)); // "b" ahora termina en 4s+3s
  });
});

describe("resolveActiveVideoPosition", () => {
  it("resuelve un instante dentro del primer clip", () => {
    const timeline = twoClipTimeline();
    const pos = resolveActiveVideoPosition(timeline, secondsToTicks(1));
    expect(pos).not.toBeNull();
    expect(pos!.sourceId).toBe("source-a");
    expect(pos!.sourceTimeTicks).toBe(secondsToTicks(1));
    expect(pos!.trackId).toBe("video-1");
  });

  it("resuelve el instante exacto del límite entre clips como el segundo clip", () => {
    const timeline = twoClipTimeline();
    const pos = resolveActiveVideoPosition(timeline, secondsToTicks(2));
    expect(pos!.sourceId).toBe("source-b");
    expect(pos!.sourceTimeTicks).toBe(secondsToTicks(5));
  });

  it("resuelve un instante dentro del segundo clip con el offset correcto", () => {
    const timeline = twoClipTimeline();
    const pos = resolveActiveVideoPosition(timeline, secondsToTicks(3.5));
    expect(pos!.sourceId).toBe("source-b");
    expect(pos!.sourceTimeTicks).toBe(secondsToTicks(6.5));
  });

  it("devuelve null para un tick negativo", () => {
    const timeline = twoClipTimeline();
    expect(resolveActiveVideoPosition(timeline, -1)).toBeNull();
  });

  it("devuelve null para un tick igual o mayor que la duración total", () => {
    const timeline = twoClipTimeline();
    const total = timelineDurationTicks(timeline);
    expect(resolveActiveVideoPosition(timeline, total)).toBeNull();
    expect(resolveActiveVideoPosition(timeline, total + 1)).toBeNull();
  });

  it("devuelve null en un hueco entre clips (no hay objeto que lo represente)", () => {
    const timeline = moveClipTo(twoClipTimeline(), "video-1", "b", secondsToTicks(3));
    expect(resolveActiveVideoPosition(timeline, secondsToTicks(2.5))).toBeNull();
  });

  it("devuelve null en una timeline sin pistas o con una pista vacía", () => {
    const noTracks: Timeline = {
      tracks: [],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    expect(resolveActiveVideoPosition(noTracks, 0)).toBeNull();
    const emptyTrack: Timeline = {
      tracks: [{ id: "video-1", kind: "video", hidden: false, clips: [] }],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    expect(resolveActiveVideoPosition(emptyTrack, 0)).toBeNull();
  });
});

describe("composición multipista (capas opacas)", () => {
  function twoVideoTrackTimeline(): Timeline {
    return {
      tracks: [
        // índice 0 = capa de abajo
        { id: "bottom", kind: "video", hidden: false, clips: [clip("a", "source-a", 0, 0, 5)] },
        // índice 1 = capa de arriba: solo tiene contenido de 1s a 2s
        { id: "top", kind: "video", hidden: false, clips: [clip("b", "source-b", 1, 0, 1)] },
      ],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
  }

  it("la pista de arriba tapa a la de abajo donde tiene clip", () => {
    const timeline = twoVideoTrackTimeline();
    const pos = resolveActiveVideoPosition(timeline, secondsToTicks(1.5));
    expect(pos!.sourceId).toBe("source-b");
    expect(pos!.trackId).toBe("top");
  });

  it("se ve la pista de abajo donde la de arriba no tiene clip", () => {
    const timeline = twoVideoTrackTimeline();
    const pos = resolveActiveVideoPosition(timeline, secondsToTicks(3));
    expect(pos!.sourceId).toBe("source-a");
    expect(pos!.trackId).toBe("bottom");
  });

  it("una pista oculta no participa en la composición", () => {
    const timeline = setTrackHidden(twoVideoTrackTimeline(), "top", true);
    const pos = resolveActiveVideoPosition(timeline, secondsToTicks(1.5));
    expect(pos!.trackId).toBe("bottom");
  });

  it("un clip con videoHidden no participa en la composición, pero se sigue mirando hacia abajo (no corta la búsqueda)", () => {
    const timeline = twoVideoTrackTimeline();
    const hidden: Timeline = {
      ...timeline,
      tracks: timeline.tracks.map((t) =>
        t.id === "top" ? { ...t, clips: t.clips.map((c) => ({ ...c, videoHidden: true })) } : t,
      ),
    };
    const pos = resolveActiveVideoPosition(hidden, secondsToTicks(1.5));
    expect(pos!.trackId).toBe("bottom");
    expect(pos!.sourceId).toBe("source-a");
  });

  it("con videoHidden y sin ninguna pista debajo con contenido, devuelve null (negro)", () => {
    const track: Track = {
      id: "video-1",
      kind: "video",
      hidden: false,
      clips: [{ ...clip("a", "source-a", 0, 0, 2), videoHidden: true }],
    };
    const timeline: Timeline = {
      tracks: [track],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    expect(resolveActiveVideoPosition(timeline, secondsToTicks(1))).toBeNull();
  });

  it("una pista de audio nunca participa en resolveActiveVideoPosition aunque tenga clips en ese instante", () => {
    const timeline: Timeline = {
      tracks: [
        { id: "audio-1", kind: "audio", hidden: false, clips: [clip("m", "music", 0, 0, 5)] },
        { id: "video-1", kind: "video", hidden: false, clips: [] },
      ],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    expect(resolveActiveVideoPosition(timeline, secondsToTicks(1))).toBeNull();
  });
});

describe("resolveActiveVideoPositionBelow", () => {
  function twoVideoTrackTimeline(): Timeline {
    return {
      tracks: [
        { id: "bottom", kind: "video", hidden: false, clips: [clip("a", "source-a", 0, 0, 3)] },
        { id: "top", kind: "video", hidden: false, clips: [clip("b", "source-b", 1, 0, 1)] },
      ],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
  }

  it("encuentra la pista con contenido inmediatamente debajo del índice dado", () => {
    const timeline = twoVideoTrackTimeline();
    const pos = resolveActiveVideoPositionBelow(timeline, secondsToTicks(1.5), 1);
    expect(pos!.trackId).toBe("bottom");
    expect(pos!.sourceId).toBe("source-a");
  });

  it("null si no hay ninguna pista de vídeo por debajo del índice dado", () => {
    const timeline = twoVideoTrackTimeline();
    expect(resolveActiveVideoPositionBelow(timeline, secondsToTicks(1.5), 0)).toBeNull();
  });

  it("null si la pista de debajo no tiene contenido en ese instante", () => {
    const timeline = twoVideoTrackTimeline();
    expect(resolveActiveVideoPositionBelow(timeline, secondsToTicks(5), 1)).toBeNull();
  });
});

describe("nextVideoContentTicks", () => {
  function twoVideoTrackTimeline(): Timeline {
    return {
      tracks: [
        { id: "bottom", kind: "video", hidden: false, clips: [clip("a", "source-a", 0, 0, 5)] },
        { id: "top", kind: "video", hidden: false, clips: [clip("b", "source-b", 3, 0, 1)] },
      ],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
  }

  it("encuentra el próximo clip de cualquier pista de vídeo tras el punto dado", () => {
    const timeline = twoVideoTrackTimeline();
    expect(nextVideoContentTicks(timeline, secondsToTicks(0))).toBe(secondsToTicks(3));
  });

  it("devuelve null si no hay ningún clip después", () => {
    const timeline = twoVideoTrackTimeline();
    expect(nextVideoContentTicks(timeline, secondsToTicks(10))).toBeNull();
  });

  it("ignora las pistas ocultas", () => {
    const timeline = setTrackHidden(twoVideoTrackTimeline(), "top", true);
    // Sin "top", el único candidato tras 0s sería el propio "a" (empieza en 0s, no cuenta) -> nada después.
    expect(nextVideoContentTicks(timeline, secondsToTicks(0))).toBeNull();
  });

  it("ignora las pistas de audio", () => {
    const timeline: Timeline = {
      tracks: [{ id: "audio-1", kind: "audio", hidden: false, clips: [clip("m", "music", 1, 0, 5)] }],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    expect(nextVideoContentTicks(timeline, 0)).toBeNull();
  });

  it("ignora un clip con videoHidden (no aporta contenido de vídeo real)", () => {
    const timeline: Timeline = {
      tracks: [{ id: "video-1", kind: "video", hidden: false, clips: [{ ...clip("a", "source-a", 3, 0, 1), videoHidden: true }] }],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    expect(nextVideoContentTicks(timeline, 0)).toBeNull();
  });
});

describe("addTrack / removeTrack / setTrackHidden / moveTrack", () => {
  it("addTrack añade una pista vacía y visible al final", () => {
    const timeline = addTrack(twoClipTimeline(), "audio-1", "audio");
    const track = timeline.tracks[timeline.tracks.length - 1]!;
    expect(track).toEqual({ id: "audio-1", kind: "audio", hidden: false, clips: [] });
  });

  it("removeTrack quita la pista indicada sin tocar las demás", () => {
    const timeline = addTrack(twoClipTimeline(), "audio-1", "audio");
    const next = removeTrack(timeline, "audio-1");
    expect(next.tracks.map((t) => t.id)).toEqual(["video-1"]);
  });

  it("removeTrack lanza si la pista no existe", () => {
    expect(() => removeTrack(twoClipTimeline(), "no-existe")).toThrow(RangeError);
  });

  it("setTrackHidden cambia solo la pista indicada", () => {
    const timeline = addTrack(twoClipTimeline(), "audio-1", "audio");
    const next = setTrackHidden(timeline, "audio-1", true);
    expect(next.tracks.find((t) => t.id === "audio-1")!.hidden).toBe(true);
    expect(next.tracks.find((t) => t.id === "video-1")!.hidden).toBe(false);
  });

  it("moveTrack 'up' acerca la pista al final del array (capa más arriba)", () => {
    const timeline = addTrack(twoClipTimeline(), "audio-1", "audio"); // ["video-1", "audio-1"]
    const next = moveTrack(timeline, "video-1", "up");
    expect(next.tracks.map((t) => t.id)).toEqual(["audio-1", "video-1"]);
  });

  it("moveTrack no tiene efecto si ya está en el extremo", () => {
    const timeline = twoClipTimeline();
    const next = moveTrack(timeline, "video-1", "up");
    expect(next).toEqual(timeline);
  });

  it("renameTrack pone el nombre personalizado de la pista indicada", () => {
    const timeline = twoClipTimeline();
    const next = renameTrack(timeline, "video-1", "Cámara principal");
    expect(next.tracks[0]!.name).toBe("Cámara principal");
  });

  it("renameTrack recorta espacios en blanco", () => {
    const timeline = twoClipTimeline();
    const next = renameTrack(timeline, "video-1", "  Con espacios  ");
    expect(next.tracks[0]!.name).toBe("Con espacios");
  });

  it("renameTrack con una cadena vacía o solo espacios quita el nombre personalizado", () => {
    const timeline = renameTrack(twoClipTimeline(), "video-1", "Nombre");
    const next = renameTrack(timeline, "video-1", "   ");
    expect(next.tracks[0]!.name).toBeUndefined();
    expect("name" in next.tracks[0]!).toBe(false);
  });
});

describe("appendClip / insertClip / removeClip", () => {
  it("appendClip añade un clip al final de la pista, ignorando su startTicks de entrada", () => {
    const timeline = twoClipTimeline();
    const next = appendClip(timeline, "video-1", clip("c", "source-c", 999, 0, 1));
    expect(next.tracks[0]!.clips.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(next.tracks[0]!.clips[2]!.startTicks).toBe(secondsToTicks(5)); // justo tras "b"
    expect(timeline.tracks[0]!.clips.map((c) => c.id)).toEqual(["a", "b"]); // no muta
  });

  it("insertClip respeta el startTicks del clip si no se solapa", () => {
    const timeline = twoClipTimeline();
    const c = clip("c", "source-c", 10, 0, 1);
    const next = insertClip(timeline, "video-1", c);
    expect(next.tracks[0]!.clips.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("insertClip lanza si el clip se solaparía con otro existente en la pista", () => {
    const timeline = twoClipTimeline();
    const overlapping = clip("x", "source-x", 1, 0, 1); // se solapa con "a" (0-2s)
    expect(() => insertClip(timeline, "video-1", overlapping)).toThrow(RangeError);
  });

  it("removeClip elimina un clip por id", () => {
    const timeline = twoClipTimeline();
    const next = removeClip(timeline, "video-1", "a");
    expect(next.tracks[0]!.clips.map((c) => c.id)).toEqual(["b"]);
  });

  it("removeClip lanza con un clipId inexistente", () => {
    const timeline = twoClipTimeline();
    expect(() => removeClip(timeline, "video-1", "no-existe")).toThrow(RangeError);
  });
});

describe("moveClipTo", () => {
  it("mueve el clip a la posición pedida si no se solapa con nada", () => {
    const timeline = twoClipTimeline();
    const next = moveClipTo(timeline, "video-1", "b", secondsToTicks(3));
    expect(next.tracks[0]!.clips.find((c) => c.id === "b")!.startTicks).toBe(secondsToTicks(3));
  });

  it("se topa con el vecino anterior sin solaparlo", () => {
    const timeline = twoClipTimeline(); // "a" 0-2s, "b" 2-5s, pegados
    const next = moveClipTo(timeline, "video-1", "b", 0);
    expect(next.tracks[0]!.clips.find((c) => c.id === "b")!.startTicks).toBe(secondsToTicks(2));
  });

  it("se topa con el vecino siguiente sin solaparlo", () => {
    const timeline: Timeline = {
      tracks: [
        {
          id: "video-1",
          kind: "video",
          hidden: false,
          clips: [clip("a", "source-a", 0, 0, 2), clip("b", "source-b", 5, 0, 3)],
        },
      ],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    const next = moveClipTo(timeline, "video-1", "a", secondsToTicks(4));
    expect(next.tracks[0]!.clips.find((c) => c.id === "a")!.startTicks).toBe(secondsToTicks(3)); // tope: 5s - 2s de duración
  });

  it("no se puede mover antes del principio de la timeline: se recorta a 0", () => {
    const timeline = twoClipTimeline();
    const next = moveClipTo(timeline, "video-1", "a", -secondsToTicks(1));
    expect(next.tracks[0]!.clips.find((c) => c.id === "a")!.startTicks).toBe(0);
  });

  it("lanza si el clip no existe en esa pista", () => {
    const timeline = twoClipTimeline();
    expect(() => moveClipTo(timeline, "video-1", "no-existe", 0)).toThrow(RangeError);
  });

  it("lanza si la pista no existe", () => {
    const timeline = twoClipTimeline();
    expect(() => moveClipTo(timeline, "no-existe", "a", 0)).toThrow(RangeError);
  });
});

describe("splitClipAt", () => {
  it("parte un clip en dos que suman la duración original", () => {
    const timeline = twoClipTimeline();
    // Cortar "b" (2s-5s en la timeline, 5s-8s de source-b) 1s después de su inicio (tick 3s).
    const next = splitClipAt(timeline, "video-1", secondsToTicks(3), ["b1", "b2"]);
    const [a, b1, b2] = next.tracks[0]!.clips;
    expect(a!.id).toBe("a");
    expect(b1!.id).toBe("b1");
    expect(b2!.id).toBe("b2");

    expect(b1!.startTicks).toBe(secondsToTicks(2));
    expect(b1!.sourceInTicks).toBe(secondsToTicks(5));
    expect(b1!.sourceOutTicks).toBe(secondsToTicks(6));
    expect(b2!.startTicks).toBe(secondsToTicks(3));
    expect(b2!.sourceInTicks).toBe(secondsToTicks(6));
    expect(b2!.sourceOutTicks).toBe(secondsToTicks(8));

    expect(clipDurationTicks(b1!) + clipDurationTicks(b2!)).toBe(clipDurationTicks(timeline.tracks[0]!.clips[1]!));
    expect(timelineDurationTicks(next)).toBe(timelineDurationTicks(timeline));
  });

  it("lanza si el punto de corte coincide con el inicio de un clip", () => {
    const timeline = twoClipTimeline();
    expect(() => splitClipAt(timeline, "video-1", secondsToTicks(2), ["x", "y"])).toThrow(RangeError);
  });

  it("lanza si el punto de corte cae en un hueco o fuera de la pista", () => {
    const timeline = twoClipTimeline();
    expect(() => splitClipAt(timeline, "video-1", secondsToTicks(999), ["x", "y"])).toThrow(RangeError);
  });
});

describe("trimClipIn / trimClipOut", () => {
  const minDuration = secondsToTicks(0.1);

  it("trimClipIn mueve el punto de entrada respetando la duración mínima, sin tocar startTicks", () => {
    const timeline = twoClipTimeline();
    const next = trimClipIn(timeline, "video-1", "a", secondsToTicks(0.5), minDuration);
    const a = next.tracks[0]!.clips.find((c) => c.id === "a")!;
    expect(a.sourceInTicks).toBe(secondsToTicks(0.5));
    expect(a.sourceOutTicks).toBe(secondsToTicks(2));
    expect(a.startTicks).toBe(0);
  });

  it("trimClipIn lanza si el resultado queda por debajo de la duración mínima", () => {
    const timeline = twoClipTimeline();
    expect(() => trimClipIn(timeline, "video-1", "a", secondsToTicks(1.95), minDuration)).toThrow(RangeError);
  });

  it("trimClipIn lanza con sourceInTicks negativo", () => {
    const timeline = twoClipTimeline();
    expect(() => trimClipIn(timeline, "video-1", "a", -1, minDuration)).toThrow(RangeError);
  });

  it("trimClipOut mueve el punto de salida respetando la duración mínima, sin tocar startTicks", () => {
    const timeline = twoClipTimeline();
    const next = trimClipOut(timeline, "video-1", "b", secondsToTicks(7), minDuration);
    const b = next.tracks[0]!.clips.find((c) => c.id === "b")!;
    expect(b.sourceOutTicks).toBe(secondsToTicks(7));
    expect(b.sourceInTicks).toBe(secondsToTicks(5));
    expect(b.startTicks).toBe(secondsToTicks(2));
  });

  it("trimClipOut lanza si el resultado queda por debajo de la duración mínima", () => {
    const timeline = twoClipTimeline();
    expect(() => trimClipOut(timeline, "video-1", "b", secondsToTicks(5.05), minDuration)).toThrow(RangeError);
  });
});

describe("trimClipInRipple / trimClipOutRipple", () => {
  const minDuration = secondsToTicks(0.1);

  /** Tres clips pegados sin huecos: "a" (0-2s), "b" (2-5s), "c" (5-7s). */
  function threeClipTimeline(): Timeline {
    return {
      tracks: [
        {
          id: "video-1",
          kind: "video",
          hidden: false,
          clips: [clip("a", "source-a", 0, 0, 2), clip("b", "source-b", 2, 0, 3), clip("c", "source-c", 5, 0, 2)],
        },
      ],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
  }

  it("trimClipOutRipple alargando un clip desplaza a los siguientes sin dejar hueco", () => {
    const timeline = threeClipTimeline();
    const next = trimClipOutRipple(timeline, "video-1", "a", secondsToTicks(3), minDuration);
    const [a, b, c] = next.tracks[0]!.clips;
    expect(a!.sourceOutTicks).toBe(secondsToTicks(3));
    expect(b!.startTicks).toBe(secondsToTicks(3));
    expect(c!.startTicks).toBe(secondsToTicks(6));
  });

  it("trimClipOutRipple acortando un clip cierra el hueco desplazando a los siguientes hacia atrás", () => {
    const timeline = threeClipTimeline();
    const next = trimClipOutRipple(timeline, "video-1", "a", secondsToTicks(1), minDuration);
    const [a, b, c] = next.tracks[0]!.clips;
    expect(a!.sourceOutTicks).toBe(secondsToTicks(1));
    expect(b!.startTicks).toBe(secondsToTicks(1));
    expect(c!.startTicks).toBe(secondsToTicks(4));
  });

  it("trimClipInRipple desplaza a los siguientes sin tocar a los anteriores", () => {
    const timeline = threeClipTimeline();
    const next = trimClipInRipple(timeline, "video-1", "b", secondsToTicks(1), minDuration);
    const [a, b, c] = next.tracks[0]!.clips;
    expect(a!.startTicks).toBe(0); // el clip anterior nunca se toca
    expect(b!.sourceInTicks).toBe(secondsToTicks(1));
    expect(b!.startTicks).toBe(secondsToTicks(2)); // el propio clip no se desplaza a sí mismo
    expect(c!.startTicks).toBe(secondsToTicks(4)); // duración de b: 3s → 2s, delta -1s
  });

  it("trimClipOutRipple sigue respetando la duración mínima", () => {
    const timeline = threeClipTimeline();
    expect(() => trimClipOutRipple(timeline, "video-1", "a", secondsToTicks(0.05), minDuration)).toThrow(RangeError);
  });
});

describe("setClipAudio / effectiveClipVolume", () => {
  it("actualiza volumen y muted del clip indicado, sin tocar los demás", () => {
    const timeline = twoClipTimeline();
    const next = setClipAudio(timeline, "video-1", "a", 0.5, true);
    const [a, b] = next.tracks[0]!.clips;
    expect(a!.volume).toBe(0.5);
    expect(a!.muted).toBe(true);
    expect(b!.volume).toBe(1);
    expect(b!.muted).toBe(false);
  });

  it("recorta el volumen al rango [0, 1]", () => {
    const timeline = twoClipTimeline();
    expect(setClipAudio(timeline, "video-1", "a", 1.5, false).tracks[0]!.clips[0]!.volume).toBe(1);
    expect(setClipAudio(timeline, "video-1", "a", -0.5, false).tracks[0]!.clips[0]!.volume).toBe(0);
  });

  it("lanza con un clipId inexistente", () => {
    const timeline = twoClipTimeline();
    expect(() => setClipAudio(timeline, "video-1", "no-existe", 1, false)).toThrow(RangeError);
  });

  it("effectiveClipVolume es 0 si el clip está silenciado, independientemente de volume", () => {
    expect(effectiveClipVolume({ ...clip("a", "s", 0, 0, 1), volume: 0.8, muted: true })).toBe(0);
    expect(effectiveClipVolume({ ...clip("a", "s", 0, 0, 1), volume: 0.8, muted: false })).toBe(0.8);
  });
});

describe("setClipVideoHidden", () => {
  it("oculta el vídeo del clip indicado, sin tocar los demás ni su audio", () => {
    const timeline = twoClipTimeline();
    const next = setClipVideoHidden(timeline, "video-1", "a", true);
    const [a, b] = next.tracks[0]!.clips;
    expect(a!.videoHidden).toBe(true);
    expect(a!.muted).toBe(false);
    expect(b!.videoHidden).toBeUndefined();
  });

  it("con false vuelve a mostrar el vídeo (quita el campo, no lo deja en false)", () => {
    const hidden = setClipVideoHidden(twoClipTimeline(), "video-1", "a", true);
    const shown = setClipVideoHidden(hidden, "video-1", "a", false);
    expect(shown.tracks[0]!.clips[0]!.videoHidden).toBeUndefined();
  });

  it("lanza con un clipId inexistente", () => {
    const timeline = twoClipTimeline();
    expect(() => setClipVideoHidden(timeline, "video-1", "no-existe", true)).toThrow(RangeError);
  });
});

describe("videoHidden no afecta al audio (allAudioSchedules)", () => {
  it("un clip con videoHidden sigue sonando en su sitio de siempre", () => {
    const track: Track = {
      id: "video-1",
      kind: "video",
      hidden: false,
      clips: [{ ...clip("a", "source-a", 0, 0, 2), videoHidden: true }],
    };
    const timeline: Timeline = {
      tracks: [track],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    const [schedule] = allAudioSchedules(timeline);
    expect(schedule).toBeDefined();
    expect(schedule!.sourceId).toBe("source-a");
    expect(schedule!.durationTicks).toBe(secondsToTicks(2));
  });
});

describe("setClipFlagged", () => {
  it("marca la bandera del clip indicado, sin tocar los demás", () => {
    const timeline = twoClipTimeline();
    const next = setClipFlagged(timeline, "video-1", "a", true);
    const [a, b] = next.tracks[0]!.clips;
    expect(a!.flagged).toBe(true);
    expect(b!.flagged).toBeUndefined();
  });

  it("con false quita el campo, no lo deja en false", () => {
    const flagged = setClipFlagged(twoClipTimeline(), "video-1", "a", true);
    const cleared = setClipFlagged(flagged, "video-1", "a", false);
    expect(cleared.tracks[0]!.clips[0]!.flagged).toBeUndefined();
  });

  it("lanza con un clipId inexistente", () => {
    expect(() => setClipFlagged(twoClipTimeline(), "video-1", "no-existe", true)).toThrow(RangeError);
  });
});

describe("setClipColorFilter", () => {
  it("añade el filtro al clip indicado, sin tocar los demás", () => {
    const timeline = twoClipTimeline();
    const next = setClipColorFilter(timeline, "video-1", "a", "grayscale");
    const [a, b] = next.tracks[0]!.clips;
    expect(a!.colorFilter).toBe("grayscale");
    expect(b!.colorFilter).toBeUndefined();
  });

  it("con undefined quita el filtro en vez de dejarlo puesto", () => {
    const timeline = setClipColorFilter(twoClipTimeline(), "video-1", "a", "sepia");
    const next = setClipColorFilter(timeline, "video-1", "a", undefined);
    const a = next.tracks[0]!.clips[0]!;
    expect(a.colorFilter).toBeUndefined();
    expect("colorFilter" in a).toBe(false);
  });

  it("lanza con un clipId inexistente", () => {
    const timeline = twoClipTimeline();
    expect(() => setClipColorFilter(timeline, "video-1", "no-existe", "invert")).toThrow(RangeError);
  });
});

describe("volumen por trozos (VolumeKeyframe)", () => {
  it("volumeAtOffsetTicks sin puntos es el volumen plano del clip (0 si está silenciado)", () => {
    const a = clip("a", "source-a", 0, 0, 2);
    expect(volumeAtOffsetTicks(a, secondsToTicks(1))).toBe(1);
    expect(volumeAtOffsetTicks({ ...a, muted: true }, secondsToTicks(1))).toBe(0);
  });

  it("volumeAtOffsetTicks interpola linealmente entre dos puntos", () => {
    const a: Clip = {
      ...clip("a", "source-a", 0, 0, 2),
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
      ...clip("a", "source-a", 0, 0, 2),
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
      ...clip("a", "source-a", 0, 0, 2),
      muted: true,
      volumeKeyframes: [{ offsetTicks: secondsToTicks(1), volume: 1 }],
    };
    expect(volumeAtOffsetTicks(a, secondsToTicks(1))).toBe(0);
  });

  it("addVolumeKeyframe inserta ordenado y recorta offset/volumen a rango", () => {
    const timeline = twoClipTimeline();
    let next = addVolumeKeyframe(timeline, "video-1", "a", secondsToTicks(1.5), 0.5);
    next = addVolumeKeyframe(next, "video-1", "a", secondsToTicks(0.5), 2); // volumen fuera de rango -> se recorta a 1
    next = addVolumeKeyframe(next, "video-1", "a", -secondsToTicks(1), -1); // offset/volumen negativos -> se recortan a 0
    const keyframes = next.tracks[0]!.clips[0]!.volumeKeyframes!;
    expect(keyframes.map((k) => k.offsetTicks)).toEqual([0, secondsToTicks(0.5), secondsToTicks(1.5)]);
    expect(keyframes[0]!.volume).toBe(0);
    expect(keyframes[1]!.volume).toBe(1);
    expect(keyframes[2]!.volume).toBe(0.5);
  });

  it("removeVolumeKeyframe quita el punto y deja volumeKeyframes undefined si no queda ninguno", () => {
    const timeline = addVolumeKeyframe(twoClipTimeline(), "video-1", "a", secondsToTicks(1), 0.5);
    const next = removeVolumeKeyframe(timeline, "video-1", "a", 0);
    expect(next.tracks[0]!.clips[0]!.volumeKeyframes).toBeUndefined();
  });

  it("removeVolumeKeyframe con un índice inexistente no cambia nada", () => {
    const timeline = addVolumeKeyframe(twoClipTimeline(), "video-1", "a", secondsToTicks(1), 0.5);
    const next = removeVolumeKeyframe(timeline, "video-1", "a", 5);
    expect(next).toEqual(timeline);
  });

  it("moveVolumeKeyframe se recorta para no cruzar a sus vecinos", () => {
    let timeline = addVolumeKeyframe(twoClipTimeline(), "video-1", "a", secondsToTicks(0.5), 0.2);
    timeline = addVolumeKeyframe(timeline, "video-1", "a", secondsToTicks(1.5), 0.8);
    const next = moveVolumeKeyframe(timeline, "video-1", "a", 0, secondsToTicks(3), 0.9);
    const keyframes = next.tracks[0]!.clips[0]!.volumeKeyframes!;
    expect(keyframes[0]!.offsetTicks).toBe(secondsToTicks(1.5));
    expect(keyframes[0]!.volume).toBe(0.9);
    expect(keyframes[1]!.offsetTicks).toBe(secondsToTicks(1.5));
  });

  it("volumeAutomationFrom sin puntos devuelve un único punto con el volumen plano", () => {
    const a = clip("a", "source-a", 0, 0, 2);
    const points = volumeAutomationFrom(a, 0);
    expect(points).toEqual([{ offsetSeconds: 0, volume: 1 }]);
  });

  it("volumeAutomationFrom empezando a mitad de una rampa arranca ya en el valor interpolado", () => {
    const a: Clip = {
      ...clip("a", "source-a", 0, 0, 2),
      volumeKeyframes: [
        { offsetTicks: secondsToTicks(0.5), volume: 0 },
        { offsetTicks: secondsToTicks(1.5), volume: 1 },
      ],
    };
    const points = volumeAutomationFrom(a, secondsToTicks(1));
    expect(points[0]!.offsetSeconds).toBe(0);
    expect(points[0]!.volume).toBeCloseTo(0.5, 5);
    expect(points[1]!.offsetSeconds).toBeCloseTo(0.5, 5);
    expect(points[1]!.volume).toBeCloseTo(1, 5);
  });

  it("volumeAutomationFrom en un clip silenciado devuelve solo un punto a volumen 0", () => {
    const a: Clip = {
      ...clip("a", "source-a", 0, 0, 2),
      muted: true,
      volumeKeyframes: [{ offsetTicks: secondsToTicks(1), volume: 1 }],
    };
    expect(volumeAutomationFrom(a, 0)).toEqual([{ offsetSeconds: 0, volume: 0 }]);
  });
});

/** "a" (3s, en 0s-3s) — transición de 0.5s (3s-3.5s) — "b" (4s, en 3.5s-7.5s), sin huecos, todo en una pista. */
function transitionTimeline(): Timeline {
  const a = clip("a", "source-a", 0, 0, 3);
  const t = createTransition("t1", secondsToTicks(3), secondsToTicks(0.5), "crossfade");
  const b = clip("b", "source-b", 3.5, 0, 4);
  return {
    tracks: [{ id: "video-1", kind: "video", hidden: false, clips: [a, t, b] }],
    outputResolution: { width: 1920, height: 1080 },
    outputFrameRate: { numerator: 30, denominator: 1 },
  };
}

describe("neighborsOfTransition", () => {
  it("encuentra los dos vecinos cuando encajan exactamente", () => {
    const timeline = transitionTimeline();
    const track = timeline.tracks[0]!;
    const t = track.clips.find((c) => c.kind === "transition")!;
    const { prev, next } = neighborsOfTransition(track, t);
    expect(prev?.id).toBe("a");
    expect(next?.id).toBe("b");
  });

  it("no encuentra un lado si el vecino se ha separado (hueco o solape roto)", () => {
    const timeline = transitionTimeline();
    const moved = moveClipTo(timeline, "video-1", "b", secondsToTicks(5));
    const track = moved.tracks[0]!;
    const t = track.clips.find((c) => c.kind === "transition")!;
    const { prev, next } = neighborsOfTransition(track, t);
    expect(prev?.id).toBe("a");
    expect(next).toBeUndefined();
  });
});

describe("audio durante una transición", () => {
  it("audioTailCutTicks/audioHeadCutTicks recortan la duración de la transición cuando el vecino es más largo", () => {
    const timeline = transitionTimeline();
    const track = timeline.tracks[0]!;
    const a = track.clips.find((c) => c.id === "a")!;
    const b = track.clips.find((c) => c.id === "b")!;
    expect(audioTailCutTicks(track, a)).toBe(secondsToTicks(0.5));
    expect(audioHeadCutTicks(track, b)).toBe(secondsToTicks(0.5));
  });

  it("audioTailCutTicks/audioHeadCutTicks son 0 si no hay transición al lado", () => {
    const timeline = transitionTimeline();
    const track = timeline.tracks[0]!;
    const a = track.clips.find((c) => c.id === "a")!;
    const b = track.clips.find((c) => c.id === "b")!;
    expect(audioHeadCutTicks(track, a)).toBe(0);
    expect(audioTailCutTicks(track, b)).toBe(0);
  });

  it("el recorte se limita a la duración del propio vecino si es más corto que la transición", () => {
    const a = clip("a", "source-a", 0, 0, 0.3);
    const t = createTransition("t1", secondsToTicks(0.3), secondsToTicks(0.5), "crossfade");
    const track: Track = { id: "video-1", kind: "video", hidden: false, clips: [a, t] };
    expect(audioTailCutTicks(track, a)).toBe(secondsToTicks(0.3));
  });

  it("transitionAudioCues desde el principio genera un cue por cada vecino con fundido cruzado 1->0 y 0->1", () => {
    const timeline = transitionTimeline();
    const track = timeline.tracks[0]!;
    const t = track.clips.find((c) => c.kind === "transition")!;
    const cues = transitionAudioCues(track, t, 0);
    expect(cues).toHaveLength(2);

    const fromCue = cues.find((c) => c.sourceId === "source-a")!;
    expect(fromCue.sourceStartTicks).toBe(secondsToTicks(2.5)); // 3s - 0.5s
    expect(fromCue.durationTicks).toBe(secondsToTicks(0.5));
    expect(fromCue.automation[0]!.volume).toBeCloseTo(1, 5);
    expect(fromCue.automation[1]!.volume).toBeCloseTo(0, 5);

    const toCue = cues.find((c) => c.sourceId === "source-b")!;
    expect(toCue.sourceStartTicks).toBe(0);
    expect(toCue.durationTicks).toBe(secondsToTicks(0.5));
    expect(toCue.automation[0]!.volume).toBeCloseTo(0, 5);
    expect(toCue.automation[1]!.volume).toBeCloseTo(1, 5);
  });

  it("transitionAudioCues a mitad de la transición arranca ya en la ganancia interpolada", () => {
    const timeline = transitionTimeline();
    const track = timeline.tracks[0]!;
    const t = track.clips.find((c) => c.kind === "transition")!;
    const cues = transitionAudioCues(track, t, secondsToTicks(0.25));
    const fromCue = cues.find((c) => c.sourceId === "source-a")!;
    expect(fromCue.durationTicks).toBe(secondsToTicks(0.25));
    expect(fromCue.sourceStartTicks).toBe(secondsToTicks(2.75)); // 3s - 0.5s + 0.25s
    expect(fromCue.automation[0]!.volume).toBeCloseTo(0.5, 5);
  });

  it("transitionAudioCues no genera cue para un lado sin vecino real (principio/final de la pista)", () => {
    const t = createTransition("t1", 0, secondsToTicks(0.5), "crossfade");
    const b = clip("b", "source-b", 0.5, 0, 4);
    const track: Track = { id: "video-1", kind: "video", hidden: false, clips: [t, b] };
    const cues = transitionAudioCues(track, t, 0);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.sourceId).toBe("source-b");
  });

  it("transitionAudioCues no genera cue para un vecino silenciado", () => {
    const timeline = transitionTimeline();
    const original = timeline.tracks[0]!;
    const track: Track = { ...original, clips: original.clips.map((c) => (c.id === "a" ? { ...c, muted: true } : c)) };
    const t = track.clips.find((c) => c.kind === "transition")!;
    const cues = transitionAudioCues(track, t, 0);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.sourceId).toBe("source-b");
  });

  it("transitionAudioCues devuelve vacío si el offset ya supera la duración de la transición", () => {
    const timeline = transitionTimeline();
    const track = timeline.tracks[0]!;
    const t = track.clips.find((c) => c.kind === "transition")!;
    expect(transitionAudioCues(track, t, secondsToTicks(1))).toEqual([]);
  });
});

describe("allAudioSchedules", () => {
  it("incluye el audio de una pista de vídeo tapada visualmente por otra pista de vídeo por encima (el audio no tiene capas)", () => {
    // "top" (pista de arriba, índice más alto) tapa a "bottom" entre 1s y 2s,
    // pero el audio de bottom debe sonar igualmente durante ese tramo.
    const bottom: Track = { id: "bottom", kind: "video", hidden: false, clips: [clip("b", "source-b", 0, 0, 3)] };
    const top: Track = { id: "top", kind: "video", hidden: false, clips: [clip("t", "source-t", 1, 0, 1)] };
    const timeline: Timeline = {
      tracks: [bottom, top],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    const schedules = allAudioSchedules(timeline);
    const sourceIds = schedules.map((s) => s.sourceId).sort();
    expect(sourceIds).toEqual(["source-b", "source-t"]);
  });

  it("incluye los clips propios de una pista de audio independiente", () => {
    const video: Track = { id: "video-1", kind: "video", hidden: false, clips: [clip("v", "source-v", 0, 0, 2)] };
    const audio: Track = { id: "audio-1", kind: "audio", hidden: false, clips: [clip("a", "source-a", 0, 0, 2)] };
    const timeline: Timeline = {
      tracks: [video, audio],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    const sourceIds = allAudioSchedules(timeline)
      .map((s) => s.sourceId)
      .sort();
    expect(sourceIds).toEqual(["source-a", "source-v"]);
  });

  it("excluye clips de una pista oculta y clips silenciados", () => {
    const hidden: Track = { id: "hidden", kind: "audio", hidden: true, clips: [clip("h", "source-h", 0, 0, 2)] };
    const muted: Track = {
      id: "muted",
      kind: "video",
      hidden: false,
      clips: [{ ...clip("m", "source-m", 0, 0, 2), muted: true }],
    };
    const timeline: Timeline = {
      tracks: [hidden, muted],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    expect(allAudioSchedules(timeline)).toEqual([]);
  });

  it("incluye los cues de fundido cruzado de una transición junto con el audio normal recortado", () => {
    const timeline = transitionTimeline();
    const schedules = allAudioSchedules(timeline);
    // "a" recortado (audioTailCutTicks) + cue saliente de la transición + cue entrante + "b" recortado (audioHeadCutTicks)
    expect(schedules).toHaveLength(4);
    expect(schedules.filter((s) => s.sourceId === "source-a")).toHaveLength(2);
    expect(schedules.filter((s) => s.sourceId === "source-b")).toHaveLength(2);
  });

  it("desde fromTicks a mitad de un clip, arranca ya adelantado en la fuente y con la duración restante", () => {
    const track: Track = { id: "video-1", kind: "video", hidden: false, clips: [clip("a", "source-a", 0, 0, 4)] };
    const timeline: Timeline = {
      tracks: [track],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    const [schedule] = allAudioSchedules(timeline, secondsToTicks(1.5));
    expect(schedule!.startTicks).toBe(secondsToTicks(1.5));
    expect(schedule!.sourceStartTicks).toBe(secondsToTicks(1.5));
    expect(schedule!.durationTicks).toBe(secondsToTicks(2.5));
  });

  it("un clip que ya terminó antes de fromTicks no genera ninguna franja", () => {
    const track: Track = { id: "video-1", kind: "video", hidden: false, clips: [clip("a", "source-a", 0, 0, 2)] };
    const timeline: Timeline = {
      tracks: [track],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    expect(allAudioSchedules(timeline, secondsToTicks(2))).toEqual([]);
  });
});

describe("setClipColorGrade / setClipChromaKey / isNeutralColorGrade", () => {
  it("NEUTRAL_COLOR_GRADE es neutro por definición", () => {
    expect(isNeutralColorGrade(NEUTRAL_COLOR_GRADE)).toBe(true);
  });

  it("cualquier campo distinto de neutro deja de ser neutro", () => {
    expect(isNeutralColorGrade({ ...NEUTRAL_COLOR_GRADE, liftR: 0.1 })).toBe(false);
    expect(isNeutralColorGrade({ ...NEUTRAL_COLOR_GRADE, invert: true })).toBe(false);
  });

  it("setClipColorGrade aplica y quita (undefined) el grading de un clip sin tocar los demás", () => {
    const timeline = twoClipTimeline();
    const grade = { ...NEUTRAL_COLOR_GRADE, saturation: 0.5 };
    const graded = setClipColorGrade(timeline, "video-1", "a", grade);
    expect(graded.tracks[0]!.clips.find((c) => c.id === "a")!.colorGrade).toEqual(grade);
    expect(graded.tracks[0]!.clips.find((c) => c.id === "b")!.colorGrade).toBeUndefined();
    const cleared = setClipColorGrade(graded, "video-1", "a", undefined);
    expect(cleared.tracks[0]!.clips.find((c) => c.id === "a")!.colorGrade).toBeUndefined();
  });

  it("setClipChromaKey aplica y quita (undefined) el croma de un clip", () => {
    const timeline = twoClipTimeline();
    const key = { ...NEUTRAL_CHROMA_KEY, enabled: true };
    const keyed = setClipChromaKey(timeline, "video-1", "a", key);
    expect(keyed.tracks[0]!.clips.find((c) => c.id === "a")!.chromaKey).toEqual(key);
    const cleared = setClipChromaKey(keyed, "video-1", "a", undefined);
    expect(cleared.tracks[0]!.clips.find((c) => c.id === "a")!.chromaKey).toBeUndefined();
  });
});

describe("máster de audio", () => {
  it("compressorParamsFromAmount(0) no comprime (umbral 0dB, ratio 1)", () => {
    expect(compressorParamsFromAmount(0)).toEqual({ thresholdDb: 0, ratio: 1 });
  });

  it("compressorParamsFromAmount(100) es la compresión máxima (umbral -30dB, ratio 12)", () => {
    expect(compressorParamsFromAmount(100)).toEqual({ thresholdDb: -30, ratio: 12 });
  });

  it("compressorParamsFromAmount satura fuera de [0,100]", () => {
    expect(compressorParamsFromAmount(-10)).toEqual({ thresholdDb: 0, ratio: 1 });
    expect(compressorParamsFromAmount(150)).toEqual({ thresholdDb: -30, ratio: 12 });
  });

  it("setMasterAudio reemplaza masterAudio sin tocar el resto de la timeline", () => {
    const track: Track = { id: "video-1", kind: "video", hidden: false, clips: [] };
    const timeline: Timeline = {
      tracks: [track],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    const master = { ...NEUTRAL_MASTER_AUDIO, enabled: true, eqLowDb: 3 };
    const updated = setMasterAudio(timeline, master);
    expect(updated.masterAudio).toEqual(master);
    expect(updated.tracks).toBe(timeline.tracks);
    expect(timeline.masterAudio).toBeUndefined(); // pura: no muta el original
  });
});
