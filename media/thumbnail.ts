import { createForwardFrameSeeker } from "./frameSeeker";
import { drawFrameFit } from "./render";
import type { DemuxedTrack } from "./samples";

const THUMBNAIL_WIDTH = 120;
const THUMBNAIL_HEIGHT = 68;

/**
 * Decodifica un único fotograma representativo de una fuente (por
 * defecto, cerca del principio) y lo devuelve como data URL PNG en
 * miniatura, para mostrar en los bloques de clip de la timeline. Un
 * decode de usar-y-tirar: crea su propio decoder y lo cierra al acabar.
 */
export async function generateThumbnail(
  demuxed: DemuxedTrack,
  atUs = 0,
): Promise<string> {
  const seeker = createForwardFrameSeeker(demuxed);
  try {
    const frame = await seeker.next(atUs);
    if (!frame) {
      throw new Error("No se pudo decodificar ningún fotograma para la miniatura");
    }
    const canvas = new OffscreenCanvas(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      frame.close();
      throw new Error("No se pudo crear el contexto 2D para la miniatura");
    }
    drawFrameFit(ctx, frame, { width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT });
    frame.close();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
    return await blobToDataUrl(blob);
  } finally {
    seeker.destroy();
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Error leyendo el blob de la miniatura"));
    reader.readAsDataURL(blob);
  });
}
