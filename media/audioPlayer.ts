import type { VolumeAutomationPoint } from "../core/timeline";

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

/** Programa la rampa de ganancia (ver core/timeline.ts volumeAutomationFrom) sobre un GainNode ya creado, ancladas a `when`. Reutilizada también por export/exportTimeline.ts. */
export function scheduleGain(gainParam: AudioParam, points: readonly VolumeAutomationPoint[], when: number): void {
  const first = points[0];
  gainParam.setValueAtTime(first ? first.volume : 1, when);
  for (let i = 1; i < points.length; i++) {
    gainParam.linearRampToValueAtTime(points[i]!.volume, when + points[i]!.offsetSeconds);
  }
}

/**
 * `BaseAudioContext` en vez de `AudioContext`: así también sirve para un
 * `OfflineAudioContext` (export/exportTimeline.ts), que comparte
 * createBufferSource/createGain pero no es un AudioContext en directo.
 * `destination` es explícito (en vez de `audioContext.destination`
 * siempre) para poder enrutar a través del bus máster — ver
 * media/masterAudioChain.ts — sin que este módulo necesite saber nada
 * de EQ/compresión.
 */
export function playAudioSlice(
  audioContext: BaseAudioContext,
  destination: AudioNode,
  buffer: AudioBuffer,
  offsetSeconds: number,
  durationSeconds: number,
  when: number,
  gain: number | VolumeAutomationPoint[] = 1,
): AudioPlaybackHandle {
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  const gainNode = audioContext.createGain();
  if (Array.isArray(gain)) {
    scheduleGain(gainNode.gain, gain, when);
  } else {
    gainNode.gain.value = gain;
  }
  source.connect(gainNode);
  gainNode.connect(destination);
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
      gainNode.disconnect();
    },
  };
}
