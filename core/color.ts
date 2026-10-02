import { NEUTRAL_COLOR_GRADE, type ColorCurves, type ColorGrade, type CurvePoint, type LutAsset } from "./types";

/**
 * Aritmética de color pura (ampliación pedida explícitamente el
 * 2026-10-02: temperatura/tinte/exposición, curvas RGB y LUTs .cube).
 * Sin WebGL ni DOM: media/colorGradeGL.ts consume lo que sale de aquí
 * (la tabla de curvas ya evaluada, la LUT ya parseada) y solo se ocupa
 * de subirlo a la GPU — así la matemática se testea con datos inventados.
 */

/** Curva identidad: (0,0)-(1,1). */
export const IDENTITY_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export const IDENTITY_CURVES: ColorCurves = {
  master: IDENTITY_CURVE,
  r: IDENTITY_CURVE,
  g: IDENTITY_CURVE,
  b: IDENTITY_CURVE,
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isIdentityCurve(points: CurvePoint[]): boolean {
  return points.every((p) => Math.abs(p.x - p.y) < 1e-9);
}

export function isIdentityCurves(curves: ColorCurves | undefined): boolean {
  return !curves || (isIdentityCurve(curves.master) && isIdentityCurve(curves.r) && isIdentityCurve(curves.g) && isIdentityCurve(curves.b));
}

/**
 * Ordena, recorta a [0,1] y garantiza los extremos x=0 y x=1 (si faltan,
 * se añaden en la identidad). Dos puntos con la misma x: gana el último.
 */
export function normalizeCurve(points: CurvePoint[]): CurvePoint[] {
  const byX = new Map<number, number>();
  for (const p of points) {
    if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y)) continue;
    byX.set(Math.max(0, Math.min(1, p.x)), Math.max(0, Math.min(1, p.y)));
  }
  if (!byX.has(0)) byX.set(0, 0);
  if (!byX.has(1)) byX.set(1, 1);
  return [...byX.entries()].sort((a, b) => a[0] - b[0]).map(([x, y]) => ({ x, y }));
}

/**
 * Evalúa la curva en `x` con interpolación cúbica de Hermite monótona
 * (Fritsch-Carlson): pasa exactamente por todos los puntos y, entre dos
 * puntos, nunca sale del rango que ellos marcan — la propiedad que hace
 * que una curva de color "no rebote" (un spline natural sí lo hace y
 * produce posterizado/inversiones al subir mucho un punto).
 * `points` debe venir normalizada (ver normalizeCurve).
 */
export function evaluateCurve(points: CurvePoint[], x: number): number {
  const n = points.length;
  if (n === 0) return x;
  if (n === 1) return points[0]!.y;
  if (x <= points[0]!.x) return points[0]!.y;
  if (x >= points[n - 1]!.x) return points[n - 1]!.y;

  const slopes = monotoneTangents(points);
  let i = 0;
  while (i < n - 2 && x > points[i + 1]!.x) i++;
  const p0 = points[i]!;
  const p1 = points[i + 1]!;
  const h = p1.x - p0.x;
  if (h <= 0) return p1.y;
  const t = (x - p0.x) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const y = h00 * p0.y + h10 * h * slopes[i]! + h01 * p1.y + h11 * h * slopes[i + 1]!;
  return Math.max(0, Math.min(1, y));
}

function monotoneTangents(points: CurvePoint[]): number[] {
  const n = points.length;
  const secants: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1]!.x - points[i]!.x;
    secants.push(dx > 0 ? (points[i + 1]!.y - points[i]!.y) / dx : 0);
  }
  const tangents: number[] = new Array<number>(n);
  tangents[0] = secants[0]!;
  tangents[n - 1] = secants[n - 2]!;
  for (let i = 1; i < n - 1; i++) {
    const a = secants[i - 1]!;
    const b = secants[i]!;
    tangents[i] = a * b <= 0 ? 0 : (a + b) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    const s = secants[i]!;
    if (s === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const alpha = tangents[i]! / s;
    const beta = tangents[i + 1]! / s;
    const sum = alpha * alpha + beta * beta;
    if (sum > 9) {
      const tau = 3 / Math.sqrt(sum);
      tangents[i] = tau * alpha * s;
      tangents[i + 1] = tau * beta * s;
    }
  }
  return tangents;
}

