import { compressorParamsFromAmount } from "../core/timeline";
import type { MasterAudio } from "../core/types";

/**
 * Cadena de audio del bus máster: EQ de 3 bandas + compresor/limitador
 * + ganancia de compensación — ver MasterAudio en core/types.ts.
 * Reproducción en directo (ui/main.ts) y exportación
 * (export/exportTimeline.ts) llaman a esta misma función sobre su
 * propio `BaseAudioContext` (uno en vivo, uno `OfflineAudioContext`)
 * para no poder divergir en qué suena — mismo principio que
 * `allAudioSchedules`/`scheduleGain`.
 */
export interface MasterAudioChain {
  /** Nodo al que hay que conectar cada fuente de audio (en vez de `destination` directamente). */
  input: AudioNode;
  /** Libera los nodos creados — llamar al terminar la sesión de reproducción/exportación. */
  disconnect(): void;
}

/**
 * Si `settings` es undefined o `enabled` es false, `input` ES
 * `destination` directamente (bypass total, cero nodos de más, cero
 * coste) — así un proyecto sin `masterAudio` configurado suena
 * exactamente igual que antes de esta ampliación.
 */
export function createMasterAudioChain(
  audioContext: BaseAudioContext,
  destination: AudioNode,
  settings: MasterAudio | undefined,
): MasterAudioChain {
  if (!settings || !settings.enabled) {
    return { input: destination, disconnect() {} };
  }

  const low = audioContext.createBiquadFilter();
  low.type = "lowshelf";
  low.frequency.value = 200;
  low.gain.value = settings.eqLowDb;

  const mid = audioContext.createBiquadFilter();
  mid.type = "peaking";
  mid.frequency.value = 1500;
  mid.Q.value = 0.8;
  mid.gain.value = settings.eqMidDb;

  const high = audioContext.createBiquadFilter();
  high.type = "highshelf";
  high.frequency.value = 5000;
  high.gain.value = settings.eqHighDb;

  const { thresholdDb, ratio } = compressorParamsFromAmount(settings.compressionAmount);
  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.value = thresholdDb;
  compressor.ratio.value = ratio;
  compressor.knee.value = 20;
  compressor.attack.value = 0.01;
  compressor.release.value = 0.25;

  const makeup = audioContext.createGain();
  makeup.gain.value = Math.pow(10, settings.makeupGainDb / 20);

  low.connect(mid);
  mid.connect(high);
  high.connect(compressor);
  compressor.connect(makeup);
  makeup.connect(destination);

  return {
    input: low,
    disconnect() {
      low.disconnect();
      mid.disconnect();
      high.disconnect();
      compressor.disconnect();
      makeup.disconnect();
    },
  };
}
