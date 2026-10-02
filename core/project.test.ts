import { describe, expect, it } from "vitest";
import { parseProjectFile, projectLutAssets, serializeProject, type ProjectSource } from "./project";
import type { TextOverlay } from "./textOverlay";
import type { Timeline } from "./types";

function sampleTimeline(): Timeline {
  return {
    tracks: [
      {
        id: "video-1",
        kind: "video",
        hidden: false,
        clips: [
          {
            id: "clip-1",
            kind: "clip",
            sourceId: "source-1",
            startTicks: 0,
            sourceInTicks: 0,
            sourceOutTicks: 600000,
            volume: 1,
            muted: false,
          },
        ],
      },
    ],
    outputResolution: { width: 1920, height: 1080 },
    outputFrameRate: { numerator: 30, denominator: 1 },
  };
}

function sampleSources(): ProjectSource[] {
  return [
    {
      id: "source-1",
      kind: "video",
      fileName: "clip.mp4",
      frameRate: { numerator: 30, denominator: 1 },
      width: 1920,
      height: 1080,
      durationTicks: 600000,
    },
  ];
}

function sampleTextOverlays(): TextOverlay[] {
  return [
    {
      id: "t1",
      startTicks: 0,
      endTicks: 300000,
      text: "Hola",
      xPercent: 50,
      yPercent: 85,
      fontSizePx: 48,
      color: "#fff",
      fontFamily: "sans-serif",
      rotationDeg: 0,
    },
  ];
}

