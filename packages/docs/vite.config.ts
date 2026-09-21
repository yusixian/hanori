import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import mdx from "fumadocs-mdx/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

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
          destination.port = "5173";
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
