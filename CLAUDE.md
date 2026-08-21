# App Video — editor de vídeo en el navegador (camino a app de escritorio)

El objetivo final es una aplicación de escritorio real, no solo un spike
de navegador — ver memoria de proyecto. El alcance de abajo es el
vigente ahora, no un techo fijo: se ha ido ampliando por petición
explícita del usuario a medida que el proyecto avanza.

## Alcance

Varias pistas de vídeo y de audio, añadibles/quitables por el usuario
(botones "+ pista de vídeo"/"+ pista de audio" junto a la línea de
tiempo). Cargar clips, recortar entrada/salida, mover clips en el
tiempo, cortar (split), añadir texto superpuesto (arrastrable en el
preview, con tipografía elegible), huecos entre clips, transiciones
básicas entre clips de una misma pista (fundido cruzado / fundido a
negro), previsualizar (con sonido), exportar a MP4 (con audio).

**Multipista, audio independiente y huecos como espacio implícito —
ampliación de alcance pedida explícitamente el 2026-08-21.** Sustituye
por completo el modelo anterior de una única pista con el audio de
cada clip pegado a su vídeo:

- `Timeline.tracks: Track[]` (antes `Timeline.track: Track` singular).
  El orden del array es el orden de composición: índice más alto =
  capa más arriba. `Track.kind` es `"video"` o `"audio"`; `Track.hidden`
  excluye la pista entera de previsualización/exportación (icono ojo
  en vídeo, altavoz/mute en audio — misma semántica: vídeo oculto
  también silencia el audio pegado a sus clips). `Track.name` opcional
  (editable haciendo clic en el nombre del gutter, `renameTrack` en
  `core/timeline.ts`) — sin él, la UI muestra un nombre automático
  ("Vídeo N"/"Audio N" según su posición entre las de su tipo).
- **Composición de vídeo**: capas opacas. Se recorre `Timeline.tracks`
  de arriba a abajo y se dibuja la primera pista de vídeo no oculta que
  tenga un clip en ese instante (`resolveActiveVideoPosition` en
  `core/timeline.ts`) — sin mezcla alfa real. Si ninguna tiene
  contenido, negro.
- **Mezcla de audio**: TODAS las pistas no ocultas suenan a la vez y se
  mezclan — tanto el audio pegado a los clips de las pistas de vídeo
  (independientemente de si están tapadas visualmente por una pista de
  vídeo superior) como los clips propios de las pistas de audio. El
  audio no tiene concepto de "capas que se tapan".
- **Pistas de audio con clips independientes**: ya no todo audio va
  forzosamente pegado a un clip de vídeo con el mismo `sourceId`. Una
  pista de audio lleva sus propios `Clip` (mismo tipo, sin vídeo
  asociado) — hoy solo pueden contener audio de fuentes de vídeo ya
  cargadas (importar un archivo de solo audio, p.ej. mp3, sigue fuera
  de alcance salvo que se pida ampliarlo aparte).
- **`Clip.startTicks`** sustituye el modelo "ripple" anterior (posición
  derivada de sumar las duraciones de los clips previos en el array):
  cada clip guarda su posición absoluta de inicio en su pista. Un
  hueco ya NO es un objeto (`kind: "gap"` ha desaparecido) — es
  simplemente el tramo sin clip entre dos posiciones. Mover un clip
  (`moveClipTo`) solo cambia su `startTicks`, con tope contra sus
  vecinos inmediatos de la MISMA pista (nunca solapamiento parcial, ni
  "pasar a través" de un vecino); recortar (`trimClipIn`/`trimClipOut`)
  ya no desplaza automáticamente al resto de la pista (sin ripple
  automático) — el hueco que deja o cierra un recorte es siempre
  explícito.
- **Arrastrar un clip entre pistas no está soportado** — un clip se
  queda en la pista en la que se creó. Es una decisión de alcance
  deliberada para acotar el tamaño de esta ampliación, no un olvido; se
  puede pedir como ampliación aparte.
- Las transiciones siguen siendo un concepto por-pista-de-vídeo (funden
  entre los dos clips vecinos de SU MISMA pista): no reproducen vídeo
  propio, congelan el último fotograma del clip anterior y el primero
  del siguiente y funden entre ambos durante su propia duración — la
  vecindad se resuelve por coincidencia exacta de posición
  (`neighborsOfTransition`), no por adyacencia de índice de array.