describe("serializeProject / parseProjectFile", () => {
  it("hace un round-trip fiel a través de JSON", () => {
    const timeline = sampleTimeline();
    const sources = sampleSources();
    const textOverlays = sampleTextOverlays();
    const serialized = serializeProject(
      timeline,
      sources,
      [{ id: "m1", ticks: 1000, label: "punto" }],
      textOverlays,
    );
    const roundTripped = parseProjectFile(JSON.parse(JSON.stringify(serialized)));

    expect(roundTripped.version).toBe(1);
    expect(roundTripped.outputResolution).toEqual(timeline.outputResolution);
    expect(roundTripped.outputFrameRate).toEqual(timeline.outputFrameRate);
    expect(roundTripped.tracks).toEqual(timeline.tracks);
    expect(roundTripped.sources).toEqual(sources);
    expect(roundTripped.markers).toEqual([{ id: "m1", ticks: 1000, label: "punto" }]);
    expect(roundTripped.textOverlays).toEqual(textOverlays);
  });

  it("acepta el formato nuevo con varias pistas (vídeo y audio, ocultas o no)", () => {
    const timeline: Timeline = {
      tracks: [
        { id: "video-1", kind: "video", hidden: false, clips: [] },
        {
          id: "audio-1",
          kind: "audio",
          hidden: true,
          clips: [
            {
              id: "m1",
              kind: "clip",
              sourceId: "music-1",
              startTicks: 0,
              sourceInTicks: 0,
              sourceOutTicks: 100,
              volume: 1,
              muted: false,
            },
          ],
        },
      ],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    const serialized = serializeProject(timeline, [], [], []);
    const parsed = parseProjectFile(JSON.parse(JSON.stringify(serialized)));
    expect(parsed.tracks).toEqual(timeline.tracks);
  });

  it("rellena markers y textOverlays como array vacío si faltan en el JSON", () => {
    const timeline = sampleTimeline();
    const serialized = serializeProject(timeline, sampleSources(), [], []);
    const { markers: _m, textOverlays: _t, ...withoutOptionals } = serialized;
    const parsed = parseProjectFile(JSON.parse(JSON.stringify(withoutOptionals)));
    expect(parsed.markers).toEqual([]);
    expect(parsed.textOverlays).toEqual([]);
  });

  it("migra un proyecto con `clips` plano (formato anterior a la ampliación multipista del 2026-08-21) a una única pista de vídeo con startTicks calculados", () => {
    const timeline = sampleTimeline();
    const serialized = serializeProject(timeline, sampleSources(), [], []);
    const { tracks: _tracks, ...withoutTracks } = serialized;
    const legacyClips = [
      { id: "a", kind: "clip", sourceId: "source-1", sourceInTicks: 0, sourceOutTicks: 600000, volume: 1, muted: false },
      { id: "g1", kind: "gap", sourceId: "", sourceInTicks: 0, sourceOutTicks: 300000, volume: 1, muted: false },
      { id: "b", kind: "clip", sourceId: "source-1", sourceInTicks: 0, sourceOutTicks: 600000, volume: 1, muted: false },
    ];
    const parsed = parseProjectFile({ ...withoutTracks, clips: legacyClips });

    expect(parsed.tracks).toHaveLength(1);
    const track = parsed.tracks[0]!;
    expect(track.kind).toBe("video");
    expect(track.hidden).toBe(false);
    // El hueco no sobrevive como objeto: solo quedan "a" y "b", con "b" desplazado
    // por el hueco de 300000 ticks que había entre ambos.
    expect(track.clips.map((c) => c.id)).toEqual(["a", "b"]);
    expect(track.clips[0]!.startTicks).toBe(0);
    expect(track.clips[1]!.startTicks).toBe(900000);
  });

  it("normaliza clips guardados antes de que existieran volume/muted/startTicks", () => {
    const timeline = sampleTimeline();
    const serialized = serializeProject(timeline, sampleSources(), [], []);
    const { tracks: _tracks, ...withoutTracks } = serialized;
    const oldClip = { id: "clip-1", sourceId: "source-1", sourceInTicks: 0, sourceOutTicks: 600000 };
    const parsed = parseProjectFile({ ...withoutTracks, clips: [oldClip] });
    expect(parsed.tracks[0]!.clips).toEqual([
      { ...oldClip, volume: 1, muted: false, kind: "clip", startTicks: 0 },
    ]);
  });

  it("conserva videoHidden en el round-trip, y omite clips guardados antes de que existiera (queda undefined)", () => {
    const timeline: Timeline = {
      tracks: [
        {
          id: "video-1",
          kind: "video",
          hidden: false,
          clips: [
            { id: "a", kind: "clip", sourceId: "source-1", startTicks: 0, sourceInTicks: 0, sourceOutTicks: 100, volume: 1, muted: false, videoHidden: true },
            { id: "b", kind: "clip", sourceId: "source-1", startTicks: 100, sourceInTicks: 0, sourceOutTicks: 200, volume: 1, muted: false },
          ],
        },
      ],
      outputResolution: { width: 1920, height: 1080 },
      outputFrameRate: { numerator: 30, denominator: 1 },
    };
    const serialized = serializeProject(timeline, sampleSources(), [], []);
    const parsed = parseProjectFile(JSON.parse(JSON.stringify(serialized)));
    expect(parsed.tracks[0]!.clips[0]!.videoHidden).toBe(true);
    expect(parsed.tracks[0]!.clips[1]!.videoHidden).toBeUndefined();
  });

  it("conserva filePath en el round-trip cuando está presente", () => {
    const timeline = sampleTimeline();
    const sourcesWithPath = [{ ...sampleSources()[0]!, filePath: "C:\\videos\\clip.mp4" }];
    const serialized = serializeProject(timeline, sourcesWithPath, [], []);
    const parsed = parseProjectFile(JSON.parse(JSON.stringify(serialized)));
    expect(parsed.sources[0]!.filePath).toBe("C:\\videos\\clip.mp4");
  });

  it("acepta fuentes guardadas antes de que existiera filePath (queda undefined)", () => {
    const timeline = sampleTimeline();
    const serialized = serializeProject(timeline, sampleSources(), [], []);
    const parsed = parseProjectFile(JSON.parse(JSON.stringify(serialized)));
    expect(parsed.sources[0]!.filePath).toBeUndefined();
  });

  it("normaliza fuentes guardadas antes de que existiera `kind` a kind:'video'", () => {
    const timeline = sampleTimeline();
    const serialized = serializeProject(timeline, sampleSources(), [], []);
    const { kind: _kind, ...legacySource } = serialized.sources[0]!;
    const parsed = parseProjectFile({ ...serialized, sources: [legacySource] });
    expect(parsed.sources[0]!.kind).toBe("video");
  });

  it("lanza si kind o transitionType de un clip no son valores reconocidos", () => {
    const timeline = sampleTimeline();
    const serialized = serializeProject(timeline, sampleSources(), [], []);
    const badKind = { id: "c1", kind: "bogus", sourceId: "s", startTicks: 0, sourceInTicks: 0, sourceOutTicks: 1 };
    expect(() =>
      parseProjectFile({ ...serialized, tracks: [{ id: "video-1", kind: "video", hidden: false, clips: [badKind] }] }),
    ).toThrow(/pistas/i);

    const badTransitionType = {
      id: "c1",
      kind: "transition",
      sourceId: "",
      startTicks: 0,
      sourceInTicks: 0,
      sourceOutTicks: 1,
      transitionType: "bogus",
    };
    expect(() =>
      parseProjectFile({
        ...serialized,
        tracks: [{ id: "video-1", kind: "video", hidden: false, clips: [badTransitionType] }],
      }),
    ).toThrow(/pistas/i);
  });

  it("lanza si la versión no es 1", () => {
    expect(() => parseProjectFile({ version: 2 })).toThrow(/versión/i);
  });

  it("lanza si falta outputResolution", () => {
    expect(() =>
      parseProjectFile({ version: 1, outputFrameRate: { numerator: 1, denominator: 1 }, sources: [], tracks: [] }),
    ).toThrow(/outputResolution/);
  });

  it("lanza si una pista no tiene la forma esperada", () => {
    const timeline = sampleTimeline();
    const serialized = serializeProject(timeline, sampleSources(), [], []);
    const broken = { ...serialized, tracks: [{ id: "video-1" }] };
    expect(() => parseProjectFile(broken)).toThrow(/pistas/i);
  });

  it("lanza si el proyecto no tiene ni `tracks` ni `clips`", () => {
    const timeline = sampleTimeline();
    const serialized = serializeProject(timeline, sampleSources(), [], []);
    const { tracks: _tracks, ...withoutTracks } = serialized;
    expect(() => parseProjectFile(withoutTracks)).toThrow(/pistas ni clips/i);
  });

  it("lanza con datos que no son un objeto", () => {
    expect(() => parseProjectFile(null)).toThrow();
    expect(() => parseProjectFile("hola")).toThrow();
  });
});

describe("LUTs y grading ampliado (2026-10-02)", () => {
  it("una LUT del proyecto y su uso en un clip sobreviven a guardar → JSON → cargar", () => {
    const data = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]);
    const base = sampleTimeline();
    const timeline: Timeline = {
      ...base,
      luts: [{ id: "lut-1", name: "Look", size: 2, data }],
      tracks: [{ ...base.tracks[0]!, clips: [{ ...base.tracks[0]!.clips[0]!, lut: { lutId: "lut-1", intensity: 0.7 } }] }],
    };
    const parsed = parseProjectFile(JSON.parse(JSON.stringify(serializeProject(timeline, sampleSources(), [], []))));
    expect(parsed.tracks[0]!.clips[0]!.lut).toEqual({ lutId: "lut-1", intensity: 0.7 });
    const [lut] = projectLutAssets(parsed);
    expect(lut!.name).toBe("Look");
    expect([...lut!.data]).toEqual([...data]);
  });

  it("rechaza un clip que apunta a una LUT que no está en el proyecto", () => {
    const base = sampleTimeline();
    const file = serializeProject(base, sampleSources(), [], []);
    (file.tracks[0]!.clips[0] as { lut?: unknown }).lut = { lutId: "nope", intensity: 1 };
    expect(() => parseProjectFile(JSON.parse(JSON.stringify(file)))).toThrow(/LUT/);
  });

  it("un grading guardado antes de existir exposición/temperatura se carga con esos mandos en neutro", () => {
    const file = serializeProject(sampleTimeline(), sampleSources(), [], []);
    (file.tracks[0]!.clips[0] as { colorGrade?: unknown }).colorGrade = {
      liftR: 0, liftG: 0, liftB: 0, gammaR: 1, gammaG: 1, gammaB: 1,
      gainR: 1.1, gainG: 1, gainB: 1, saturation: 1, contrast: 1, invert: false,
    };
    const grade = parseProjectFile(JSON.parse(JSON.stringify(file))).tracks[0]!.clips[0]!.colorGrade!;
    expect(grade.gainR).toBe(1.1);
    expect(grade.exposure).toBe(0);
    expect(grade.temperature).toBe(0);
  });
});
