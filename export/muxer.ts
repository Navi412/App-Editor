import { createFile, type Box, type ISOFile } from "mp4box";

export interface Mp4MuxerOptions {
  width: number;
  height: number;
  /**
   * Timescale de la pista de vídeo de salida, en unidades por segundo.
   * Se usa 1_000_000 (microsegundos) para que los timestamps/duraciones
   * de WebCodecs (ya en microsegundos) se puedan pasar tal cual, sin
   * convertir a otra escala.
   */
  timescale: number;
  /** Duración total esperada, en unidades de `timescale`. Solo se usa para declarar duration/media_duration en la pista — no afecta la muxación en sí. */
  durationUnits?: number;
  /** Códec de la pista de vídeo (por defecto H.264): decide la caja de configuración (avcC/hvcC). */
  videoCodec?: "avc" | "hevc";
}

export interface Mp4Muxer {
  addChunk(chunk: EncodedVideoChunk, metadata: EncodedVideoChunkMetadata | undefined): void;
  addAudioChunk(chunk: EncodedAudioChunk, metadata: EncodedAudioChunkMetadata | undefined): void;
  /** Cierra el archivo y devuelve el MP4 resultante. Un único uso: no se puede seguir añadiendo después. */
  finalize(): Blob;
}

/**
 * Envuelve la API de "creación" de mp4box.js (addTrack/addSample) para
 * construir un MP4 nuevo a partir de los EncodedVideoChunk/EncodedAudioChunk
 * que emiten VideoEncoder/AudioEncoder. No es una concatenación de
 * archivos de origen — ver DESIGN.md §5 sobre por qué eso no serviría.
 */
export function createMp4Muxer(options: Mp4MuxerOptions): Mp4Muxer {
  const isoFile: ISOFile = createFile();
  let videoTrackId: number | undefined;
  let audioTrackId: number | undefined;
  /** Timescale de la pista de audio (= su frecuencia de muestreo). */
  let audioTimescale = 0;

  function ensureVideoTrack(description: ArrayBuffer): number {
    if (videoTrackId !== undefined) return videoTrackId;
    const hevc = options.videoCodec === "hevc";
    const id = isoFile.addTrack({
      timescale: options.timescale,
      width: options.width,
      height: options.height,
      ...(hevc ? { hevcDecoderConfigRecord: description } : { avcDecoderConfigRecord: description }),
      type: hevc ? "hvc1" : "avc1",
      name: "App Video export — vídeo",
      duration: options.durationUnits ?? 0,
      media_duration: options.durationUnits ?? 0,
    });
    if (id === undefined) {
      throw new Error("mp4box.js no pudo crear la pista de vídeo de salida (¿códec no soportado?)");
    }
    videoTrackId = id;
    return id;
  }

  function ensureAudioTrack(description: ArrayBuffer, sampleRate: number, channelCount: number): number {
    if (audioTrackId !== undefined) return audioTrackId;
    const id = isoFile.addTrack({
      timescale: sampleRate,
      type: "mp4a",
      // Sin esto mp4box declara la pista como "vide" (su valor por
      // defecto): reproductores y decodeAudioData la tomaban por vídeo.
      hdlr: "soun",
      name: "App Video export — audio",
      channel_count: channelCount,
      samplerate: sampleRate,
      samplesize: 16,
      description: buildEsdsBox(new Uint8Array(description)) as unknown as Box,
    });
    if (id === undefined) {
      throw new Error("mp4box.js no pudo crear la pista de audio de salida (¿códec no soportado?)");
    }
    audioTrackId = id;
    audioTimescale = sampleRate;
    return id;
  }

  return {
    addChunk(chunk, metadata) {
      const description = metadata?.decoderConfig?.description;
      if (description) {
        ensureVideoTrack(toArrayBuffer(description));
      }
      if (videoTrackId === undefined) {
        throw new Error(
          "El primer fotograma de vídeo codificado no trae la configuración del decodificador (avcC/hvcC)",
        );
      }

      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      isoFile.addSample(videoTrackId, data, {
        duration: chunk.duration ?? 0,
        cts: chunk.timestamp,
        dts: chunk.timestamp,
        is_sync: chunk.type === "key",
      });
    },
    addAudioChunk(chunk, metadata) {
      const config = metadata?.decoderConfig;
      if (config?.description) {
        ensureAudioTrack(toArrayBuffer(config.description), config.sampleRate, config.numberOfChannels);
      }
      if (audioTrackId === undefined) {
        throw new Error(
          "El primer fotograma de audio codificado no trae la configuración del decodificador (AudioSpecificConfig)",
        );
      }

      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      // La pista de audio va en la escala de su frecuencia de muestreo
      // (como cualquier MP4 de AAC), pero WebCodecs da timestamp/duración
      // en microsegundos. Antes se pasaban tal cual: el audio quedaba
      // declarado ~20 veces más largo de lo que era y con duración 0, y
      // decodeAudioData (entre otros) rechazaba el archivo exportado.
      const toTrackUnits = (us: number) => Math.round((us * audioTimescale) / 1_000_000);
      isoFile.addSample(audioTrackId, data, {
        duration: toTrackUnits(chunk.duration ?? 0),
        cts: toTrackUnits(chunk.timestamp),
        dts: toTrackUnits(chunk.timestamp),
        is_sync: true, // AAC: todas las muestras son autocontenidas
      });
    },
    finalize(): Blob {
      const buffer = isoFile.getBuffer().buffer;
      return new Blob([buffer], { type: "video/mp4" });
    },
  };
}

