import { secondsToTicks, ticksToSeconds } from "../core/time";
import { clipDurationTicks, clipEndTicks, volumeAtOffsetTicks } from "../core/timeline";
import type { TextOverlay } from "../core/textOverlay";
import type { Clip, Timeline, Track } from "../core/types";
import { colorFilterCss } from "../media/render";

/**
 * Línea de tiempo dibujada íntegramente en un único <canvas> (ampliación
 * pedida explícitamente el 2026-08-29 por rendimiento, implementada el
 * 2026-10-02). Sustituye al DOM de un <div> por clip/celda de audio/
 * marca de regla: con muchos clips, cada zoom/scroll/arrastre obligaba
 * a reconstruir y re-maquetar cientos de nodos y a redibujar un <canvas>
 * de forma de onda por celda. Aquí solo se pinta lo que está a la vista
 * (virtualizado en X e Y), en una pasada, como un NLE de escritorio.
 *
 * Este módulo NO conoce el historial, la reproducción ni los gestos:
 * pinta un `TimelineViewState` y responde "qué hay en este píxel"
 * (hitTest). ui/main.ts decide qué hacer con cada gesto y llama a
 * `draw` cuando algo cambia (como mucho una vez por fotograma).
 *
 * Coordenadas: "x de tiempo" = segundos·pps (0 = inicio de la timeline),
 * "y de filas" = desde la primera fila bajo la regla. El canvas muestra
 * la ventana [scrollX, scrollX+ancho) × [scrollY, scrollY+alto-regla).
 * La regla se queda fija arriba (no se desplaza en vertical).
 */

export const RULER_HEIGHT_PX = 24;
export const DEFAULT_VIDEO_ROW_HEIGHT_PX = 64;
export const DEFAULT_AUDIO_ROW_HEIGHT_PX = 36;
export const TEXT_ROW_HEIGHT_PX = 26;
export const MIN_ROW_HEIGHT_PX = 20;
/** Zona sensible de cada borde de un clip para recortar (en píxeles de pantalla). */
const TRIM_HANDLE_PX = 8;
const VOLUME_LINE_HIT_PX = 5;
const KEYFRAME_HIT_PX = 7;

export type RowKind = "video" | "attachedAudio" | "audio" | "text";

export interface TimelineRow {
  /** `trackId` (fila principal), `${trackId}:audio` (audio pegado de un vídeo) o "text". También es la clave de altura personalizada. */
  key: string;
  kind: RowKind;
  trackId?: string;
  /** Desde la primera fila (bajo la regla), en px. */
  top: number;
  height: number;
  /** true en la última fila de un grupo de pista: se dibuja una línea más marcada debajo. */
  endsGroup: boolean;
}

/**
 * Filas en orden visual: por cada pista, de la capa más alta a la más
 * baja (índice más alto de `timeline.tracks` arriba, como siempre), una
 * fila principal y —solo en vídeo— su fila de audio pegado; al final, la
 * fila de textos.
 */
export function computeRows(tracks: Track[], heightOf: (key: string, fallback: number) => number): { rows: TimelineRow[]; totalHeight: number } {
  const rows: TimelineRow[] = [];
  let top = 0;
  for (let i = tracks.length - 1; i >= 0; i--) {
    const track = tracks[i]!;
    if (track.kind === "video") {
      const h = heightOf(track.id, DEFAULT_VIDEO_ROW_HEIGHT_PX);
      rows.push({ key: track.id, kind: "video", trackId: track.id, top, height: h, endsGroup: false });
      top += h;
      const ah = heightOf(`${track.id}:audio`, DEFAULT_AUDIO_ROW_HEIGHT_PX);
      rows.push({ key: `${track.id}:audio`, kind: "attachedAudio", trackId: track.id, top, height: ah, endsGroup: true });
      top += ah;
    } else {
      const h = heightOf(track.id, DEFAULT_AUDIO_ROW_HEIGHT_PX);
      rows.push({ key: track.id, kind: "audio", trackId: track.id, top, height: h, endsGroup: true });
      top += h;
    }
  }
  rows.push({ key: "text", kind: "text", top, height: TEXT_ROW_HEIGHT_PX, endsGroup: true });
  top += TEXT_ROW_HEIGHT_PX;
  return { rows, totalHeight: top };
}

