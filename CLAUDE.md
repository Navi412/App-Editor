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
  contenido, negro. Excepción única y acotada: un clip con `chromaKey`
  activo SÍ compone con la pista inmediatamente inferior, pero solo en
  la exportación — ver "Grading real y croma" más abajo.
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
- **Arrastrar un clip de vídeo a otra pista de vídeo — ampliación
  pedida explícitamente el 2026-09-30** (antes un clip se quedaba en la
  pista en la que se creó). `moveClipToTrack` en `core/timeline.ts`:
  solo entre pistas del MISMO tipo y nunca transiciones (son de su
  pista, funden entre SUS vecinos). El clip cae en el hueco de la pista
  destino donde queda su punto medio y se topa con los vecinos como en
  `moveClipTo`; si no cabe en ese hueco, lanza — en la UI
  (`beginClipMoveDrag`) eso significa que el clip sigue en su pista
  original mientras el cursor esté sobre un hueco demasiado pequeño. Su
  audio pegado viaja con él (es el mismo `Clip`). Los clips de las
  pistas de AUDIO independientes siguen sin gesto de mover (ni dentro
  de su pista ni entre pistas) — solo tienen el arrastre de volumen.
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

**Rendimiento como prioridad y acceso nativo al sistema de archivos —
ampliación de alcance pedida explícitamente el 2026-08-29.** El usuario
pidió explícitamente que la app se sienta y rinda como una de escritorio
real (DaVinci Resolve/Premiere), no como una web dentro de una ventana.
Dos consecuencias arquitectónicas, ambas en marcha:

- **Acceso nativo al sistema de archivos.** `electron/preload.cjs`
  expone `window.appVideo` (`getPathForFile`, `readFileAsBytes`,
  `fileExists`) vía `contextBridge.exposeInMainWorld` — el renderer
  SIGUE sin `nodeIntegration` y sin `require()` propio; solo el script
  de preload gana Node real, y decide explícitamente qué cruza hacia la
  página. Esto exige `sandbox: false` en `webPreferences` del
  `BrowserWindow` (el sandbox de preload, activado por defecto desde
  Electron 20, bloquea hasta `require("fs")` dentro del propio
  preload — comprobado en vivo, no solo en la documentación de
  Electron). `ui/electronBridge.ts` es el único punto de `/ui` que toca
  `window.appVideo`; su ausencia (bajo `npm run dev`, navegador normal
  sin Electron) es la propia señal de "no hay puente nativo, usa el
  `<input type=file>` de siempre" — sin ninguna rama de build distinta.
  `ProjectSource.filePath` (opcional, en `core/project.ts`) guarda la
  ruta absoluta capturada al cargar un archivo real (nunca sobre un
  `File` sintético reconstruido por `readFileFromPath` — `getPathForFile`
  no funciona sobre esos); al recargar un proyecto, `ui/main.ts` intenta
  releer cada fuente por su `filePath` guardado antes de pedirle nada al
  usuario, y solo cae al selector de archivos de siempre para las que de
  verdad falten o se hayan movido.
  Compromiso de seguridad asumido a propósito: `readFileAsBytes` puede
  leer cualquier archivo local que el usuario del SO pueda leer — para
  una app de escritorio de un solo usuario, sin contenido remoto, es un
  riesgo bajo y aceptado, no un descuido.
- **Timeline dibujada en canvas**, sustituyendo al DOM de `<div>`s por
  clip actual — ver el plan en curso, referenciado desde esta sección
  mientras se implementa por fases.

Deliberadamente **fuera** de esta ampliación: explorador/selector de
carpeta de medios y watcher de cambios en disco — no hay UI hoy para
"elegir una carpeta de proyecto", y añadirían complejidad real sin una
necesidad ya confirmada.

**Cuatro ampliaciones para acercar la app a un editor profesional
(DaVinci Resolve) — pedidas explícitamente el 2026-08-29**, tras un
análisis crítico de la brecha entre ambos. Cada una se explica por
separado porque son independientes entre sí:

