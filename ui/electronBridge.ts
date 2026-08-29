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
  /** true si `filePath` sigue existiendo en disco. */
  fileExists(filePath: string): Promise<boolean>;
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
