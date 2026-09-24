import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const projectEnv = loadEnv(mode, resolve(__dirname, "../.."), "");
  const serverPort = Number(process.env.PORT ?? projectEnv.PORT ?? 43100);
  const panelPort = Number(process.env.COS_TOOL_BOT_DEV_PANEL_PORT ?? 43101);
  const docsPort = Number(process.env.COS_TOOL_BOT_DEV_DOCS_PORT ?? 43102);

  return {
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
            destination.port = String(docsPort);
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
      port: panelPort,
      strictPort: true,
      proxy: {
        "/api": {
          target: `http://localhost:${serverPort}`,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist",
    },
  };
});
