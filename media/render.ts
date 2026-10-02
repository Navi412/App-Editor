import { NEUTRAL_COLOR_GRADE, type ChromaKey, type Clip, type ColorFilterType, type ColorGrade, type LutAsset } from "../core/types";
import { needsColorGradeGL, type ColorGradeRenderer, type ResolvedLut } from "./colorGradeGL";

/**
 * Todo lo que decide el aspecto de los fotogramas de un clip: preset CSS,
 * grading real, croma y LUT 3D ya resuelta desde el registro del
 * proyecto. Agrupado en un objeto (2026-10-02) en vez de un parámetro
 * suelto más por cada ampliación de color.
 */
export interface FrameLook {
  colorFilter?: ColorFilterType | undefined;
  colorGrade?: ColorGrade | undefined;
  chromaKey?: ChromaKey | undefined;
  lut?: ResolvedLut | undefined;
}

/** Aspecto de un clip, resolviendo su `lut` (si la tiene) contra el registro `luts` de la timeline. */
export function lookForClip(clip: Clip, luts: LutAsset[] | undefined): FrameLook {
  const asset = clip.lut ? luts?.find((l) => l.id === clip.lut!.lutId) : undefined;
  return {
    colorFilter: clip.colorFilter,
    colorGrade: clip.colorGrade,
    chromaKey: clip.chromaKey,
    lut: asset && clip.lut ? { asset, intensity: clip.lut.intensity } : undefined,
  };
}

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

/**
 * Pinta un VideoFrame en `ctx` con aspect-fit sobre el tamaño `target`,
 * con barras negras si hace falta, aplicando `look.colorFilter` (preset
 * CSS, de siempre) y opcionalmente grading/croma/LUT (grading real +
 * croma vía WebGL, ver media/colorGradeGL.ts — ampliación de alcance
 * del 2026-08-29). El grading se aplica ANTES del filtro CSS (orden
 * fijo, nunca al revés): si no hay `gradeRenderer` o ni `colorGrade` ni
 * `chromaKey` cambiarían nada, se salta esa pasada entera y el coste es
 * exactamente el de siempre (un solo drawImage).
 *
 * `clear` (true por defecto) controla si se limpia `target` antes de
 * pintar — a false para componer ENCIMA de lo que ya haya en `ctx` (ver
 * export/exportTimeline.ts, que dibuja primero la capa de fondo de un
 * croma con `clear:true` y luego la capa recortada con `clear:false`).
 */
export function drawFrameFit(
  ctx: FrameDrawTarget,
  frame: VideoFrame,
  target: Size,
  look: FrameLook = {},
  gradeRenderer?: ColorGradeRenderer,
  clear: boolean = true,
): void {
  if (clear) ctx.clearRect(0, 0, target.width, target.height);
  const rect = computeFitRect({ width: frame.displayWidth, height: frame.displayHeight }, target);
  ctx.filter = colorFilterCss(look.colorFilter);
  const source =
    gradeRenderer && needsColorGradeGL(look.colorGrade, look.chromaKey, look.lut)
      ? gradeRenderer.draw(frame, look.colorGrade ?? NEUTRAL_COLOR_GRADE, look.chromaKey, look.lut)
      : frame;
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height);
  ctx.filter = "none";
}
