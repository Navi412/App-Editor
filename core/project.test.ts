import { describe, expect, it } from "vitest";
import { parseProjectFile, serializeProject, type ProjectSource } from "./project";
import type { TextOverlay } from "./textOverlay";
import type { Timeline } from "./types";

function sampleTimeline(): Timeline {
  return {
    track: {
      id: "track-1",
      clips: [{ id: "clip-1", sourceId: "source-1", sourceInTicks: 0, sourceOutTicks: 600000 }],
    },
    outputResolution: { width: 1920, height: 1080 },
    outputFrameRate: { numerator: 30, denominator: 1 },
  };
}

function sampleSources(): ProjectSource[] {
  return [
    {
      id: "source-1",
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
    { id: "t1", startTicks: 0, endTicks: 300000, text: "Hola", xPercent: 50, yPercent: 85, fontSizePx: 48, color: "#fff" },
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
    expect(roundTripped.clips).toEqual(timeline.track.clips);
    expect(roundTripped.sources).toEqual(sources);
    expect(roundTripped.markers).toEqual([{ id: "m1", ticks: 1000, label: "punto" }]);
    expect(roundTripped.textOverlays).toEqual(textOverlays);
  });

  it("rellena markers y textOverlays como array vacío si faltan en el JSON", () => {
    const timeline = sampleTimeline();
    const serialized = serializeProject(timeline, sampleSources(), [], []);
    const { markers: _m, textOverlays: _t, ...withoutOptionals } = serialized;
    const parsed = parseProjectFile(JSON.parse(JSON.stringify(withoutOptionals)));
    expect(parsed.markers).toEqual([]);
    expect(parsed.textOverlays).toEqual([]);
  });

  it("lanza si la versión no es 1", () => {
    expect(() => parseProjectFile({ version: 2 })).toThrow(/versión/i);
  });

  it("lanza si falta outputResolution", () => {
    expect(() =>
      parseProjectFile({ version: 1, outputFrameRate: { numerator: 1, denominator: 1 }, sources: [], clips: [] }),
    ).toThrow(/outputResolution/);
  });

  it("lanza si un clip no tiene la forma esperada", () => {
    const timeline = sampleTimeline();
    const serialized = serializeProject(timeline, sampleSources(), [], []);
    const broken = { ...serialized, clips: [{ id: "clip-1" }] };
    expect(() => parseProjectFile(broken)).toThrow(/clips/i);
  });

  it("lanza con datos que no son un objeto", () => {
    expect(() => parseProjectFile(null)).toThrow();
    expect(() => parseProjectFile("hola")).toThrow();
  });
});