/** Lo que el canvas necesita saber de una fuente para pintar sus clips. */
export interface SourceVisual {
  name: string;
  thumbnail?: string | undefined;
  waveformPeaks?: Float32Array | undefined;
  durationTicks: number;
  /** Ancho/alto del vídeo — para que los fotogramas de la tira de miniaturas no se deformen. */
  aspect: number;
}

export interface MarqueeRect {
  /** En coordenadas de contenido: x de tiempo e y de filas. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TimelineViewState {
  timeline: Timeline;
  rows: TimelineRow[];
  scrollX: number;
  scrollY: number;
  pixelsPerSecond: number;
  totalTicks: number;
  playheadTicks: number;
  markers: number[];
  textOverlays: TextOverlay[];
  isSelected: (trackId: string, clipId: string) => boolean;
  selectedOverlayId: string | undefined;
  dropTargetClipId: string | undefined;
  marquee: MarqueeRect | undefined;
  source: (sourceId: string) => SourceVisual | undefined;
}

export type ClipPart = "body" | "trimLeft" | "trimRight" | "volumeLine" | "keyframe";

export type TimelineHit =
  | { area: "ruler"; ticks: number }
  | {
      area: "row";
      row: TimelineRow;
      ticks: number;
      clip?: Clip;
      part?: ClipPart;
      keyframeIndex?: number;
      overlay?: TextOverlay;
      overlayPart?: "body" | "trimLeft" | "trimRight";
    }
  | { area: "none" };

/** Colores del tema actual, leídos de las variables CSS (ver ui/styles.css). */
interface Palette {
  surface: string;
  lane: string;
  laneAudio: string;
  laneSub: string;
  textTrack: string;
  border: string;
  borderStrong: string;
  text: string;
  textDim: string;
  accent: string;
  clip: string;
  clipSelected: string;
  playhead: string;
}

const NICE_RULER_INTERVALS_SECONDS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
const FONT = "-apple-system, 'Segoe UI', sans-serif";
const VOLUME_COLOR = "#e07a00";
const WAVEFORM_COLOR = "#3f74d6";
const FLAG_COLOR = "#f5a623";
const TRANSITION_A = "#7b5cc4";
const TRANSITION_B = "#6a4ab0";

/** "1:05", "12s", "0.50s" — misma notación que la regla de siempre. */
export function formatTimelineTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds - minutes * 60;
  if (minutes > 0) return `${minutes}:${String(Math.floor(secs)).padStart(2, "0")}`;
  return Number.isInteger(secs) ? `${secs}s` : `${secs.toFixed(2)}s`;
}

function pickRulerInterval(pixelsPerSecond: number): number {
  for (const interval of NICE_RULER_INTERVALS_SECONDS) {
    if (interval * pixelsPerSecond >= 70) return interval;
  }
  return NICE_RULER_INTERVALS_SECONDS[NICE_RULER_INTERVALS_SECONDS.length - 1]!;
}

