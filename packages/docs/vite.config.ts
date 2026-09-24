import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import mdx from "fumadocs-mdx/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const panelPort = Number(process.env.COS_TOOL_BOT_DEV_PANEL_PORT ?? 43101);

export default defineConfig({
  plugins: [
    mdx(),
    tailwindcss(),
    reactRouter(),
    {
      name: "panel-dev-navigation",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          const destination = new URL("/", `http://${req.headers.host}`);
          destination.port = String(panelPort);
          res.writeHead(302, { Location: destination.href });
          res.end();
        });
      },
    },
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./app", import.meta.url)),
      collections: fileURLToPath(new URL("./.source", import.meta.url)),
    },
  },
  build: {
    assetsDir: "docs/assets",
  },
});
