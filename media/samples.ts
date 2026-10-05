import { createFile, MP4BoxBuffer, type ISOFile, type Sample, type Track } from "mp4box";
import type { FrameRate } from "../core/time";
import { getDecoderDescription } from "./description";
import { demuxMatroska } from "./demuxMatroska";
import { demuxMpegTs, mpegTsPacketLayout } from "./demuxMpegTs";

/**
 * Una muestra comprimida (un fotograma codificado) de la pista de
 * vídeo. Es el subconjunto de `Sample` de mp4box.js que usa el resto
 * de /media: las muestras de mp4box encajan tal cual, y los demuxers
 * propios (Matroska/WebM, MPEG-TS) construyen objetos con esta misma
 * forma. `cts`/`duration` van en la escala `timescale` de la muestra.
 */
export interface DemuxedSample {
  cts: number;
  duration: number;
  timescale: number;
  is_sync: boolean;
  data?: Uint8Array;
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
 * Demuxa TODAS las muestras comprimidas de la primera pista de vídeo
 * de un archivo (metadatos + datos, sin decodificar). Para clips
 * cortos esto es aceptable: lo que se guarda en memoria sigue siendo
 * el flujo comprimido, no fotogramas decodificados. Si el proyecto
 * necesitara clips largos habría que pasar a extracción por streaming
 * en vez de cargar toda la tabla de muestras de una vez — eso queda
 * fuera de esta rebanada.
 *
 * Contenedores: MP4/MOV/M4V/3GP (mp4box.js), Matroska/WebM
 * (demuxMatroska) y MPEG-TS/M2TS (demuxMpegTs). Que el códec de dentro
 * se pueda decodificar lo comprueba checkDecodable aparte.
 */
export async function decodeAllSamples(file: File): Promise<DemuxedTrack> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const container = sniffContainer(bytes.subarray(0, 400));
  switch (container) {
    case "matroska":
      return demuxMatroska(bytes);
    case "mpegts":
      return demuxMpegTs(bytes);
    case "iso":
      return demuxIso(buffer);
    case "unknown":
      throw new Error(
        `Formato de archivo no soportado (${describeUnknownContainer(bytes)}). ` +
          `Se admiten MP4, MOV, M4V, 3GP, WebM, MKV y MPEG-TS (.ts/.mts/.m2ts).`,
      );
  }
}

function demuxIso(buffer: ArrayBuffer): Promise<DemuxedTrack> {
  return new Promise((resolve, reject) => {
    const isoFile: ISOFile = createFile();
    let videoTrack: Track | undefined;
    const samples: Sample[] = [];

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

  const firstKey = demuxed.samples.find((sample) => sample.is_sync && sample.data);
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
