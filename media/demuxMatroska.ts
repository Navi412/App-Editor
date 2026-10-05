import { avcCodecFromAvcC, av1CodecFromAv1C, hevcCodecFromHvcC, vp9CodecFromFrame } from "./codecStrings";
import type { FrameRate } from "../core/time";
import type { DemuxedSample, DemuxedTrack } from "./samples";
import { snapFrameRate } from "./sourceFile";

/**
 * Demuxer mínimo de Matroska / WebM (.mkv, .webm — OBS graba en MKV
 * por defecto). Solo lee lo necesario para la primera pista de vídeo:
 * Info (escala de tiempo, duración), Tracks (códec, CodecPrivate,
 * tamaño, DefaultDuration) y los bloques de los Clusters. Funciones
 * puras sobre bytes, sin DOM ni WebCodecs — testeable con archivos
 * inventados.
 *
 * Soporta tamaños desconocidos de Segment/Cluster (lo que escriben
 * MediaRecorder y los grabadores en directo) y la compresión por
 * "header stripping" de mkvmerge antiguo. No soporta lacing en vídeo
 * (nadie lo usa) ni pistas cifradas/comprimidas con zlib.
 */

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  ContentEncodings: 0x6d80,
  ContentEncoding: 0x6240,
  ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254,
  ContentCompSettings: 0x4255,
  ContentEncryption: 0x5035,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b,
  Attachments: 0x1941a469,
  Chapters: 0x1043a770,
  Tags: 0x1254c367,
} as const;

/** Hijos directos de Segment: un Cluster de tamaño desconocido acaba donde empieza el siguiente de estos. */
const LEVEL1_IDS = new Set<number>([
  ID.SeekHead,
  ID.Info,
  ID.Tracks,
  ID.Cluster,
  ID.Cues,
  ID.Attachments,
  ID.Chapters,
  ID.Tags,
]);

const UNKNOWN_SIZE = -1;

interface ElementHeader {
  id: number;
  /** Bytes de datos, o UNKNOWN_SIZE. */
  size: number;
  /** Posición del primer byte de datos. */
  dataStart: number;
}

function vintLength(firstByte: number): number {
  for (let length = 1; length <= 8; length++) {
    if (firstByte & (0x80 >> (length - 1))) return length;
  }
  throw new Error("Matroska: entero de longitud variable inválido");
}

/** Lee la cabecera de un elemento EBML (ID con su marcador, tamaño sin él). undefined si no cabe en el archivo. */
function readElementHeader(bytes: Uint8Array, pos: number): ElementHeader | undefined {
  if (pos >= bytes.length) return undefined;
  const idLength = vintLength(bytes[pos]!);
  if (pos + idLength >= bytes.length) return undefined;
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + bytes[pos + i]!;
  const sizePos = pos + idLength;
  const sizeLength = vintLength(bytes[sizePos]!);
  if (sizePos + sizeLength > bytes.length) return undefined;
  let size = bytes[sizePos]! & (0xff >> sizeLength);
  let allOnes = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i++) {
    const byte = bytes[sizePos + i]!;
    if (byte !== 0xff) allOnes = false;
    size = size * 256 + byte;
  }
  return { id, size: allOnes ? UNKNOWN_SIZE : size, dataStart: sizePos + sizeLength };
}

function readUint(bytes: Uint8Array, start: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + bytes[start + i]!;
  return value;
}

function readFloat(bytes: Uint8Array, start: number, size: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, size);
  if (size === 4) return view.getFloat32(0);
  if (size === 8) return view.getFloat64(0);
  return 0;
}

function readString(bytes: Uint8Array, start: number, size: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + size)).replace(/\0+$/, "");
}

/** Recorre los hijos de un elemento de tamaño conocido. */
function forEachChild(
  bytes: Uint8Array,
  start: number,
  end: number,
  visit: (header: ElementHeader, dataEnd: number) => void,
): void {
  let pos = start;
  while (pos < end) {
    const header = readElementHeader(bytes, pos);
    if (!header || header.size === UNKNOWN_SIZE) return;
    const dataEnd = Math.min(header.dataStart + header.size, end);
    visit(header, dataEnd);
    pos = header.dataStart + header.size;
  }
}

interface MatroskaVideoTrack {
  number: number;
  codecId: string;
  codecPrivate?: Uint8Array;
  defaultDurationNs?: number;
  width: number;
  height: number;
  /** Bytes que el muxer quitó del principio de cada fotograma (header stripping) y hay que volver a poner. */
  strippedHeader?: Uint8Array;
}

