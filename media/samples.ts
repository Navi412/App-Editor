import { createFile, MP4BoxBuffer, type ISOFile, type Sample, type Track } from "mp4box";
import type { FrameRate } from "../core/time";
import { getDecoderDescription } from "./description";
import { demuxMatroska } from "./demuxMatroska";
import { demuxMpegTs, mpegTsPacketLayout } from "./demuxMpegTs";
import { byteSourceFromBlob, SampleDataLoader, type ByteSource } from "./sampleData";

/**
 * Una muestra comprimida (un fotograma codificado) de la pista de
 * vídeo. Es el subconjunto de `Sample` de mp4box.js que usa el resto
 * de /media: las muestras de mp4box encajan tal cual, y los demuxers
 * propios (Matroska/WebM, MPEG-TS) construyen objetos con esta misma
 * forma. `cts`/`duration` van en la escala `timescale` de la muestra.
 *
 * `data` puede faltar: en MP4 y Matroska las muestras solo guardan
 * dónde están en el archivo (`offset`/`size`) y `DemuxedTrack.loader`
 * las lee del disco cuando hacen falta (ver media/sampleData.ts). Quien
 * decodifica llama antes a `ensureSampleData`.
 */
export interface DemuxedSample {
  cts: number;
  duration: number;
  timescale: number;
  is_sync: boolean;
  data?: Uint8Array;
  offset?: number;
  size?: number;
}

/** Igual que DemuxedSample: el subconjunto de `Track` de mp4box que usa /media. `duration` en `timescale`. */
export interface DemuxedVideoTrack {
  id: number;
  /** Cadena de códec de WebCodecs ("avc1.64001f", "vp09.00.50.08"...). */
  codec: string;
  timescale: number;
  duration: number;
  /** Ausente si el contenedor no la declara (MPEG-TS): se averigua decodificando el primer fotograma, ver checkDecodable. */
  video?: { width: number; height: number };
}

export interface DemuxedTrack {
  videoTrack: DemuxedVideoTrack;
  /** En orden de DECODIFICACIÓN (el del archivo), no de presentación. */
  samples: DemuxedSample[];
  /** VideoDecoderConfig.description (avcC/hvcC/av1C crudos). undefined = el códec no la usa, o el flujo va en Annex B con los parámetros en banda. */
  decoderDescription?: Uint8Array;
  /** Frame rate ya conocida por el demuxer (p.ej. DefaultDuration de Matroska); si falta se infiere de las duraciones de muestra (ver frameRateOf). */
  frameRate?: FrameRate;
  /** Lee del disco los bytes de las muestras bajo demanda. Ausente si todas traen ya `data` (MPEG-TS, tests). */
  loader?: SampleDataLoader;
}

/** Asegura que las muestras [from, to] (orden de decodificación) tienen sus bytes en memoria. */
export function ensureSampleData(demuxed: DemuxedTrack, from: number, to: number): Promise<void> {
  return demuxed.loader ? demuxed.loader.ensure(from, to) : Promise.resolve();
}

/** Contenedores que sabemos leer. Los códecs dentro de ellos son los que WebCodecs decodifique en esta máquina. */
export const SUPPORTED_VIDEO_EXTENSIONS = [".mp4", ".m4v", ".mov", ".3gp", ".webm", ".mkv", ".ts", ".mts", ".m2ts"];

/** Valor para el atributo `accept` de los `<input type=file>` de vídeo. */
export const VIDEO_FILE_ACCEPT = ["video/*", ...SUPPORTED_VIDEO_EXTENSIONS].join(",");

/** Coletilla común de los mensajes de "códec no soportado". */
const SUPPORTED_CODECS_HINT = "Se admiten H.264, H.265/HEVC (si la GPU lo soporta), VP8, VP9 y AV1.";

type ContainerKind = "iso" | "matroska" | "mpegts" | "unknown";

