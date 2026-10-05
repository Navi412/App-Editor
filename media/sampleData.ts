/**
 * Lectura de muestras de vídeo bajo demanda — mejora pedida el
 * 2026-10-05 ("cargar los vídeos sin meterlos enteros en memoria").
 *
 * Antes, cada fuente se leía entera con `file.arrayBuffer()` y todas
 * sus muestras comprimidas se quedaban en RAM: una grabación de OBS de
 * 1 GB eran 1 GB de memoria, por fuente. Ahora los demuxers guardan
 * solo DÓNDE está cada muestra (`offset` + `size` en el archivo) y este
 * cargador lee del disco, por bloques de muestras consecutivas, lo que
 * el decoder está a punto de necesitar — con un tope de memoria por
 * fuente (los bloques menos usados se sueltan).
 *
 * Funciona igual en el navegador y en Electron: un `File` elegido por el
 * usuario es un Blob respaldado por disco, y `slice().arrayBuffer()` lee
 * solo ese tramo. Para archivos reabiertos por ruta (proyectos
 * guardados), Electron da lecturas por rango (ui/electronBridge.ts).
 */

/** Algo de lo que se pueden leer tramos de bytes: un archivo en disco, o un buffer en memoria (tests). */
export interface ByteSource {
  readonly size: number;
  /** Bytes [start, end). */
  read(start: number, end: number): Promise<Uint8Array>;
}

export function byteSourceFromBlob(blob: Blob): ByteSource {
  return {
    size: blob.size,
    async read(start, end) {
      return new Uint8Array(await blob.slice(start, end).arrayBuffer());
    },
  };
}

export function byteSourceFromBytes(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    async read(start, end) {
      return bytes.subarray(start, Math.min(end, bytes.length));
    },
  };
}

/** Lo que el cargador necesita de una muestra: dónde está y dónde dejar sus bytes. */
export interface LazySample {
  data?: Uint8Array;
  /** Posición absoluta en el archivo (ausente si `data` vino ya resuelta del demuxer, p.ej. MPEG-TS). */
  offset?: number;
  size?: number;
}

/** Muestras por bloque: lecturas de unos pocos MB, ni una por fotograma ni el archivo entero. */
const SAMPLES_PER_BLOCK = 48;
/** Memoria máxima de muestras comprimidas por fuente. Un GOP largo de 4K cabe de sobra. */
const DEFAULT_BUDGET_BYTES = 192 * 1024 * 1024;
/** Muestras por delante que prefetch() intenta tener listas durante la reproducción. */
export const PREFETCH_SAMPLES = 96;

export class SampleDataLoader {
  private readonly loading = new Map<number, Promise<void>>();
  /** Bloques cargados, en orden de uso (el último, el más reciente). */
  private readonly lru: number[] = [];
  private readonly blockBytes = new Map<number, number>();
  private loadedBytes = 0;

  constructor(
    private readonly source: ByteSource,
    private readonly samples: LazySample[],
    /** Bytes a anteponer a cada muestra (compresión "header stripping" de Matroska). */
    private readonly prefix?: Uint8Array,
    private readonly budgetBytes = DEFAULT_BUDGET_BYTES,
  ) {}

  /** true si TODAS las muestras [from, to] tienen ya sus bytes. */
  isLoaded(from: number, to: number): boolean {
    for (let i = Math.max(0, from); i <= Math.min(to, this.samples.length - 1); i++) {
      const sample = this.samples[i]!;
      if (!sample.data && sample.offset !== undefined) return false;
    }
    return true;
  }

  /** Carga las muestras [from, to] (índices de decodificación) si no lo están. */
  async ensure(from: number, to: number): Promise<void> {
    const first = Math.max(0, Math.floor(from / SAMPLES_PER_BLOCK));
    const last = Math.floor(Math.min(to, this.samples.length - 1) / SAMPLES_PER_BLOCK);
    const pending: Array<Promise<void>> = [];
    for (let block = first; block <= last; block++) pending.push(this.ensureBlock(block));
    await Promise.all(pending);
  }

  /** Igual que ensure pero sin esperar: para ir leyendo por delante de la reproducción. */
  prefetch(from: number, count = PREFETCH_SAMPLES): Promise<void> {
    return this.ensure(from, from + count - 1);
  }

  private ensureBlock(block: number): Promise<void> {
    const start = block * SAMPLES_PER_BLOCK;
    const end = Math.min(start + SAMPLES_PER_BLOCK, this.samples.length);
    if (this.isLoaded(start, end - 1)) {
      this.touch(block);
      return Promise.resolve();
    }
    const inFlight = this.loading.get(block);
    if (inFlight) return inFlight;
    const promise = this.loadBlock(block, start, end).finally(() => this.loading.delete(block));
    this.loading.set(block, promise);
    return promise;
  }

  private async loadBlock(block: number, start: number, end: number): Promise<void> {
    let spanStart = Infinity;
    let spanEnd = -Infinity;
    for (let i = start; i < end; i++) {
      const sample = this.samples[i]!;
      if (sample.offset === undefined || sample.size === undefined) continue;
      spanStart = Math.min(spanStart, sample.offset);
      spanEnd = Math.max(spanEnd, sample.offset + sample.size);
    }
    if (spanStart === Infinity) return;
    const bytes = await this.source.read(spanStart, spanEnd);
    let total = 0;
    for (let i = start; i < end; i++) {
      const sample = this.samples[i]!;
      if (sample.offset === undefined || sample.size === undefined) continue;
      const raw = bytes.subarray(sample.offset - spanStart, sample.offset - spanStart + sample.size);
      sample.data = this.prefix ? concatBytes(this.prefix, raw) : raw;
      total += sample.size;
    }
    // El bloque entero (con lo que haya intercalado, p.ej. audio) vive
    // mientras alguna muestra lo referencie: se cuenta su tamaño real.
    const cost = Math.max(total, bytes.byteLength);
    this.blockBytes.set(block, cost);
    this.loadedBytes += cost;
    this.touch(block);
    this.evictIfNeeded(block);
  }

  private touch(block: number): void {
    const index = this.lru.indexOf(block);
    if (index >= 0) this.lru.splice(index, 1);
    this.lru.push(block);
  }

  private evictIfNeeded(keep: number): void {
    while (this.loadedBytes > this.budgetBytes && this.lru.length > 1) {
      const victim = this.lru[0] === keep ? this.lru.splice(1, 1)[0]! : this.lru.shift()!;
      const start = victim * SAMPLES_PER_BLOCK;
      const end = Math.min(start + SAMPLES_PER_BLOCK, this.samples.length);
      for (let i = start; i < end; i++) {
        const sample = this.samples[i]!;
        if (sample.offset !== undefined) delete sample.data;
      }
      this.loadedBytes -= this.blockBytes.get(victim) ?? 0;
      this.blockBytes.delete(victim);
    }
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