**Volumen por trozos dentro de un clip — ampliación de alcance pedida
explícitamente el 2026-08-21.** Un clip puede llevar, además de su
`volume` plano de siempre, una lista opcional `volumeKeyframes` de
puntos `{ offsetTicks, volume }` (ticks relativos al inicio del propio
clip). Sin puntos, el volumen sigue siendo el escalar plano de
siempre. Con puntos, se interpola linealmente entre ellos —
`volumeAtOffsetTicks`/`volumeAutomationFrom` en `core/timeline.ts` son
el único sitio que sabe hacer esa interpolación; tanto la reproducción
(`media/audioPlayer.ts`, vía `GainNode.gain.linearRampToValueAtTime`)
como la exportación (`export/exportTimeline.ts`, mismo mecanismo sobre
`OfflineAudioContext`) consumen esos mismos puntos, nunca recalculan
la rampa por su cuenta. En la UI se editan Alt+clic/arrastrando
directamente sobre la pista de audio de la línea de tiempo — no hay
edición de keyframes de vídeo ni de otros parámetros, solo de volumen.

**Filtros de color — ampliación de alcance pedida explícitamente el
2026-08-21.** Un clip puede llevar un `colorFilter` plano (uno de un
catálogo fijo: blanco y negro, sepia, invertido, cálido, frío, alto
contraste — `ColorFilterType` en `core/types.ts`), aplicado a todo su
rango recortado, sin variar en el tiempo — a diferencia de
`volumeKeyframes`, no hay keyframes de filtro. `colorFilterCss` en
`media/render.ts` es el único sitio que traduce el filtro a la sintaxis
CSS `filter()` de Canvas 2D; tanto el preview en vivo como la
exportación pasan por `drawFrameFit` con ese mismo valor, así que no
pueden divergir en qué se ve. Se aplica arrastrando un ítem desde el
panel de efectos (a la izquierda del preview) hasta un clip de la
línea de tiempo — nunca con un botón de "aplicar", a petición explícita
del usuario; quitarlo sí tiene un `<select>` en el panel de recorte,
porque dejar el filtro sin ninguna forma de retirarlo sería una trampa
de usabilidad. Las transiciones (ya en alcance) se insertan de la
misma forma, arrastradas desde ese mismo panel.

**Fuera de alcance deliberadamente, salvo que se pida explícitamente
ampliarlo:** arrastrar un clip de una pista a otra, importar archivos
de solo audio (mp3/wav) como fuente propia para una pista de audio,
cambios de velocidad.

No añadas nada de la lista de "fuera de alcance" aunque parezca trivial
— si aparece la tentación, es señal de que hay que parar y preguntar,
no de que hay una oportunidad de mejora. Si el usuario pide algo de la
lista, trátalo como una ampliación deliberada del alcance: quítalo de
la lista y documenta la decisión aquí, no lo implementes en silencio
sin actualizar este archivo.

## Stack

- **TypeScript** (`strict: true`, sin `any` salvo en los bordes con APIs del
  navegador que no lo tipan bien).
- **WebCodecs** (`VideoDecoder` / `VideoEncoder`) para decodificar y
  codificar fotogramas. No usamos `<video>`/`MediaRecorder` para nada del
  pipeline de edición — solo WebCodecs nos da control fotograma a fotograma.
- **mp4box.js** para demuxear (leer `moov`, tabla de muestras, keyframes) y
  muxear el contenedor MP4 de salida.
- **Canvas 2D** (`OffscreenCanvas` donde se pueda, para no bloquear el hilo
  principal) para componer cada fotograma antes de previsualizar o codificar.
- Sin framework de UI pesado. UI en TypeScript + DOM directo, o como mucho
  `lit`/preact si `/ui` se vuelve inmanejable — decisión a tomar solo si
  hace falta, no por adelantado.
- Bundler/dev server: **Vite**. Test runner: **Vitest**. (Propuesta —
  confirmar antes de instalar nada; ninguna decisión aquí es sagrada.)

## Regla de oro

