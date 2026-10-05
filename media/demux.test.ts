import { describe, expect, it } from "vitest";
import { av1CodecFromAv1C, avcCodecFromAvcC, hevcCodecFromHvcC, nalToRbsp, vp9CodecFromFrame } from "./codecStrings";
import { demuxMatroska } from "./demuxMatroska";
import { annexBNalUnits, demuxMpegTs, extractMpegTsAudio } from "./demuxMpegTs";
import { sniffContainer } from "./samples";
import { byteSourceFromBytes, SampleDataLoader, type ByteSource } from "./sampleData";
import { snapFrameRate } from "./sourceFile";

// --- Matroska inventado -------------------------------------------------

function ebmlId(id: number): number[] {
  const bytes: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return bytes;
}

/** Tamaño EBML en 8 bytes (siempre válido), o "desconocido". */
function ebmlSize(size: number | "unknown"): number[] {
  if (size === "unknown") return [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  const out = [0x01, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 7, v = size; i > 0; i--, v = Math.floor(v / 256)) out[i] = v & 0xff;
  return out;
}

function el(id: number, ...children: number[][]): number[] {
  const data = children.flat();
  return [...ebmlId(id), ...ebmlSize(data.length), ...data];
}

function uint(id: number, value: number, length = 4): number[] {
  const data: number[] = [];
  for (let i = 0, v = value; i < length; i++, v = Math.floor(v / 256)) data.unshift(v & 0xff);
  return el(id, data);
}

function str(id: number, text: string): number[] {
  return el(id, Array.from(text, (c) => c.charCodeAt(0)));
}

function simpleBlock(track: number, relTimecode: number, key: boolean, payload: number[]): number[] {
  return el(0xa3, [0x80 | track, (relTimecode >> 8) & 0xff, relTimecode & 0xff, key ? 0x80 : 0x00, ...payload]);
}

const AVCC = [0x01, 0x64, 0x00, 0x1f, 0xff, 0xe0, 0x00];

function makeMkv(options: { unknownSizeCluster?: boolean } = {}): Uint8Array {
  const tracks = el(
    0x1654ae6b,
    el(
      0xae,
      uint(0xd7, 1, 1),
      uint(0x83, 1, 1),
      str(0x86, "V_MPEG4/ISO/AVC"),
      el(0x63a2, AVCC),
      uint(0x23e383, 33_366_667),
      el(0xe0, uint(0xb0, 1920, 2), uint(0xba, 1080, 2)),
    ),
  );
  const info = el(0x1549a966, uint(0x2ad7b1, 1_000_000, 3));
  // 29,97 fps redondeado al ms, en orden de decodificación con un B-frame: 0, 67, 33, 100.
  const blocks = [
    simpleBlock(1, 0, true, [0xaa]),
    simpleBlock(1, 67, false, [0xbb]),
    simpleBlock(2, 0, false, [0x00]), // otra pista (audio): se ignora
    simpleBlock(1, 33, false, [0xcc]),
    simpleBlock(1, 100, false, [0xdd]),
  ];
  const clusterBody = [...uint(0xe7, 0, 1), ...blocks.flat()];
  const cluster = options.unknownSizeCluster
    ? [...ebmlId(0x1f43b675), ...ebmlSize("unknown"), ...clusterBody]
    : el(0x1f43b675, clusterBody);
  const segment = [...ebmlId(0x18538067), ...ebmlSize("unknown"), ...info, ...tracks, ...cluster];
  return Uint8Array.from([...el(0x1a45dfa3, str(0x4282, "matroska")), ...segment]);
}

/** Demuxa y carga todas las muestras (los bytes van bajo demanda, ver media/sampleData.ts). */
async function demuxMkv(bytes: Uint8Array) {
  const demuxed = await demuxMatroska(byteSourceFromBytes(bytes));
  await demuxed.loader!.ensure(0, demuxed.samples.length - 1);
  return demuxed;
}

describe("demuxMatroska", () => {
  it("lee códec, tamaño, keyframes y orden de decodificación de la pista de vídeo", async () => {
    const demuxed = await demuxMkv(makeMkv());
    expect(demuxed.videoTrack.codec).toBe("avc1.64001f");
    expect(demuxed.videoTrack.video).toEqual({ width: 1920, height: 1080 });
    expect(Array.from(demuxed.decoderDescription!)).toEqual(AVCC);
    expect(demuxed.samples.map((s) => s.data![0])).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    expect(demuxed.samples.map((s) => s.is_sync)).toEqual([true, false, false, false]);
  });

  it("devuelve a la rejilla de 30000/1001 los timestamps redondeados al milisegundo", async () => {
    const demuxed = await demuxMkv(makeMkv());
    expect(demuxed.frameRate).toEqual({ numerator: 30000, denominator: 1001 });
    expect(demuxed.samples.map((s) => s.cts)).toEqual([0, 66733, 33367, 100100]);
    expect(demuxed.samples.every((s) => s.timescale === 1_000_000 && s.duration > 0)).toBe(true);
  });

  it("soporta Clusters de tamaño desconocido (MediaRecorder, grabación en directo)", async () => {
    const demuxed = await demuxMkv(makeMkv({ unknownSizeCluster: true }));
    expect(demuxed.samples.map((s) => s.data![0])).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  it("guarda dónde está cada fotograma en el archivo, no sus bytes", async () => {
    const bytes = makeMkv();
    const demuxed = await demuxMatroska(byteSourceFromBytes(bytes));
    expect(demuxed.samples.map((s) => [s.size, bytes[s.offset!]])).toEqual([
      [1, 0xaa],
      [1, 0xbb],
      [1, 0xcc],
      [1, 0xdd],
    ]);
  });
});

// --- Cargador de muestras bajo demanda ------------------------------------

/** Fuente en memoria que cuenta las lecturas, para comprobar qué se lee y cuándo. */
function countingSource(bytes: Uint8Array): ByteSource & { reads: Array<[number, number]> } {
  const reads: Array<[number, number]> = [];
  return {
    size: bytes.length,
    reads,
    async read(start, end) {
      reads.push([start, end]);
      return bytes.subarray(start, end);
    },
  };
}

describe("SampleDataLoader", () => {
  const fileBytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
  const makeSamples = () => Array.from({ length: 100 }, (_, i) => ({ offset: i * 10, size: 10 }) as { offset: number; size: number; data?: Uint8Array });

  it("lee por bloques solo lo que se pide, y una sola vez", async () => {
    const source = countingSource(fileBytes);
    const samples = makeSamples();
    const loader = new SampleDataLoader(source, samples);
    await loader.ensure(0, 3);
    expect(source.reads).toHaveLength(1);
    expect(Array.from(samples[2]!.data!)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    expect(samples[60]!.data).toBeUndefined();
    await loader.ensure(1, 2);
    expect(source.reads).toHaveLength(1);
  });

  it("suelta los bloques menos usados al pasar del tope y los relee si vuelven a hacer falta", async () => {
    const source = countingSource(fileBytes);
    const samples = makeSamples();
    const loader = new SampleDataLoader(source, samples, undefined, 600); // menos de dos bloques de 48 × 10 B
    await loader.ensure(0, 0);
    await loader.ensure(60, 60);
    expect(samples[0]!.data).toBeUndefined();
    expect(samples[60]!.data).toBeDefined();
    await loader.ensure(0, 0);
    expect(samples[0]!.data![0]).toBe(0);
    expect(source.reads).toHaveLength(3);
  });

  it("antepone el prefijo de header stripping a cada muestra", async () => {
    const samples = makeSamples();
    await new SampleDataLoader(byteSourceFromBytes(fileBytes), samples, Uint8Array.from([0xee])).ensure(1, 1);
    expect(Array.from(samples[1]!.data!.subarray(0, 3))).toEqual([0xee, 10, 11]);
  });
});

// --- MPEG-TS inventado --------------------------------------------------

function tsPacket(pid: number, start: boolean, payload: number[]): number[] {
  const header = [0x47, (start ? 0x40 : 0) | (pid >> 8), pid & 0xff];
  const room = 184;
  if (payload.length >= room) return [...header, 0x10, ...payload.slice(0, room)];
  // Relleno con campo de adaptación para completar los 188 bytes.
  const stuffing = room - payload.length - 1;
  const adaptation = stuffing > 0 ? [stuffing, 0x00, ...new Array<number>(stuffing - 1).fill(0xff)] : [0];
  return [...header, 0x30, ...adaptation, ...payload];
}

function psiSection(tableId: number, body: number[]): number[] {
  const length = 5 + body.length + 4; // cabecera extendida + cuerpo + CRC
  return [0x00, tableId, 0xb0 | (length >> 8), length & 0xff, 0x00, 0x01, 0xc1, 0x00, 0x00, ...body, 0, 0, 0, 0];
}

function ptsBytes(pts: number): number[] {
  return [
    0x21 | (Math.floor(pts / 2 ** 30) << 1),
    (pts >> 22) & 0xff,
    (((pts >> 15) & 0x7f) << 1) | 1,
    (pts >> 7) & 0xff,
    ((pts & 0x7f) << 1) | 1,
  ];
}

function pes(streamId: number, pts: number, data: number[]): number[] {
  return [0, 0, 1, streamId, 0, 0, 0x80, 0x80, 5, ...ptsBytes(pts), ...data];
}

const SPS = [0x67, 0x4d, 0x40, 0x28, 0x11];
const IDR = [0x65, 0x88];
const P_SLICE = [0x41, 0x9a];
const startCode = (nal: number[]) => [0, 0, 0, 1, ...nal];

function makeTs(): Uint8Array {
  const pat = psiSection(0x00, [0x00, 0x01, 0xe1, 0x00]); // programa 1 → PMT en PID 0x100
  const pmt = psiSection(0x02, [
    0xe1, 0x01, 0xf0, 0x00, // PCR PID, program_info_length 0
    0x1b, 0xe1, 0x01, 0xf0, 0x00, // H.264 en PID 0x101
    0x0f, 0xe1, 0x02, 0xf0, 0x00, // AAC en PID 0x102
  ]);
  const base = 900_000; // el reloj de un TS no empieza en 0
  return Uint8Array.from([
    ...tsPacket(0, true, pat),
    ...tsPacket(0x100, true, pmt),
    ...tsPacket(0x101, true, pes(0xe0, base - 3003, startCode(P_SLICE))), // antes del primer keyframe: se descarta
    ...tsPacket(0x102, true, pes(0xc0, base - 900, [0xff, 0xf1, 0x01])),
    ...tsPacket(0x101, true, pes(0xe0, base, [...startCode(SPS), ...startCode(IDR)])),
    ...tsPacket(0x101, true, pes(0xe0, base + 3003, startCode(P_SLICE))),
    ...tsPacket(0x102, true, pes(0xc0, base + 1024, [0xff, 0xf1, 0x02])),
    ...tsPacket(0x101, true, pes(0xe0, base + 6006, startCode(P_SLICE))),
  ]);
}

describe("demuxMpegTs", () => {
  it("lee H.264 en Annex B, empieza en el primer keyframe y normaliza el reloj a 0", () => {
    const demuxed = demuxMpegTs(makeTs());
    expect(demuxed.videoTrack.codec).toBe("avc1.4d4028");
    expect(demuxed.decoderDescription).toBeUndefined();
    expect(demuxed.samples.map((s) => s.cts)).toEqual([0, 3003, 6006]);
    expect(demuxed.samples.map((s) => s.is_sync)).toEqual([true, false, false]);
    expect(demuxed.samples.every((s) => s.duration === 3003 && s.timescale === 90_000)).toBe(true);
  });

  it("extrae el flujo AAC y su desfase respecto al primer fotograma", () => {
    const audio = extractMpegTsAudio(makeTs())!;
    expect(Array.from(audio.data)).toEqual([0xff, 0xf1, 0x01, 0xff, 0xf1, 0x02]);
    expect(audio.offsetSeconds).toBeCloseTo(-900 / 90_000);
  });

  it("trocea Annex B con códigos de inicio de 3 y 4 bytes", () => {
    const nals = annexBNalUnits(Uint8Array.from([0, 0, 0, 1, 0x67, 0x01, 0, 0, 1, 0x68, 0x02]));
    expect(nals.map((nal) => Array.from(nal))).toEqual([
      [0x67, 0x01],
      [0x68, 0x02],
    ]);
  });
});

// --- Detección de contenedor, cadenas de códec, frame rate --------------

describe("sniffContainer", () => {
  it("reconoce cada contenedor por sus primeros bytes, no por la extensión", () => {
    expect(sniffContainer(makeMkv().subarray(0, 400))).toBe("matroska");
    expect(sniffContainer(makeTs().subarray(0, 400))).toBe("mpegts");
    expect(sniffContainer(Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]))).toBe("iso");
    expect(sniffContainer(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]))).toBe("unknown");
  });
});

