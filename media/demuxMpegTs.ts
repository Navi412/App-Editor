import { avcCodecFromSps, hevcCodecFromSps } from "./codecStrings";
import type { DemuxedSample, DemuxedTrack } from "./samples";

/**
 * Demuxer mínimo de MPEG-TS (.ts) y de su variante con cabecera de 4
 * bytes por paquete, M2TS (.m2ts/.mts — AVCHD de cámaras, Blu-ray).
 * Solo H.264 y H.265: los demás códecs de vídeo habituales en TS
 * (MPEG-2, MPEG-4 Part 2) no los decodifica WebCodecs.
 *
 * El vídeo sale en Annex B (códigos de inicio 00 00 01, SPS/PPS en
 * banda), que es justo lo que WebCodecs espera cuando el
 * VideoDecoderConfig NO lleva `description` — no hace falta convertir
 * a avcC/hvcC. Se asume un fotograma (access unit) por PES, que es lo
 * que escriben cámaras, ffmpeg, OBS y la difusión; un PES sin PTS se
 * trata como continuación del anterior.
 *
 * El audio (AAC/MP3) se extrae aparte con extractMpegTsAudio, porque
 * `decodeAudioData` no sabe leer el contenedor TS (ver media/audio.ts).
 *
 * Funciones puras sobre bytes, testeables con paquetes inventados.
 */

const PACKET_SIZE = 188;
const PTS_CLOCK = 90_000;

/** 188 bytes (TS) o 192 (M2TS: 4 bytes de timestamp delante de cada paquete). undefined si no parece TS. */
export function mpegTsPacketLayout(bytes: Uint8Array): { stride: number; offset: number } | undefined {
  for (const [stride, offset] of [
    [188, 0],
    [192, 4],
  ] as const) {
    // Tres bytes de sincronía seguidos (o los que quepan): un 0x47 suelto al principio es demasiado poco.
    let matches = 0;
    for (let i = 0; i < 3; i++) {
      const pos = offset + i * stride;
      if (pos >= bytes.length) break;
      if (bytes[pos] !== 0x47) {
        matches = -1;
        break;
      }
      matches++;
    }
    if (matches >= 1 && (matches === 3 || bytes.length < offset + 3 * stride)) return { stride, offset };
  }
  return undefined;
}

type VideoCodec = "h264" | "h265";
type AudioCodec = "aac" | "mp3";

interface Pes {
  pts?: number;
  chunks: Uint8Array[];
  length: number;
}

interface TransportVideo {
  pid: number;
  codec: VideoCodec;
  pesList: Pes[];
}

interface ParsedTransportStream {
  video?: TransportVideo;
  audio?: { codec: AudioCodec; pesList: Pes[] };
  unsupportedVideoType?: number;
}

