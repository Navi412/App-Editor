/**
 * Decodificación de audio. Deliberadamente NO usa WebCodecs
 * AudioDecoder + mp4box: `decodeAudioData` es una API nativa del
 * navegador pensada exactamente para esto (decodificar la pista de
 * audio de un contenedor típico — mp4/m4a, ogg, wav — a un
 * AudioBuffer PCM), y evita reconstruir a mano el pipeline de
 * demux+decode+ensamblado que sí hace falta para vídeo (donde
 * necesitamos control fotograma a fotograma que WebCodecs da y
 * decodeAudioData no).
 */

/** Decodifica la pista de audio de un archivo a un AudioBuffer completo. undefined si el archivo no tiene audio (o no es decodificable). */
export async function decodeAudioAsset(
  file: File,
  audioContext: BaseAudioContext,
): Promise<AudioBuffer | undefined> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    return await audioContext.decodeAudioData(arrayBuffer);
  } catch {
    return undefined;
  }
}
