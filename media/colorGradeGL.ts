import { buildCurveTable, isIdentityCurves } from "../core/color";
import { isNeutralColorGrade } from "../core/timeline";
import { NEUTRAL_CHROMA_KEY, type ChromaKey, type ColorCurves, type ColorGrade, type LutAsset } from "../core/types";

/** LUT del registro ya resuelta para un clip (ver Clip.lut / lookForClip en media/render.ts). */
export interface ResolvedLut {
  asset: LutAsset;
  intensity: number;
}

/**
 * Grading real (lift/gamma/gain/saturación/contraste/inversión) +
 * chroma key, en WebGL2 — ampliación de alcance pedida explícitamente
 * el 2026-08-29. Un único shader hace ambas cosas a la vez porque
 * comparten el mismo coste (una pasada por el frame) y suelen usarse
 * juntas (recortar un croma y luego corregir su color). Desde el
 * 2026-10-02 la misma pasada aplica también exposición, balance de
 * blancos (temperatura/tinte), sombras/luces, curvas RGB (tabla 256×1
 * precalculada en core/color.ts) y una LUT 3D (.cube) con intensidad.
 *
 * Deliberadamente NO sustituye el Canvas 2D del preview/exportación:
 * `draw()` deja el resultado en un `OffscreenCanvas` propio del mismo
 * tamaño que el `VideoFrame` de origen, y quien llama (drawFrameFit en
 * media/render.ts) lo pinta con `ctx.drawImage` exactamente donde
 * habría pintado el VideoFrame — mismo aspect-fit, mismo `ctx.filter`
 * de los presets antiguos encima, cero divergencia entre preview y
 * exportación (ambos instancian su propio ColorGradeRenderer y llaman
 * a esta misma clase).
 */
export class ColorGradeRenderer {
  private canvas = new OffscreenCanvas(2, 2);
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private texture: WebGLTexture;
  /** Tabla 256×1 de las curvas (unidad 1) — se resube solo si cambian las curvas (comparación por identidad del objeto, que en /core es inmutable). */
  private curveTexture: WebGLTexture;
  private uploadedCurves: ColorCurves | undefined;
  /** LUT 3D (unidad 2) — ídem, por identidad del LutAsset. */
  private lutTexture: WebGLTexture;
  private uploadedLut: LutAsset | undefined;
  private uniforms: Record<string, WebGLUniformLocation>;
  private width = 0;
  private height = 0;