/** Una pasada por los paquetes: PAT → PMT → PES de la primera pista de vídeo y de la primera de audio decodificable. */
function parseTransportStream(bytes: Uint8Array): ParsedTransportStream {
  const layout = mpegTsPacketLayout(bytes);
  if (!layout) throw new Error("No es un archivo MPEG-TS válido");

  let pmtPid: number | undefined;
  let pmt: ReturnType<typeof parsePmt> | undefined;
  const streams = new Map<number, { pesList: Pes[]; current?: Pes }>();

  for (let pos = layout.offset; pos + PACKET_SIZE <= bytes.length; pos += layout.stride) {
    if (bytes[pos] !== 0x47) continue; // paquete corrupto: se salta, como hacen los reproductores
    const payloadStartIndicator = (bytes[pos + 1]! & 0x40) !== 0;
    const pid = ((bytes[pos + 1]! & 0x1f) << 8) | bytes[pos + 2]!;
    const adaptation = (bytes[pos + 3]! >> 4) & 0x3;
    let payloadStart = pos + 4;
    if (adaptation === 2) continue; // solo campo de adaptación, sin datos
    if (adaptation === 3) payloadStart += 1 + bytes[payloadStart]!;
    const packetEnd = pos + PACKET_SIZE;
    if (payloadStart >= packetEnd) continue;
    const payload = bytes.subarray(payloadStart, packetEnd);

    if (pid === 0 && payloadStartIndicator && pmtPid === undefined) {
      pmtPid = parsePat(payload);
    } else if (pid === pmtPid && payloadStartIndicator && pmt === undefined) {
      pmt = parsePmt(payload);
      if (pmt.video) streams.set(pmt.video.pid, { pesList: [] });
      if (pmt.audio) streams.set(pmt.audio.pid, { pesList: [] });
    } else {
      const stream = streams.get(pid);
      if (!stream) continue;
      if (payloadStartIndicator) {
        const { pts, dataStart } = parsePesHeader(payload);
        const data = payload.subarray(dataStart);
        if (pts === undefined && stream.current) {
          stream.current.chunks.push(data);
          stream.current.length += data.length;
        } else {
          stream.current = { chunks: [data], length: data.length, ...(pts !== undefined ? { pts } : {}) };
          stream.pesList.push(stream.current);
        }
      } else if (stream.current) {
        stream.current.chunks.push(payload);
        stream.current.length += payload.length;
      }
    }
  }

  return {
    ...(pmt?.video ? { video: { ...pmt.video, pesList: streams.get(pmt.video.pid)!.pesList } } : {}),
    ...(pmt?.audio ? { audio: { codec: pmt.audio.codec, pesList: streams.get(pmt.audio.pid)!.pesList } } : {}),
    ...(pmt?.unsupportedVideoType !== undefined ? { unsupportedVideoType: pmt.unsupportedVideoType } : {}),
  };
}

/**
 * PTS de 33 bits: si da la vuelta (unas 26 h de reloj, pero los relojes
 * de cámara empiezan donde quieren), se desenrolla. Devuelve una
 * función con estado para recorrer los PTS de un flujo en orden.
 */
function ptsUnwrapper(): (pts: number) => number {
  let last: number | undefined;
  let offset = 0;
  return (raw) => {
    let pts = raw + offset;
    if (last !== undefined && pts < last - 2 ** 32) {
      offset += 2 ** 33;
      pts += 2 ** 33;
    }
    last = pts;
    return pts;
  };
}

/** Fotogramas de vídeo con su PTS desenrollado (sin normalizar), desde el primer keyframe. */
function videoSamplesFrom(video: TransportVideo): { samples: DemuxedSample[]; firstSps?: Uint8Array } {
  const unwrap = ptsUnwrapper();
  const samples: DemuxedSample[] = [];
  let firstSps: Uint8Array | undefined;
  for (const pes of video.pesList) {
    if (pes.pts === undefined || pes.length === 0) continue;
    const pts = unwrap(pes.pts);
    const data = joinChunks(pes.chunks, pes.length);
    const nals = annexBNalUnits(data);
    const key = nals.some((nal) => isKeyframeNal(nal, video.codec));
    // Lo anterior al primer keyframe no se puede decodificar (falta el
    // fotograma de referencia): se descarta, como haría cualquier reproductor.
    if (samples.length === 0 && !key) continue;
    firstSps ??= nals.find((nal) => isSpsNal(nal, video.codec));
    samples.push({ cts: pts, duration: 0, timescale: PTS_CLOCK, is_sync: key, data });
  }
  return { samples, ...(firstSps ? { firstSps } : {}) };
}

function videoOrThrow(parsed: ParsedTransportStream): TransportVideo {
  if (parsed.video) return parsed.video;
  const type = parsed.unsupportedVideoType;
  if (type !== undefined) {
    const name = type === 0x02 || type === 0x01 ? "MPEG-2" : `tipo 0x${type.toString(16)}`;
    throw new Error(`El vídeo usa el códec ${name}, que no se puede decodificar. En MPEG-TS se admiten H.264 y H.265.`);
  }
  throw new Error("El archivo no contiene ninguna pista de vídeo");
}

