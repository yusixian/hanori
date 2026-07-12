import { Badge } from "@/components/ui/badge";
import { Pagination } from "@/components/ui/pagination";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/lib/client";
import { Check, Loader2, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";

interface MemoryItem {
  id: number;
  botId: string;
  telegramId: number | null;
  content: string;
  category: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CreateForm {
  content: string;
  category: string;
  telegramId: string;
}

interface EditForm {
  content: string;
  category: string;
  telegramId: string;
}

const emptyCreateForm: CreateForm = {
  content: "",
  category: "",
  telegramId: "",
};

export function BotMemoriesPage() {
  const { botId } = useParams<{ botId: string }>();
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<string[]>([]);
  const [filterCategory, setFilterCategory] = useState("");
  const [filterTelegramId, setFilterTelegramId] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(emptyCreateForm);
  const [showCreate, setShowCreate] = useState(false);
  const limit = 20;

  const loadCategories = useCallback(async () => {
    if (!botId) return;
    try {
      const res = await client.api.bots[":botId"].memories.meta.$get({
        param: { botId },
      });
      const json = await res.json();
      if (json.ok) {
        setCategories(json.data.categories);
      }
    } catch (err) {
      console.error("Failed to load categories:", err);
    }
  }, [botId]);

  const loadMemories = useCallback(async () => {
    if (!botId) return;
    setLoading(true);
    try {
      const query: Record<string, string> = {
        page: String(page),
        limit: String(limit),
      };
      if (filterCategory) query.category = filterCategory;
      if (filterTelegramId) query.telegramId = filterTelegramId;
      if (search) query.search = search;

      const res = await client.api.bots[":botId"].memories.$get({
        param: { botId },
        query,
      });
      const json = await res.json();
      if (json.ok) {
        setMemories(json.data as MemoryItem[]);
        setTotal(json.total);
      }
    } catch (err) {
      console.error("Failed to load memories:", err);
    } finally {
      setLoading(false);
    }
  }, [botId, page, filterCategory, filterTelegramId, search]);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

  const handleSearch = () => {
    setPage(1);
    setSearch(searchInput);
  };

  const handleDelete = async (memoryId: number) => {
    if (!botId || !window.confirm("Delete this memory?")) return;
    try {
      await client.api.bots[":botId"].memories[":memoryId"].$delete({
        param: { botId, memoryId: String(memoryId) },
      });
      loadMemories();
      loadCategories();
    } catch (err) {
      console.error("Failed to delete memory:", err);
    }
  };

  const startEdit = (m: MemoryItem) => {
    setEditingId(m.id);
    setEditForm({
      content: m.content,
      category: m.category ?? "",
      telegramId: m.telegramId != null ? String(m.telegramId) : "",
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditForm(null);
  };

  const handleSave = async () => {
    if (!botId || !editForm || editingId === null) return;
    setSaving(true);
    try {
      const tid = editForm.telegramId.trim();
      await client.api.bots[":botId"].memories[":memoryId"].$put({
        param: { botId, memoryId: String(editingId) },
        json: {
          content: editForm.content,
          category: editForm.category.trim() || null,
          telegramId: tid ? Number(tid) : null,
        },
      });
      cancelEdit();
      loadMemories();
      loadCategories();
    } catch (err) {
      console.error("Failed to save memory:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async () => {
    if (!botId || !createForm.content.trim()) return;
    setCreating(true);
    try {
      const tid = createForm.telegramId.trim();
      await client.api.bots[":botId"].memories.$post({
        param: { botId },
        json: {
          content: createForm.content,
          category: createForm.category.trim() || undefined,
          telegramId: tid ? Number(tid) : undefined,
        },
      });
      setShowCreate(false);
      setCreateForm(emptyCreateForm);
      loadMemories();
      loadCategories();
    } catch (err) {
      console.error("Failed to create memory:", err);
    } finally {
      setCreating(false);
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Bot Memories</h1>
        <span className="text-muted-foreground text-sm">{total} total</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => setShowCreate(!showCreate)}
        >
          <Plus className="h-4 w-4" />
          Add Memory
        </Button>
      </div>

      {showCreate && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">New Memory</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <label htmlFor="create-mem-content" className="text-muted-foreground text-xs">
                Content *
              </label>
              <Textarea
                id="create-mem-content"
                className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                rows={3}
                value={createForm.content}
                onChange={(e) => setCreateForm({ ...createForm, content: e.target.value })}
                placeholder="Memory content..."
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="create-mem-category" className="text-muted-foreground text-xs">
                  Category
                </label>
                <Input
                  id="create-mem-category"
                  value={createForm.category}
                  onChange={(e) => setCreateForm({ ...createForm, category: e.target.value })}
                  placeholder="fact, preference, rule, event"
                />
              </div>
              <div>
                <label htmlFor="create-mem-telegram-id" className="text-muted-foreground text-xs">
                  Telegram ID (optional)
                </label>
                <Input
                  id="create-mem-telegram-id"
                  value={createForm.telegramId}
                  onChange={(e) => setCreateForm({ ...createForm, telegramId: e.target.value })}
                  placeholder="Leave empty for general memory"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleCreate}
                disabled={creating || !createForm.content.trim()}
              >
                {creating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Create
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowCreate(false);
                  setCreateForm(emptyCreateForm);
                }}
              >
                <X className="h-4 w-4" />
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search memories..."
          className="max-w-xs"
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        />
        <Button variant="outline" size="sm" onClick={handleSearch}>
          <Search className="h-4 w-4" />
          Search
        </Button>

        <Select
          className="border-input flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm"
          value={filterCategory}
          onChange={(e) => {
            setFilterCategory(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All Categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>

        <Select
          className="border-input flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm"
          value={filterTelegramId}
          onChange={(e) => {
            setFilterTelegramId(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All Memories</option>
          <option value="general">General Only</option>
        </Select>

        {(search || filterCategory || filterTelegramId) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setSearchInput("");
              setFilterCategory("");
              setFilterTelegramId("");
              setPage(1);
            }}
          >
            Clear Filters
          </Button>
        )}
      </div>

      {loading ? (
        <p className="text-muted-foreground text-sm">Loading...</p>
      ) : memories.length === 0 ? (
        <p className="text-muted-foreground text-sm">No memories found.</p>
      ) : (
        <div className="space-y-3">
          {memories.map((m) => (
            <Card key={m.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    {m.category && <Badge variant="default">{m.category}</Badge>}
                    {m.telegramId != null ? (
                      <Badge variant="warning">User: {m.telegramId}</Badge>
                    ) : (
                      <Badge variant="muted">General</Badge>
                    )}
                  </div>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {new Date(m.updatedAt).toLocaleString()}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 pt-0">
                {editingId === m.id && editForm ? (
                  <div className="space-y-3">
                    <div>
                      <label
                        htmlFor={`edit-mem-content-${m.id}`}
                        className="text-muted-foreground text-xs"
                      >
                        Content
                      </label>
                      <Textarea
                        id={`edit-mem-content-${m.id}`}
                        className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                        rows={3}
                        value={editForm.content}
                        onChange={(e) => setEditForm({ ...editForm, content: e.target.value })}
                      />
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label
                          htmlFor={`edit-mem-category-${m.id}`}
                          className="text-muted-foreground text-xs"
                        >
                          Category
                        </label>
                        <Input
                          id={`edit-mem-category-${m.id}`}
                          value={editForm.category}
                          onChange={(e) => setEditForm({ ...editForm, category: e.target.value })}
                        />
                      </div>
                      <div>
                        <label
                          htmlFor={`edit-mem-telegram-id-${m.id}`}
                          className="text-muted-foreground text-xs"
                        >
                          Telegram ID
                        </label>
                        <Input
                          id={`edit-mem-telegram-id-${m.id}`}
                          value={editForm.telegramId}
                          onChange={(e) => setEditForm({ ...editForm, telegramId: e.target.value })}
                          placeholder="Empty = general"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleSave} disabled={saving}>
                        {saving ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Check className="h-4 w-4" />
                        )}
                        Save
                      </Button>
                      <Button variant="ghost" size="sm" onClick={cancelEdit}>
                        <X className="h-4 w-4" />
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-sm whitespace-pre-wrap">{m.content}</p>
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-muted-foreground text-xs">
                        Created: {new Date(m.createdAt).toLocaleString()}
                      </span>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => startEdit(m)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(m.id)}>
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
