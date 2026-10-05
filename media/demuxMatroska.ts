import { avcCodecFromAvcC, av1CodecFromAv1C, hevcCodecFromHvcC, vp9CodecFromFrame } from "./codecStrings";
import type { FrameRate } from "../core/time";
import { SampleDataLoader, type ByteSource } from "./sampleData";
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
  /** Posición absoluta del fotograma en el archivo, y su tamaño: los bytes los lee el loader cuando hacen falta. */
  offset: number;
  size: number;
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

/** Lecturas del archivo por tramos de este tamaño mientras se recorre (no se guarda nada de ellos salvo posiciones). */
const WINDOW_BYTES = 4 * 1024 * 1024;

/**
 * Ventana deslizante sobre el archivo: el recorrido de Matroska es
 * secuencial, así que se lee a trozos de WINDOW_BYTES en vez de cargar
 * el archivo entero. Las funciones de parseo de arriba trabajan con
 * posiciones locales a `bytes`; `base` es la posición absoluta de su
 * primer byte.
 */
class ByteWindow {
  base = 0;
  bytes: Uint8Array = new Uint8Array(0);
  constructor(private readonly source: ByteSource) {}

  /** Garantiza que [pos, pos+length) (recortado al archivo) está en la ventana. Devuelve la posición local de `pos`. */
  async ensure(pos: number, length: number): Promise<number> {
    const end = Math.min(pos + length, this.source.size);
    if (pos < this.base || end > this.base + this.bytes.length) {
      this.base = pos;
      this.bytes = await this.source.read(pos, Math.min(this.source.size, pos + Math.max(length, WINDOW_BYTES)));
    }
    return pos - this.base;
  }

  /** Cabecera del elemento en `pos` (absoluto), con `dataStart` absoluto. */
  async header(pos: number): Promise<ElementHeader | undefined> {
    if (pos >= this.source.size) return undefined;
    const local = await this.ensure(pos, 16);
    const header = readElementHeader(this.bytes, local);
    return header ? { ...header, dataStart: header.dataStart + this.base } : undefined;
  }
}

