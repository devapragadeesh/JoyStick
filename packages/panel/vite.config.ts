import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SIDECAR = `http://127.0.0.1:${process.env.JOYSTICK_PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    // In development the panel is served by Vite and talks to the sidecar
    // through this proxy, so the app code uses same-origin paths in both modes.
    proxy: {
      "/stream": { target: SIDECAR, changeOrigin: false, ws: false },
      "/api": { target: SIDECAR, changeOrigin: false },
      "/health": { target: SIDECAR, changeOrigin: false },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
