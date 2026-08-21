import { frameDurationTicks, ticksToSeconds } from "../core/time";
import { neighborsOfTransition } from "../core/timeline";
import type { Clip, Track, TransitionType } from "../core/types";
import { captureFrameBitmap } from "./frameSnapshot";
import type { DemuxedTrack } from "./samples";
import { inferFrameRate } from "./sourceFile";

/**
 * Fotogramas fijos que delimitan una transición: el último fotograma
 * decodificable del clip anterior de su pista y el primero del
 * siguiente (por posición, no por relación guardada — ver
 * neighborsOfTransition en core/timeline.ts). undefined si ese lado no
 * tiene vecino real (p.ej. transición al principio/final de la pista,
 * o separada de su vecino por un hueco).
 */
export interface TransitionBoundaryFrames {
  fromImage?: ImageBitmap;
  toImage?: ImageBitmap;
}

/**
 * Decodifica el fotograma de salida (justo antes de sourceOutTicks del
 * clip anterior) y el de entrada (justo en sourceInTicks del clip
 * siguiente) de `transitionClip`, dentro de `track`. No cachea nada —
 * se decodifica de cero cada vez que hace falta (al hacer scrub,
 * reproducir o exportar), así nunca puede quedar obsoleto tras editar
 * los clips vecinos.
 */
export async function captureTransitionBoundaryFrames(
  track: Track,
  transitionClip: Clip,
  getSource: (sourceId: string) => DemuxedTrack | undefined,
  width: number,
  height: number,
): Promise<TransitionBoundaryFrames> {
  const { prev: prevClip, next: nextClip } = neighborsOfTransition(track, transitionClip);

  let fromImage: ImageBitmap | undefined;
  if (prevClip) {
    const demuxed = getSource(prevClip.sourceId);
    if (demuxed) {
      const frameStep = frameDurationTicks(inferFrameRate(demuxed.samples, demuxed.videoTrack.timescale));
      const atTicks = Math.max(prevClip.sourceInTicks, prevClip.sourceOutTicks - frameStep);
      fromImage = await captureFrameBitmap(demuxed, Math.round(ticksToSeconds(atTicks) * 1_000_000), width, height);
    }
  }

  let toImage: ImageBitmap | undefined;
  if (nextClip) {
    const demuxed = getSource(nextClip.sourceId);
    if (demuxed) {
      toImage = await captureFrameBitmap(
        demuxed,
        Math.round(ticksToSeconds(nextClip.sourceInTicks) * 1_000_000),
        width,
        height,
      );
    }
  }

  return {
    ...(fromImage ? { fromImage } : {}),
    ...(toImage ? { toImage } : {}),
  };
}

/** Subconjunto de CanvasRenderingContext2D/OffscreenCanvasRenderingContext2D que necesitamos para el fundido. */
export interface TransitionDrawTarget {
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
  globalAlpha: number;
}

/**
 * Dibuja un fotograma de la transición en `progress` (0 al empezar, 1
 * al terminar). "crossfade": disuelve linealmente fromImage→toImage.
 * "dipToBlack": funde a negro en la primera mitad, funde desde negro
 * en la segunda — la versión "básica" pedida, sin decodificar más
 * fotogramas que los dos fijos ya capturados.
 */
export function drawTransitionFrame(
  ctx: TransitionDrawTarget,
  width: number,
  height: number,
  transitionType: TransitionType,
  frames: TransitionBoundaryFrames,
  progress: number,
): void {
  ctx.clearRect(0, 0, width, height);
  const p = Math.max(0, Math.min(1, progress));

  if (transitionType === "dipToBlack") {
    if (p < 0.5) {
      const alpha = 1 - p / 0.5;
      if (frames.fromImage && alpha > 0) {
        ctx.globalAlpha = alpha;
        ctx.drawImage(frames.fromImage, 0, 0, width, height);
        ctx.globalAlpha = 1;
      }
    } else {
      const alpha = (p - 0.5) / 0.5;
      if (frames.toImage && alpha > 0) {
        ctx.globalAlpha = alpha;
        ctx.drawImage(frames.toImage, 0, 0, width, height);
        ctx.globalAlpha = 1;
      }
    }
    return;
  }

  // crossfade
  if (frames.fromImage) {
    ctx.globalAlpha = 1 - p;
    ctx.drawImage(frames.fromImage, 0, 0, width, height);
  }
  if (frames.toImage) {
    ctx.globalAlpha = p;
    ctx.drawImage(frames.toImage, 0, 0, width, height);
  }
  ctx.globalAlpha = 1;
}