  constructor() {
    const gl = this.canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false });
    if (!gl) throw new Error("WebGL2 no disponible en este navegador");
    this.gl = gl;

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    this.program = linkProgram(gl, vertexShader, fragmentShader);
    gl.useProgram(this.program);

    // Quad a pantalla completa (dos triángulos vía TRIANGLE_STRIP) con
    // su UV — la textura se sube con UNPACK_FLIP_Y_WEBGL así que UV
    // (0,0)-(1,1) ya cae del lado correcto.
    const quad = new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(this.program, "aPos");
    const uvLoc = gl.getAttribLocation(this.program, "aUV");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);

    this.texture = createLinearTexture(gl, gl.TEXTURE_2D);

    // Texturas de curvas/LUT con un contenido mínimo válido desde el
    // principio: un sampler sin textura completa devuelve negro y, peor,
    // algunos drivers avisan en cada draw.
    this.curveTexture = createLinearTexture(gl, gl.TEXTURE_2D);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.lutTexture = createLinearTexture(gl, gl.TEXTURE_3D);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, 1, 1, 1, 0, gl.RGB, gl.FLOAT, new Float32Array([0, 0, 0]));

    this.uniforms = {};
    for (const name of [
      "uFrame",
      "uLift",
      "uGain",
      "uGamma",
      "uSaturation",
      "uContrast",
      "uInvert",
      "uKey",
      "uKeyEnabled",
      "uSimilarity",
      "uSmoothness",
      "uExposure",
      "uWhiteBalance",
      "uShadows",
      "uHighlights",
      "uCurves",
      "uCurvesEnabled",
      "uLut",
      "uLutSize",
      "uLutIntensity",
    ]) {
      const loc = gl.getUniformLocation(this.program, name);
      if (loc) this.uniforms[name] = loc;
    }
  }

  private ensureSize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.width = width;
    this.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  /** Pinta `frame` graduado/con croma/LUT en un OffscreenCanvas propio (mismas dimensiones que el frame) y lo devuelve — listo para `ctx.drawImage`. */
  draw(frame: VideoFrame, grade: ColorGrade, chromaKey: ChromaKey = NEUTRAL_CHROMA_KEY, lut?: ResolvedLut): OffscreenCanvas {
    const gl = this.gl;
    this.ensureSize(frame.displayWidth, frame.displayHeight);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    const curvesEnabled = !isIdentityCurves(grade.curves);
    if (curvesEnabled && grade.curves !== this.uploadedCurves) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.curveTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildCurveTable(grade.curves!));
      this.uploadedCurves = grade.curves;
    }
    const lutActive = lut !== undefined && lut.intensity > 0;
    if (lutActive && lut.asset !== this.uploadedLut) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_3D, this.lutTexture);
      const n = lut.asset.size;
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, n, n, n, 0, gl.RGB, gl.FLOAT, lut.asset.data);
      this.uploadedLut = lut.asset;
    }

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.curveTexture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTexture);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);

    gl.useProgram(this.program);
    gl.uniform1i(this.uniforms.uFrame!, 0);
    gl.uniform3f(this.uniforms.uLift!, grade.liftR, grade.liftG, grade.liftB);
    gl.uniform3f(this.uniforms.uGain!, grade.gainR, grade.gainG, grade.gainB);
    gl.uniform3f(this.uniforms.uGamma!, grade.gammaR, grade.gammaG, grade.gammaB);
    gl.uniform1f(this.uniforms.uSaturation!, grade.saturation);
    gl.uniform1f(this.uniforms.uContrast!, grade.contrast);
    gl.uniform1f(this.uniforms.uInvert!, grade.invert ? 1 : 0);
    gl.uniform1f(this.uniforms.uKeyEnabled!, chromaKey.enabled ? 1 : 0);
    gl.uniform3f(this.uniforms.uKey!, chromaKey.keyR, chromaKey.keyG, chromaKey.keyB);
    gl.uniform1f(this.uniforms.uSimilarity!, chromaKey.similarity);
    gl.uniform1f(this.uniforms.uSmoothness!, Math.max(0.001, chromaKey.smoothness));
    gl.uniform1f(this.uniforms.uExposure!, Math.pow(2, grade.exposure));
    const [wbR, wbG, wbB] = whiteBalanceGains(grade.temperature, grade.tint);
    gl.uniform3f(this.uniforms.uWhiteBalance!, wbR, wbG, wbB);
    gl.uniform1f(this.uniforms.uShadows!, grade.shadows);
    gl.uniform1f(this.uniforms.uHighlights!, grade.highlights);
    gl.uniform1i(this.uniforms.uCurves!, 1);
    gl.uniform1f(this.uniforms.uCurvesEnabled!, curvesEnabled ? 1 : 0);
    gl.uniform1i(this.uniforms.uLut!, 2);
    gl.uniform1f(this.uniforms.uLutSize!, lutActive ? lut.asset.size : 1);
    gl.uniform1f(this.uniforms.uLutIntensity!, lutActive ? Math.min(1, lut.intensity) : 0);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    return this.canvas;
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    gl.deleteTexture(this.curveTexture);
    gl.deleteTexture(this.lutTexture);
    gl.deleteProgram(this.program);
  }
}

/** true si aplicar `grade`/`chromaKey`/`lut` produciría algún cambio visible — si no, drawFrameFit se ahorra la pasada de WebGL entera. */
export function needsColorGradeGL(grade: ColorGrade | undefined, chromaKey: ChromaKey | undefined, lut?: ResolvedLut): boolean {
  return (
    (grade !== undefined && !isNeutralColorGrade(grade)) ||
    (chromaKey !== undefined && chromaKey.enabled) ||
    (lut !== undefined && lut.intensity > 0)
  );
}

/**
 * Ganancias RGB del balance de blancos: la temperatura mueve el eje
 * azul↔ámbar (sube R y baja B, o al revés) y el tinte el eje
 * verde↔magenta (baja/sube G frente a R y B). Normalizadas para que la
 * luminancia (Rec.709) se mantenga: mover la temperatura vira el color
 * de la imagen, no la aclara ni la oscurece.
 */
export function whiteBalanceGains(temperature: number, tint: number): [number, number, number] {
  const t = Math.max(-1, Math.min(1, temperature)) * 0.3;
  const m = Math.max(-1, Math.min(1, tint)) * 0.25;
  const r = (1 + t) * (1 + m * 0.5);
  const g = 1 - m;
  const b = (1 - t) * (1 + m * 0.5);
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [r / luma, g / luma, b / luma];
}

