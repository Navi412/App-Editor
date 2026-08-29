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
const { contextBridge, webUtils } = require("electron");
const fs = require("node:fs/promises");

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
  /** true si `filePath` sigue existiendo — usado para reemparejar un proyecto guardado sin pedirle al usuario que re-seleccione archivos que no se han movido. */
  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  },
});