/** Reconoce el contenedor por sus primeros bytes (la extensión miente a menudo: .mp4 que son WebM, .mov que son MP4...). */
export function sniffContainer(head: Uint8Array): ContainerKind {
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "matroska";
  if (mpegTsPacketLayout(head)) return "mpegts";
  // ISO BMFF / QuickTime: [tamaño 4 bytes][tipo de caja 4 bytes].
  const type = String.fromCharCode(...head.subarray(4, 8));
  if (["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot", "uuid"].includes(type)) return "iso";
  return "unknown";
}

function describeUnknownContainer(head: Uint8Array): string {
  const ascii = String.fromCharCode(...head.subarray(0, 4));
  if (ascii === "RIFF") return "AVI";
  if (head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01 && head[3] === 0xba) return "MPEG-PS (.mpg/.vob)";
  if (head[0] === 0x30 && head[1] === 0x26 && head[2] === 0xb2 && head[3] === 0x75) return "ASF/WMV";
  if (ascii === "FLV\u0001") return "FLV";
  return "desconocido";
}

/**
 * Lee la tabla de muestras de la primera pista de vídeo de un archivo
 * (tiempos, keyframes y dónde está cada fotograma), sin decodificar.
 * Los bytes de las muestras NO se cargan aquí (salvo en MPEG-TS, donde
 * cada fotograma está repartido en paquetes y hay que reensamblarlo):
 * los lee el `loader` bajo demanda, así que un vídeo de 1 GB no ocupa
 * 1 GB de memoria.
 *
 * `source` permite leer por ruta en Electron (proyectos reabiertos) sin
 * crear un File en memoria; por defecto se lee el propio `file` (un File
 * del selector o de arrastrar está respaldado por disco).
 *
 * Contenedores: MP4/MOV/M4V/3GP (mp4box.js), Matroska/WebM
 * (demuxMatroska) y MPEG-TS/M2TS (demuxMpegTs). Que el códec de dentro
 * se pueda decodificar lo comprueba checkDecodable aparte.
 */
export async function decodeAllSamples(file: Blob, source: ByteSource = byteSourceFromBlob(file)): Promise<DemuxedTrack> {
  const head = await source.read(0, Math.min(400, source.size));
  switch (sniffContainer(head)) {
    case "matroska":
      return demuxMatroska(source);
    case "mpegts":
      return demuxMpegTs(await source.read(0, source.size));
    case "iso":
      return demuxIso(source);
    case "unknown":
      throw new Error(
        `Formato de archivo no soportado (${describeUnknownContainer(head)}). ` +
          `Se admiten MP4, MOV, M4V, 3GP, WebM, MKV y MPEG-TS (.ts/.mts/.m2ts).`,
      );
  }
}

/** Cajas de nivel superior de un ISO BMFF: [tipo, posición, tamaño]. Solo lee sus cabeceras. */
async function topLevelBoxes(source: ByteSource): Promise<Array<{ type: string; start: number; size: number }>> {
  const boxes: Array<{ type: string; start: number; size: number }> = [];
  for (let pos = 0; pos + 8 <= source.size; ) {
    const header = await source.read(pos, Math.min(pos + 16, source.size));
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    let size = view.getUint32(0);
    const type = String.fromCharCode(...header.subarray(4, 8));
    if (size === 1 && header.length >= 16) size = Number(view.getBigUint64(8));
    else if (size === 0) size = source.size - pos;
    if (size < 8) break; // archivo corrupto: se deja de recorrer
    boxes.push({ type, start: pos, size });
    pos += size;
  }
  return boxes;
}

/**
 * MP4/MOV sin leer el `mdat`: se le da a mp4box solo el resto de cajas
 * (ftyp + moov, unos pocos KB/MB) y se toma la tabla de muestras que
 * construye a partir del moov — cada muestra trae su `offset`/`size`
 * absolutos en el archivo (los de la tabla stco/stsz), que es justo lo
 * que necesita el loader. Los MP4 fragmentados (moof, p.ej. el "MP4
 * fragmentado" de OBS) reparten la tabla por todo el archivo: para
 * esos se mantiene la lectura completa de siempre.
 */