- **Bin de medios.** Antes, reutilizar un archivo ya cargado para un
  segundo clip exigía volver a elegirlo con el selector de archivos
  (cada carga por `addClipFromFile` crea una `sourceId` nueva sin
  reutilizar nada). El panel "Bin de medios" (`ui/main.ts`,
  `renderMediaBin`/`addClipFromSource`) lista las fuentes ya cargadas
  con miniatura y un botón "+" que añade un clip nuevo de esa misma
  fuente al final de la pista de vídeo más arriba.

- **Máster de audio: EQ de 3 bandas + compresor/limitador.**
  `Timeline.masterAudio?: MasterAudio` (opcional — undefined se
  comporta exactamente como antes de esta ampliación, cero coste).
  `media/masterAudioChain.ts` (`createMasterAudioChain`) construye la
  cadena de `BiquadFilterNode`×3 + `DynamicsCompressorNode` + ganancia
  de compensación sobre CUALQUIER `BaseAudioContext` — el mismo código
  sirve para la reproducción en vivo (`ui/main.ts`,
  `scheduleAllTrackAudio`) y para la exportación
  (`export/exportTimeline.ts`, `renderExportAudio`), igual que ya hacía
  `allAudioSchedules`. `compressorParamsFromAmount` en
  `core/timeline.ts` es la ÚNICA traducción entre el mando único
  "cantidad" (0-100) del panel y los `threshold`/`ratio` reales del
  compresor — simplificación deliberada frente a exponer los 4-5
  parámetros crudos de un compresor real. Panel "Máster de audio" en
  el lateral, con botón "Aplicar" (mismo patrón que "Salida"), no
  controles en vivo mientras se arrastra.

- **Recorte profesional: ripple opt-in + shuttle J/K/L.** El recorte
  sin ripple (`trimClipIn`/`trimClipOut`, ver más arriba) sigue siendo
  el comportamiento POR DEFECTO — sin cambios. `trimClipInRipple`/
  `trimClipOutRipple` (`core/timeline.ts`) son variantes que ADEMÁS
  desplazan todos los clips de la MISMA pista que empiecen en o después
  del final original del clip recortado, por la diferencia exacta en
  ese final — así no se abre ni cierra un hueco. En la UI
  (`beginTrimDrag`) se activan manteniendo Mayús pulsado al empezar a
  arrastrar un asa de recorte (capturado una vez al inicio del gesto,
  no se relee en cada movimiento). J/K/L (`ui/main.ts`, el switch de
  `keydown`) son shuttle clásico de NLE: L reproduce, K para — ambos
  reutilizan `playFromPlayhead`/`stopPlayback` tal cual. J NO es
  reproducción real hacia atrás (el decodificador de este proyecto es
  solo-adelante, ver `media/frameSeeker.ts`/`createForwardFrameSeeker`
  y DESIGN.md §3) — retrocede un fotograma por pulsación (`stepFrame`),
  apoyándose en la repetición de tecla nativa del SO mientras se
  mantiene pulsada, igual que ya hacía `ArrowLeft`. Deliberadamente
  fuera de esta ampliación: roll edit (mover a la vez el límite entre
  dos clips adyacentes) — no encaja con que `startTicks` nunca se toque
  al recortar (ver más arriba), forzarlo habría producido una función
  confusa en vez de una herramienta real.

