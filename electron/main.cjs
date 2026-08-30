// Proceso principal de Electron. Extensión .cjs a propósito: el resto
// del proyecto es ESM ("type": "module" en package.json), pero
// Electron carga el proceso principal con require() — .cjs fuerza
// CommonJS sin depender de la config global de módulos.
const { app, BrowserWindow, Menu } = require("electron");
const path = require("node:path");

/** Ventana principal — se guarda para poder enviarle las acciones del menú nativo. */
let mainWindow = null;

/**
 * Envía una acción de menú al renderer. El menú nativo NO conoce la
 * lógica del editor: solo nombra la acción ("undo", "split"...), y
 * ui/main.ts (ver MENU_ACTIONS) la resuelve haciendo click en el
 * control que ya existe en la interfaz, respetando su estado disabled.
 * Así no hay lógica duplicada entre el menú y los botones.
 */
function sendMenuAction(action) {
  mainWindow?.webContents.send("menu-action", action);
}

/**
 * Menú de aplicación nativo (Archivo / Editar / Ver / Pista / Ayuda).
 * Los aceleradores solo se ponen en combinaciones que el renderer NO
 * captura ya por su cuenta (Ctrl+O/S/E/0/+/-, Ctrl+/): las teclas
 * sueltas tipo C/M o Ctrl+Z ya las maneja el `keydown` de ui/main.ts,
 * y duplicar el acelerador aquí las dispararía dos veces (además de
 * robar la tecla mientras se escribe en un campo de texto). Por eso
 * esos ítems solo llevan la pista de tecla en la etiqueta.
 */
function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "Archivo",
      submenu: [
        { label: "Abrir vídeo…", accelerator: "CmdOrCtrl+O", click: () => sendMenuAction("open-video") },
        { type: "separator" },
        { label: "Cargar proyecto…", click: () => sendMenuAction("load-project") },
        { label: "Guardar proyecto", accelerator: "CmdOrCtrl+S", click: () => sendMenuAction("save-project") },
        { type: "separator" },
        { label: "Exportar a MP4…", accelerator: "CmdOrCtrl+E", click: () => sendMenuAction("export") },
        { type: "separator" },
        isMac ? { role: "close", label: "Cerrar" } : { role: "quit", label: "Salir" },
      ],
    },
    {
      label: "Editar",
      submenu: [
        { label: "Deshacer", click: () => sendMenuAction("undo") },
        { label: "Rehacer", click: () => sendMenuAction("redo") },
        { type: "separator" },
        { label: "Seleccionar clip en el playhead (A)", click: () => sendMenuAction("select-clip") },
        { label: "Cortar clip en el playhead (C)", click: () => sendMenuAction("split") },
        { label: "Imán / snapping (N)", click: () => sendMenuAction("toggle-snap") },
        { label: "Bandera en el clip seleccionado (G)", click: () => sendMenuAction("flag-clip") },
        { label: "Eliminar clip seleccionado (Supr)", click: () => sendMenuAction("delete-clip") },
        { type: "separator" },
        { label: "Añadir marcador (M)", click: () => sendMenuAction("add-marker") },
        { label: "Añadir texto", click: () => sendMenuAction("add-text") },
      ],
    },
    {
      label: "Ver",
      submenu: [
        { label: "Acercar la timeline", accelerator: "CmdOrCtrl+=", click: () => sendMenuAction("zoom-in") },
        { label: "Alejar la timeline", accelerator: "CmdOrCtrl+-", click: () => sendMenuAction("zoom-out") },
        { label: "Ajustar la timeline a la ventana", accelerator: "CmdOrCtrl+0", click: () => sendMenuAction("zoom-fit") },
        { type: "separator" },
        { label: "Alternar zoom del preview", click: () => sendMenuAction("toggle-preview-zoom") },
        { type: "separator" },
        { role: "togglefullscreen", label: "Pantalla completa" },
        { role: "toggleDevTools", label: "Herramientas de desarrollo" },
      ],
    },
    {
      label: "Pista",
      submenu: [
        { label: "Añadir pista de vídeo", click: () => sendMenuAction("add-video-track") },
        { label: "Añadir pista de audio", click: () => sendMenuAction("add-audio-track") },
      ],
    },
    {
      label: "Ayuda",
      submenu: [
        { label: "Atajos de teclado", accelerator: "CmdOrCtrl+/", click: () => sendMenuAction("show-shortcuts") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
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

  mainWindow = win;
  win.on("closed", () => {
    mainWindow = null;
  });

  win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

app.whenReady().then(() => {
  buildAppMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