export function demuxMpegTs(bytes: Uint8Array): DemuxedTrack {
  const video = videoOrThrow(parseTransportStream(bytes));
  const { samples, firstSps } = videoSamplesFrom(video);
  if (samples.length === 0) throw new Error("El vídeo no tiene ningún fotograma clave");
  if (!firstSps) throw new Error("No se encontraron los parámetros del vídeo (SPS)");

  // El reloj de un TS empieza en cualquier valor: se lleva a 0 para que
  // el tiempo de fuente 0 sea el primer fotograma, como en MP4.
  const minPts = Math.min(...samples.map((sample) => sample.cts));
  for (const sample of samples) sample.cts -= minPts;
  fillDurations(samples);
  const lastEnd = Math.max(...samples.map((sample) => sample.cts + sample.duration));

  return {
    videoTrack: {
      id: video.pid,
      codec: video.codec === "h264" ? avcCodecFromSps(firstSps) : hevcCodecFromSps(firstSps),
      timescale: PTS_CLOCK,
      duration: lastEnd,
    },
    samples,
  };
}

/**
 * `decodeAudioData` no entiende el contenedor TS, pero sí el flujo de
 * audio "desnudo" que va dentro (AAC en ADTS, MP3: tramas que se
 * delimitan solas). Devuelve ese flujo y cuánto empieza el audio
 * después (+) o antes (−) del primer fotograma de vídeo — el tiempo 0
 * de la fuente tras la normalización de demuxMpegTs. undefined si no
 * hay audio decodificable (p.ej. AC-3, habitual en AVCHD: Chromium no
 * lo decodifica).
 */
export function extractMpegTsAudio(bytes: Uint8Array): { data: Uint8Array; offsetSeconds: number } | undefined {
  const parsed = parseTransportStream(bytes);
  if (!parsed.audio || !parsed.video) return undefined;
  const { samples } = videoSamplesFrom(parsed.video);
  if (samples.length === 0) return undefined;
  const videoStart = Math.min(...samples.map((sample) => sample.cts));

  const unwrap = ptsUnwrapper();
  let audioStart: number | undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (const pes of parsed.audio.pesList) {
    if (pes.pts !== undefined) audioStart ??= unwrap(pes.pts);
    chunks.push(...pes.chunks);
    length += pes.length;
  }
  if (audioStart === undefined || length === 0) return undefined;
  return { data: joinChunks(chunks, length), offsetSeconds: (audioStart - videoStart) / PTS_CLOCK };
}

/** PAT: devuelve el PID de la PMT del primer programa (≠ 0, que es la red). */
function parsePat(payload: Uint8Array): number | undefined {
  const section = payload.subarray(1 + payload[0]!); // pointer_field
  const sectionLength = ((section[1]! & 0x0f) << 8) | section[2]!;
  const end = Math.min(3 + sectionLength - 4, section.length); // sin CRC
  for (let i = 8; i + 4 <= end; i += 4) {
    const program = (section[i]! << 8) | section[i + 1]!;
    const pid = ((section[i + 2]! & 0x1f) << 8) | section[i + 3]!;
    if (program !== 0) return pid;
  }
  return undefined;
}

/** stream_type de vídeo que se pueden ver en una PMT pero no decodificamos. */
const OTHER_VIDEO_STREAM_TYPES = new Set([0x01, 0x02, 0x10, 0x42, 0xd1, 0xea]);

/** stream_type de audio que decodeAudioData sabe decodificar sin contenedor. */
const AUDIO_STREAM_TYPES = new Map<number, AudioCodec>([
  [0x0f, "aac"], // AAC en ADTS
  [0x03, "mp3"], // MPEG-1 audio
  [0x04, "mp3"], // MPEG-2 audio
]);