function parseTrackEntry(bytes: Uint8Array, start: number, end: number): MatroskaVideoTrack | undefined {
  let number = 0;
  let type = 0;
  let codecId = "";
  let codecPrivate: Uint8Array | undefined;
  let defaultDurationNs: number | undefined;
  let width = 0;
  let height = 0;
  let strippedHeader: Uint8Array | undefined;
  forEachChild(bytes, start, end, (el, dataEnd) => {
    switch (el.id) {
      case ID.TrackNumber:
        number = readUint(bytes, el.dataStart, el.size);
        break;
      case ID.TrackType:
        type = readUint(bytes, el.dataStart, el.size);
        break;
      case ID.CodecID:
        codecId = readString(bytes, el.dataStart, el.size);
        break;
      case ID.CodecPrivate:
        codecPrivate = bytes.subarray(el.dataStart, dataEnd);
        break;
      case ID.DefaultDuration:
        defaultDurationNs = readUint(bytes, el.dataStart, el.size);
        break;
      case ID.Video:
        forEachChild(bytes, el.dataStart, dataEnd, (child) => {
          if (child.id === ID.PixelWidth) width = readUint(bytes, child.dataStart, child.size);
          if (child.id === ID.PixelHeight) height = readUint(bytes, child.dataStart, child.size);
        });
        break;
      case ID.ContentEncodings:
        strippedHeader = parseContentEncodings(bytes, el.dataStart, dataEnd);
        break;
    }
  });
  if (type !== 1) return undefined; // 1 = vídeo
  return {
    number,
    codecId,
    width,
    height,
    ...(codecPrivate ? { codecPrivate } : {}),
    ...(defaultDurationNs ? { defaultDurationNs } : {}),
    ...(strippedHeader ? { strippedHeader } : {}),
  };
}

function parseContentEncodings(bytes: Uint8Array, start: number, end: number): Uint8Array | undefined {
  let stripped: Uint8Array | undefined;
  forEachChild(bytes, start, end, (encoding, encodingEnd) => {
    if (encoding.id !== ID.ContentEncoding) return;
    forEachChild(bytes, encoding.dataStart, encodingEnd, (child, childEnd) => {
      if (child.id === ID.ContentEncryption) {
        throw new Error("El vídeo MKV está cifrado — no se puede leer");
      }
      if (child.id !== ID.ContentCompression) return;
      let algo = 0; // 0 = zlib por defecto según la especificación
      let settings: Uint8Array = new Uint8Array(0);
      forEachChild(bytes, child.dataStart, childEnd, (field, fieldEnd) => {
        if (field.id === ID.ContentCompAlgo) algo = readUint(bytes, field.dataStart, field.size);
        if (field.id === ID.ContentCompSettings) settings = bytes.subarray(field.dataStart, fieldEnd);
      });
      if (algo !== 3) {
        throw new Error("El vídeo MKV usa compresión de pista (zlib/bzlib/lzo) — remúxalo sin compresión");
      }
      stripped = settings;
    });
  });
  return stripped;
}

interface RawBlock {
  /** Timestamp en unidades de TimecodeScale (cluster + relativo del bloque). */
  timecode: number;
  key: boolean;
  data: Uint8Array;
  /** Duración explícita (BlockGroup/BlockDuration), en unidades de TimecodeScale. */
  duration?: number;
}

/** Cabecera de un Block/SimpleBlock: número de pista, timecode relativo (int16), flags. */
function parseBlock(
  bytes: Uint8Array,
  start: number,
  end: number,
): { track: number; relativeTimecode: number; flags: number; payloadStart: number } {
  const trackLength = vintLength(bytes[start]!);
  const track = readUint(bytes, start, trackLength) - (0x80 >> (trackLength - 1)) * 256 ** (trackLength - 1);
  const tcPos = start + trackLength;
  if (tcPos + 3 > end) throw new Error("Matroska: bloque truncado");
  let relativeTimecode = (bytes[tcPos]! << 8) | bytes[tcPos + 1]!;
  if (relativeTimecode & 0x8000) relativeTimecode -= 0x10000;
  return { track, relativeTimecode, flags: bytes[tcPos + 2]!, payloadStart: tcPos + 3 };
}

