import type { McpServerPreset } from "@cos-tool-bot/shared";

export const mcpPresets: McpServerPreset[] = [
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Web search via Brave Search API",
    transport: "sse",
    url: "https://mcp.bravesearch.com/sse",
    headerTemplate: { Authorization: "Bearer {{API_KEY}}" },
    docsUrl: "https://brave.com/search/api/",
  },
  {
    id: "github",
    name: "GitHub",
    description: "GitHub repositories, issues, and pull requests",
    transport: "streamable-http",
    url: "https://api.githubcopilot.com/mcp/",
    headerTemplate: { Authorization: "Bearer {{API_KEY}}" },
    docsUrl: "https://github.com/github/github-mcp-server",
  },
  {
    id: "context7",
    name: "Context7",
    description: "Up-to-date library documentation lookup",
    transport: "streamable-http",
    url: "https://mcp.context7.com/mcp",
    docsUrl: "https://context7.com",
  },
  {
    id: "fetch",
    name: "Fetch",
    description: "HTTP request tool for fetching web pages",
    transport: "sse",
    url: "https://mcp-fetch.onrender.com/sse",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
];
