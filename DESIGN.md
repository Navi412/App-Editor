# Diseño — editor de vídeo básico

## 0. Unidad de tiempo

`TICKS_PER_SECOND = 600_000`. Se eligió por ser altamente compuesto:
divisible exactamente por 24, 25, 30, 50, 60, 120 y por 1000 (milisegundos
exactos también). Las tasas "NTSC" (24000/1001, 30000/1001, 60000/1001)
no caen en un tick exacto — el error es de ~1.7µs por fotograma, es decir,
15 órdenes de magnitud menor que la duración de un fotograma (~33ms a 30fps).
Ese error nunca es suficiente para que `round(ticks / duraciónFotograma)`
dé un índice de fotograma equivocado, así que la conversión ticks→fotograma
siempre es exacta en la práctica aunque no sea exacta en el papel.

Se representan como `number` (entero, no `BigInt`): con timelines de hasta
~15.000 años seguimos dentro de `Number.MAX_SAFE_INTEGER`. No hace falta
`BigInt` y complicaría toda la aritmética sin beneficio real.

Todas las conversiones (segundos↔ticks, ticks↔fotograma-de-fuente) viven en
un único módulo de `/core` (`time.ts`), nunca inline en otro sitio.

## 1. Modelo de datos

```ts
interface SourceFile {
  id: string;
  // referencia al archivo real, gestionada por /media, no por /core
  frameRate: { numerator: number; denominator: number };
  width: number;
  height: number;
  durationTicks: number;
}

interface Clip {
  id: string;
  sourceId: string;
  sourceInTicks: number;   // punto de entrada, en ticks, dentro del tiempo de LA FUENTE
  sourceOutTicks: number;  // punto de salida, exclusivo
}

interface Track {
  id: string;
  clips: Clip[]; // orden = orden en la línea de tiempo
}

interface Timeline {
  track: Track;               // una sola pista en v1; modelado como array-de-uno
  outputResolution: { width: number; height: number };
  outputFrameRate: { numerator: number; denominator: number };
}
```

**Decisión deliberada: modelo "ripple", sin huecos.** Un `Clip` no
almacena su posición en la línea de tiempo. La posición se deriva
siempre como la suma acumulada de las duraciones de los clips
anteriores en el array. Ventajas:

- Reordenar es un `splice` de array. Cortar es partir un elemento en
  dos. Nunca hay que "recalcular posiciones" como paso aparte ni puede
  desincronizarse una posición guardada de la realidad — no existe tal
  campo.
- Elimina una categoría entera de bugs (huecos superpuestos, posiciones
  negativas, gaps que el usuario no pidió).

Coste: no hay huecos en la línea de tiempo en v1 (como una pista de
"insert edit" clásica). Si más adelante hace falta separar clips con un
hueco, se modela como un `Clip` especial de tipo "gap" en el array, no
añadiendo un campo de posición — mantiene la misma invariante.

`durationTicks` de un clip = `sourceOutTicks - sourceInTicks` (siempre
> 0, mínimo 1 fotograma de la fuente).

## 2. Línea de tiempo → (archivo, tiempo en el archivo)

```
walkTimeline(timeline, timelineTicks) -> { clip, sourceId, sourceTimeTicks }
```

Recorre `track.clips` acumulando duración hasta encontrar el clip que
contiene `timelineTicks`. `sourceTimeTicks = clip.sourceInTicks + (timelineTicks - inicioDelClipEnLaTimeline)`.

Para v1 (decenas de clips) un recorrido lineal es más que suficiente y
más fácil de razonar/testear que una estructura con sumas prefijadas.
Si el número de clips crece mucho, se puede añadir un array de sumas
acumuladas cacheado — sin cambiar la interfaz pública de la función.

Esta función es el corazón de `/core`: tanto la previsualización como
la exportación llaman exactamente a esta misma función para saber "qué
fotograma de qué archivo toca en el instante T". Un único punto de
verdad, dos consumidores.

