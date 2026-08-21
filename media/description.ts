import { DataStream, Endianness, type Sample } from "mp4box";

/**
 * mp4box.js no exporta tipos públicos para las cajas de configuración
 * de códec (avcC/hvcC) — solo expone el árbol de cajas completo
 * internamente. Esta es la única interfaz local del proyecto que
 * describe, de forma estructural, la parte de esa caja que
 * necesitamos (un método write compatible con DataStream). Es el
 * único cast "de borde" en /media — ver CLAUDE.md.
 */
interface DecoderConfigBox {
  write(stream: DataStream): void;
}

interface SampleEntryWithConfigBox {
  avcC?: DecoderConfigBox;
  hvcC?: DecoderConfigBox;
}

/**
 * Extrae los bytes de configuración del decodificador
 * (AVCDecoderConfigurationRecord o HEVCDecoderConfigurationRecord) que
 * WebCodecs necesita en VideoDecoderConfig.description. Se obtienen
 * serializando la caja avcC/hvcC de la muestra y descartando su
 * cabecera de caja (8 bytes: tamaño + fourcc), ya que WebCodecs quiere
 * el registro "en crudo", no la caja ISOBMFF completa.
 */
export function getDecoderDescription(sample: Sample): Uint8Array {
  const entry = sample.description as unknown as SampleEntryWithConfigBox;
  const box = entry.avcC ?? entry.hvcC;
  if (!box) {
    throw new Error(
      "La pista no tiene una caja avcC/hvcC — códec no soportado en esta rebanada (solo H.264/H.265)",
    );
  }
  const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
  box.write(stream);
  return new Uint8Array(stream.buffer, 8);
}
