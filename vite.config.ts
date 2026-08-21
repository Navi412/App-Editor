import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  // Rutas relativas: el build tiene que poder cargarse tanto desde un
  // servidor web (dev/preview) como desde file:// dentro de Electron,
  // que no resuelve rutas absolutas ("/assets/...") de la misma forma.
  base: "./",
});