## 3. Estrategia de decodificación para previsualización

- `/media` mantiene un **pool acotado de `VideoDecoder`** (2–3 activos),
  uno por `SourceFile` en uso reciente. Los decoders son caros de crear;
  no se crea uno por fotograma ni uno por clip.
- mp4box.js parsea el `moov` de cada fuente una vez al cargarla y
  produce la tabla de muestras: offset, tamaño, `is_sync` (keyframe),
  DTS/PTS por muestra. Con eso, para pedir "el fotograma en el tiempo T
  de la fuente X":
  1. Buscar (búsqueda binaria) el keyframe más cercano ≤ T.
  2. Alimentar al `VideoDecoder` los `EncodedVideoChunk` desde ese
     keyframe hasta la muestra objetivo, en orden de decodificación.
  3. Los fotogramas intermedios se decodifican (son necesarios como
     referencia para P/B-frames) pero solo se cachean/renderizan si
     también son útiles (ver caché).
- **Caché de fotogramas**: LRU de `VideoFrame` decodificados, clave
  `(sourceId, índiceDeFotogramaDeFuente)`. Límite por presupuesto de
  memoria estimado (`width * height * 1.5 * count`, formato YUV 4:2:0),
  no por número fijo de fotogramas, porque la resolución varía entre
  fuentes.
- **Qué se descarta**: todo lo que sale del LRU se cierra explícitamente
  con `.close()` en cuanto se evict — un `VideoFrame` retiene memoria
  GPU/nativa que el GC de JS no libera con prontitud.
- **Reproducción vs scrubbing** se tratan distinto:
  - *Reproducción*: hay un pequeño decode-ahead (ventana de ~1s) en un
    loop en background, para no depender de decodificar justo a tiempo
    en cada frame de rAF.
  - *Scrubbing*: es sensible a latencia, no a throughput. Al recibir un
    nuevo seek se marca como obsoleta cualquier decodificación en vuelo
    hacia el objetivo anterior, para no acumular trabajo redundante
    cuando el usuario arrastra el playhead rápido.

## 4. Clips con distinta resolución o distinta tasa de fotogramas

- El `Timeline` tiene una resolución y frame rate de salida propios
  (`outputResolution`, `outputFrameRate`), fijados al crear el proyecto
  — por defecto, los del primer clip añadido, pero editables por el
  usuario.
- El canvas de previsualización/composición siempre tiene el tamaño de
  `outputResolution`. Cada fotograma de fuente se dibuja con
  **aspect-fit** (letterbox/pillarbox con barras negras), nunca
  estirado — estirar es indistinguible de un "efecto" y el alcance dice
  no efectos. El fit no es opcional en v1 (no hay UI de "fill" todavía).
- **Frame rate en previsualización**: el reloj de reproducción no está
  cuantizado a fotogramas. Es continuo (dirigido por reloj de pared /
  rAF): en cada repintado se pregunta "¿qué fotograma de qué fuente
  corresponde a este instante de la timeline?" vía `walkTimeline` +
  "fotograma con PTS ≤ T más cercano" (frame hold, sin interpolación de
  movimiento — fuera de alcance). Esto hace que la previsualización sea
  best-effort/de tasa variable, que es el comportamiento estándar de
  cualquier NLE al hacer scrub o reproducir.
- **Frame rate en exportación**: tiene que ser determinista y
  cuantizada. Para cada fotograma de salida `k` (0..N-1):
  `timelineTicks = k * ticksPerOutputFrame`, se resuelve con la misma
  `walkTimeline`, se toma el fotograma de fuente con frame-hold (mismo
  algoritmo que la previsualización, aplicado en pasos fijos en vez de
  en tiempo real). Es la misma función muestreando la timeline; solo
  cambia quién la llama y con qué cadencia.

## 5. Estrategia de exportación