export class TimelineCanvasView {
  private ctx: CanvasRenderingContext2D;
  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;
  private palette: Palette | undefined;
  private thumbnails = new Map<string, HTMLImageElement>();
  private hatch: CanvasPattern | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private onNeedsRedraw: () => void,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("No se pudo crear el contexto 2D de la línea de tiempo");
    this.ctx = ctx;
    // El tema cambia con data-theme en <html> (ver applyTheme en ui/main.ts):
    // se vuelve a leer la paleta en el siguiente pintado.
    new MutationObserver(() => {
      this.palette = undefined;
      this.onNeedsRedraw();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  get width(): number {
    return this.cssWidth;
  }

  get height(): number {
    return this.cssHeight;
  }

  /** Ajusta el búfer del canvas a su tamaño en pantalla × devicePixelRatio (nítido en pantallas HiDPI). */
  setSize(cssWidth: number, cssHeight: number): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cssWidth));
    const h = Math.max(1, Math.round(cssHeight));
    if (w === this.cssWidth && h === this.cssHeight && dpr === this.dpr) return;
    this.cssWidth = w;
    this.cssHeight = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  private readPalette(): Palette {
    if (this.palette) return this.palette;
    const style = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    this.palette = {
      surface: v("--surface", "#e4e9f2"),
      lane: v("--lane", "#e9edf5"),
      laneAudio: v("--lane-audio", "#e1e6ef"),
      laneSub: v("--lane-sub", "#dfe5ee"),
      textTrack: v("--text-track", "#e2e0f0"),
      border: v("--border", "rgba(163,177,198,0.35)"),
      borderStrong: v("--border-strong", "rgba(163,177,198,0.6)"),
      text: v("--text", "#33405a"),
      textDim: v("--text-dim", "#7d889d"),
      accent: v("--accent", "#2f6bff"),
      clip: v("--clip", "#4c78d8"),
      clipSelected: v("--clip-selected", "#3a5fc4"),
      playhead: v("--playhead", "#ff3b3b"),
    };
    return this.palette;
  }

  private thumbnailImage(url: string): HTMLImageElement | undefined {
    let image = this.thumbnails.get(url);
    if (!image) {
      image = new Image();
      image.onload = () => this.onNeedsRedraw();
      image.src = url;
      this.thumbnails.set(url, image);
    }
    return image.complete && image.naturalWidth > 0 ? image : undefined;
  }

  // --- Conversión de coordenadas ---

  xForTicks(state: TimelineViewState, ticks: number): number {
    return ticksToSeconds(ticks) * state.pixelsPerSecond - state.scrollX;
  }

  ticksForX(state: TimelineViewState, x: number): number {
    return secondsToTicks(Math.max(0, (x + state.scrollX) / state.pixelsPerSecond));
  }

  rowScreenTop(state: TimelineViewState, row: TimelineRow): number {
    return RULER_HEIGHT_PX + row.top - state.scrollY;
  }

  /** Clips que se pintan (y se pueden tocar) en una fila. */
  clipsOfRow(timeline: Timeline, row: TimelineRow): Clip[] {
    if (row.kind === "text" || !row.trackId) return [];
    const track = timeline.tracks.find((t) => t.id === row.trackId);
    if (!track) return [];
    return row.kind === "video" ? track.clips : track.clips.filter((c) => c.kind === "clip");
  }

  // --- Hit testing ---