/**
 * Tabla de `size` entradas RGBA8 lista para subir como textura 1D
 * (size×1) al shader: canal R/G/B = curva de ese canal aplicada sobre la
 * maestra (`out_c = curva_c(master(in_c))`), A = 255. Se evalúa aquí una
 * vez por cambio de curva, nunca por píxel.
 */
export function buildCurveTable(curves: ColorCurves, size: number = 256): Uint8Array {
  const master = normalizeCurve(curves.master);
  const channels = [normalizeCurve(curves.r), normalizeCurve(curves.g), normalizeCurve(curves.b)];
  const table = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const m = evaluateCurve(master, i / (size - 1));
    for (let c = 0; c < 3; c++) {
      table[i * 4 + c] = Math.round(evaluateCurve(channels[c]!, m) * 255);
    }
    table[i * 4 + 3] = 255;
  }
  return table;
}

/**
 * Rellena con su valor neutro los campos que un grading guardado antes
 * del 2026-10-02 (proyectos, filtros propios en localStorage) no tiene,
 * y normaliza las curvas si las hay. Devuelve undefined si `value` ni
 * siquiera tiene los campos CDL de siempre.
 */
export function normalizeColorGrade(value: unknown): ColorGrade | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const required = ["liftR", "liftG", "liftB", "gammaR", "gammaG", "gammaB", "gainR", "gainG", "gainB", "saturation", "contrast"];
  if (!required.every((key) => isFiniteNumber(v[key])) || typeof v.invert !== "boolean") return undefined;
  const numbers: Record<string, number> = {};
  for (const key of Object.keys(NEUTRAL_COLOR_GRADE)) {
    if (key === "invert") continue;
    const raw = v[key];
    numbers[key] = isFiniteNumber(raw) ? raw : (NEUTRAL_COLOR_GRADE as unknown as Record<string, number>)[key]!;
  }
  const grade = { ...NEUTRAL_COLOR_GRADE, ...numbers, invert: v.invert } as ColorGrade;
  const curves = normalizeCurves(v.curves);
  if (curves && !isIdentityCurves(curves)) grade.curves = curves;
  return grade;
}

function isCurvePointArray(value: unknown): value is CurvePoint[] {
  return (
    Array.isArray(value) &&
    value.every((p) => typeof p === "object" && p !== null && isFiniteNumber((p as CurvePoint).x) && isFiniteNumber((p as CurvePoint).y))
  );
}

function normalizeCurves(value: unknown): ColorCurves | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (!isCurvePointArray(v.master) || !isCurvePointArray(v.r) || !isCurvePointArray(v.g) || !isCurvePointArray(v.b)) {
    return undefined;
  }
  return { master: normalizeCurve(v.master), r: normalizeCurve(v.r), g: normalizeCurve(v.g), b: normalizeCurve(v.b) };
}

// --- LUT 3D (.cube) ---

/**
 * Parsea el texto de un `.cube` (formato Adobe/Resolve, el estándar de
 * facto): `LUT_3D_SIZE N` y N³ líneas "r g b". Acepta y descarta TITLE,
 * comentarios (#), DOMAIN_MIN/MAX por defecto (0..1) — un DOMAIN distinto
 * de 0..1 se reescala a 0..1 —, y rechaza las LUT 1D (`LUT_1D_SIZE`),
 * que serían otro tipo de dato. Lanza con un mensaje claro si no encaja.
 */
