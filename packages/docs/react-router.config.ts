import type { Config } from "@react-router/dev/config";
import { glob } from "node:fs/promises";
import { getSlugs } from "fumadocs-core/source";

export default {
  ssr: false,
  async prerender({ getStaticPaths }) {
    const paths = new Set([...getStaticPaths(), "/docs", "/docs/search.json"]);

    for await (const entry of glob("**/*.mdx", { cwd: "content/docs" })) {
      const slugs = getSlugs(entry);
      paths.add(slugs.length === 0 ? "/docs" : `/docs/${slugs.join("/")}`);
    }

    return [...paths];
  },
} satisfies Config;