function toArrayBuffer(source: AllowSharedBufferSource): ArrayBuffer {
  if (source instanceof ArrayBuffer) return source;
  if (ArrayBuffer.isView(source)) {
    return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
  }
  throw new Error("No se pudo leer la configuración del decodificador (SharedArrayBuffer no soportado)");
}

/**
 * mp4box.js no tiene, para audio, un atajo equivalente a
 * `avcDecoderConfigRecord` — hay que construir la caja `esds`
 * (ElementaryStreamDescriptor, ISO/IEC 14496-1) a mano: un
 * ES_Descriptor con un DecoderConfigDescriptor (que envuelve el
 * AudioSpecificConfig que ya nos da AudioEncoder) y un
 * SLConfigDescriptor mínimo. Los tamaños de nuestros descriptores caben
 * siempre en un byte de longitud (<128), así que no hace falta la
 * codificación de longitud multi-byte del formato.
 *
 * Se expone como un objeto con `type`/`write()` — el mínimo que
 * `addBox` de mp4box.js necesita para tratarlo como una caja hija más
 * dentro de la entrada de la pista de audio.
 */
function buildEsdsBox(audioSpecificConfig: Uint8Array): {
  type: "esds";
  size: number;
  write(stream: { writeUint8Array(a: Uint8Array): void }): void;
} {
  const decoderSpecificInfo = [0x05, audioSpecificConfig.length, ...audioSpecificConfig];

  const avgBitrate = 128_000;
  const maxBitrate = 128_000;
  const decoderConfigContent = [
    0x40, // objectTypeIndication: Audio ISO/IEC 14496-3 (AAC)
    0x15, // streamType(5, audio) << 2 | upStream(0) << 1 | reserved(1)
    0x00,
    0x00,
    0x00, // bufferSizeDB (24 bits) — no lo declaramos con precisión
    ...uint32Bytes(maxBitrate),
    ...uint32Bytes(avgBitrate),
    ...decoderSpecificInfo,
  ];
  const decoderConfigDescriptor = [0x04, decoderConfigContent.length, ...decoderConfigContent];

  const slConfigDescriptor = [0x06, 0x01, 0x02]; // predefined = 0x02 ("MP4 file")

  const esDescriptorContent = [
    0x00,
    0x00, // ES_ID
    0x00, // flags
    ...decoderConfigDescriptor,
    ...slConfigDescriptor,
  ];
  const esDescriptor = [0x03, esDescriptorContent.length, ...esDescriptorContent];

  // FullBox: size(4) + type(4) + version(1) + flags(3) + payload
  const payload = [0x00, 0x00, 0x00, 0x00, ...esDescriptor];
  const size = 8 + payload.length;
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(0, size);
  bytes.set([0x65, 0x73, 0x64, 0x73], 4); // "esds"
  bytes.set(payload, 8);

  return {
    type: "esds",
    size: bytes.length,
    write(stream) {
      this.size = bytes.length;
      stream.writeUint8Array(bytes);
    },
  };
}

function uint32Bytes(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