export function parseCubeLut(text: string, id: string, fallbackName: string): LutAsset {
  let size = 0;
  let title: string | undefined;
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  const values: number[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith("TITLE")) {
      const match = /"(.*)"/.exec(line);
      title = match ? match[1] : line.slice(5).trim();
      continue;
    }
    if (upper.startsWith("LUT_1D_SIZE")) throw new Error("Es una LUT 1D; solo se admiten LUT 3D (.cube con LUT_3D_SIZE)");
    if (upper.startsWith("LUT_3D_SIZE")) {
      size = Number(line.split(/\s+/)[1]);
      continue;
    }
    if (upper.startsWith("DOMAIN_MIN")) {
      domainMin = line.split(/\s+/).slice(1, 4).map(Number);
      continue;
    }
    if (upper.startsWith("DOMAIN_MAX")) {
      domainMax = line.split(/\s+/).slice(1, 4).map(Number);
      continue;
    }
    if (/^[A-Z_]/.test(upper)) continue; // otras palabras clave (LUT_3D_INPUT_RANGE...) — se ignoran
    const parts = line.split(/\s+/);
    if (parts.length < 3) throw new Error(`Línea de datos inválida en el .cube: «${line}»`);
    for (let c = 0; c < 3; c++) {
      const value = Number(parts[c]);
      if (!Number.isFinite(value)) throw new Error(`Valor no numérico en el .cube: «${line}»`);
      values.push(value);
    }
  }

  if (!Number.isInteger(size) || size < 2 || size > 256) throw new Error("El .cube no declara un LUT_3D_SIZE válido (2-256)");
  if (values.length !== size * size * size * 3) {
    throw new Error(`El .cube declara ${size}³ entradas pero trae ${values.length / 3}`);
  }
  if (domainMin.length !== 3 || domainMax.length !== 3 || domainMin.some((v, i) => !(domainMax[i]! > v))) {
    throw new Error("DOMAIN_MIN/DOMAIN_MAX inválidos en el .cube");
  }

  const data = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const c = i % 3;
    data[i] = (values[i]! - domainMin[c]!) / (domainMax[c]! - domainMin[c]!);
  }
  return { id, name: title && title.length > 0 ? title : fallbackName, size, data };
}

/** Inverso de parseCubeLut (dominio 0..1) — así se guarda una LUT dentro del archivo de proyecto. */
export function serializeCubeLut(lut: LutAsset): string {
  const lines = [`TITLE "${lut.name.replace(/"/g, "'")}"`, `LUT_3D_SIZE ${lut.size}`];
  for (let i = 0; i < lut.data.length; i += 3) {
    lines.push(`${round6(lut.data[i]!)} ${round6(lut.data[i + 1]!)} ${round6(lut.data[i + 2]!)}`);
  }
  return lines.join("\n");
}

function round6(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

/**
 * Muestrea la LUT en `rgb` (0-1) con interpolación trilineal — la misma
 * que hace la GPU con una textura 3D LINEAR. Para tests y para cualquier
 * consumidor que no tenga WebGL; el render real lo hace el shader.
 */
export function sampleLut(lut: LutAsset, rgb: [number, number, number]): [number, number, number] {
  const n = lut.size;
  const pos = rgb.map((v) => Math.max(0, Math.min(1, v)) * (n - 1));
  const i0 = pos.map((p) => Math.min(n - 2, Math.floor(p)));
  const f = pos.map((p, k) => p - i0[k]!);
  const at = (r: number, g: number, b: number, c: number) => lut.data[((b * n + g) * n + r) * 3 + c]!;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let acc = 0;
    for (let dr = 0; dr <= 1; dr++) {
      for (let dg = 0; dg <= 1; dg++) {
        for (let db = 0; db <= 1; db++) {
          const w = (dr ? f[0]! : 1 - f[0]!) * (dg ? f[1]! : 1 - f[1]!) * (db ? f[2]! : 1 - f[2]!);
          acc += w * at(i0[0]! + dr, i0[1]! + dg, i0[2]! + db, c);
        }
      }
    }
    out[c] = acc;
  }
  return out;
}