function createLinearTexture(gl: WebGL2RenderingContext, target: number): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(target, texture);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return texture;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Error compilando shader de grading: ${log}`);
  }
  return shader;
}

function linkProgram(gl: WebGL2RenderingContext, vertexShader: WebGLShader, fragmentShader: WebGLShader): WebGLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Error enlazando programa de grading: ${log}`);
  }
  return program;
}

const VERTEX_SRC = `#version 300 es
in vec2 aPos;
in vec2 aUV;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Lift/gamma/gain: fórmula ASC CDL (Slope=gain, Offset=lift,
// Power=1/gamma), el estándar de facto en corrección de color
// profesional — no una aproximación cosmética. El croma es una
// distancia de color simple (no un keyer de croma real con
// despill/spill suppression, que queda fuera de esta ampliación).
//
// Orden fijo de la pasada (2026-10-02): exposición y balance de blancos
// sobre la señal de entrada (como en la cámara) → CDL → sombras/luces →
// saturación/contraste → curvas → LUT 3D → inversión. El croma se
// calcula siempre sobre el color ORIGINAL (src), no sobre el graduado:
// corregir el color no debe cambiar qué se recorta.
const FRAGMENT_SRC = `#version 300 es
precision highp float;
precision mediump sampler3D;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uFrame;
uniform vec3 uLift;
uniform vec3 uGain;
uniform vec3 uGamma;
uniform float uSaturation;
uniform float uContrast;
uniform float uInvert;
uniform float uKeyEnabled;
uniform vec3 uKey;
uniform float uSimilarity;
uniform float uSmoothness;
uniform float uExposure;
uniform vec3 uWhiteBalance;
uniform float uShadows;
uniform float uHighlights;
uniform sampler2D uCurves;
uniform float uCurvesEnabled;
uniform sampler3D uLut;
uniform float uLutSize;
uniform float uLutIntensity;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 curvesAt(vec3 c) {
  vec3 u = (clamp(c, 0.0, 1.0) * 255.0 + 0.5) / 256.0;
  return vec3(
    texture(uCurves, vec2(u.r, 0.5)).r,
    texture(uCurves, vec2(u.g, 0.5)).g,
    texture(uCurves, vec2(u.b, 0.5)).b
  );
}

void main() {
  vec4 src = texture(uFrame, vUV);
  vec3 c = src.rgb;

  c *= uExposure;
  c *= uWhiteBalance;

  c = clamp(c * uGain + uLift, 0.0, 1.0);
  c = pow(c, 1.0 / max(uGamma, vec3(0.01)));

  // Sombras/luces: desplazamiento ponderado por la luminancia que se
  // desvanece hacia las luces (sombras) o hacia las sombras (luces) —
  // los medios tonos apenas se mueven.
  float l0 = dot(c, LUMA);
  float shadowWeight = 1.0 - smoothstep(0.0, 0.6, l0);
  float highlightWeight = smoothstep(0.4, 1.0, l0);
  c += uShadows * 0.35 * shadowWeight * (uShadows > 0.0 ? (1.0 - c) : c);
  c += uHighlights * 0.35 * highlightWeight * (uHighlights > 0.0 ? (1.0 - c) : c);
  c = clamp(c, 0.0, 1.0);

  float luma = dot(c, LUMA);
  c = mix(vec3(luma), c, uSaturation);
  c = (c - 0.5) * uContrast + 0.5;
  c = clamp(c, 0.0, 1.0);

  if (uCurvesEnabled > 0.5) {
    c = curvesAt(c);
  }

  if (uLutIntensity > 0.0) {
    vec3 lutCoord = c * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
    c = mix(c, texture(uLut, lutCoord).rgb, uLutIntensity);
  }

  c = mix(c, 1.0 - c, uInvert);
  c = clamp(c, 0.0, 1.0);

  float alpha = src.a;
  if (uKeyEnabled > 0.5) {
    float dist = distance(src.rgb, uKey);
    alpha *= smoothstep(uSimilarity, uSimilarity + uSmoothness, dist);
  }

  // Contexto creado con premultipliedAlpha:false — el color de salida
  // va SIN premultiplicar (si no, el borde del croma saldría oscurecido
  // al componerlo luego con ctx.drawImage).
  outColor = vec4(c, alpha);
}`;
