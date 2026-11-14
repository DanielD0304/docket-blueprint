import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Large, rarely-changing libraries get their own long-cacheable chunks so an app change
// doesn't re-download ~600 kB of three.js/d3, and no single chunk exceeds Vite's 500 kB warning.
const VENDOR_CHUNKS: Record<string, string[]> = {
  three: ["three"],
  d3: ["d3", "d3-"],
  react: ["react", "react-dom", "scheduler"],
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.DOCKET_API_URL || "http://127.0.0.1:8000", changeOrigin: true } },
  },
  build: {
    // three.js alone is ~530 kB minified (135 kB gzip) and can't be split further; app code is ~140 kB.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const m = id.match(/node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/);
          if (!m) return;
          const pkg = m[1];
          for (const [chunk, names] of Object.entries(VENDOR_CHUNKS))
            if (names.some((n) => (n.endsWith("-") ? pkg.startsWith(n) : pkg === n))) return chunk;
          return "vendor";
        },
      },
    },
  },
});