export function demuxMatroska(bytes: Uint8Array): DemuxedTrack {
  const ebml = readElementHeader(bytes, 0);
  if (!ebml || ebml.id !== ID.EBML || ebml.size === UNKNOWN_SIZE) {
    throw new Error("No es un archivo Matroska/WebM válido");
  }
  let pos = ebml.dataStart + ebml.size;
  let segment: ElementHeader | undefined;
  while (pos < bytes.length) {
    const header = readElementHeader(bytes, pos);
    if (!header) break;
    if (header.id === ID.Segment) {
      segment = header;
      break;
    }
    if (header.size === UNKNOWN_SIZE) break;
    pos = header.dataStart + header.size;
  }
  if (!segment) throw new Error("Matroska: el archivo no tiene Segment");
  const segmentEnd =
    segment.size === UNKNOWN_SIZE ? bytes.length : Math.min(bytes.length, segment.dataStart + segment.size);

  let timecodeScaleNs = 1_000_000;
  let durationUnits: number | undefined;
  let track: MatroskaVideoTrack | undefined;
  /** [inicio de datos, fin] de cada Cluster — se procesan al final, cuando ya se conoce la pista. */
  const clusters: Array<[number, number]> = [];

  pos = segment.dataStart;
  while (pos < segmentEnd) {
    const header = readElementHeader(bytes, pos);
    if (!header) break;
    let end: number;
    if (header.size === UNKNOWN_SIZE) {
      if (header.id !== ID.Cluster) break; // solo Cluster puede venir sin tamaño en la práctica
      end = findUnknownSizeEnd(bytes, header.dataStart, segmentEnd);
    } else {
      end = Math.min(header.dataStart + header.size, segmentEnd);
    }
    switch (header.id) {
      case ID.Info:
        forEachChild(bytes, header.dataStart, end, (el) => {
          if (el.id === ID.TimecodeScale) timecodeScaleNs = readUint(bytes, el.dataStart, el.size) || 1_000_000;
          if (el.id === ID.Duration) durationUnits = readFloat(bytes, el.dataStart, el.size);
        });
        break;
      case ID.Tracks:
        forEachChild(bytes, header.dataStart, end, (el, dataEnd) => {
          if (el.id === ID.TrackEntry && !track) track = parseTrackEntry(bytes, el.dataStart, dataEnd);
        });
        break;
      case ID.Cluster:
        clusters.push([header.dataStart, end]);
        break;
    }
    pos = end;
  }

  if (!track) throw new Error("El archivo no contiene ninguna pista de vídeo");
  const videoTrack = track;

  const blocks: RawBlock[] = [];
  for (const [start, end] of clusters) {
    let clusterTimecode = 0;
    forEachChild(bytes, start, end, (el, dataEnd) => {
      if (el.id === ID.Timecode) {
        clusterTimecode = readUint(bytes, el.dataStart, el.size);
      } else if (el.id === ID.SimpleBlock) {
        const block = parseBlock(bytes, el.dataStart, dataEnd);
        if (block.track !== videoTrack.number) return;
        assertNoLacing(block.flags);
        blocks.push({
          timecode: clusterTimecode + block.relativeTimecode,
          key: (block.flags & 0x80) !== 0,
          data: bytes.subarray(block.payloadStart, dataEnd),
        });
      } else if (el.id === ID.BlockGroup) {
        let raw: ReturnType<typeof parseBlock> | undefined;
        let rawEnd = 0;
        let duration: number | undefined;
        let hasReference = false;
        forEachChild(bytes, el.dataStart, dataEnd, (child, childEnd) => {
          if (child.id === ID.Block) {
            raw = parseBlock(bytes, child.dataStart, childEnd);
            rawEnd = childEnd;
          } else if (child.id === ID.BlockDuration) {
            duration = readUint(bytes, child.dataStart, child.size);
          } else if (child.id === ID.ReferenceBlock) {
            hasReference = true;
          }
        });
        if (!raw || raw.track !== videoTrack.number) return;
        assertNoLacing(raw.flags);
        blocks.push({
          timecode: clusterTimecode + raw.relativeTimecode,
          key: !hasReference,
          data: bytes.subarray(raw.payloadStart, rawEnd),
          ...(duration !== undefined ? { duration } : {}),
        });
      }
    });
  }
  if (blocks.length === 0) throw new Error("La pista de vídeo no tiene fotogramas");

  const unitToUs = timecodeScaleNs / 1000;
  const samples: DemuxedSample[] = blocks.map((block) => ({
    cts: Math.round(block.timecode * unitToUs),
    duration: block.duration !== undefined ? Math.round(block.duration * unitToUs) : 0,
    timescale: 1_000_000,
    is_sync: block.key,
    data: videoTrack.strippedHeader ? concat(videoTrack.strippedHeader, block.data) : block.data,
  }));
  const frameRate = snapFrameRate(estimateFps(samples, videoTrack.defaultDurationNs));
  snapToFrameGrid(samples, frameRate, unitToUs);
  fillDurations(samples, videoTrack.defaultDurationNs !== undefined ? videoTrack.defaultDurationNs / 1000 : undefined);

  const { codec, description } = codecForTrack(videoTrack, samples[0]!.data!);
  const lastEndUs = Math.max(...samples.map((sample) => sample.cts + sample.duration));
  const durationUs = durationUnits !== undefined && durationUnits > 0 ? Math.round(durationUnits * unitToUs) : lastEndUs;

  return {
    videoTrack: {
      id: videoTrack.number,
      codec,
      timescale: 1_000_000,
      duration: durationUs,
      ...(videoTrack.width > 0 && videoTrack.height > 0
        ? { video: { width: videoTrack.width, height: videoTrack.height } }
        : {}),
    },
    samples,
    ...(description ? { decoderDescription: description } : {}),
    frameRate,
  };
}

