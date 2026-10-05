import { describe, expect, it } from "vitest";
import { deserializeProxy, serializeProxy } from "./proxy";
import type { DemuxedTrack } from "./samples";

describe("proxy en disco (serializeProxy/deserializeProxy)", () => {
  it("ida y vuelta sin perder muestras, keyframes ni configuración", () => {
    const proxy: DemuxedTrack = {
      videoTrack: { id: 1, codec: "avc1.4d001f", timescale: 1_000_000, duration: 100_000, video: { width: 960, height: 540 } },
      samples: [
        { cts: 0, duration: 33_333, timescale: 1_000_000, is_sync: true, data: Uint8Array.from([1, 2, 3]) },
        { cts: 33_333, duration: 33_333, timescale: 1_000_000, is_sync: false, data: Uint8Array.from([4, 5]) },
      ],
      decoderDescription: Uint8Array.from([9, 8, 7]),
      frameRate: { numerator: 30, denominator: 1 },
    };
    const back = deserializeProxy(serializeProxy(proxy))!;
    expect(back.videoTrack).toEqual(proxy.videoTrack);
    expect(back.frameRate).toEqual(proxy.frameRate);
    expect(Array.from(back.decoderDescription!)).toEqual([9, 8, 7]);
    expect(back.samples.map((s) => [s.cts, s.is_sync, Array.from(s.data!)])).toEqual([
      [0, true, [1, 2, 3]],
      [33_333, false, [4, 5]],
    ]);
  });

  it("rechaza un archivo truncado o de otro formato", () => {
    const bytes = new Uint8Array(serializeProxy({
      videoTrack: { id: 1, codec: "avc1", timescale: 1_000_000, duration: 1 },
      samples: [{ cts: 0, duration: 1, timescale: 1_000_000, is_sync: true, data: Uint8Array.from([1, 2, 3, 4]) }],
    }));
    expect(deserializeProxy(bytes.slice(0, bytes.length - 2).buffer)).toBeUndefined();
    expect(deserializeProxy(new Uint8Array([0, 0, 0, 3, 1, 2, 3]).buffer)).toBeUndefined();
  });
});
