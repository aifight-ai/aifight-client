import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Renderer build. Shared presentational components (agent avatars, replay/live
// game visuals) come from the @aifight/ui workspace package, so the desktop
// cockpit and the website draw matches the same way.
export default defineConfig({
  root: path.resolve(here, "src/renderer"),
  base: "./", // relative asset URLs so index.html loads under file:// in Electron
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(here, "dist/renderer"),
    emptyOutDir: true,
    target: "es2022",
  },
});
