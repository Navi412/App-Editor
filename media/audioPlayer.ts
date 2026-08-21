/**
 * Reproducción de una porción de un AudioBuffer ya decodificado, vía
 * Web Audio. Cada `play()` crea un AudioBufferSourceNode nuevo (son de
 * un solo uso por diseño de la API) empezando en `when` (tiempo del
 * reloj del AudioContext) y sonando exactamente [offsetSeconds,
 * offsetSeconds+durationSeconds) del buffer — así el audio recorta
 * igual que el vídeo, sin copiar datos.
 */
export interface AudioPlaybackHandle {
  stop(): void;
}

export function playAudioSlice(
  audioContext: AudioContext,
  buffer: AudioBuffer,
  offsetSeconds: number,
  durationSeconds: number,
  when: number,
): AudioPlaybackHandle {
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  const safeOffset = Math.max(0, Math.min(offsetSeconds, buffer.duration));
  const safeDuration = Math.max(0, Math.min(durationSeconds, buffer.duration - safeOffset));
  source.start(when, safeOffset, safeDuration);
  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        source.stop();
      } catch {
        // ya estaba parado (llegó al final por sí solo) — no pasa nada
      }
      source.disconnect();
    },
  };
}
