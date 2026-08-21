# App Video — editor de vídeo en el navegador (camino a app de escritorio)

El objetivo final es una aplicación de escritorio real, no solo un spike
de navegador — ver memoria de proyecto. El alcance de abajo es el
vigente ahora, no un techo fijo: se ha ido ampliando por petición
explícita del usuario a medida que el proyecto avanza.

## Alcance

Una sola pista de vídeo, con su pista de audio asociada (el audio de
cada clip viaja pegado a su vídeo — mismo `sourceId`, mismo recorte;
no es una pista independiente que se pueda desincronizar). Cargar
clips, recortar entrada/salida, ordenar, cortar (split), añadir texto
superpuesto, previsualizar (con sonido), exportar a MP4 (con audio).

**Fuera de alcance deliberadamente, salvo que se pida explícitamente
ampliarlo:** transiciones, efectos/filtros de vídeo, multipista de
vídeo (varios clips de vídeo superpuestos), cambios de velocidad.

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
/core     modelo de línea de tiempo, Clip, Track, Timeline; aritmética de
          tiempo (ticks ↔ segundos ↔ índice de fotograma de una fuente);
          operaciones puras: cortar, reordenar, recortar in/out.
          Cero dependencias de WebCodecs/mp4box/DOM.
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
