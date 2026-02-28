import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authFetch, client } from "@/lib/client";
import Editor from "@monaco-editor/react";
import { File, FilePlus, FolderOpen, Loader2, PackagePlus, Save, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";

interface FileEntry {
  name: string;
  path: string;
  size: number;
  type: "file" | "dir";
}

interface ApiOk<T = unknown> {
  ok: true;
  content?: string;
  files?: FileEntry[];
  created?: string[];
  data?: T;
}

interface ApiErr {
  ok: false;
  error: string;
}

type ApiResult<T = unknown> = ApiOk<T> | ApiErr;

export function BotFilesPage() {
  const { botId } = useParams<{ botId: string }>();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [showNewFile, setShowNewFile] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [creating, setCreating] = useState(false);
  const [initializing, setInitializing] = useState(false);

  const isDirty = content !== originalContent;

  const editorLanguage = selectedFile?.endsWith(".json")
    ? "json"
    : selectedFile?.endsWith(".txt")
      ? "plaintext"
      : "markdown";

  const loadFiles = useCallback(async () => {
    if (!botId) return;
    setLoading(true);
    try {
      const res = await client.api.bots[":botId"].files.$get({
        param: { botId },
      });
      const json = await res.json();
      if (json.ok) {
        setFiles(json.files);
      }
    } catch (err) {
      console.error("Failed to load files:", err);
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  // Hono RPC client doesn't support wildcard routes (/:botId/files/*),
  // so file read/write/delete use raw authFetch instead of the typed client.
  const loadFile = useCallback(
    async (fileName: string) => {
      if (!botId) return;
      setFileLoading(true);
      try {
        const res = await authFetch(`/api/bots/${botId}/files/${encodeURIComponent(fileName)}`);
        const json = (await res.json()) as ApiResult;
        if (json.ok && json.content != null) {
          setContent(json.content);
          setOriginalContent(json.content);
          setSelectedFile(fileName);
        }
      } catch (err) {
        console.error("Failed to load file:", err);
      } finally {
        setFileLoading(false);
      }
    },
    [botId],
  );

  const saveFile = useCallback(async () => {
    if (!botId || !selectedFile) return;
    setSaving(true);
    try {
      const res = await authFetch(`/api/bots/${botId}/files/${encodeURIComponent(selectedFile)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const json = (await res.json()) as ApiResult;
      if (json.ok) {
        setOriginalContent(content);
        await loadFiles();
      }
    } catch (err) {
      console.error("Failed to save file:", err);
    } finally {
      setSaving(false);
    }
  }, [botId, selectedFile, content, loadFiles]);

  const deleteFile = useCallback(
    async (fileName: string) => {
      if (!botId) return;
      if (!confirm(`Delete "${fileName}"?`)) return;
      try {
        const res = await authFetch(`/api/bots/${botId}/files/${encodeURIComponent(fileName)}`, {
          method: "DELETE",
        });
        const json = (await res.json()) as ApiResult;
        if (json.ok) {
          if (selectedFile === fileName) {
            setSelectedFile(null);
            setContent("");
            setOriginalContent("");
          }
          await loadFiles();
        }
      } catch (err) {
        console.error("Failed to delete file:", err);
      }
    },
    [botId, selectedFile, loadFiles],
  );

  const createFile = useCallback(async () => {
    if (!botId || !newFileName.trim()) return;
    setCreating(true);
    try {
      const name = newFileName.trim().endsWith(".md")
        ? newFileName.trim()
        : `${newFileName.trim()}.md`;
      const res = await authFetch(`/api/bots/${botId}/files/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `# ${name.replace(".md", "")}\n\n` }),
      });
      const json = (await res.json()) as ApiResult;
      if (json.ok) {
        setNewFileName("");
        setShowNewFile(false);
        await loadFiles();
        await loadFile(name);
      }
    } catch (err) {
      console.error("Failed to create file:", err);
    } finally {
      setCreating(false);
    }
  }, [botId, newFileName, loadFiles, loadFile]);

  const initTemplates = useCallback(async () => {
    if (!botId) return;
    setInitializing(true);
    try {
      const res = await client.api.bots[":botId"]["files-init"].$post({
        param: { botId },
      });
      const json = await res.json();
      if (json.ok) {
        await loadFiles();
      }
    } catch (err) {
      console.error("Failed to init templates:", err);
    } finally {
      setInitializing(false);
    }
  }, [botId, loadFiles]);

  // Keyboard shortcut: Ctrl+S / Cmd+S to save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty && selectedFile) saveFile();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isDirty, selectedFile, saveFile]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Files</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowNewFile(true)}
            disabled={showNewFile}
          >
            <FilePlus className="mr-1 h-4 w-4" />
            New File
          </Button>
          <Button variant="outline" size="sm" onClick={initTemplates} disabled={initializing}>
            {initializing ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <PackagePlus className="mr-1 h-4 w-4" />
            )}
            Init Templates
          </Button>
        </div>
      </div>

      <div className="flex gap-4" style={{ height: "calc(100dvh - 160px)" }}>
        {/* File list sidebar */}
        <Card className="w-60 shrink-0 overflow-hidden">
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <FolderOpen className="h-4 w-4" />
              /data/{botId}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 overflow-y-auto px-2 pb-2">
            {showNewFile && (
              <div className="flex items-center gap-1 px-1">
                <Input
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  placeholder="filename.md"
                  className="h-7 text-xs"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") createFile();
                    if (e.key === "Escape") {
                      setShowNewFile(false);
                      setNewFileName("");
                    }
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={createFile}
                  disabled={creating || !newFileName.trim()}
                >
                  {creating ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => {
                    setShowNewFile(false);
                    setNewFileName("");
                  }}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            )}
            {loading ? (
              <div className="text-muted-foreground flex items-center gap-2 px-2 py-4 text-xs">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading...
              </div>
            ) : files.length === 0 ? (
              <div className="text-muted-foreground px-2 py-4 text-center text-xs">
                No files yet. Click "Init Templates" to create default files.
              </div>
            ) : (
              files
                .filter((f) => f.type === "file")
                .map((file) => (
                  <div
                    key={file.name}
                    className={`group flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-sm transition-colors ${
                      selectedFile === file.name
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/50"
                    }`}
                    onClick={() => loadFile(file.name)}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <File className="h-3.5 w-3.5 shrink-0 opacity-60" />
                      <span className="truncate">{file.name}</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteFile(file.name);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))
            )}
          </CardContent>
        </Card>

        {/* Editor area */}
        <Card className="min-w-0 flex-1 overflow-hidden">
          {selectedFile ? (
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between border-b px-4 py-2">
                <div className="flex items-center gap-2">
                  <File className="h-4 w-4 opacity-60" />
                  <span className="text-sm font-medium">{selectedFile}</span>
                  {isDirty && <span className="text-muted-foreground text-xs">(unsaved)</span>}
                </div>
                <Button size="sm" onClick={saveFile} disabled={saving || !isDirty}>
                  {saving ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="mr-1 h-4 w-4" />
                  )}
                  Save
                </Button>
              </div>
              <div className="flex-1">
                {fileLoading ? (
                  <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading file...
                  </div>
                ) : (
                  <Editor
                    height="100%"
                    language={editorLanguage}
                    value={content}
                    onChange={(value) => setContent(value ?? "")}
                    theme="vs-dark"
                    options={{
                      minimap: { enabled: false },
                      wordWrap: "on",
                      lineNumbers: "on",
                      fontSize: 14,
                      tabSize: 2,
                      scrollBeyondLastLine: false,
                      padding: { top: 8 },
                    }}
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2">
              <FolderOpen className="h-8 w-8 opacity-40" />
              <p className="text-sm">Select a file to edit</p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