- **Grading real (WebGL) y croma.** Independiente y ADITIVO respecto a
  `colorFilter` (los 6 presets CSS de siempre, sin cambios) — un clip
  puede llevar `colorGrade?: ColorGrade` (primarias lift/gamma/gain por
  canal RGB + saturación + contraste + inversión, fórmula ASC CDL:
  `out = clamp(in·gain+lift, 0, 1) ^ (1/gamma)`, el estándar real de
  corrección de color, no una aproximación) y/o `chromaKey?: ChromaKey`
  (croma por distancia de color). `media/colorGradeGL.ts`
  (`ColorGradeRenderer`) es una única clase WebGL2 compartida por
  preview y exportación (una instancia por cada uno, igual que cada uno
  tiene su propio `AudioContext`/`OfflineAudioContext`): sube el
  `VideoFrame` como textura, aplica el shader, y deja el resultado en
  un `OffscreenCanvas` propio que `drawFrameFit` (`media/render.ts`)
  pinta con `ctx.drawImage` exactamente donde habría pintado el
  `VideoFrame` — mismo aspect-fit, mismo `ctx.filter` de los presets
  antiguos ENCIMA (orden fijo: grading real primero, filtro CSS
  después), cero divergencia entre preview y exportación. Si no hay
  grading/croma activo (el caso común) o WebGL2 no está disponible,
  `drawFrameFit` no toca la GPU para nada extra — el coste es
  exactamente el de siempre.
  **Limitación deliberada del croma**: solo compone con la pista de
  vídeo inmediatamente inferior (`resolveActiveVideoPositionBelow`) EN
  LA EXPORTACIÓN. La previsualización en directo sigue mostrando solo
  la pista superior (con el croma ya recortado, alfa real, pero sobre
  negro) — el motor de reproducción en vivo (`media/player.ts`) está
  construido alrededor de un único `VideoPlayer` activo empujando
  fotogramas por callback (`onFrame`), no de una tubería que pueda tirar
  de dos fuentes sincronizadas a la vez; forzarlo habría sido reescribir
  esa tubería (con el riesgo de reintroducir el bug de "reproducción
  congelada a mitad de GOP" ya resuelto una vez) por una previsualización
  perfecta que la exportación ya proporciona. Documentado explícitamente
  en la UI (panel de croma), no un olvido.

**Bandera de clip (`Clip.flagged`) — ampliación pedida explícitamente el
2026-08-30.** Estilo DaVinci Resolve: la tecla `G` (y el botón `G` de
la barra de la timeline) marca/desmarca el clip seleccionado. Es solo
un distintivo visual (`box-shadow` superior de color en
`.timeline-clip--flagged`), SIN efecto en reproducción ni exportación —
distinto del marcador de `M`, que es un punto en la regla, no en un
clip. `setClipFlagged` en `core/timeline.ts` (pura, misma forma que
`setClipColorFilter`); se serializa/valida en `core/project.ts` como
los demás campos opcionales de `Clip`.

**Fuera de alcance deliberadamente, salvo que se pida explícitamente
ampliarlo:** mover clips de las pistas de audio independientes, importar archivos
de solo audio (mp3/wav) como fuente propia para una pista de audio,
cambios de velocidad de reproducción de un CLIP (retiming/slow-motion
— distinto del shuttle J/K/L de arriba, que es solo transporte de
edición y no toca ningún dato del proyecto), roll edit, compositing
tipo Fusion (keying con tracking/despill, máscaras, nodos), soporte de
códecs RAW de cámara o más allá de lo que WebCodecs ya decodifique de
forma nativa.

No añadas nada de la lista de "fuera de alcance" aunque parezca trivial
— si aparece la tentación, es señal de que hay que parar y preguntar,
no de que hay una oportunidad de mejora. Si el usuario pide algo de la
lista, trátalo como una ampliación deliberada del alcance: quítalo de
la lista y documenta la decisión aquí, no lo implementes en silencio
sin actualizar este archivo.

## Interfaz

Rediseño pedido explícitamente el 2026-08-30 ("la interfaz y el menú
son mejorables · limpia y fácil de entender pero con estilo
profesional · estilos blancos y glass"). Cuatro cambios, todos sobre
`index.html` / `ui/styles.css` / `ui/main.ts` (más `electron/` para el
menú), sin tocar `/core`, `/media` ni `/export`:

- **Menú de aplicación.** En Electron hay una barra de menú NATIVA
  (`electron/main.cjs`, `buildAppMenu` → `Menu.setApplicationMenu`):
  Archivo / Editar / Ver / Pista / Ayuda. No reimplementa lógica: cada
  ítem manda una clave de acción por IPC (`electron/preload.cjs`
  expone `onMenuAction`), y `ui/main.ts` (`MENU_ACTIONS`) la resuelve
  haciendo `.click()` en el botón que YA existe en la interfaz —
  respeta su estado `disabled`. Aceleradores nativos SOLO en combos que
  el `keydown` del renderer no captura ya (Ctrl+O/S/E/0/±, Ctrl+/):
  poner acelerador nativo a teclas sueltas (C, M) o a Ctrl+Z las
  dispararía dos veces. En el navegador (`npm run dev`, sin
  `window.appVideo`) no hay barra nativa: el botón `☰` de la cabecera
  abre un desplegable DOM construido desde el mismo listado (`APP_MENU`)
  y refleja el `disabled` de cada control. En Electron ese botón se
  oculta. La cabecera queda: `☰` · título · nombre del proyecto ·
  Abrir vídeo · Deshacer/Rehacer · `?`. Guardar/Cargar pasan al menú
  (sus botones siguen en el DOM, `hidden`, porque el menú y varias
  partes de `ui/main.ts` referencian sus ids).

- **Barra de la línea de tiempo mínima** (2\ª iteración, pedida el
  2026-08-30). Primero se fundieron las dos barras que había (columna
  vertical de iconos + fila superior) en una sola; después se recortó a
  lo esencial: SOLO cinco botones "de una tecla" estilo NLE, cada uno
  con la letra de su atajo (`.tl-btn` / `.tl-key`), más un deslizador
  de volumen a la derecha:
  - **A** — seleccionar el clip del playhead (`selectClipAtPlayhead`)
  - **C** — cortar en el playhead (`splitAtPlayhead`)
  - **N** — imán/snapping on-off (`snappingEnabled`, ver abajo)
  - **G** — bandera del clip seleccionado (`Clip.flagged`, ver Alcance)
  - **M** — marcador en el playhead (`addMarkerAtPlayhead`)
  Todo lo demás (eliminar clip, texto, +pista vídeo/audio, zoom,
  insertar transición) se hace desde el menú (nativo o `☰`) y sus
  atajos; sus botones siguen en el DOM (`<div hidden>`) porque el menú
  los activa con `.click()`. El tipo/duración de transición se mudaron
  al panel de efectos (`#transition-duration` bajo "Transiciones",
  junto a los chips que se arrastran). El botón "Añadir marcador" que
  estaba en el panel lateral "Marcadores" también se fue a la barra
  (`#add-marker-button` es único, vive ahí ahora).
  - **`snappingEnabled`** (tecla N / botón N): interruptor global del
    imán, encendido por defecto. Lo consultan los TRES sitios que
    imantaban siempre: `snapTimelineTicks` (scrub del playhead + mover/
    recortar textos), el bucle de candidatos de `beginClipMoveDrag`, y
    el `snap()` interno de `beginTrimDrag`. Apagado = arrastre libre,
    sin pegado a bordes ni marcadores.

- **Volumen de monitor.** Deslizador `#master-volume` a la derecha de
  la barra de la timeline. Es un `GainNode` (`monitorGain`) que se
  intercala una sola vez entre la cadena de audio y
  `audioContext.destination` — sube/baja TODO lo que se oye en la
  previsualización. NO se guarda en el proyecto, NO interviene en la
  exportación (`export/exportTimeline.ts` tiene su propio
  `OfflineAudioContext`) y NO toca el `volume`/`volumeKeyframes` de
  ningún clip. Decisión pedida explícitamente el 2026-08-30 ("una barra
  de sonido general para todo, sin tocar el de las timelines").

- **Espaciado del inspector.** Los controles del panel lateral estaban
  muy apretados: se subieron los paddings/márgenes de
  `.panel-section-body`, `.field-group`, `.field-grid`, `.slider-row`,
  `.checkbox-row` y de los `input`/`select`. Solo CSS.

- **Bug corregido (2026-08-30): "al volver a un clip tras un hueco solo
  vuelve el audio, el vídeo se queda parado".** Al soltar un arrastre de
  MOVER clip (`beginClipMoveDrag.onUp`), y también al recortar
  (`beginTrimDrag.onUp`) o redimensionar una transición
  (`beginTransitionResizeDrag.onUp`), NO se llamaba a
  `refreshTimelineLayout()` — durante el arrastre solo se movía el clip
  en el DOM (`syncClipLeftInDom`). Resultado: el caché
  `timelineTotalTicks` se quedaba con el valor de ANTES de mover. Si el
  clip se movía más adelante (justo lo que pasa al "dejar un hueco"),
  `advanceFrom` creía que la timeline acababa antes de llegar al clip y
  disparaba "Reproducción terminada" — el audio, que se programa entero
  por adelantado en `playFromPlayhead`, seguía sonando; el vídeo se
  quedaba en el último fotograma. Arreglo: los tres `onUp` llaman ahora
  a `refreshTimelineLayout()`, y además `advanceFrom` recalcula la
  duración total desde `timeline` (`timelineDurationTicks`) en vez de
  fiarse del caché. De paso, `playClipFrom` re-ancla el vídeo al reloj
  del audio (`audioTimelineTicksNow`): tras un hueco reproducido en
  tiempo real el audio puede ir un pelín por delante, así que el vídeo
  arranca en ESE punto del clip, no en su primer fotograma, y no quedan
  desincronizados. En `media/player.ts`, `seekTo` marca
  `decoderNeedsKeyframe` en cuanto crea el decoder nuevo (no tras el
  flush) y cierra el decoder "en silencio" (`closeDecoderQuietly`) para
  que un flush rechazado no aborte el `seekTo` siguiente ni deje meter
  un delta en un decoder recién configurado (otra vía a "vídeo
  congelado, solo audio").

- **Bug corregido (2026-09-30): "tras un corte (C), al reproducir se
  para en el corte".** Al terminar el trozo A, `playClipFrom` trataba
  el trozo B como un salto nuevo (`seekTo`) aunque fuese continuación
  exacta del mismo archivo: el seek decodificaba el GOP entero hasta el
  corte y, como tras un `flush()` WebCodecs exige empezar por keyframe,
  al reanudar lo decodificaba OTRA vez. Con keyframes cada varios
  segundos (grabaciones de OBS/cámara, 1080p+) el vídeo se quedaba
  clavado en el corte mientras seguía el audio. Arreglo: si el clip
  anterior es de la misma fuente y B empieza exactamente donde acabó
  (en timeline y en archivo), se sigue con `player.play()` sin seek.
  De paso, `media/player.ts` descarta (`discardBeforeUs`) los
  fotogramas re-decodificados desde el keyframe anteriores al objetivo
  del seek — antes se pintaban y el playhead saltaba atrás y avanzaba
  en rápido al darle a play a mitad de un GOP.
  **Causa de fondo (encontrada después, el mismo día, probando en
  Electron — en Chrome no se reproducía):** `seekTo` acumulaba en
  `outputQueue` TODOS los fotogramas decodificados desde el keyframe
  hasta el objetivo y no cerraba ninguno hasta el final del `flush()`.
  El decoder por hardware tiene pocos búferes de salida (en Electron se
  atascaba con 8 `VideoFrame` abiertos) y abortaba el `flush()` sin
  llamar a su callback de error: cualquier seek a más de ~8 fotogramas
  de un keyframe fallaba en silencio — vídeo congelado al volver tras un
  corte o un hueco, audio sonando. Ahora el seek usa `seekSink`: se
  queda solo con el mejor candidato y cierra el resto según salen.
  `media/frameSeeker.ts` (exportación/transiciones, decoder software)
  hace lo mismo con `currentTargetUs`, para no acumular el GOP entero.

- **Inspector contextual.** El panel lateral ya no apila 7
  `<details>` siempre presentes. `renderInspector()` en `ui/main.ts`
  muestra SOLO lo relevante a la selección: un clip → "Clip" (recorte /
  audio / filtro + subsecciones plegables Grading y Croma); un texto →
  editor de texto; nada seleccionado → ajustes de proyecto (Salida ·
  Máster de audio · Marcadores) + un hint. "Bin de medios" y "Exportar"
  son siempre visibles (no dependen de la selección). `renderInspector`
  se llama desde `refreshTimelineLayout` (cubre casi todo) y desde
  `selectClipRef` / `syncTextEditorPanel` / `clearOverlaySelection`.
  El grading pasó de 11 `<input type=number>` a `<input type=range>`
  con lectura numérica (`<output>`, `refreshGradeOutputs`), y tiene
  **previsualización en vivo**: al arrastrar un slider de grading/croma
  se pinta el fotograma actual con `activeColorGrade`/`activeChromaKey`
  leídos del panel (`previewGradeLive`, throttled a fotograma) SIN
  escribirlos en el clip — eso sigue pasando solo con "Aplicar"
  (`applyGradeSettings`/`applyChromaSettings`), el modelo de historial
  no cambia. Si no se aplica, el siguiente `seekToTimelineTicks`/play
  restaura los valores guardados del clip.

- **Modo oscuro con interruptor** (pedido explícito del 2026-09-30).
  Botón ☾/☀ en la cabecera (`#theme-toggle-button`, junto a `?`) y
  Ver › "Modo oscuro / claro" en ambos menús (nativo con Ctrl+Mayús+D,
  combo que el `keydown` del renderer no captura; y el desplegable
  `☰`). `:root[data-theme="dark"]` en `ui/styles.css` redefine los
  mismos tokens (misma técnica neumórfica: superficie `#2a2d34`, luz
  gris apenas más clara, sombra casi negra; acento naranja `#ff6a2b`
  como la variante oscura de la referencia). Un script en línea en
  `index.html` fija `data-theme` ANTES del primer pintado (sin
  destello): preferencia guardada en `localStorage`
  (`appVideo.theme`, por equipo, no se guarda en el proyecto) o, si no
  hay, la del sistema operativo. `ui/main.ts` (`applyTheme`) solo
  sincroniza el icono y alterna. Cualquier color nuevo del CSS tiene que
  ser un token con valor en ambos temas, no un literal.

- **Tema claro neumórfico** (sustituye al "claro + glass" anterior —
  pedido explícito del 2026-09-30, imagen de referencia en
  `design-references/`). `color-scheme: only light` en claro y
  `only dark` en oscuro (+ `<meta name="color-scheme">`, que actualiza
  el mismo script/`applyTheme`). Toda la interfaz es UNA
  superficie opaca `--surface` (`#e4e9f2`, gris azulado); los
  controles salen de ella o se hunden en ella SOLO con sombras dobles
  (clara arriba-izquierda, oscura abajo-derecha), sin bordes ni
  transparencias ni `backdrop-filter`. Tokens en `:root`:
  `--nm-raised`/`--nm-raised-sm` (relieve: botones, tarjetas del
  inspector, carpetas de efectos, desplegables, modal) y
  `--nm-inset`/`--nm-inset-sm` (hundido: campos de texto/número,
  canal de los deslizadores, contenedor de la timeline, barra de
  progreso, píldora de estado). Pulsar un botón lo hunde (`:active`);
  un interruptor encendido (imán N) se queda hundido con el icono en
  acento `#2f6bff`, no con relleno de color. Deslizadores, casillas y
  scrollbars van estilizados a mano (`appearance: none`, al final de
  `ui/styles.css`). **Excepción a propósito**: el preview de vídeo
  (`.preview-canvas-wrap`) sigue siendo una isla oscura (`#0b0d12`),
  enmarcada como una pantalla en relieve — el vídeo se juzga mejor
  sobre un entorno neutro. Los clips de la timeline mantienen sus
  colores (miniatura/azul, transición morada). Nota: una extensión de
  modo oscuro del navegador (Dark Reader / Catppuccin) invierte encima
  los colores — no es un fallo del tema; en Electron no hay extensiones.

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
- **WebGL2** (`media/colorGradeGL.ts`), solo para el grading real/croma
  (ver "Grading real (WebGL) y croma" más abajo) — el resto del
  pipeline sigue siendo Canvas 2D; el resultado de WebGL se pinta sobre
  el Canvas 2D con `drawImage`, nunca sustituye su contexto.
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
          la app web como aplicación de escritorio real. El renderer
          sigue sin nodeIntegration ni require() propio
          (contextIsolation: true, nodeIntegration: false) — usa APIs
          web estándar (File, Canvas, WebCodecs, Web Audio) para todo
          salvo el puente estrecho de electron/preload.cjs
          (window.appVideo, ver "Rendimiento como prioridad..." más
          arriba), el único sitio con Node real (necesita
          sandbox: false, el preload por sí solo no basta desde
          Electron 20).
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
`electron.exe`, y colocar `dist/` + todo `electron/` (main.cjs Y
preload.cjs — antes solo main.cjs, ya no basta) + un `package.json`
mínimo en `resources/app/`) es el método oficial de Electron para
"manual packaging" y no necesita esos privilegios — es el que se usó
para generar la copia del Escritorio.

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