async function demuxIso(source: ByteSource): Promise<DemuxedTrack> {
  const boxes = await topLevelBoxes(source);
  const fragmented = boxes.some((box) => box.type === "moof");
  const hasMoov = boxes.some((box) => box.type === "moov");
  if (fragmented || !hasMoov) {
    const all = await source.read(0, source.size);
    return parseIso(all.slice().buffer, false);
  }
  const kept = boxes.filter((box) => box.type !== "mdat");
  const total = kept.reduce((sum, box) => sum + box.size, 0);
  const metadata = new Uint8Array(total);
  let offset = 0;
  for (const box of kept) {
    metadata.set(await source.read(box.start, box.start + box.size), offset);
    offset += box.size;
  }
  const demuxed = await parseIso(metadata.buffer, true);
  return { ...demuxed, loader: new SampleDataLoader(source, demuxed.samples) };
}

/**
 * La edit list (elst) de un MP4 dice en qué instante de la pista empieza
 * de verdad la presentación. Con B-frames, los codificadores retrasan
 * todos los cts unos fotogramas y lo compensan con `media_time` (p.ej.
 * 2002/30000 = 2 fotogramas en x264). Sin aplicarlo, el tiempo de
 * fuente 0 caía 2 fotogramas antes del primer fotograma real: el vídeo
 * iba por detrás del audio (que decodeAudioData sí entrega alineado) en
 * casi cualquier MP4 H.264 de móvil, cámara u OBS. Se toma la primera
 * entrada no vacía; los retrasos iniciales (entradas vacías, rarísimos)
 * se ignoran.
 */
function applyEditListOffset(track: Track, samples: Sample[]): void {
  const edit = track.edits?.find((entry) => entry.media_time >= 0);
  if (!edit || edit.media_time <= 0) return;
  for (const sample of samples) {
    // media_time va en la escala de la pista, igual que cts/dts.
    sample.cts -= edit.media_time;
    sample.dts -= edit.media_time;
  }
}

/** `lazy`: el buffer solo tiene metadatos — se toma la tabla de muestras del moov en vez de extraerlas con sus datos. */
function parseIso(buffer: ArrayBuffer, lazy: boolean): Promise<DemuxedTrack> {
  return new Promise((resolve, reject) => {
    const isoFile: ISOFile = createFile();
    let videoTrack: Track | undefined;
    let samples: Sample[] = [];

    isoFile.onError = (module, message) => {
      reject(new Error(`mp4box (${module}): ${message}`));
    };

    isoFile.onReady = (info) => {
      videoTrack = info.videoTracks[0];
      if (!videoTrack) {
        // mp4box deja fuera de videoTracks las pistas de códec que no
        // conoce (ProRes, DNxHD...), pero siguen en `tracks` con el ancho de la pista.
        const unknownVideo = info.tracks.find((track) => track.track_width > 0);
        reject(
          new Error(
            unknownVideo
              ? `El vídeo usa el códec ${codecLabel(unknownVideo.codec)}, que no se puede decodificar. ${SUPPORTED_CODECS_HINT}`
              : "El archivo no contiene ninguna pista de vídeo",
          ),
        );
        return;
      }
      if (lazy) {
        // La tabla completa ya está construida a partir del moov (offset,
        // size, cts, is_sync, description), sin datos.
        samples = (isoFile.getTrackById(videoTrack.id) as unknown as { samples: Sample[] }).samples;
        return;
      }
      // Sin nbSamples: extrae toda la pista (en lotes internos de
      // mp4box.js), todos entregados de forma síncrona más abajo
      // porque el archivo entero ya está en el buffer que se le pasa.
      isoFile.setExtractionOptions(videoTrack.id);
      isoFile.start();
    };

    isoFile.onSamples = (_id, _user, newSamples) => {
      samples.push(...newSamples);
    };

    const mp4boxBuffer = MP4BoxBuffer.fromArrayBuffer(buffer, 0);
    isoFile.appendBuffer(mp4boxBuffer);
    isoFile.flush();
    if (!videoTrack) {
      reject(new Error("No se pudo leer la pista de vídeo"));
      return;
    }
    applyEditListOffset(videoTrack, samples);
    const firstSample = samples[0];
    const decoderDescription = firstSample ? getDecoderDescription(firstSample) : undefined;
    resolve({ videoTrack, samples, ...(decoderDescription ? { decoderDescription } : {}) });
  });
}

