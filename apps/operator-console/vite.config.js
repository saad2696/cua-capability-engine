import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4300,
    proxy: { "/api": "http://localhost:4200", "/ws": { target: "ws://localhost:4200", ws: true } },
  },
});