function parsePmt(payload: Uint8Array): {
  video?: { pid: number; codec: VideoCodec };
  audio?: { pid: number; codec: AudioCodec };
  unsupportedVideoType?: number;
} {
  const section = payload.subarray(1 + payload[0]!);
  const sectionLength = ((section[1]! & 0x0f) << 8) | section[2]!;
  const end = Math.min(3 + sectionLength - 4, section.length);
  const programInfoLength = ((section[10]! & 0x0f) << 8) | section[11]!;
  let video: { pid: number; codec: VideoCodec } | undefined;
  let audio: { pid: number; codec: AudioCodec } | undefined;
  let unsupportedVideoType: number | undefined;
  for (let i = 12 + programInfoLength; i + 5 <= end; ) {
    const streamType = section[i]!;
    const pid = ((section[i + 1]! & 0x1f) << 8) | section[i + 2]!;
    const esInfoLength = ((section[i + 3]! & 0x0f) << 8) | section[i + 4]!;
    if (!video && streamType === 0x1b) video = { pid, codec: "h264" };
    else if (!video && streamType === 0x24) video = { pid, codec: "h265" };
    else if (OTHER_VIDEO_STREAM_TYPES.has(streamType)) unsupportedVideoType ??= streamType;
    const audioCodec = AUDIO_STREAM_TYPES.get(streamType);
    if (!audio && audioCodec) audio = { pid, codec: audioCodec };
    i += 5 + esInfoLength;
  }
  return {
    ...(video ? { video } : {}),
    ...(audio ? { audio } : {}),
    ...(!video && unsupportedVideoType !== undefined ? { unsupportedVideoType } : {}),
  };
}

function readPts(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! >> 1) & 0x07) * 2 ** 30 +
    ((bytes[at + 1]! << 7) | (bytes[at + 2]! >> 1)) * 2 ** 15 +
    ((bytes[at + 3]! << 7) | (bytes[at + 4]! >> 1))
  );
}

function parsePesHeader(payload: Uint8Array): { pts?: number; dataStart: number } {
  if (payload.length < 9 || payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) {
    return { dataStart: payload.length }; // no es un PES válido: sin datos útiles
  }
  const flags = payload[7]!;
  const headerLength = payload[8]!;
  const dataStart = 9 + headerLength;
  if (flags & 0x80 && payload.length >= 14) return { pts: readPts(payload, 9), dataStart };
  return { dataStart };
}

function joinChunks(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!.slice();
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Trocea un flujo Annex B en NAL units (sin los códigos de inicio). */
export function annexBNalUnits(data: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && data[end - 1] === 0) end--; // ceros de un código de inicio de 4 bytes / relleno
        nals.push(data.subarray(start, end));
      }
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < data.length) nals.push(data.subarray(start));
  return nals;
}

function nalType(nal: Uint8Array, codec: VideoCodec): number {
  return codec === "h264" ? nal[0]! & 0x1f : (nal[0]! >> 1) & 0x3f;
}

/** IDR en H.264 (5); IRAP en HEVC (16-21: BLA/IDR/CRA). Solo esos sirven de punto de entrada para WebCodecs. */
function isKeyframeNal(nal: Uint8Array, codec: VideoCodec): boolean {
  if (nal.length === 0) return false;
  const type = nalType(nal, codec);
  return codec === "h264" ? type === 5 : type >= 16 && type <= 21;
}

function isSpsNal(nal: Uint8Array, codec: VideoCodec): boolean {
  if (nal.length < 4) return false;
  return nalType(nal, codec) === (codec === "h264" ? 7 : 33);
}

/** Duración = distancia al siguiente en orden de presentación; la última hereda la más común. */
function fillDurations(samples: DemuxedSample[]): void {
  const byPts = [...samples].sort((a, b) => a.cts - b.cts);
  const counts = new Map<number, number>();
  for (let i = 0; i < byPts.length - 1; i++) {
    const duration = byPts[i + 1]!.cts - byPts[i]!.cts;
    byPts[i]!.duration = duration;
    counts.set(duration, (counts.get(duration) ?? 0) + 1);
  }
  let typical = 3003; // 29,97 fps a 90 kHz
  let best = 0;
  for (const [duration, count] of counts) {
    if (duration > 0 && count > best) {
      best = count;
      typical = duration;
    }
  }
  byPts[byPts.length - 1]!.duration = typical;
}