  hitTest(state: TimelineViewState, x: number, y: number): TimelineHit {
    if (x < 0 || x > this.cssWidth || y < 0 || y > this.cssHeight) return { area: "none" };
    const ticks = this.ticksForX(state, x);
    if (y < RULER_HEIGHT_PX) return { area: "ruler", ticks };
    const rowY = y - RULER_HEIGHT_PX + state.scrollY;
    const row = state.rows.find((r) => rowY >= r.top && rowY < r.top + r.height);
    if (!row) return { area: "none" };

    if (row.kind === "text") {
      // De arriba (último pintado) a abajo: el texto pintado encima gana.
      for (let i = state.textOverlays.length - 1; i >= 0; i--) {
        const overlay = state.textOverlays[i]!;
        const x0 = this.xForTicks(state, overlay.startTicks);
        const x1 = Math.max(x0 + 10, this.xForTicks(state, overlay.endTicks));
        if (x < x0 || x >= x1) continue;
        const handle = Math.min(TRIM_HANDLE_PX, (x1 - x0) / 3);
        const overlayPart = x < x0 + handle ? "trimLeft" : x >= x1 - handle ? "trimRight" : "body";
        return { area: "row", row, ticks, overlay, overlayPart };
      }
      return { area: "row", row, ticks };
    }

    const top = this.rowScreenTop(state, row);
    for (const clip of this.clipsOfRow(state.timeline, row)) {
      const x0 = this.xForTicks(state, clip.startTicks);
      const x1 = Math.max(x0 + 1, this.xForTicks(state, clipEndTicks(clip)));
      if (x < x0 || x >= x1) continue;
      if (clip.kind === "transition") return { area: "row", row, ticks, clip, part: "body" };

      if (row.kind !== "video") {
        const keyframes = clip.volumeKeyframes ?? [];
        const duration = clipDurationTicks(clip) || 1;
        for (let k = 0; k < keyframes.length; k++) {
          const kx = x0 + (keyframes[k]!.offsetTicks / duration) * (x1 - x0);
          const ky = top + (1 - keyframes[k]!.volume) * row.height;
          if (Math.hypot(x - kx, y - ky) <= KEYFRAME_HIT_PX) return { area: "row", row, ticks, clip, part: "keyframe", keyframeIndex: k };
        }
      }
      const handle = Math.min(TRIM_HANDLE_PX, (x1 - x0) / 3);
      if (x < x0 + handle) return { area: "row", row, ticks, clip, part: "trimLeft" };
      if (x >= x1 - handle) return { area: "row", row, ticks, clip, part: "trimRight" };
      if (row.kind !== "video" && (clip.volumeKeyframes ?? []).length === 0 && this.hasAudio(state, clip)) {
        const lineY = top + (1 - clip.volume) * row.height;
        if (Math.abs(y - lineY) <= VOLUME_LINE_HIT_PX) return { area: "row", row, ticks, clip, part: "volumeLine" };
      }
      return { area: "row", row, ticks, clip, part: "body" };
    }
    return { area: "row", row, ticks };
  }

  hasAudio(state: TimelineViewState, clip: Clip): boolean {
    const peaks = state.source(clip.sourceId)?.waveformPeaks;
    return !!peaks && peaks.length > 0;
  }

  // --- Pintado ---

  draw(state: TimelineViewState): void {
    const ctx = this.ctx;
    const p = this.readPalette();
    const W = this.cssWidth;
    const H = this.cssHeight;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = p.lane;
    ctx.fillRect(0, 0, W, H);

    // Filas (con su fondo) — solo las visibles.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_HEIGHT_PX, W, H - RULER_HEIGHT_PX);
    ctx.clip();
    for (const row of state.rows) {
      const top = this.rowScreenTop(state, row);
      if (top > H || top + row.height < RULER_HEIGHT_PX) continue;
      ctx.fillStyle = row.kind === "video" ? p.lane : row.kind === "attachedAudio" ? p.laneSub : row.kind === "audio" ? p.laneAudio : p.textTrack;
      ctx.fillRect(0, top, W, row.height);
      if (row.kind === "text") this.drawTextRow(state, row, top, p);
      else this.drawClipRow(state, row, top, p);
      ctx.fillStyle = row.endsGroup ? p.borderStrong : p.border;
      ctx.fillRect(0, top + row.height - 1, W, 1);
    }
    // Fin de la timeline: el tramo después del último clip se atenúa un poco.
    const endX = this.xForTicks(state, state.totalTicks);
    if (endX < W) {
      ctx.fillStyle = "rgba(0,0,0,0.04)";
      ctx.fillRect(Math.max(0, endX), RULER_HEIGHT_PX, W - Math.max(0, endX), H - RULER_HEIGHT_PX);
    }
    if (state.marquee) this.drawMarquee(state, p);
    ctx.restore();

    this.drawRuler(state, p);
    this.drawPlayhead(state, p);
  }

