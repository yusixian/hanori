import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Popover } from "@/components/ui/popover";
import { authFetch, client } from "@/lib/client";
import { triggerDownload } from "@/lib/download";
import { IMAGE_EXTENSIONS, TEXT_EXTENSIONS } from "@cos-tool-bot/shared";
import Editor from "@monaco-editor/react";
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  Download,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  MoreHorizontal,
  PackagePlus,
  Save,
  Search,
  Shield,
  Square,
  SquareCheckBig,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";

interface FileEntry {
  name: string;
  path: string;
  size: number;
  type: "file" | "dir";
}

interface InjectionConfig {
  injectableFiles: string[];
  maxTotalSize: number;
}

interface ApiOk<T = unknown> {
  ok: true;
  content?: string;
  files?: FileEntry[];
  created?: string[];
  injection?: InjectionConfig;
  data?: T;
}

interface ApiErr {
  ok: false;
  error: string;
}

type ApiResult<T = unknown> = ApiOk<T> | ApiErr;

type FileCategory = "text" | "image" | "binary";

function getFileCategory(name: string): FileCategory {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "binary";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/** Encode each segment of a path like `generations/foo.png` */
function encodeFilePath(filePath: string): string {
  return filePath
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

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
  const [fileCategory, setFileCategory] = useState<FileCategory>("text");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadingZip, setDownloadingZip] = useState<string | null>(null);
  const imageUrlRef = useRef<string | null>(null);

  // Directory browsing state
  const [currentPath, setCurrentPath] = useState("");

  // Multi-select state
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  // Injection config state
  const [injection, setInjection] = useState<InjectionConfig>({
    injectableFiles: [],
    maxTotalSize: 8192,
  });
  const [editingMaxSize, setEditingMaxSize] = useState(false);
  const [maxSizeInput, setMaxSizeInput] = useState("");
  const [savingInjection, setSavingInjection] = useState(false);
  const [search, setSearch] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [mobileEditorOpen, setMobileEditorOpen] = useState(false);
  const [autoSave, setAutoSave] = useState(
    () => localStorage.getItem("files:auto-save") === "true",
  );

  const isDirty = content !== originalContent;

  const EXT_LANG: Record<string, string> = {
    ".json": "json",
    ".txt": "plaintext",
    ".csv": "plaintext",
    ".html": "html",
    ".css": "css",
    ".xml": "xml",
  };
  const ext = selectedFile ? selectedFile.slice(selectedFile.lastIndexOf(".")) : "";
  const editorLanguage = EXT_LANG[ext] ?? "markdown";

  const loadFiles = useCallback(
    async (dirPath?: string) => {
      if (!botId) return;
      const pathToLoad = dirPath ?? currentPath;
      setLoading(true);
      try {
        const res = await client.api.bots[":botId"].files.$get({
          param: { botId },
          query: pathToLoad ? { path: pathToLoad } : {},
        });
        const json = await res.json();
        if (json.ok) {
          setFiles(json.files);
          if (json.injection) {
            setInjection(json.injection);
          }
        }
      } catch (err) {
        console.error("Failed to load files:", err);
      } finally {
        setLoading(false);
      }
    },
    [botId, currentPath],
  );

  // Initial load only
  useEffect(() => {
    loadFiles();
    // only on mount / botId change
  }, [botId]);

  // Clear selection when navigating directories and load new path directly
  const navigateTo = useCallback(
    (dirPath: string) => {
      setCurrentPath(dirPath);
      setSelectedFiles(new Set());
      setSelectedFile(null);
      setContent("");
      setOriginalContent("");
      loadFiles(dirPath);
    },
    [loadFiles],
  );

  // Revoke previous blob URL when switching files
  const revokeImageUrl = useCallback(() => {
    if (imageUrlRef.current) {
      URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = null;
    }
    setImageUrl(null);
  }, []);

  // Clean up blob URL on unmount
  useEffect(() => {
    return () => {
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    };
  }, []);

  // Hono RPC client doesn't support wildcard routes (/:botId/files/*),
  // so file read/write/delete use raw authFetch instead of the typed client.
  const loadFile = useCallback(
    async (filePath: string) => {
      if (!botId) return;
      revokeImageUrl();
      setFileLoading(true);
      setContent("");
      setOriginalContent("");

      const category = getFileCategory(filePath);

      try {
        if (category === "text") {
          const res = await authFetch(`/api/bots/${botId}/files/${encodeFilePath(filePath)}`);
          const json = (await res.json()) as ApiResult;
          if (json.ok && json.content != null) {
            setContent(json.content);
            setOriginalContent(json.content);
          }
        } else if (category === "image") {
          const res = await authFetch(`/api/bots/${botId}/files-raw/${encodeFilePath(filePath)}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          imageUrlRef.current = url;
          setImageUrl(url);
        }
        // binary: no content to load, just select the file
        setFileCategory(category);
        setSelectedFile(filePath);
        setMobileEditorOpen(true);
      } catch (err) {
        console.error("Failed to load file:", err);
      } finally {
        setFileLoading(false);
      }
    },
    [botId, revokeImageUrl],
  );

  const saveFile = useCallback(async () => {
    if (!botId || !selectedFile) return;
    setSaving(true);
    try {
      const res = await authFetch(`/api/bots/${botId}/files/${encodeFilePath(selectedFile)}`, {
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

  useEffect(() => {
    localStorage.setItem("files:auto-save", String(autoSave));
  }, [autoSave]);

  useEffect(() => {
    if (!autoSave || !isDirty || fileCategory !== "text" || !selectedFile) return;
    const timer = window.setTimeout(() => void saveFile(), 800);
    return () => window.clearTimeout(timer);
  }, [autoSave, content, fileCategory, isDirty, saveFile, selectedFile]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!isDirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isDirty]);

  const downloadFile = useCallback(
    async (filePath: string) => {
      if (!botId) return;
      setDownloading(true);
      try {
        const res = await authFetch(
          `/api/bots/${botId}/files-raw/${encodeFilePath(filePath)}?download=true`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const fileName = filePath.includes("/")
          ? filePath.slice(filePath.lastIndexOf("/") + 1)
          : filePath;
        triggerDownload(blob, fileName);
      } catch (err) {
        console.error("Failed to download file:", err);
      } finally {
        setDownloading(false);
      }
    },
    [botId],
  );

  const downloadZip = useCallback(
    async (dirPath: string) => {
      if (!botId) return;
      setDownloadingZip(dirPath);
      try {
        const query = dirPath ? `?path=${encodeURIComponent(dirPath)}` : "";
        const res = await authFetch(`/api/bots/${botId}/files-zip${query}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const dirName = dirPath ? dirPath.replace(/\//g, "_") : "files";
        triggerDownload(blob, `${dirName}.zip`);
      } catch (err) {
        console.error("Failed to download ZIP:", err);
      } finally {
        setDownloadingZip(null);
      }
    },
    [botId],
  );

  const deleteFile = useCallback(
    async (filePath: string) => {
      if (!botId) return;
      const fileName = filePath.includes("/")
        ? filePath.slice(filePath.lastIndexOf("/") + 1)
        : filePath;
      if (!confirm(`Delete "${fileName}"?`)) return;
      try {
        const res = await authFetch(`/api/bots/${botId}/files/${encodeFilePath(filePath)}`, {
          method: "DELETE",
        });
        const json = (await res.json()) as ApiResult;
        if (json.ok) {
          if (selectedFile === filePath) {
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

  const deleteBatch = useCallback(async () => {
    if (!botId || selectedFiles.size === 0) return;
    if (!confirm(`Delete ${selectedFiles.size} file(s)?`)) return;
    setDeleting(true);
    try {
      const res = await authFetch(`/api/bots/${botId}/files-delete-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: [...selectedFiles] }),
      });
      const json = (await res.json()) as { ok: boolean; deleted?: string[]; skipped?: string[] };
      if (json.ok) {
        if (selectedFile && selectedFiles.has(selectedFile)) {
          setSelectedFile(null);
          setContent("");
          setOriginalContent("");
        }
        setSelectedFiles(new Set());
        await loadFiles();
      }
    } catch (err) {
      console.error("Failed to batch delete:", err);
    } finally {
      setDeleting(false);
    }
  }, [botId, selectedFiles, selectedFile, loadFiles]);

  const createFile = useCallback(async () => {
    if (!botId || !newFileName.trim()) return;
    setCreating(true);
    try {
      const name = newFileName.trim().endsWith(".md")
        ? newFileName.trim()
        : `${newFileName.trim()}.md`;
      const filePath = currentPath ? `${currentPath}/${name}` : name;
      const res = await authFetch(`/api/bots/${botId}/files/${encodeFilePath(filePath)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `# ${name.replace(".md", "")}\n\n` }),
      });
      const json = (await res.json()) as ApiResult;
      if (json.ok) {
        setNewFileName("");
        setShowNewFile(false);
        await loadFiles();
        await loadFile(filePath);
      }
    } catch (err) {
      console.error("Failed to create file:", err);
    } finally {
      setCreating(false);
    }
  }, [botId, newFileName, currentPath, loadFiles, loadFile]);

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

  const toggleInjectable = useCallback(
    async (fileName: string) => {
      if (!botId) return;
      const isCurrentlyInjectable = injection.injectableFiles.includes(fileName);
      const newFiles = isCurrentlyInjectable
        ? injection.injectableFiles.filter((f) => f !== fileName)
        : [...injection.injectableFiles, fileName];

      setSavingInjection(true);
      try {
        const res = await client.api.bots[":botId"]["files-injection"].$put({
          param: { botId },
          json: { injectableFiles: newFiles, maxTotalSize: injection.maxTotalSize },
        });
        const json = await res.json();
        if (json.ok) {
          setInjection({ injectableFiles: newFiles, maxTotalSize: injection.maxTotalSize });
        }
      } catch (err) {
        console.error("Failed to update injection config:", err);
      } finally {
        setSavingInjection(false);
      }
    },
    [botId, injection],
  );

  const saveMaxSize = useCallback(async () => {
    if (!botId) return;
    const parsed = Number.parseInt(maxSizeInput, 10);
    if (Number.isNaN(parsed) || parsed < 0) return;

    setSavingInjection(true);
    try {
      const res = await client.api.bots[":botId"]["files-injection"].$put({
        param: { botId },
        json: { injectableFiles: injection.injectableFiles, maxTotalSize: parsed },
      });
      const json = await res.json();
      if (json.ok) {
        setInjection({ ...injection, maxTotalSize: parsed });
        setEditingMaxSize(false);
      }
    } catch (err) {
      console.error("Failed to update max size:", err);
    } finally {
      setSavingInjection(false);
    }
  }, [botId, maxSizeInput, injection]);

  // Keyboard shortcut: Ctrl+S / Cmd+S to save (text files only)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (fileCategory === "text" && isDirty && selectedFile) saveFile();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isDirty, selectedFile, saveFile, fileCategory]);

  // Compute injection summary (only for root-level .md files)
  const injectedFiles = files.filter(
    (f) =>
      f.type === "file" && f.name.endsWith(".md") && injection.injectableFiles.includes(f.path),
  );
  const injectedSize = injectedFiles.reduce((sum, f) => sum + f.size, 0);

  // Multi-select helpers
  const selectableFiles = files.filter(
    (f) => f.type === "file" && !injection.injectableFiles.includes(f.path),
  );
  const allSelected =
    selectableFiles.length > 0 && selectableFiles.every((f) => selectedFiles.has(f.path));

  const toggleFileSelect = (filePath: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(selectableFiles.map((f) => f.path)));
    }
  };

  // Breadcrumb segments
  const pathSegments = currentPath ? currentPath.split("/") : [];
  const visibleFiles = files.filter((file) =>
    file.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Files</h1>
          <p className="text-muted-foreground mt-0.5 text-sm">Manage this bot's workspace files.</p>
        </div>
        <div className="flex items-center gap-2">
          {selectedFiles.size > 0 && (
            <Button variant="destructive" size="sm" onClick={deleteBatch} disabled={deleting}>
              {deleting ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-4 w-4" />
              )}
              Delete Selected ({selectedFiles.size})
            </Button>
          )}
          <Button size="sm" onClick={() => setShowNewFile(true)} disabled={showNewFile}>
            <FilePlus className="mr-1 h-4 w-4" />
            New File
          </Button>
          <Popover
            placement="bottom-end"
            trigger={
              <Button
                variant="outline"
                size="icon"
                className="h-10 w-10"
                aria-label="More file actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            }
          >
            <div className="w-60 p-1.5">
              <button
                className="hover:bg-accent focus-visible:bg-accent flex h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm whitespace-nowrap transition-colors outline-none"
                onClick={() => downloadZip(currentPath)}
              >
                <Archive className="h-4 w-4 shrink-0" />
                Download current folder
              </button>
              <button
                className="hover:bg-accent focus-visible:bg-accent flex h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm whitespace-nowrap transition-colors outline-none disabled:pointer-events-none disabled:opacity-50"
                onClick={initTemplates}
                disabled={initializing}
              >
                <PackagePlus className="h-4 w-4 shrink-0" />
                Restore templates
              </button>
            </div>
          </Popover>
        </div>
      </div>

      {/* Injection summary bar */}
      <div className="flex items-center gap-3 border-y px-1 py-2">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-blue-500" />
          <span className="text-muted-foreground text-sm">
            Prompt files: {injectedFiles.length} &middot; {formatBytes(injectedSize)} /{" "}
            {editingMaxSize ? (
              <span className="inline-flex items-center gap-1">
                <Input
                  value={maxSizeInput}
                  onChange={(e) => setMaxSizeInput(e.target.value)}
                  className="inline h-6 w-20 text-xs"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveMaxSize();
                    if (e.key === "Escape") setEditingMaxSize(false);
                  }}
                />
                <span className="text-xs">B</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={saveMaxSize}
                  disabled={savingInjection}
                >
                  {savingInjection ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Check className="h-3 w-3" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={() => setEditingMaxSize(false)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </span>
            ) : (
              <button
                type="button"
                className="cursor-pointer underline decoration-dotted underline-offset-2"
                onClick={() => {
                  setMaxSizeInput(String(injection.maxTotalSize));
                  setEditingMaxSize(true);
                }}
              >
                {formatBytes(injection.maxTotalSize)}
              </button>
            )}
          </span>
          {injectedSize > injection.maxTotalSize && (
            <span className="text-xs text-red-500">(exceeded limit)</span>
          )}
        </div>
      </div>

      <div
        className="flex overflow-hidden rounded-xl border bg-white"
        style={{ height: "calc(100dvh - 210px)" }}
      >
        {/* File list sidebar */}
        <div
          className={`${mobileEditorOpen ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col overflow-hidden border-r md:w-80`}
        >
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-1 text-sm">
              <FolderOpen className="h-4 w-4 shrink-0 text-blue-500" />
              <button
                type="button"
                className="hover:text-foreground cursor-pointer hover:underline"
                onClick={() => navigateTo("")}
              >
                Workspace
              </button>
              {pathSegments.map((seg, i) => (
                <span
                  key={pathSegments.slice(0, i + 1).join("/")}
                  className="flex items-center gap-1"
                >
                  <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
                  <button
                    type="button"
                    className="hover:text-foreground cursor-pointer truncate hover:underline"
                    onClick={() => navigateTo(pathSegments.slice(0, i + 1).join("/"))}
                  >
                    {seg}
                  </button>
                </span>
              ))}
            </CardTitle>
          </CardHeader>
          <div className="px-3 pb-2">
            <div className="relative">
              <Search className="text-muted-foreground absolute top-2 left-2.5 h-3.5 w-3.5" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search files"
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>
          <CardContent className="flex flex-col gap-1 overflow-y-auto px-2 pb-2">
            {/* Select all / batch controls */}
            {selectableFiles.length > 0 && (
              <div className="flex items-center gap-1.5 border-b px-2 pb-1.5">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs transition-colors"
                  onClick={() => (selectionMode ? toggleSelectAll() : setSelectionMode(true))}
                >
                  {allSelected ? (
                    <SquareCheckBig className="h-3.5 w-3.5" />
                  ) : (
                    <Square className="h-3.5 w-3.5" />
                  )}
                  {selectionMode ? "Select all" : "Select files"}
                </button>
                {selectionMode && (
                  <button
                    className="text-muted-foreground ml-auto text-xs"
                    onClick={() => {
                      setSelectionMode(false);
                      setSelectedFiles(new Set());
                    }}
                  >
                    Done
                  </button>
                )}
              </div>
            )}

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
                {currentPath
                  ? "Empty directory."
                  : 'No files yet. Click "Init Templates" to create default files.'}
              </div>
            ) : (
              visibleFiles.map((file) => {
                if (file.type === "dir") {
                  return (
                    <div
                      key={file.path}
                      className="hover:bg-accent/50 group flex cursor-pointer items-center justify-between gap-1.5 rounded px-2 py-1.5 text-sm transition-colors"
                      onClick={() => navigateTo(file.path)}
                    >
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
                        <span className="truncate">{file.name}</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
                        disabled={downloadingZip === file.path}
                        onClick={(e) => {
                          e.stopPropagation();
                          downloadZip(file.path);
                        }}
                      >
                        {downloadingZip === file.path ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Archive className="h-3 w-3" />
                        )}
                      </Button>
                    </div>
                  );
                }

                const isInRoot = !currentPath;
                const isMd = file.name.endsWith(".md");
                const isInjectable = injection.injectableFiles.includes(file.path);
                const isSelected = selectedFiles.has(file.path);
                const category = getFileCategory(file.name);

                return (
                  <div
                    key={file.path}
                    className={`group flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-sm transition-colors ${
                      selectedFile === file.path
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/50"
                    }`}
                    onClick={() => loadFile(file.path)}
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      {isInRoot && isMd ? (
                        <button
                          type="button"
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                            isInjectable
                              ? "border-blue-500 bg-blue-500 text-white"
                              : "border-muted-foreground/30 hover:border-blue-400"
                          }`}
                          title={
                            isInjectable
                              ? "Injected into system prompt (click to remove)"
                              : "Click to inject into system prompt"
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleInjectable(file.path);
                          }}
                          disabled={savingInjection}
                        >
                          {isInjectable && <Check className="h-2.5 w-2.5" />}
                        </button>
                      ) : selectionMode && !isInjectable ? (
                        <button
                          type="button"
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                            isSelected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-muted-foreground/30 hover:border-muted-foreground/60"
                          }`}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFileSelect(file.path);
                          }}
                        >
                          {isSelected && <Check className="h-2.5 w-2.5" />}
                        </button>
                      ) : category === "image" ? (
                        <ImageIcon className="h-3.5 w-3.5 shrink-0 opacity-60" />
                      ) : (
                        <File className="h-3.5 w-3.5 shrink-0 opacity-60" />
                      )}
                      <span className="truncate">{file.name}</span>
                      {isInjectable && <Badge className="px-1.5 py-0 text-[9px]">Prompt</Badge>}
                    </div>
                    {!isInjectable && !isSelected && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteFile(file.path);
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                );
              })
            )}
          </CardContent>
        </div>

        {/* Editor / Preview area */}
        <div
          className={`${mobileEditorOpen ? "flex" : "hidden md:flex"} min-w-0 flex-1 overflow-hidden`}
        >
          {selectedFile ? (
            <div className="flex h-full min-w-0 flex-1 flex-col">
              <div className="flex items-center justify-between border-b px-4 py-2">
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 md:hidden"
                    onClick={() => setMobileEditorOpen(false)}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                  {fileCategory === "image" ? (
                    <ImageIcon className="h-4 w-4 opacity-60" />
                  ) : (
                    <File className="h-4 w-4 opacity-60" />
                  )}
                  <span className="text-sm font-medium">{selectedFile}</span>
                  {fileCategory === "text" && isDirty && (
                    <span className="text-xs text-amber-600">Unsaved</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {fileCategory === "text" && (
                    <label className="text-muted-foreground mr-1 flex cursor-pointer items-center gap-2 text-xs whitespace-nowrap">
                      <Switch checked={autoSave} onCheckedChange={setAutoSave} />
                      Auto-save
                    </label>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => downloadFile(selectedFile)}
                    disabled={downloading}
                  >
                    {downloading ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="mr-1 h-4 w-4" />
                    )}
                    Download
                  </Button>
                  {fileCategory === "text" && (
                    <Button size="sm" onClick={saveFile} disabled={saving || !isDirty}>
                      {saving ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      ) : (
                        <Save className="mr-1 h-4 w-4" />
                      )}
                      Save
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex-1">
                {fileLoading ? (
                  <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading file...
                  </div>
                ) : fileCategory === "text" ? (
                  <Editor
                    height="100%"
                    language={editorLanguage}
                    value={content}
                    onChange={(value) => setContent(value ?? "")}
                    theme="vs-dark"
                    options={{
                      automaticLayout: true,
                      minimap: { enabled: false },
                      wordWrap: "on",
                      lineNumbers: "on",
                      fontSize: 14,
                      tabSize: 2,
                      scrollBeyondLastLine: false,
                      padding: { top: 8 },
                    }}
                  />
                ) : fileCategory === "image" && imageUrl ? (
                  <div className="flex h-full items-center justify-center bg-neutral-950 p-4">
                    <img
                      src={imageUrl}
                      alt={selectedFile}
                      className="max-h-full max-w-full object-contain"
                    />
                  </div>
                ) : (
                  <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3">
                    <File className="h-12 w-12 opacity-30" />
                    <p className="text-sm">This file cannot be previewed</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => downloadFile(selectedFile)}
                      disabled={downloading}
                    >
                      {downloading ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="mr-1 h-4 w-4" />
                      )}
                      Download File
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2">
              <FolderOpen className="h-8 w-8 opacity-40" />
              <p className="text-sm">Select a file to edit</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
