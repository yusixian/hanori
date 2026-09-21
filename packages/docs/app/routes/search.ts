import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source.server";

const { staticGET } = createFromSource(source);

export function loader() {
  return staticGET();
}