  private drawRuler(state: TimelineViewState, p: Palette): void {
    const ctx = this.ctx;
    const W = this.cssWidth;
    ctx.fillStyle = p.surface;
    ctx.fillRect(0, 0, W, RULER_HEIGHT_PX);
    ctx.fillStyle = p.borderStrong;
    ctx.fillRect(0, RULER_HEIGHT_PX - 1, W, 1);

    const pps = state.pixelsPerSecond;
    const interval = pickRulerInterval(pps);
    const minor = interval / 5;
    const firstSecond = Math.max(0, Math.floor(state.scrollX / pps / minor) * minor);
    const lastSecond = (state.scrollX + W) / pps;
    ctx.font = `10px ${FONT}`;
    ctx.textBaseline = "top";
    for (let i = Math.round(firstSecond / minor); i * minor <= lastSecond + 1e-9; i++) {
      const t = i * minor;
      const x = Math.round(t * pps - state.scrollX) + 0.5;
      const isMajor = i % 5 === 0;
      ctx.fillStyle = isMajor ? p.textDim : p.border;
      ctx.fillRect(x - 0.5, isMajor ? 0 : RULER_HEIGHT_PX - 7, 1, isMajor ? RULER_HEIGHT_PX : 6);
      if (isMajor) {
        ctx.fillStyle = p.textDim;
        ctx.fillText(formatTimelineTime(Math.round(t * 1000) / 1000), x + 3, 3);
      }
    }

    // Marcadores: triángulo naranja colgando de la regla.
    ctx.fillStyle = VOLUME_COLOR;
    for (const ticks of state.markers) {
      const x = this.xForTicks(state, ticks);
      if (x < -6 || x > W + 6) continue;
      ctx.beginPath();
      ctx.moveTo(x - 5, RULER_HEIGHT_PX - 10);
      ctx.lineTo(x + 5, RULER_HEIGHT_PX - 10);
      ctx.lineTo(x, RULER_HEIGHT_PX - 1);
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawPlayhead(state: TimelineViewState, p: Palette): void {
    const ctx = this.ctx;
    const x = Math.round(this.xForTicks(state, state.playheadTicks));
    if (x < -6 || x > this.cssWidth + 6) return;
    ctx.fillStyle = p.playhead;
    ctx.fillRect(x - 1, 0, 2, this.cssHeight);
    ctx.beginPath();
    ctx.moveTo(x - 6, 0);
    ctx.lineTo(x + 6, 0);
    ctx.lineTo(x + 6, 7);
    ctx.lineTo(x, 13);
    ctx.lineTo(x - 6, 7);
    ctx.closePath();
    ctx.fill();
  }

  private drawMarquee(state: TimelineViewState, p: Palette): void {
    const m = state.marquee!;
    const ctx = this.ctx;
    const x = Math.min(m.x0, m.x1) - state.scrollX;
    const y = RULER_HEIGHT_PX + Math.min(m.y0, m.y1) - state.scrollY;
    const w = Math.abs(m.x1 - m.x0);
    const h = Math.abs(m.y1 - m.y0);
    ctx.fillStyle = "rgba(47,107,255,0.10)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = p.accent;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.setLineDash([]);
  }

  private drawClipRow(state: TimelineViewState, row: TimelineRow, top: number, p: Palette): void {
    const W = this.cssWidth;
    for (const clip of this.clipsOfRow(state.timeline, row)) {
      const x0 = this.xForTicks(state, clip.startTicks);
      const x1 = Math.max(x0 + 1, this.xForTicks(state, clipEndTicks(clip)));
      if (x1 < 0 || x0 > W) continue; // fuera de la vista: ni se toca
      const selected = !!row.trackId && state.isSelected(row.trackId, clip.id);
      if (row.kind === "video") {
        if (clip.kind === "transition") this.drawTransition(clip, x0, x1, top, row.height, selected, p);
        else this.drawVideoClip(state, clip, x0, x1, top, row.height, selected, p);
      } else {
        this.drawAudioClip(state, clip, x0, x1, top, row.height, selected, p);
      }
    }
  }

  private roundRectPath(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
  }

  private drawVideoClip(
    state: TimelineViewState,
    clip: Clip,
    x0: number,
    x1: number,
    top: number,
    height: number,
    selected: boolean,
    p: Palette,
  ): void {
    const ctx = this.ctx;
    const W = this.cssWidth;
    const source = state.source(clip.sourceId);
    const y = top + 1;
    const h = height - 2;
    const w = x1 - x0;

    ctx.save();
    if (clip.videoHidden) ctx.globalAlpha = 0.4;
    this.roundRectPath(x0, y, w, h, 7);
    ctx.fillStyle = selected ? p.clipSelected : p.clip;
    ctx.fill();
    ctx.clip();

    // Tira de miniaturas (filmstrip): el fotograma repetido a lo largo del
    // clip con su proporción real, solo en el tramo visible. Con el
    // filtro de color del clip aplicado, igual que el preview.
    const thumbnailUrl = source?.thumbnail;
    const image = thumbnailUrl ? this.thumbnailImage(thumbnailUrl) : undefined;
    if (image && w > 4) {
      const tileW = Math.max(16, h * (source?.aspect || 16 / 9));
      const firstTile = Math.max(0, Math.floor((0 - x0) / tileW));
      ctx.filter = colorFilterCss(clip.colorFilter);
      for (let tx = x0 + firstTile * tileW; tx < Math.min(x1, W); tx += tileW) {
        ctx.drawImage(image, tx, y, tileW, h);
      }
      ctx.filter = "none";
    }
    const shade = ctx.createLinearGradient(0, y, 0, y + h);
    shade.addColorStop(0, "rgba(0,0,0,0.15)");
    shade.addColorStop(0.45, "rgba(0,0,0,0.05)");
    shade.addColorStop(1, "rgba(0,0,0,0.6)");
    ctx.fillStyle = shade;
    ctx.fillRect(x0, y, w, h);

    if (clip.flagged) {
      ctx.fillStyle = FLAG_COLOR;
      ctx.fillRect(x0, y, w, 4);
    }

    // Texto pegado al borde izquierdo VISIBLE (si el clip empieza fuera
    // de la vista, su nombre sigue leyéndose).
    if (w > 28) {
      const textX = Math.max(x0, 0) + 6;
      const maxTextW = x1 - textX - 6;
      if (maxTextW > 10) {
        ctx.fillStyle = "#fff";
        ctx.textBaseline = "top";
        ctx.font = `600 11px ${FONT}`;
        ctx.fillText(ellipsize(ctx, source?.name ?? clip.sourceId, maxTextW), textX, y + 5);
        if (h > 34) {
          ctx.font = `10.5px ${FONT}`;
          ctx.fillStyle = "rgba(255,255,255,0.75)";
          const tag = clip.videoHidden ? " · solo audio" : "";
          ctx.fillText(ellipsize(ctx, `${ticksToSeconds(clipDurationTicks(clip)).toFixed(2)}s${tag}`, maxTextW), textX, y + h - 16);
        }
      }
    }
    ctx.restore();

    this.drawClipOutline(clip, x0, y, w, h, selected, state.dropTargetClipId === clip.id, p);
  }

  private drawClipOutline(
    clip: Clip,
    x: number,
    y: number,
    w: number,
    h: number,
    selected: boolean,
    dropTarget: boolean,
    p: Palette,
  ): void {
    const ctx = this.ctx;
    if (dropTarget) {
      ctx.setLineDash([5, 3]);
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 2;
      this.roundRectPath(x + 1, y + 1, w - 2, h - 2, 7);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (selected) {
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 2;
      this.roundRectPath(x + 1, y + 1, w - 2, h - 2, 7);
      ctx.stroke();
    } else {
      // Separación fina entre clips pegados, para distinguir un corte.
      ctx.fillStyle = "rgba(18,27,45,0.35)";
      ctx.fillRect(x + w - 1, y + 2, 1, h - 4);
    }
    void clip;
  }

  private drawTransition(clip: Clip, x0: number, x1: number, top: number, height: number, selected: boolean, p: Palette): void {
    const ctx = this.ctx;
    const y = top + Math.min(10, height * 0.15);
    const h = height - 2 * Math.min(10, height * 0.15);
    const w = x1 - x0;
    ctx.save();
    this.roundRectPath(x0, y, w, h, 6);
    ctx.clip();
    ctx.fillStyle = TRANSITION_A;
    ctx.fillRect(x0, y, w, h);
    ctx.strokeStyle = TRANSITION_B;
    ctx.lineWidth = 6;
    for (let sx = x0 - h; sx < x1 + h; sx += 12) {
      ctx.beginPath();
      ctx.moveTo(sx, y + h);
      ctx.lineTo(sx + h, y);
      ctx.stroke();
    }
    if (w > 40) {
      ctx.fillStyle = "#fff";
      ctx.font = `600 10px ${FONT}`;
      ctx.textBaseline = "middle";
      ctx.fillText(ellipsize(ctx, clip.transitionType === "dipToBlack" ? "A negro" : "Fundido", w - 10), x0 + 5, y + h / 2);
    }
    ctx.restore();
    ctx.strokeStyle = selected ? p.text : p.accent;
    ctx.lineWidth = selected ? 2 : 1;
    this.roundRectPath(x0 + 0.5, y + 0.5, w - 1, h - 1, 6);
    ctx.stroke();
  }

  private hatchPattern(): CanvasPattern | null {
    if (this.hatch) return this.hatch;
    const tile = document.createElement("canvas");
    tile.width = 8;
    tile.height = 8;
    const t = tile.getContext("2d");
    if (!t) return null;
    t.strokeStyle = "rgba(18,27,45,0.08)";
    t.lineWidth = 2;
    t.beginPath();
    t.moveTo(0, 8);
    t.lineTo(8, 0);
    t.stroke();
    this.hatch = this.ctx.createPattern(tile, "repeat");
    return this.hatch;
  }

  private drawAudioClip(
    state: TimelineViewState,
    clip: Clip,
    x0: number,
    x1: number,
    top: number,
    height: number,
    selected: boolean,
    p: Palette,
  ): void {
    const ctx = this.ctx;
    const W = this.cssWidth;
    const source = state.source(clip.sourceId);
    const peaks = source?.waveformPeaks;
    const w = x1 - x0;
    const y = top + 1;
    const h = height - 2;

    ctx.save();
    this.roundRectPath(x0, y, w, h, 4);
    ctx.fillStyle = "rgba(63,116,214,0.10)";
    ctx.fill();
    ctx.clip();

    if (!peaks || peaks.length === 0) {
      const hatch = this.hatchPattern();
      if (hatch) {
        ctx.fillStyle = hatch;
        ctx.fillRect(x0, y, w, h);
      }
      if (w > 60) {
        ctx.fillStyle = p.textDim;
        ctx.font = `9px ${FONT}`;
        ctx.textBaseline = "middle";
        ctx.fillText("sin audio", Math.max(x0, 0) + 4, y + h / 2);
      }
      ctx.restore();
      if (selected) this.drawClipOutline(clip, x0, y, w, h, true, false, p);
      return;
    }

    // Forma de onda: por cada columna de píxel visible, el mín/máx de
    // los cubos de la fuente que caen en ella (envolvente real, no
    // barras simétricas) — coste proporcional al ancho visible, no a la
    // duración del clip.
    const sourceDuration = source!.durationTicks || 1;
    const bucketCount = Math.max(1, Math.floor(peaks.length / 2));
    const fracStart = clip.sourceInTicks / sourceDuration;
    const fracSpan = clipDurationTicks(clip) / sourceDuration;
    const mid = y + h / 2;
    const half = h / 2 - 1;
    ctx.fillStyle = clip.muted ? p.textDim : WAVEFORM_COLOR;
    const startPx = Math.max(Math.floor(x0), 0);
    const endPx = Math.min(Math.ceil(x1), W);
    for (let px = startPx; px < endPx; px++) {
      const a = fracStart + ((px - x0) / w) * fracSpan;
      const b = fracStart + ((px + 1 - x0) / w) * fracSpan;
      let i0 = Math.floor(a * bucketCount);
      let i1 = Math.max(i0 + 1, Math.ceil(b * bucketCount));
      i0 = Math.max(0, Math.min(bucketCount - 1, i0));
      i1 = Math.max(i0 + 1, Math.min(bucketCount, i1));
      let min = 0;
      let max = 0;
      for (let i = i0; i < i1; i++) {
        const lo = peaks[i * 2]!;
        const hi = peaks[i * 2 + 1]!;
        if (lo < min) min = lo;
        if (hi > max) max = hi;
      }
      const yTop = mid - max * half;
      ctx.fillRect(px, yTop, 1, Math.max(1, mid - min * half - yTop));
    }

    // Envolvente de volumen (plana o por puntos).
    const duration = clipDurationTicks(clip) || 1;
    const keyframes = clip.volumeKeyframes ?? [];
    ctx.strokeStyle = clip.muted ? p.textDim : VOLUME_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (keyframes.length === 0) {
      const ly = y + (1 - clip.volume) * h;
      ctx.moveTo(x0, ly);
      ctx.lineTo(x1, ly);
    } else {
      // Mismo tramo plano antes del primer punto / tras el último que
      // volumeAtOffsetTicks (la reproducción y la exportación).
      const silentClip = { ...clip, muted: false };
      ctx.moveTo(x0, y + (1 - volumeAtOffsetTicks(silentClip, 0)) * h);
      for (const k of keyframes) ctx.lineTo(x0 + (k.offsetTicks / duration) * w, y + (1 - k.volume) * h);
      ctx.lineTo(x1, y + (1 - volumeAtOffsetTicks(silentClip, duration)) * h);
    }
    ctx.stroke();
    for (const k of keyframes) {
      const kx = x0 + (k.offsetTicks / duration) * w;
      const ky = y + (1 - k.volume) * h;
      ctx.beginPath();
      ctx.arc(kx, ky, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = clip.muted ? p.textDim : VOLUME_COLOR;
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (keyframes.length === 0 && w > 34 && h > 16) {
      ctx.font = `600 9px ${FONT}`;
      ctx.textBaseline = "top";
      ctx.fillStyle = clip.muted ? p.textDim : "#c96a00";
      ctx.fillText(clip.muted ? "silenciado" : `${Math.round(clip.volume * 100)}%`, Math.max(x0, 0) + 4, y + 2);
    }
    ctx.restore();
    if (selected || state.dropTargetClipId === clip.id) {
      this.drawClipOutline(clip, x0, y, w, h, selected, state.dropTargetClipId === clip.id, p);
    } else {
      ctx.fillStyle = "rgba(18,27,45,0.18)";
      ctx.fillRect(x1 - 1, y, 1, h);
    }
  }

  private drawTextRow(state: TimelineViewState, row: TimelineRow, top: number, p: Palette): void {
    const ctx = this.ctx;
    const W = this.cssWidth;
    for (const overlay of state.textOverlays) {
      const x0 = this.xForTicks(state, overlay.startTicks);
      const x1 = Math.max(x0 + 10, this.xForTicks(state, overlay.endTicks));
      if (x1 < 0 || x0 > W) continue;
      const selected = overlay.id === state.selectedOverlayId;
      const y = top + 2;
      const h = row.height - 5;
      ctx.save();
      this.roundRectPath(x0, y, x1 - x0, h, 4);
      const grad = ctx.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, selected ? "#9a72d0" : "#8a63c0");
      grad.addColorStop(1, selected ? "#7d57bd" : "#6f4aae");
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.clip();
      ctx.fillStyle = "#fff";
      ctx.font = `10px ${FONT}`;
      ctx.textBaseline = "middle";
      const textX = Math.max(x0, 0) + 6;
      ctx.fillText(ellipsize(ctx, overlay.text, x1 - textX - 4), textX, y + h / 2);
      ctx.restore();
      if (selected) {
        ctx.strokeStyle = p.accent;
        ctx.lineWidth = 2;
        this.roundRectPath(x0 + 1, y + 1, x1 - x0 - 2, h - 2, 4);
        ctx.stroke();
      }
    }
  }
}

/** Recorta `text` con "…" para que quepa en `maxWidth` px con la fuente actual de `ctx`. */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const midIndex = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, midIndex) + "…").width <= maxWidth) lo = midIndex;
    else hi = midIndex - 1;
  }
  return lo === 0 ? "" : text.slice(0, lo) + "…";
}
