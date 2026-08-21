import type { ColorFilterType } from "../core/types";

export interface Size {
  width: number;
  height: number;
}

export interface FitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Rectángulo destino para dibujar `source` dentro de `target`
 * manteniendo su relación de aspecto (aspect-fit / letterbox), nunca
 * estirado. Ver DESIGN.md §4. Es pura — sin DOM — para poder testearla
 * sin canvas real; el trazo real vive en drawFrameFit más abajo.
 */
export function computeFitRect(source: Size, target: Size): FitRect {
  if (source.width <= 0 || source.height <= 0) {
    return { x: 0, y: 0, width: target.width, height: target.height };
  }
  const scale = Math.min(target.width / source.width, target.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  return { x: (target.width - width) / 2, y: (target.height - height) / 2, width, height };
}

/** Subconjunto de CanvasRenderingContext2D/OffscreenCanvasRenderingContext2D que necesitamos. */
export interface FrameDrawTarget {
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
  filter: string;
}

const COLOR_FILTER_CSS: Record<ColorFilterType, string> = {
  grayscale: "grayscale(1)",
  sepia: "sepia(0.85)",
  invert: "invert(1)",
  warm: "sepia(0.35) saturate(1.4) brightness(1.05)",
  cool: "hue-rotate(180deg) saturate(1.15)",
  highContrast: "contrast(1.6) saturate(1.15)",
};

/** Valor de `ctx.filter`/CSS `filter` para un ColorFilterType, o "none" sin filtro. Preview y exportación comparten esta misma función para no poder divergir en qué se ve. */
export function colorFilterCss(colorFilter: ColorFilterType | undefined): string {
  return colorFilter ? COLOR_FILTER_CSS[colorFilter] : "none";
}

/** Pinta un VideoFrame en `ctx` con aspect-fit sobre el tamaño `target`, con barras negras si hace falta, aplicando `colorFilter` si se indica. */
export function drawFrameFit(
  ctx: FrameDrawTarget,
  frame: VideoFrame,
  target: Size,
  colorFilter?: ColorFilterType,
): void {
  ctx.clearRect(0, 0, target.width, target.height);
  const rect = computeFitRect({ width: frame.displayWidth, height: frame.displayHeight }, target);
  ctx.filter = colorFilterCss(colorFilter);
  ctx.drawImage(frame, rect.x, rect.y, rect.width, rect.height);
  ctx.filter = "none";
}
