/**
 * Un texto superpuesto en la timeline. No pertenece a ningún clip —
 * vive en coordenadas absolutas de la timeline (startTicks/endTicks),
 * igual que los marcadores, así que sobrevive a reordenar/recortar
 * clips sin necesidad de re-mapearlo.
 */
export interface TextOverlay {
  id: string;
  /** Ticks de la timeline en los que empieza a mostrarse (inclusive). */
  startTicks: number;
  /** Ticks de la timeline en los que deja de mostrarse (exclusive). */
  endTicks: number;
  text: string;
  /** Posición del centro del texto, en % del ancho/alto del frame (0-100). */
  xPercent: number;
  yPercent: number;
  fontSizePx: number;
  color: string;
  /** Valor CSS font-family — ver ui/main.ts TEXT_FONT_OPTIONS para las opciones "básicas" que ofrece la UI. */
  fontFamily: string;
}

/** Los overlays activos en un instante de la timeline, en el orden en que deben dibujarse. */
export function activeTextOverlaysAt(overlays: TextOverlay[], ticks: number): TextOverlay[] {
  return overlays.filter((overlay) => ticks >= overlay.startTicks && ticks < overlay.endTicks);
}
