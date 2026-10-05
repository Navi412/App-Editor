// Preload de Electron. Un preload SIEMPRE tiene acceso completo a Node.js
// (para eso existe), sin importar contextIsolation/nodeIntegration del
// renderer — contextBridge es lo que limita qué cruza hacia la página
// aislada. Por eso las operaciones de fs viven aquí mismo, sin necesitar
// ipcMain/IPC: no hay nada que reenviar al proceso principal.
//
// Superficie deliberadamente mínima (ver CLAUDE.md): dar una ruta
// absoluta real a partir de un File ya elegido por el usuario, releer ese
// archivo por ruta sin volver a pedirlo, y comprobar si sigue existiendo.
// Nada de explorador de carpetas ni watcher — no hay UI hoy para "elegir
// una carpeta de proyecto", y no hace falta anticiparla sin un caso de
// uso ya confirmado.
//
// Compromiso de seguridad asumido a propósito: readFileAsBytes es, en la
// práctica, "lee cualquier archivo local que el usuario del SO pueda
// leer". Para una app de escritorio de un solo usuario, sin contenido
// remoto, es un riesgo bajo — y siempre se invoca con una ruta que o bien
// viene de getPathForFile (un archivo que el propio usuario acaba de
// elegir) o de un JSON de proyecto que el propio usuario escribió.
const { contextBridge, ipcRenderer, webUtils } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

// Caché de proxies de edición (media/proxy.ts) en disco, para no
// regenerarlos en cada sesión. La página solo puede nombrar entradas por
// una clave hexadecimal (hash calculado en el renderer): nunca rutas, así
// que esto no amplía qué puede escribir — solo dentro de esta carpeta.
const PROXY_CACHE_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "AppVideo", "proxies");
const PROXY_CACHE_MAX_BYTES = 3 * 1024 * 1024 * 1024;
const PROXY_KEY = /^[0-9a-f]{16,64}$/;

function proxyCachePath(key) {
  if (!PROXY_KEY.test(key)) throw new Error("Clave de caché inválida");
  return path.join(PROXY_CACHE_DIR, key + ".proxy");
}

/** Borra los proxies más antiguos (por último uso) hasta quedar por debajo del tope. */
async function pruneProxyCache() {
  const names = await fs.readdir(PROXY_CACHE_DIR).catch(() => []);
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".proxy")) continue;
    const full = path.join(PROXY_CACHE_DIR, name);
    const stat = await fs.stat(full).catch(() => undefined);
    if (stat) entries.push({ full, size: stat.size, used: stat.mtimeMs });
  }
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  entries.sort((a, b) => a.used - b.used);
  for (const entry of entries) {
    if (total <= PROXY_CACHE_MAX_BYTES) break;
    await fs.rm(entry.full, { force: true });
    total -= entry.size;
  }
}

contextBridge.exposeInMainWorld("appVideo", {
  /** Ruta absoluta real de un File ya elegido por el usuario (selector nativo o input de proyecto). Síncrono, sin IPC. */
  getPathForFile(file) {
    return webUtils.getPathForFile(file);
  },
  /** Bytes de un archivo por ruta absoluta, listos para envolver en un File real (ver ui/electronBridge.ts) — nunca se usa aquí un File de por sí, así que /media no necesita saber que esto existe. */
  async readFileAsBytes(filePath) {
    const buffer = await fs.readFile(filePath);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  },
  /** Tamaño en bytes de un archivo por ruta. */
  async fileSize(filePath) {
    return (await fs.stat(filePath)).size;
  },
  /** Bytes [start, end) de un archivo por ruta, sin leerlo entero — para leer vídeos grandes bajo demanda (media/sampleData.ts). */
  async readFileRange(filePath, start, end) {
    const handle = await fs.open(filePath, "r");
    try {
      const length = Math.max(0, end - start);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead);
    } finally {
      await handle.close();
    }
  },
  /** Tamaño y fecha de modificación de un archivo por ruta (para reconocer si cambió). */
  async fileStat(filePath) {
    const stat = await fs.stat(filePath);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  },
  /** Proxy guardado con esa clave, o null. Marca su uso (para la limpieza por antigüedad). */
  async proxyCacheRead(key) {
    const file = proxyCachePath(key);
    try {
      const buffer = await fs.readFile(file);
      const now = new Date();
      await fs.utimes(file, now, now).catch(() => {});
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    } catch {
      return null;
    }
  },
  /** Guarda un proxy con esa clave y limpia la caché si pasa del tope. */
  async proxyCacheWrite(key, bytes) {
    await fs.mkdir(PROXY_CACHE_DIR, { recursive: true });
    const file = proxyCachePath(key);
    await fs.writeFile(file + ".tmp", Buffer.from(bytes));
    await fs.rename(file + ".tmp", file);
    await pruneProxyCache();
  },
  /** true si `filePath` sigue existiendo — usado para reemparejar un proyecto guardado sin pedirle al usuario que re-seleccione archivos que no se han movido. */
  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  },
  /** Se suscribe a las acciones del menú nativo (electron/main.cjs). El renderer las mapea a los botones que ya existen — ver MENU_ACTIONS en ui/main.ts. */
  onMenuAction(callback) {
    ipcRenderer.on("menu-action", (_event, action) => callback(action));
  },
});