describe("cadenas de códec", () => {
  it("H.264 desde avcC", () => {
    expect(avcCodecFromAvcC(Uint8Array.from(AVCC))).toBe("avc1.64001f");
  });

  it("HEVC Main desde hvcC (flags de compatibilidad invertidos, restricciones sin ceros finales)", () => {
    const hvcC = Uint8Array.from([0x01, 0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 93, 0xf0]);
    expect(hevcCodecFromHvcC(hvcC)).toBe("hvc1.1.6.L93.B0");
  });

  it("AV1 desde av1C", () => {
    expect(av1CodecFromAv1C(Uint8Array.from([0x81, 0x0c, 0x0c, 0x00]))).toBe("av01.0.12M.08");
    expect(av1CodecFromAv1C(Uint8Array.from([0x81, 0x08, 0x4c, 0x00]))).toBe("av01.0.08M.10");
  });

  it("VP9: perfil 0 de 8 bits y perfil 2 de 10 bits desde la cabecera del fotograma", () => {
    expect(vp9CodecFromFrame(Uint8Array.from([0x82, 0x49, 0x83, 0x42, 0x00]))).toBe("vp09.00.50.08");
    // frame_marker=10, profile_low=0, profile_high=1 (perfil 2), show_existing=0, key, show, !err, sync, bit10.
    const bits = "10" + "0" + "1" + "0" + "0" + "1" + "0" + "010010011000001101000010" + "0";
    const bytes = Uint8Array.from(bits.padEnd(40, "0").match(/.{8}/g)!.map((b) => parseInt(b, 2)));
    expect(vp9CodecFromFrame(bytes)).toBe("vp09.02.50.10");
  });

  it("nalToRbsp quita los bytes de prevención de emulación", () => {
    expect(Array.from(nalToRbsp(Uint8Array.from([1, 0, 0, 3, 1, 0, 0, 3, 0])))).toEqual([1, 0, 0, 1, 0, 0, 0]);
  });
});

describe("snapFrameRate", () => {
  it("ajusta a la frame rate estándar más cercana", () => {
    expect(snapFrameRate(29.97)).toEqual({ numerator: 30000, denominator: 1001 });
    expect(snapFrameRate(1000 / 40)).toEqual({ numerator: 25, denominator: 1 });
    expect(snapFrameRate(59.94)).toEqual({ numerator: 60000, denominator: 1001 });
  });

  it("deja una fracción con milésimas si no se parece a ninguna", () => {
    expect(snapFrameRate(17.5)).toEqual({ numerator: 17500, denominator: 1000 });
  });
});