export async function demuxMatroska(source: ByteSource): Promise<DemuxedTrack> {
  const win = new ByteWindow(source);
  const ebml = await win.header(0);
  if (!ebml || ebml.id !== ID.EBML || ebml.size === UNKNOWN_SIZE) {
    throw new Error("No es un archivo Matroska/WebM válido");
  }
  let pos = ebml.dataStart + ebml.size;
  let segment: ElementHeader | undefined;
  while (pos < source.size) {
    const header = await win.header(pos);
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
    segment.size === UNKNOWN_SIZE ? source.size : Math.min(source.size, segment.dataStart + segment.size);

  let timecodeScaleNs = 1_000_000;
  let durationUnits: number | undefined;
  let track: MatroskaVideoTrack | undefined;
  /** Clusters vistos antes que Tracks (no debería pasar): se recorren al final. */
  const pendingClusters: ElementHeader[] = [];
  const blocks: RawBlock[] = [];

  /** Recorre los hijos de un Cluster (de tamaño conocido o no) y apunta los bloques de la pista de vídeo. Devuelve dónde acaba. */
  async function walkCluster(cluster: ElementHeader, videoTrack: MatroskaVideoTrack): Promise<number> {
    const end =
      cluster.size === UNKNOWN_SIZE ? segmentEnd : Math.min(cluster.dataStart + cluster.size, segmentEnd);
    let clusterTimecode = 0;
    let p = cluster.dataStart;
    while (p < end) {
      const el = await win.header(p);
      if (!el || el.size === UNKNOWN_SIZE) return p;
      // Un Cluster sin tamaño acaba donde empieza el siguiente elemento de nivel 1.
      if (cluster.size === UNKNOWN_SIZE && LEVEL1_IDS.has(el.id)) return p;
      const dataEnd = Math.min(el.dataStart + el.size, end);
      if (el.id === ID.Timecode) {
        const local = await win.ensure(el.dataStart, el.size);
        clusterTimecode = readUint(win.bytes, local, el.size);
      } else if (el.id === ID.SimpleBlock) {
        // Solo la cabecera del bloque: los bytes del fotograma no se leen aquí.
        const local = await win.ensure(el.dataStart, 16);
        const block = parseBlock(win.bytes, local, local + (dataEnd - el.dataStart));
        if (block.track === videoTrack.number) {
          assertNoLacing(block.flags);
          const offset = win.base + block.payloadStart;
          blocks.push({
            timecode: clusterTimecode + block.relativeTimecode,
            key: (block.flags & 0x80) !== 0,
            offset,
            size: dataEnd - offset,
          });
        }
      } else if (el.id === ID.BlockGroup) {
        let raw: ReturnType<typeof parseBlock> | undefined;
        let rawOffset = 0;
        let rawEnd = 0;
        let duration: number | undefined;
        let hasReference = false;
        let q = el.dataStart;
        while (q < dataEnd) {
          const child = await win.header(q);
          if (!child || child.size === UNKNOWN_SIZE) break;
          const childEnd = Math.min(child.dataStart + child.size, dataEnd);
          if (child.id === ID.Block) {
            const local = await win.ensure(child.dataStart, 16);
            raw = parseBlock(win.bytes, local, local + (childEnd - child.dataStart));
            rawOffset = win.base + raw.payloadStart;
            rawEnd = childEnd;
          } else if (child.id === ID.BlockDuration) {
            const local = await win.ensure(child.dataStart, child.size);
            duration = readUint(win.bytes, local, child.size);
          } else if (child.id === ID.ReferenceBlock) {
            hasReference = true;
          }
          q = child.dataStart + child.size;
        }
        if (raw && raw.track === videoTrack.number) {
          assertNoLacing(raw.flags);
          blocks.push({
            timecode: clusterTimecode + raw.relativeTimecode,
            key: !hasReference,
            offset: rawOffset,
            size: rawEnd - rawOffset,
            ...(duration !== undefined ? { duration } : {}),
          });
        }
      }
      p = el.dataStart + el.size;
    }
    return Math.min(p, end);
  }

  pos = segment.dataStart;
  while (pos < segmentEnd) {
    const header = await win.header(pos);
    if (!header) break;
    if (header.id === ID.Cluster) {
      if (track) {
        pos = await walkCluster(header, track);
      } else {
        pendingClusters.push(header);
        if (header.size === UNKNOWN_SIZE) break;
        pos = header.dataStart + header.size;
      }
      continue;
    }
    if (header.size === UNKNOWN_SIZE) break; // solo Cluster puede venir sin tamaño en la práctica
    const end = Math.min(header.dataStart + header.size, segmentEnd);
    if (header.id === ID.Info || header.id === ID.Tracks) {
      const local = await win.ensure(header.dataStart, end - header.dataStart);
      const bytes = win.bytes;
      const localEnd = local + (end - header.dataStart);
      if (header.id === ID.Info) {
        forEachChild(bytes, local, localEnd, (el) => {
          if (el.id === ID.TimecodeScale) timecodeScaleNs = readUint(bytes, el.dataStart, el.size) || 1_000_000;
          if (el.id === ID.Duration) durationUnits = readFloat(bytes, el.dataStart, el.size);
        });
      } else {
        // Los CodecPrivate se copian: la ventana se reutiliza al seguir leyendo.
        forEachChild(bytes, local, localEnd, (el, dataEnd) => {
          if (el.id === ID.TrackEntry && !track) track = parseTrackEntry(bytes.slice(el.dataStart, dataEnd), 0, dataEnd - el.dataStart);
        });
      }
    }
    pos = end;
  }

  if (!track) throw new Error("El archivo no contiene ninguna pista de vídeo");
  const videoTrack = track;
  for (const cluster of pendingClusters) await walkCluster(cluster, videoTrack);
  if (blocks.length === 0) throw new Error("La pista de vídeo no tiene fotogramas");

  const unitToUs = timecodeScaleNs / 1000;
  const samples: DemuxedSample[] = blocks.map((block) => ({
    cts: Math.round(block.timecode * unitToUs),
    duration: block.duration !== undefined ? Math.round(block.duration * unitToUs) : 0,
    timescale: 1_000_000,
    is_sync: block.key,
    offset: block.offset,
    size: block.size,
  }));
  const frameRate = snapFrameRate(estimateFps(samples, videoTrack.defaultDurationNs));
  snapToFrameGrid(samples, frameRate, unitToUs);
  fillDurations(samples, videoTrack.defaultDurationNs !== undefined ? videoTrack.defaultDurationNs / 1000 : undefined);

  const loader = new SampleDataLoader(source, samples, videoTrack.strippedHeader);
  await loader.ensure(0, 0); // el primer fotograma hace falta para la cadena de códec de VP9
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
    loader,
  };
}

function assertNoLacing(flags: number): void {
  if ((flags & 0x06) !== 0) {
    throw new Error("Matroska: el vídeo usa lacing (varios fotogramas por bloque), no soportado");
  }
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
