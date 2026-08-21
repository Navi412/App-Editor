import { createForwardFrameSeeker } from "./frameSeeker";
import { drawFrameFit } from "./render";
import type { DemuxedTrack } from "./samples";

/**
 * Decodifica un único fotograma de `demuxed` en el instante `atUs` (µs
 * de tiempo de fuente) y lo devuelve ya compuesto con aspect-fit sobre
 * un lienzo de `width`x`height` — listo para usarse como imagen fija
 * (p.ej. en un fundido de transición, ver transitionRender.ts). Un
 * decode de usar-y-tirar, igual que generateThumbnail pero
 * parametrizado en tamaño y devolviendo un ImageBitmap en vez de un
 * data URL.
 */
export async function captureFrameBitmap(
  demuxed: DemuxedTrack,
  atUs: number,
  width: number,
  height: number,
): Promise<ImageBitmap | undefined> {
  const seeker = createForwardFrameSeeker(demuxed);
  try {
    const frame = await seeker.next(atUs);
    if (!frame) return undefined;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      frame.close();
      return undefined;
    }
    drawFrameFit(ctx, frame, { width, height });
    frame.close();
    return canvas.transferToImageBitmap();
  } finally {
    seeker.destroy();
  }
}