/**
 * La parte común del VideoDecoderConfig de una fuente — el player en
 * vivo, el seeker de exportación y checkDecodable añaden encima solo
 * sus preferencias de aceleración.
 */
export function baseDecoderConfig(demuxed: DemuxedTrack): VideoDecoderConfig {
  const { videoTrack, decoderDescription } = demuxed;
  return {
    codec: videoTrack.codec,
    ...(decoderDescription ? { description: decoderDescription } : {}),
    ...(videoTrack.video && videoTrack.video.width > 0 && videoTrack.video.height > 0
      ? { codedWidth: videoTrack.video.width, codedHeight: videoTrack.video.height }
      : {}),
  };
}

/** Nombre legible del códec para los mensajes de error ("avc1.64001f" → "H.264"). */
function codecLabel(codec: string): string {
  const family = codec.split(".")[0]!;
  const labels: Record<string, string> = {
    avc1: "H.264",
    avc3: "H.264",
    hvc1: "H.265/HEVC",
    hev1: "H.265/HEVC",
    vp8: "VP8",
    vp09: "VP9",
    av01: "AV1",
    apch: "ProRes",
    apcn: "ProRes",
    apcs: "ProRes",
    apco: "ProRes",
    ap4h: "ProRes 4444",
    mp4v: "MPEG-4 Part 2",
    jpeg: "Motion JPEG",
    mjpa: "Motion JPEG",
    AVdn: "DNxHD",
    AVdh: "DNxHR",
  };
  return labels[family] ?? codec;
}

/**
 * Falla pronto y con un mensaje claro si esta máquina no puede
 * decodificar el códec de la fuente, en vez de añadir un clip que
 * luego fallará en silencio al reproducirlo o exportarlo. Si el
 * contenedor no declara el tamaño (MPEG-TS), decodifica el primer
 * keyframe para averiguarlo — devuelve la fuente con `video` relleno.
 */
export async function checkDecodable(demuxed: DemuxedTrack): Promise<DemuxedTrack> {
  if (demuxed.samples.length === 0) {
    throw new Error("El archivo no tiene ningún fotograma de vídeo");
  }
  const config = baseDecoderConfig(demuxed);
  const support = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!support.supported) {
    throw new Error(
      `El vídeo usa el códec ${codecLabel(demuxed.videoTrack.codec)}, que este equipo no puede decodificar. ` +
        SUPPORTED_CODECS_HINT,
    );
  }
  if (demuxed.videoTrack.video && demuxed.videoTrack.video.width > 0) return demuxed;

  const firstKeyIndex = demuxed.samples.findIndex((sample) => sample.is_sync);
  if (firstKeyIndex >= 0) await ensureSampleData(demuxed, firstKeyIndex, firstKeyIndex);
  const firstKey = demuxed.samples[firstKeyIndex];
  if (!firstKey?.data) throw new Error("El vídeo no tiene ningún fotograma clave");
  const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    let settled = false;
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (!settled) {
          settled = true;
          resolve({ width: frame.displayWidth, height: frame.displayHeight });
        }
        frame.close();
      },
      error: (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      },
    });
    decoder.configure(config);
    decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data: firstKey.data! }));
    decoder
      .flush()
      .then(() => {
        if (!settled) {
          settled = true;
          reject(new Error("No se pudo decodificar el primer fotograma del vídeo"));
        }
      })
      .catch((error: unknown) => {
        if (!settled) {
          settled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })
      .finally(() => {
        if (decoder.state !== "closed") decoder.close();
      });
  });
  return { ...demuxed, videoTrack: { ...demuxed.videoTrack, video: size } };
}

/** H.265/HEVC: Chromium solo lo decodifica por hardware/SO, nunca por software. */
export function isHevcCodec(codec: string): boolean {
  return codec.startsWith("hvc1") || codec.startsWith("hev1");
}
