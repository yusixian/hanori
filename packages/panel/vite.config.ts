import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "docs-dev-navigation",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!/^\/docs(?:\/|\?|$)/.test(req.url ?? "")) return next();
          // Each Vite app must serve its own root module URLs and HMR client.
          const destination = new URL(req.url!, `http://${req.headers.host}`);
          destination.port = "5174";
          res.writeHead(302, { Location: destination.href });
          res.end();
        });
      },
    },
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
