import { isNeutralColorGrade } from "../core/timeline";
import { NEUTRAL_CHROMA_KEY, type ChromaKey, type ColorGrade } from "../core/types";

/**
 * Grading real (lift/gamma/gain/saturación/contraste/inversión) +
 * chroma key, en WebGL2 — ampliación de alcance pedida explícitamente
 * el 2026-08-29. Un único shader hace ambas cosas a la vez porque
 * comparten el mismo coste (una pasada por el frame) y suelen usarse
 * juntas (recortar un croma y luego corregir su color).
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

    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.uniforms = {};
    for (const name of ["uFrame", "uLift", "uGain", "uGamma", "uSaturation", "uContrast", "uInvert", "uKey", "uKeyEnabled", "uSimilarity", "uSmoothness"]) {
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

  /** Pinta `frame` graduado/con croma en un OffscreenCanvas propio (mismas dimensiones que el frame) y lo devuelve — listo para `ctx.drawImage`. */
  draw(frame: VideoFrame, grade: ColorGrade, chromaKey: ChromaKey = NEUTRAL_CHROMA_KEY): OffscreenCanvas {
    const gl = this.gl;
    this.ensureSize(frame.displayWidth, frame.displayHeight);

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

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    return this.canvas;
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    gl.deleteProgram(this.program);
  }
}

/** true si aplicar `grade`/`chromaKey` produciría algún cambio visible — si no, drawFrameFit se ahorra la pasada de WebGL entera. */
export function needsColorGradeGL(grade: ColorGrade | undefined, chromaKey: ChromaKey | undefined): boolean {
  return (grade !== undefined && !isNeutralColorGrade(grade)) || (chromaKey !== undefined && chromaKey.enabled);
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
const FRAGMENT_SRC = `#version 300 es
precision highp float;
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

void main() {
  vec4 src = texture(uFrame, vUV);
  vec3 c = src.rgb;

  c = clamp(c * uGain + uLift, 0.0, 1.0);
  c = pow(c, 1.0 / max(uGamma, vec3(0.01)));

  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, uSaturation);
  c = (c - 0.5) * uContrast + 0.5;
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
