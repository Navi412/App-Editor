import type { ByteSource } from "../media/sampleData";

/**
 * Puente hacia electron/preload.cjs — ver ese archivo para el porqué de
 * no usar IPC. `window.appVideo` solo existe dentro de la app de
 * Electron empaquetada (o `npm run electron:start`); bajo `npm run dev`
 * (navegador normal) es `undefined` y todo el código que lo usa cae de
 * vuelta al flujo de siempre (`<input type=file>`) sin ninguna rama de
 * build distinta — su sola presencia/ausencia ES la detección de entorno.
 */
export interface AppVideoBridge {
  /** Ruta absoluta real de un File ya elegido por el usuario. */
  getPathForFile(file: File): string;
  /** Bytes de un archivo por ruta absoluta. */
  readFileAsBytes(filePath: string): Promise<ArrayBuffer>;
  /** Tamaño en bytes de un archivo por ruta. */
  fileSize(filePath: string): Promise<number>;
  /** Bytes [start, end) de un archivo por ruta, sin leerlo entero. */
  readFileRange(filePath: string, start: number, end: number): Promise<ArrayBuffer>;
  /** Tamaño y fecha de modificación de un archivo por ruta. */
  fileStat(filePath: string): Promise<{ size: number; mtimeMs: number }>;
  /** Proxy de edición guardado con esa clave (hex), o null. */
  proxyCacheRead(key: string): Promise<ArrayBuffer | null>;
  /** Guarda un proxy de edición con esa clave (hex). */
  proxyCacheWrite(key: string, bytes: ArrayBuffer): Promise<void>;
  /** true si `filePath` sigue existiendo en disco. */
  fileExists(filePath: string): Promise<boolean>;
  /** Se suscribe a las acciones del menú de aplicación nativo (ver electron/main.cjs). Solo existe dentro de Electron. */
  onMenuAction(callback: (action: string) => void): void;
}

declare global {
  interface Window {
    appVideo?: AppVideoBridge;
  }
}

export function getAppVideoBridge(): AppVideoBridge | undefined {
  return typeof window !== "undefined" ? window.appVideo : undefined;
}

/** Relee un archivo por ruta y lo envuelve en un File real — decodeAllSamples/decodeAudioAsset solo llaman a file.arrayBuffer(), así que no necesitan saber que el archivo no vino de un <input>. */
export async function readFileFromPath(bridge: AppVideoBridge, filePath: string, fileName: string): Promise<File> {
  const bytes = await bridge.readFileAsBytes(filePath);
  return new File([bytes], fileName);
}

/** Lecturas por rango de un archivo por ruta: así un vídeo reabierto desde un proyecto no se carga entero en memoria (ver media/sampleData.ts). */
export async function byteSourceFromPath(bridge: AppVideoBridge, filePath: string): Promise<ByteSource> {
  const size = await bridge.fileSize(filePath);
  return {
    size,
    async read(start, end) {
      return new Uint8Array(await bridge.readFileRange(filePath, start, Math.min(end, size)));
    },
  };
}