**La línea de tiempo es un modelo de datos puro, independiente de los
archivos.** Un `Clip` es una referencia (`sourceId` + rango de tiempo),
nunca píxeles ni bytes copiados. `/core` no debe importar nada de
`/media`, WebCodecs, mp4box, ni el DOM. Toda la lógica de línea de
tiempo (recortar, ordenar, cortar, mapear tiempo→archivo) tiene que
poder testearse con datos inventados, sin abrir un solo fichero de
vídeo real. Si un test de `/core` necesita un `.mp4` en disco, el
diseño está roto.

## Unidad de tiempo

**Ticks enteros a 600.000 por segundo**, en todo el proyecto. Nunca
segundos en coma flotante, nunca números de fotograma como unidad de
posición. Ver `DESIGN.md` §1 para la justificación completa (resumen:
600.000 es múltiplo de todas las tasas de fotogramas comunes salvo las
de 1001, donde el error de redondeo es de ~1.7µs — quince órdenes de
magnitud por debajo de la duración de un fotograma, así que nunca
genera ambigüedad al reconvertir a índice de fotograma).

Un índice de fotograma de una fuente es siempre un valor **derivado**,
calculado on-demand con la frame rate racional de esa fuente. No se
almacena como campo paralelo a los ticks en ningún sitio — eso es
exactamente el tipo de mezcla de unidades que causa bugs de
sincronización.

## Estructura

```
/core     modelo de línea de tiempo, Clip, Track (multipista), Timeline;
          aritmética de tiempo (ticks ↔ segundos ↔ índice de fotograma
          de una fuente); operaciones puras: mover, cortar, recortar
          in/out, gestionar pistas. Cero dependencias de
          WebCodecs/mp4box/DOM.
/media    decodificación de vídeo (WebCodecs + mp4box.js) y de audio
          (Web Audio API, decodeAudioData), caché de fotogramas,
          gestión del pool de VideoDecoder. Sabe leer archivos reales.
/export   pipeline de renderizado a fotograma fijo + VideoEncoder,
          resample/encode de audio + AudioEncoder, mux con mp4box.js
          (vídeo y audio en el mismo archivo). Consume /core y /media,
          no al revés.
/ui       DOM, controles de línea de tiempo, reproductor de previsualización.
/electron Proceso principal de Electron (electron/main.cjs) — empaqueta
          la app web como aplicación de escritorio real. Sin preload ni
          IPC: el renderer usa solo APIs web estándar (File, Canvas,
          WebCodecs, Web Audio), nunca Node — contextIsolation: true,
          nodeIntegration: false.
/tests    tests de integración que sí tocan archivos de vídeo reales
          (fixtures pequeños). Los tests unitarios de /core viven junto
          al código que testean, no aquí.
```

## Empaquetado de escritorio

`npm run electron:start` compila y abre la app en una ventana de
Electron (Chromium empaquetado, no WebView2 — evita depender de la
versión de WebView2 instalada en cada máquina para WebCodecs/
OffscreenCanvas). `npm run electron:build` genera un instalador con
electron-builder — en esta máquina falla por un problema conocido de
electron-builder en Windows sin el Modo de desarrollador activado
(necesita crear symlinks para herramientas de macOS que no usamos). El
empaquetado manual (copiar `node_modules/electron/dist`, renombrar
`electron.exe`, y colocar `dist/` + `electron/main.cjs` + un
`package.json` mínimo en `resources/app/`) es el método oficial de
Electron para "manual packaging" y no necesita esos privilegios — es
el que se usó para generar la copia del Escritorio.

Dependencias en una sola dirección: `ui → export → media → core`, y
`core` no depende de nada del proyecto. Si algún día `core` necesita
saber algo de `media`, es que la abstracción está mal puesta.

## Convenciones

- Cada `VideoFrame` de WebCodecs se cierra explícitamente (`.close()`)
  en cuanto deja de hacer falta — no confiar en el GC para memoria
  GPU/nativa.
- Las funciones de `/core` son puras: reciben el `Timeline` y devuelven
  un `Timeline` nuevo (o un valor derivado), nunca mutan in place.
- Ver `DESIGN.md` para el resto de decisiones de diseño y el plan de
  rebanadas verticales.
