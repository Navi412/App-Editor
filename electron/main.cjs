// Proceso principal de Electron. Extensión .cjs a propósito: el resto
// del proyecto es ESM ("type": "module" en package.json), pero
// Electron carga el proceso principal con require() — .cjs fuerza
// CommonJS sin depender de la config global de módulos.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // El preload SÍ necesita Node real (fs, para leer archivos de
      // proyecto por ruta — ver electron/preload.cjs) y el sandbox de
      // preload (activado por defecto desde Electron 20) se lo bloquea:
      // ahí dentro ni siquiera `require("fs")` está disponible. Desactivar
      // el sandbox NO reactiva nodeIntegration en la página — la propia
      // renderer sigue sin poder hacer require() de nada, solo el script
      // de preload (que ya decide qué expone vía contextBridge) gana
      // Node completo.
      sandbox: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
