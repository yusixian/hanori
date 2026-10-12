import { docsOrigin, docsRobots } from "@/lib/seo.server";

export function loader() {
  return new Response(docsRobots(docsOrigin()), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
