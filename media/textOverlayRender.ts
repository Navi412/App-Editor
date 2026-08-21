import type { TextOverlay } from "../core/textOverlay";

/** Subconjunto de CanvasRenderingContext2D/OffscreenCanvasRenderingContext2D que necesitamos. */
export interface TextDrawTarget {
  font: string;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
}

/** Dibuja un overlay de texto centrado en (xPercent, yPercent) del frame, con un borde oscuro para que se lea sobre cualquier fondo. */
export function drawTextOverlay(
  ctx: TextDrawTarget,
  overlay: TextOverlay,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const x = (overlay.xPercent / 100) * canvasWidth;
  const y = (overlay.yPercent / 100) * canvasHeight;
  ctx.font = `bold ${overlay.fontSizePx}px ${overlay.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = Math.max(2, overlay.fontSizePx / 12);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
  ctx.strokeText(overlay.text, x, y);
  ctx.fillStyle = overlay.color;
  ctx.fillText(overlay.text, x, y);
}

export function drawTextOverlays(
  ctx: TextDrawTarget,
  overlays: TextOverlay[],
  canvasWidth: number,
  canvasHeight: number,
): void {
  for (const overlay of overlays) drawTextOverlay(ctx, overlay, canvasWidth, canvasHeight);
}
