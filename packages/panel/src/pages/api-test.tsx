import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/lib/client";
import { cn } from "@/lib/utils";
import { Loader2, Play, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { JsonView, darkStyles } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";

interface HistoryEntry {
  id: number;
  method: string;
  endpoint: string;
  status: number | null;
  data: unknown;
  error?: string;
  timestamp: Date;
}

const PRESETS = [
  { label: "List Models", method: "GET" as const, endpoint: "/models" },
  {
    label: "Chat Completions",
    method: "POST" as const,
    endpoint: "/chat/completions",
    body: JSON.stringify(
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        max_tokens: 100,
      },
      null,
      2,
    ),
  },
  {
    label: "Embeddings",
    method: "POST" as const,
    endpoint: "/embeddings",
    body: JSON.stringify(
      {
        model: "text-embedding-3-small",
        input: "Hello world",
      },
      null,
      2,
    ),
  },
];

export function ApiTestPage() {
  const nextIdRef = useRef(0);
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [method, setMethod] = useState<"GET" | "POST">("GET");
  const [endpoint, setEndpoint] = useState("/models");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<HistoryEntry | null>(null);

  const handleSend = async (
    overrideMethod?: "GET" | "POST",
    overrideEndpoint?: string,
    overrideBody?: string,
  ) => {
    const m = overrideMethod ?? method;
    const ep = overrideEndpoint ?? endpoint;
    const b = overrideBody ?? body;

    if (!baseURL || !apiKey) return;

    setLoading(true);
    const entry: HistoryEntry = {
      id: nextIdRef.current++,
      method: m,
      endpoint: ep,
      status: null,
      data: null,
      timestamp: new Date(),
    };

    try {
      const res = await client.api["api-test"].proxy.$post({
        json: {
          baseURL,
          apiKey,
          endpoint: ep,
          method: m,
          body: m === "POST" && b ? JSON.parse(b) : undefined,
        },
      });
      const json = await res.json();
      if (json.ok) {
        entry.status = json.status;
        entry.data = json.data;
      } else {
        entry.error = "error" in json ? String(json.error) : "Unknown error";
      }
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
    } finally {
      setLoading(false);
      setHistory((prev) => [entry, ...prev]);
      setSelectedEntry(entry);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">API Test</h1>

      {/* Connection Config */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="api-base-url" className="text-sm font-medium">
              Base URL
            </label>
            <Input
              id="api-base-url"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder="https://api.openai.com/v1"
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {[
                ["OpenAI", "https://api.openai.com/v1"],
                ["DeepSeek", "https://api.deepseek.com"],
              ].map(([name, url]) => (
                <button
                  key={name}
                  type="button"
                  className="text-muted-foreground hover:text-foreground rounded border px-2 py-0.5 text-xs"
                  onClick={() => setBaseURL(url!)}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="api-key" className="text-sm font-medium">
              API Key
            </label>
            <Input
              id="api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
            />
          </div>
        </CardContent>
      </Card>

      {/* Request */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Request</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <Button
                key={p.label}
                variant="outline"
                size="sm"
                disabled={loading || !baseURL || !apiKey}
                onClick={() => {
                  setMethod(p.method);
                  setEndpoint(p.endpoint);
                  if (p.body) setBody(p.body);
                  handleSend(p.method, p.endpoint, p.body);
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>

          <div className="flex gap-2">
            <Select
              className="border-input flex h-9 w-24 rounded-md border bg-transparent px-2 py-1 text-sm"
              value={method}
              onChange={(e) => setMethod(e.target.value as "GET" | "POST")}
            >
              <option value="GET">GET</option>
              <option value="POST">POST</option>
            </Select>
            <Input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="/models"
              className="flex-1"
            />
            <Button onClick={() => handleSend()} disabled={loading || !baseURL || !apiKey}>
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Send
            </Button>
          </div>

          {method === "POST" && (
            <div className="space-y-1.5">
              <label htmlFor="api-request-body" className="text-sm font-medium">
                Request Body (JSON)
              </label>
              <Textarea
                id="api-request-body"
                className="border-input placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-32 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-sm focus-visible:ring-2 focus-visible:outline-none"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder='{"model": "gpt-4o", "messages": [...]}'
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Response */}
      {selectedEntry && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Response
              {selectedEntry.status != null && (
                <span
                  className={`ml-2 text-sm font-normal ${selectedEntry.status < 300 ? "text-green-600" : "text-red-600"}`}
                >
                  HTTP {selectedEntry.status}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {selectedEntry.error ? (
              <div className="rounded bg-red-500/10 p-3 text-sm text-red-600">
                {selectedEntry.error}
              </div>
            ) : (
              <div className="max-h-[600px] overflow-auto rounded bg-gray-950 p-3">
                <JsonView data={selectedEntry.data as object} style={darkStyles} />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* History */}
      {history.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">History</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => setHistory([])}>
                <Trash2 className="h-4 w-4" />
                Clear
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {history.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-3 rounded px-3 py-2 text-left text-sm transition-colors",
                    selectedEntry?.id === entry.id ? "bg-accent" : "hover:bg-accent/50",
                  )}
                  onClick={() => setSelectedEntry(entry)}
                >
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 font-mono text-xs",
                      entry.method === "GET"
                        ? "bg-blue-500/10 text-blue-600"
                        : "bg-green-500/10 text-green-600",
                    )}
                  >
                    {entry.method}
                  </span>
                  <span className="text-muted-foreground flex-1 truncate font-mono">
                    {entry.endpoint}
                  </span>
                  <span
                    className={cn(
                      "text-xs",
                      entry.error
                        ? "text-red-500"
                        : entry.status && entry.status < 300
                          ? "text-green-500"
                          : "text-yellow-500",
                    )}
                  >
                    {entry.error ? "ERR" : entry.status}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {entry.timestamp.toLocaleTimeString()}
                  </span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
