import { extractMpegTsAudio } from "./demuxMpegTs";
import { sniffContainer } from "./samples";

/**
 * Decodificación de audio. Deliberadamente NO usa WebCodecs
 * AudioDecoder + mp4box: `decodeAudioData` es una API nativa del
 * navegador pensada exactamente para esto (decodificar la pista de
 * audio de un contenedor típico — mp4/mov, webm/mkv, ogg, wav — a un
 * AudioBuffer PCM), y evita reconstruir a mano el pipeline de
 * demux+decode+ensamblado que sí hace falta para vídeo (donde
 * necesitamos control fotograma a fotograma que WebCodecs da y
 * decodeAudioData no).
 *
 * Única excepción: MPEG-TS, que decodeAudioData no sabe abrir. Se le
 * pasa el flujo AAC/MP3 que va dentro (extractMpegTsAudio) y se alinea
 * con el primer fotograma de vídeo (alignAudioStart).
 */

/**
 * Archivos de solo audio que se importan como fuente propia (música,
 * voz en off...) — ampliación pedida el 2026-10-05. decodeAudioData los
 * decodifica todos de forma nativa.
 */
export const AUDIO_FILE_EXTENSIONS = [".mp3", ".wav", ".ogg", ".oga", ".flac", ".m4a", ".aac", ".opus", ".weba"];

/** Por extensión o tipo MIME: ¿es un archivo de solo audio? (un .m4a/.mp4 sin vídeo también acaba aquí, ver addClipFromFile). */
export function isAudioOnlyFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return file.type.startsWith("audio/") || AUDIO_FILE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** Decodifica la pista de audio de un archivo a un AudioBuffer completo. undefined si el archivo no tiene audio (o no es decodificable). */
export async function decodeAudioAsset(
  file: File,
  audioContext: BaseAudioContext,
): Promise<AudioBuffer | undefined> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    if (sniffContainer(new Uint8Array(arrayBuffer, 0, Math.min(400, arrayBuffer.byteLength))) === "mpegts") {
      const audio = extractMpegTsAudio(new Uint8Array(arrayBuffer));
      if (!audio) return undefined;
      const decoded = await audioContext.decodeAudioData(audio.data.slice().buffer);
      return alignAudioStart(decoded, audio.offsetSeconds, audioContext);
    }
    return await audioContext.decodeAudioData(arrayBuffer);
  } catch {
    return undefined;
  }
}

/**
 * El tiempo 0 de una fuente es su primer fotograma de vídeo. Si el
 * audio empieza `offsetSeconds` después (+), se antepone silencio; si
 * empieza antes (−), se recorta el principio — así audio y vídeo
 * quedan sincronizados igual que en un MP4.
 */
function alignAudioStart(buffer: AudioBuffer, offsetSeconds: number, audioContext: BaseAudioContext): AudioBuffer {
  const offsetFrames = Math.round(offsetSeconds * buffer.sampleRate);
  if (offsetFrames === 0) return buffer;
  const length = buffer.length + offsetFrames;
  if (length <= 0) return buffer;
  const aligned = audioContext.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const source = buffer.getChannelData(channel);
    if (offsetFrames > 0) aligned.copyToChannel(source, channel, offsetFrames);
    else aligned.copyToChannel(source.subarray(-offsetFrames), channel, 0);
  }
  return aligned;
}