/** Fin de un Cluster de tamaño desconocido: el siguiente elemento de nivel 1, o el fin del Segment. */
function findUnknownSizeEnd(bytes: Uint8Array, start: number, segmentEnd: number): number {
  let pos = start;
  while (pos < segmentEnd) {
    const header = readElementHeader(bytes, pos);
    if (!header || header.size === UNKNOWN_SIZE || LEVEL1_IDS.has(header.id)) return pos;
    pos = header.dataStart + header.size;
  }
  return Math.min(pos, segmentEnd);
}

function assertNoLacing(flags: number): void {
  if ((flags & 0x06) !== 0) {
    throw new Error("Matroska: el vídeo usa lacing (varios fotogramas por bloque), no soportado");
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Matroska guarda timestamps de PRESENTACIÓN y casi nunca la duración
 * de cada bloque: la de cada muestra es la distancia a la siguiente en
 * orden de presentación; la última hereda DefaultDuration o la típica.
 */
function fillDurations(samples: DemuxedSample[], defaultDurationUs: number | undefined): void {
  const byPts = [...samples].sort((a, b) => a.cts - b.cts);
  for (let i = 0; i < byPts.length - 1; i++) {
    const sample = byPts[i]!;
    if (sample.duration <= 0) sample.duration = byPts[i + 1]!.cts - sample.cts;
  }
  const last = byPts[byPts.length - 1]!;
  if (last.duration <= 0) {
    const typical = byPts.length > 1 ? byPts[byPts.length - 2]!.duration : 0;
    last.duration = Math.round(defaultDurationUs ?? (typical > 0 ? typical : 33_333));
  }
}

/**
 * Matroska redondea los timestamps a su TimecodeScale (1 ms casi
 * siempre): a 29,97 fps el segundo fotograma queda en 67 000 µs en vez
 * de 66 733, y la exportación, que pide fotogramas en la rejilla exacta
 * de la salida, cogería el anterior (un fotograma de retraso). Se
 * devuelve cada timestamp a la rejilla de su frame rate SOLO si está a
 * menos de una unidad de redondeo de ella — el contenido de frame rate
 * variable (lejos de la rejilla) se queda como está.
 */
function snapToFrameGrid(samples: DemuxedSample[], frameRate: FrameRate, toleranceUs: number): void {
  const frameUs = (1_000_000 * frameRate.denominator) / frameRate.numerator;
  for (const sample of samples) {
    const grid = Math.round(Math.round(sample.cts / frameUs) * frameUs);
    if (Math.abs(grid - sample.cts) <= toleranceUs) sample.cts = grid;
  }
}

/** fps de la pista: DefaultDuration si la hay; si no, la media entre el primer y el último fotograma (los timestamps en ms no dan duraciones individuales exactas). */
function estimateFps(samples: DemuxedSample[], defaultDurationNs: number | undefined): number {
  if (defaultDurationNs && defaultDurationNs > 0) return 1e9 / defaultDurationNs;
  if (samples.length < 2) return 30;
  let min = Infinity;
  let max = -Infinity;
  for (const sample of samples) {
    min = Math.min(min, sample.cts);
    max = Math.max(max, sample.cts);
  }
  return max > min ? ((samples.length - 1) * 1_000_000) / (max - min) : 30;
}

function codecForTrack(
  track: MatroskaVideoTrack,
  firstFrame: Uint8Array,
): { codec: string; description?: Uint8Array } {
  const priv = track.codecPrivate;
  switch (track.codecId) {
    case "V_MPEG4/ISO/AVC":
      if (!priv) throw new Error("MKV H.264 sin CodecPrivate (avcC)");
      return { codec: avcCodecFromAvcC(priv), description: priv };
    case "V_MPEGH/ISO/HEVC":
      if (!priv) throw new Error("MKV HEVC sin CodecPrivate (hvcC)");
      return { codec: hevcCodecFromHvcC(priv), description: priv };
    case "V_VP8":
      return { codec: "vp8" };
    case "V_VP9":
      return { codec: vp9CodecFromFrame(firstFrame) };
    case "V_AV1":
      if (!priv || priv.length < 4) return { codec: "av01.0.08M.08" };
      return { codec: av1CodecFromAv1C(priv), description: priv };
    default:
      throw new Error(
        `El vídeo usa el códec ${track.codecId.replace(/^V_/, "")}, que no se puede decodificar. ` +
          `Se admiten H.264, H.265/HEVC, VP8, VP9 y AV1.`,
      );
  }
}
