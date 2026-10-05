/**
 * Construcción de las cadenas de códec que WebCodecs exige en
 * `VideoDecoderConfig.codec` ("avc1.64001f", "hvc1.1.6.L93.B0",
 * "av01.0.08M.08", "vp09.00.50.08"...). mp4box.js ya las da hechas para
 * MP4/MOV; los demuxers propios (Matroska/WebM y MPEG-TS) solo tienen
 * los registros de configuración o los NAL de parámetros, así que la
 * traducción vive aquí, en funciones puras testeables con bytes
 * inventados.
 */

function hex2(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/** H.264 a partir de un AVCDecoderConfigurationRecord (avcC): bytes 1-3 = profile, compatibilidad, level. */
export function avcCodecFromAvcC(avcC: Uint8Array): string {
  if (avcC.length < 4) throw new Error("Registro avcC demasiado corto");
  return `avc1.${hex2(avcC[1]!)}${hex2(avcC[2]!)}${hex2(avcC[3]!)}`;
}

/** H.264 a partir del NAL de SPS (con su byte de cabecera): mismos tres bytes que en avcC, justo detrás de la cabecera. */
export function avcCodecFromSps(spsNal: Uint8Array): string {
  if (spsNal.length < 4) throw new Error("SPS de H.264 demasiado corto");
  return `avc1.${hex2(spsNal[1]!)}${hex2(spsNal[2]!)}${hex2(spsNal[3]!)}`;
}

/** Invierte el orden de los 32 bits (los general_profile_compatibility_flags van "al revés" en la cadena de códec HEVC). */
function reverseBits32(value: number): number {
  let result = 0;
  for (let i = 0; i < 32; i++) {
    result = (result << 1) | ((value >>> i) & 1);
  }
  return result >>> 0;
}

/**
 * HEVC a partir de los 12 bytes de general_profile_tier_level, que
 * tienen la misma disposición en el hvcC (bytes 1-12) y en el RBSP del
 * SPS (bytes 1-12, tras el byte de vps_id/max_sub_layers):
 * profile_space(2) tier(1) profile_idc(5) · compat(32) · constraint(48) · level(8).
 * Formato ISO/IEC 14496-15 anexo E.
 */
function hevcCodecFromProfileTierLevel(ptl: Uint8Array, prefix: "hvc1" | "hev1"): string {
  if (ptl.length < 12) throw new Error("profile_tier_level de HEVC demasiado corto");
  const profileSpace = ptl[0]! >> 6;
  const tier = (ptl[0]! >> 5) & 1;
  const profileIdc = ptl[0]! & 0x1f;
  const compat = ((ptl[1]! << 24) | (ptl[2]! << 16) | (ptl[3]! << 8) | ptl[4]!) >>> 0;
  const constraints = Array.from(ptl.subarray(5, 11));
  while (constraints.length > 0 && constraints[constraints.length - 1] === 0) constraints.pop();
  const level = ptl[11]!;
  const space = ["", "A", "B", "C"][profileSpace]!;
  const parts = [
    prefix,
    `${space}${profileIdc}`,
    reverseBits32(compat).toString(16),
    `${tier ? "H" : "L"}${level}`,
    ...constraints.map((byte) => byte.toString(16).toUpperCase()),
  ];
  return parts.join(".");
}

/** HEVC a partir de un HEVCDecoderConfigurationRecord (hvcC). */
export function hevcCodecFromHvcC(hvcC: Uint8Array): string {
  if (hvcC.length < 13) throw new Error("Registro hvcC demasiado corto");
  return hevcCodecFromProfileTierLevel(hvcC.subarray(1, 13), "hvc1");
}

/** Quita los bytes de prevención de emulación (00 00 03 → 00 00) de un NAL: el RBSP real. */
export function nalToRbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of nal) {
    if (zeros >= 2 && byte === 0x03) {
      zeros = 0;
      continue;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

/** HEVC a partir del NAL de SPS (cabecera de 2 bytes incluida). Prefijo hev1: sin hvcC, el flujo va en Annex B con los parámetros en banda. */
export function hevcCodecFromSps(spsNal: Uint8Array): string {
  // Solo hacen falta los primeros bytes; quitar la emulación en el NAL
  // entero sería trabajo inútil.
  const rbsp = nalToRbsp(spsNal.subarray(0, Math.min(spsNal.length, 32)));
  // rbsp[0..1] = cabecera NAL; rbsp[2] = vps_id(4) max_sub_layers(3) nesting(1).
  return hevcCodecFromProfileTierLevel(rbsp.subarray(3, 15), "hev1");
}

/** AV1 a partir de un AV1CodecConfigurationRecord (av1C): "av01.P.LLT.DD". */
export function av1CodecFromAv1C(av1C: Uint8Array): string {
  if (av1C.length < 4) throw new Error("Registro av1C demasiado corto");
  const profile = av1C[1]! >> 5;
  const level = av1C[1]! & 0x1f;
  const tier = av1C[2]! >> 7;
  const highBitdepth = (av1C[2]! >> 6) & 1;
  const twelveBit = (av1C[2]! >> 5) & 1;
  const bitDepth = highBitdepth ? (twelveBit ? 12 : 10) : 8;
  return `av01.${profile}.${level.toString().padStart(2, "0")}${tier ? "H" : "M"}.${bitDepth.toString().padStart(2, "0")}`;
}

/**
 * VP9: "vp09.PP.LL.DD". Perfil y profundidad salen de la cabecera sin
 * comprimir del primer fotograma (frame_marker, profile_low/high_bit y,
 * en perfiles 2-3 de un keyframe, ten_or_twelve_bit tras el código de
 * sincronía). El nivel no se puede saber sin analizar el flujo entero:
 * se declara 5.0, que cubre hasta 4K — Chromium no lo usa para decidir
 * si decodifica.
 */
export function vp9CodecFromFrame(frame: Uint8Array): string {
  let bitPos = 0;
  const readBit = (): number => {
    const byte = frame[bitPos >> 3];
    if (byte === undefined) throw new Error("Fotograma VP9 truncado");
    const bit = (byte >> (7 - (bitPos & 7))) & 1;
    bitPos++;
    return bit;
  };
  let profile = 0;
  let bitDepth = 8;
  try {
    readBit();
    readBit(); // frame_marker
    const low = readBit();
    const high = readBit();
    profile = (high << 1) | low;
    if (profile === 3) readBit(); // reserved_zero
    const showExisting = readBit();
    if (!showExisting) {
      const frameType = readBit(); // 0 = KEY_FRAME
      readBit(); // show_frame
      readBit(); // error_resilient_mode
      if (frameType === 0) {
        bitPos += 24; // frame_sync_code
        if (profile >= 2) bitDepth = readBit() ? 12 : 10;
      }
    }
  } catch {
    // Cabecera ilegible: perfil 0, 8 bits — el caso abrumadoramente común.
  }
  return `vp09.${hex2(profile)}.50.${bitDepth.toString().padStart(2, "0")}`;
}