**No puede ser concatenar los MP4 de origen.** Razones:

1. Los puntos de recorte casi nunca caen en un keyframe. No se puede
   cortar un stream comprimido a mitad de GOP sin volver a codificar
   alrededor del corte — el archivo resultante no tendría un keyframe
   donde hace falta.
2. Las fuentes pueden diferir en resolución, frame rate, códec o
   espacio de color. Un único track de salida necesita un conjunto
   consistente de esos parámetros; la concatenación de contenedores no
   normaliza nada de eso.
3. v1 no lleva audio: hay que descartar las pistas de audio de origen
   aunque el vídeo se pudiera copiar tal cual.
4. La concatenación a nivel de contenedor (edit lists / `elst`, o
   pegado literal de cajas) es notoriamente inconsistente entre
   reproductores, y de todas formas no da recortes frame-accurate sin
   recodificar los GOP de los bordes — no hay atajo real.

**Pipeline de exportación**: por cada fotograma de salida (frame-quantizado,
ver §4) → decodificar el fotograma de fuente correspondiente (reutilizando
`/media`) → dibujarlo en un canvas offscreen a `outputResolution` con
aspect-fit → construir un `VideoFrame` a partir del canvas → `VideoEncoder.encode()`
→ el muxer (mp4box.js en modo creación de archivo) va escribiendo el MP4
de salida. Escritura incremental a disco vía File System Access API
cuando esté disponible, para no acumular el archivo entero en memoria en
exportaciones largas.

Detalles a vigilar:

- Códec de salida: H.264 (`avc1.640028` o similar), por ser el que hoy
  tiene mayor soporte de codificación por hardware vía WebCodecs entre
  navegadores — a confirmar con pruebas reales en la slice 5.
- Intervalo de keyframes del archivo de **salida**: un valor razonable
  fijo (p.ej. cada 2s), sin relación con los cortes de la timeline —
  ya no hace falta un keyframe por corte porque todo se recodifica.
- Backpressure: hay que respetar `encodeQueueSize` del `VideoEncoder`
  (y el equivalente del decoder) para no acumular memoria sin límite —
  esto merece su propio test en `/export`, no solo probarlo a ojo.

## 6. Plan de rebanadas verticales

Cada rebanada es demostrable de punta a punta (se puede enseñar
funcionando), y cada una añade una sola cosa nueva sobre la anterior.

1. **Pipeline mínimo**: cargar un archivo, decodificar el primer
   fotograma con WebCodecs+mp4box.js, dibujarlo en un canvas. Sin
   timeline. Objetivo: probar que la base técnica funciona antes de
   construir nada encima.
2. **Reproducción de un clip completo**: el mismo archivo, pero
   reproducido de principio a fin en el navegador (reloj de
   reproducción, loop de render, decode-ahead básico). Sigue sin haber
   modelo de `/core`.
3. **`/core` entra en juego**: un `Timeline` con un solo `Clip` que
   referencia ese archivo con `sourceInTicks`/`sourceOutTicks`. Recortar
   entrada/salida y hacer scrub dentro del rango recortado.
4. **Varios clips en la pista**: concatenación ordenada de N clips
   (posiblemente de archivos distintos). La reproducción cruza
   correctamente el límite entre clips (cambio de fuente, re-seek del
   decoder).
5. **Editar la timeline**: reordenar y cortar (split) desde la UI, con
   la previsualización reflejando el cambio al instante.
6. **Exportación**: tomar la timeline actual (N clips, posibles
   fuentes distintas) y exportarla a un único MP4 vía el pipeline
   decode→render→encode→mux.
7. **Endurecer mezclas heterogéneas**: clips con distinta resolución o
   frame rate en la misma timeline, aspect-fit correcto, casos límite
   de seeking, ajuste de tamaños de caché, manejo de códecs no
   soportados por el navegador.

No se empieza la rebanada N+1 sin que la N sea demostrable.
