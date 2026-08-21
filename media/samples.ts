import { createFile, MP4BoxBuffer, type ISOFile, type Sample, type Track } from "mp4box";

export interface DemuxedTrack {
  videoTrack: Track;
  samples: Sample[];
}

/**
 * Demuxa TODAS las muestras comprimidas de la primera pista de vídeo
 * de un archivo (metadatos + datos, sin decodificar). Para clips
 * cortos esto es aceptable: lo que se guarda en memoria sigue siendo
 * el flujo comprimido, no fotogramas decodificados. Si el proyecto
 * necesitara clips largos habría que pasar a extracción por streaming
 * en vez de cargar toda la tabla de muestras de una vez — eso queda
 * fuera de esta rebanada.
 */
export function decodeAllSamples(file: File): Promise<DemuxedTrack> {
  return new Promise((resolve, reject) => {
    const isoFile: ISOFile = createFile();
    let videoTrack: Track | undefined;
    const samples: Sample[] = [];

    isoFile.onError = (module, message) => {
      reject(new Error(`mp4box (${module}): ${message}`));
    };

    isoFile.onReady = (info) => {
      videoTrack = info.videoTracks[0];
      if (!videoTrack) {
        reject(new Error("El archivo no contiene ninguna pista de vídeo"));
        return;
      }
      // Sin nbSamples: extrae toda la pista (en lotes internos de
      // mp4box.js), todos entregados de forma síncrona más abajo
      // porque el archivo entero ya está en el buffer que se le pasa.
      isoFile.setExtractionOptions(videoTrack.id);
      isoFile.start();
    };

    isoFile.onSamples = (_id, _user, newSamples) => {
      samples.push(...newSamples);
    };

    file
      .arrayBuffer()
      .then((buffer) => {
        const mp4boxBuffer = MP4BoxBuffer.fromArrayBuffer(buffer, 0);
        isoFile.appendBuffer(mp4boxBuffer);
        isoFile.flush();
        if (!videoTrack) {
          reject(new Error("No se pudo leer la pista de vídeo"));
          return;
        }
        resolve({ videoTrack, samples });
      })
      .catch(reject);
  });
}
