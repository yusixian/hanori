import { Badge } from "@/components/ui/badge";
import { Pagination } from "@/components/ui/pagination";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/lib/client";
import {
  AlertTriangle,
  Check,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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

type LoadError = "initial" | "stale" | null;
type MutationKind = "create" | "save" | "delete";

async function requireSuccessfulMutation(response: Response, message: string): Promise<void> {
  let result: { ok?: boolean };
  try {
    result = (await response.json()) as { ok?: boolean };
  } catch {
    throw new Error(message);
  }
  if (!response.ok || result.ok !== true) throw new Error(message);
}

export function BotMemoriesPage() {
  const { botId } = useParams<{ botId: string }>();
  return botId ? <BotMemoriesContent key={botId} botId={botId} /> : null;
}

function BotMemoriesContent({ botId }: { botId: string }) {
  const { t, i18n } = useTranslation("botData");
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadedQueryKey, setLoadedQueryKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<LoadError>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [categories, setCategories] = useState<string[]>([]);
  const [categoriesReloadToken, setCategoriesReloadToken] = useState(0);
  const [filterCategory, setFilterCategory] = useState("");
  const [filterTelegramId, setFilterTelegramId] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [createForm, setCreateForm] = useState<CreateForm>(emptyCreateForm);
  const [showCreate, setShowCreate] = useState(false);
  const [pendingMutation, setPendingMutation] = useState<{
    kind: MutationKind;
    memoryId?: number;
  } | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [mutationRecoveryPending, setMutationRecoveryPending] = useState(false);
  const listRequestRef = useRef(0);
  const loadedQueryKeyRef = useRef<string | null>(null);
  const mutationInFlightRef = useRef(false);
  const mutationRecoveryRef = useRef(false);
  const mountedRef = useRef(false);
  const limit = 20;
  const queryKey = JSON.stringify([page, filterCategory, filterTelegramId, search]);
  const hasCurrentData = loadedQueryKey === queryKey;
  const hasConfirmedEmptyData =
    hasCurrentData && memories.length === 0 && !loading && loadError === null;
  const mutationPending = pendingMutation !== null;
  const mutationControlsLocked = mutationPending || mutationRecoveryPending;
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const dateTimeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await client.api.bots[":botId"].memories.meta.$get(
          { param: { botId } },
          { init: { signal: controller.signal } },
        );
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error("Categories request failed");
        if (!controller.signal.aborted) setCategories(result.data.categories);
      } catch {
        // The category filter remains usable with its default options when metadata is unavailable.
      }
    })();
    return () => controller.abort();
  }, [botId, categoriesReloadToken]);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++listRequestRef.current;
    setLoading(true);
    setLoadError(null);
    const query: Record<string, string> = {
      page: String(page),
      limit: String(limit),
    };
    if (filterCategory) query.category = filterCategory;
    if (filterTelegramId) query.telegramId = filterTelegramId;
    if (search) query.search = search;

    void (async () => {
      try {
        const response = await client.api.bots[":botId"].memories.$get(
          { param: { botId }, query },
          { init: { signal: controller.signal } },
        );
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error("Memories request failed");
        if (controller.signal.aborted || requestId !== listRequestRef.current) return;
        setMemories(result.data as MemoryItem[]);
        setTotal(result.total);
        loadedQueryKeyRef.current = queryKey;
        setLoadedQueryKey(queryKey);
      } catch {
        if (controller.signal.aborted || requestId !== listRequestRef.current) return;
        setLoadError(loadedQueryKeyRef.current === queryKey ? "stale" : "initial");
      } finally {
        if (!controller.signal.aborted && requestId === listRequestRef.current) {
          setLoading(false);
          if (mutationRecoveryRef.current) {
            mutationRecoveryRef.current = false;
            setMutationRecoveryPending(false);
          }
        }
      }
    })();

    return () => controller.abort();
  }, [botId, filterCategory, filterTelegramId, page, queryKey, reloadToken, search]);

  useEffect(() => {
    setMutationError(null);
    setSuccessMessage(null);
  }, [queryKey]);

  const handleSearch = () => {
    if (mutationInFlightRef.current || mutationRecoveryRef.current) return;
    setPage(1);
    setSearch(searchInput);
  };

  const handleDelete = async (memoryId: number) => {
    if (
      mutationInFlightRef.current ||
      mutationRecoveryRef.current ||
      !window.confirm(t("memories.deleteConfirm"))
    )
      return;
    mutationInFlightRef.current = true;
    setPendingMutation({ kind: "delete", memoryId });
    setMutationError(null);
    setSuccessMessage(null);
    try {
      const response = await client.api.bots[":botId"].memories[":memoryId"].$delete({
        param: { botId, memoryId: String(memoryId) },
      });
      await requireSuccessfulMutation(response, t("common.deleteFailed"));
      if (mountedRef.current) {
        setSuccessMessage(t("common.deleted"));
        setReloadToken((value) => value + 1);
        setCategoriesReloadToken((value) => value + 1);
      }
    } catch {
      if (mountedRef.current) setMutationError(t("common.deleteFailed"));
    } finally {
      mutationInFlightRef.current = false;
      if (mountedRef.current) setPendingMutation(null);
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
    if (
      !editForm ||
      editingId === null ||
      mutationInFlightRef.current ||
      mutationRecoveryRef.current
    )
      return;
    mutationInFlightRef.current = true;
    setPendingMutation({ kind: "save", memoryId: editingId });
    setMutationError(null);
    setSuccessMessage(null);
    try {
      const tid = editForm.telegramId.trim();
      const response = await client.api.bots[":botId"].memories[":memoryId"].$put({
        param: { botId, memoryId: String(editingId) },
        json: {
          content: editForm.content,
          category: editForm.category.trim() || null,
          telegramId: tid ? Number(tid) : null,
        },
      });
      await requireSuccessfulMutation(response, t("common.saveFailed"));
      if (mountedRef.current) {
        cancelEdit();
        setSuccessMessage(t("common.saved"));
        setReloadToken((value) => value + 1);
        setCategoriesReloadToken((value) => value + 1);
      }
    } catch {
      if (mountedRef.current) setMutationError(t("common.saveFailed"));
    } finally {
      mutationInFlightRef.current = false;
      if (mountedRef.current) setPendingMutation(null);
    }
  };

  const handleCreate = async () => {
    if (!createForm.content.trim() || mutationInFlightRef.current || mutationRecoveryRef.current)
      return;
    mutationInFlightRef.current = true;
    setPendingMutation({ kind: "create" });
    setMutationError(null);
    setSuccessMessage(null);
    try {
      const tid = createForm.telegramId.trim();
      const response = await client.api.bots[":botId"].memories.$post({
        param: { botId },
        json: {
          content: createForm.content,
          category: createForm.category.trim() || undefined,
          telegramId: tid ? Number(tid) : undefined,
        },
      });
      await requireSuccessfulMutation(response, t("common.createFailed"));
      if (mountedRef.current) {
        setShowCreate(false);
        setCreateForm(emptyCreateForm);
        setSuccessMessage(t("common.created"));
        setReloadToken((value) => value + 1);
        setCategoriesReloadToken((value) => value + 1);
      }
    } catch {
      if (mountedRef.current) setMutationError(t("common.createFailed"));
    } finally {
      mutationInFlightRef.current = false;
      if (mountedRef.current) setPendingMutation(null);
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-bold">{t("memories.title")}</h1>
          {hasCurrentData && (total > 0 || (!loading && loadError === null)) && (
            <span className="text-muted-foreground shrink-0 text-sm whitespace-nowrap">
              {t("common.total", { value: numberFormatter.format(total) })}
            </span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-full shrink-0 sm:ml-auto sm:w-auto"
          onClick={() => setShowCreate(!showCreate)}
          disabled={mutationControlsLocked}
        >
          <Plus className="h-4 w-4" />
          {t("memories.add")}
        </Button>
      </div>

      {mutationError && (
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/5 text-destructive flex flex-col gap-3 rounded-lg border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <span>{mutationError}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              mutationRecoveryRef.current = true;
              setMutationRecoveryPending(true);
              setMutationError(null);
              setReloadToken((value) => value + 1);
              setCategoriesReloadToken((value) => value + 1);
            }}
          >
            <RefreshCw className="size-3.5" />
            {t("common.refreshList")}
          </Button>
        </div>
      )}
      {successMessage && (
        <div
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
        >
          {successMessage}
        </div>
      )}

      {showCreate && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("memories.new")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <label htmlFor="create-mem-content" className="text-muted-foreground text-xs">
                {t("memories.content")} *
              </label>
              <Textarea
                id="create-mem-content"
                className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                rows={3}
                value={createForm.content}
                onChange={(e) => setCreateForm({ ...createForm, content: e.target.value })}
                placeholder={t("memories.contentPlaceholder")}
                disabled={mutationControlsLocked}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="create-mem-category" className="text-muted-foreground text-xs">
                  {t("memories.category")}
                </label>
                <Input
                  id="create-mem-category"
                  value={createForm.category}
                  onChange={(e) => setCreateForm({ ...createForm, category: e.target.value })}
                  placeholder={t("memories.categoryPlaceholder")}
                  disabled={mutationControlsLocked}
                />
              </div>
              <div>
                <label htmlFor="create-mem-telegram-id" className="text-muted-foreground text-xs">
                  {t("memories.telegramIdOptional")}
                </label>
                <Input
                  id="create-mem-telegram-id"
                  value={createForm.telegramId}
                  onChange={(e) => setCreateForm({ ...createForm, telegramId: e.target.value })}
                  placeholder={t("memories.generalMemoryPlaceholder")}
                  disabled={mutationControlsLocked}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleCreate}
                disabled={mutationControlsLocked || !createForm.content.trim()}
              >
                {pendingMutation?.kind === "create" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                {pendingMutation?.kind === "create" ? t("common.submitting") : t("common.create")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowCreate(false);
                  setCreateForm(emptyCreateForm);
                }}
                disabled={mutationControlsLocked}
              >
                <X className="h-4 w-4" />
                {t("common.cancel")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <fieldset
        className="flex min-w-0 flex-wrap items-center gap-2 border-0 p-0"
        disabled={mutationControlsLocked}
      >
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t("memories.searchPlaceholder")}
          className="max-w-xs"
          disabled={mutationControlsLocked}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={handleSearch}
          disabled={mutationControlsLocked}
        >
          <Search className="h-4 w-4" />
          {t("common.search")}
        </Button>

        <Select
          className="border-input flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm"
          value={filterCategory}
          onChange={(e) => {
            if (mutationInFlightRef.current || mutationRecoveryRef.current) return;
            setFilterCategory(e.target.value);
            setPage(1);
          }}
          disabled={mutationControlsLocked}
        >
          <option value="">{t("memories.allCategories")}</option>
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
            if (mutationInFlightRef.current || mutationRecoveryRef.current) return;
            setFilterTelegramId(e.target.value);
            setPage(1);
          }}
          disabled={mutationControlsLocked}
        >
          <option value="">{t("memories.allMemories")}</option>
          <option value="general">{t("memories.generalOnly")}</option>
        </Select>

        {(search || filterCategory || filterTelegramId) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (mutationInFlightRef.current || mutationRecoveryRef.current) return;
              setSearch("");
              setSearchInput("");
              setFilterCategory("");
              setFilterTelegramId("");
              setPage(1);
            }}
            disabled={mutationControlsLocked}
          >
            {t("common.clearFilters")}
          </Button>
        )}
      </fieldset>

      {loadError === "stale" && hasCurrentData && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between"
        >
          <span className="flex items-start gap-2">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t("common.refreshFailed")}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => setReloadToken((value) => value + 1)}
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            {t("common.retry")}
          </Button>
        </div>
      )}

      {loadError === "initial" && !hasCurrentData ? (
        <Card role="alert">
          <CardContent className="flex flex-col items-start gap-4 px-5 py-8">
            <p className="text-sm">{t("common.loadFailed")}</p>
            <Button
              size="sm"
              disabled={loading}
              onClick={() => setReloadToken((value) => value + 1)}
            >
              <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
              {t("common.retry")}
            </Button>
          </CardContent>
        </Card>
      ) : (loading || !hasCurrentData) && !hasCurrentData ? (
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      ) : hasConfirmedEmptyData ? (
        <p className="text-muted-foreground text-sm">{t("memories.empty")}</p>
      ) : hasCurrentData ? (
        <div className="space-y-3">
          {memories.map((m) => (
            <Card key={m.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    {m.category && <Badge variant="default">{m.category}</Badge>}
                    {m.telegramId != null ? (
                      <Badge variant="warning">{t("memories.user", { id: m.telegramId })}</Badge>
                    ) : (
                      <Badge variant="muted">{t("memories.general")}</Badge>
                    )}
                  </div>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {dateTimeFormatter.format(new Date(m.updatedAt))}
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
                        {t("memories.content")}
                      </label>
                      <Textarea
                        id={`edit-mem-content-${m.id}`}
                        className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                        rows={3}
                        value={editForm.content}
                        onChange={(e) => setEditForm({ ...editForm, content: e.target.value })}
                        disabled={mutationControlsLocked}
                      />
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label
                          htmlFor={`edit-mem-category-${m.id}`}
                          className="text-muted-foreground text-xs"
                        >
                          {t("memories.category")}
                        </label>
                        <Input
                          id={`edit-mem-category-${m.id}`}
                          value={editForm.category}
                          onChange={(e) => setEditForm({ ...editForm, category: e.target.value })}
                          disabled={mutationControlsLocked}
                        />
                      </div>
                      <div>
                        <label
                          htmlFor={`edit-mem-telegram-id-${m.id}`}
                          className="text-muted-foreground text-xs"
                        >
                          {t("memories.telegramId")}
                        </label>
                        <Input
                          id={`edit-mem-telegram-id-${m.id}`}
                          value={editForm.telegramId}
                          onChange={(e) => setEditForm({ ...editForm, telegramId: e.target.value })}
                          placeholder={t("memories.emptyMeansGeneral")}
                          disabled={mutationControlsLocked}
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleSave} disabled={mutationControlsLocked}>
                        {pendingMutation?.kind === "save" ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Check className="h-4 w-4" />
                        )}
                        {pendingMutation?.kind === "save"
                          ? t("common.submitting")
                          : t("common.save")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={cancelEdit}
                        disabled={mutationControlsLocked}
                      >
                        <X className="h-4 w-4" />
                        {t("common.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-sm whitespace-pre-wrap">{m.content}</p>
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-muted-foreground text-xs">
                        {t("memories.createdAt", {
                          date: dateTimeFormatter.format(new Date(m.createdAt)),
                        })}
                      </span>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => startEdit(m)}
                          title={t("memories.editTitle")}
                          aria-label={t("memories.editTitle")}
                          disabled={mutationControlsLocked}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(m.id)}
                          title={t("memories.deleteTitle")}
                          aria-label={t("memories.deleteTitle")}
                          disabled={mutationControlsLocked}
                        >
                          {pendingMutation?.kind === "delete" &&
                          pendingMutation.memoryId === m.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4 text-red-500" />
                          )}
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {hasCurrentData && (
        <fieldset disabled={mutationControlsLocked} className="min-w-0 border-0 p-0">
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={(nextPage) => {
              if (mutationInFlightRef.current || mutationRecoveryRef.current) return;
              setPage(nextPage);
            }}
          />
        </fieldset>
      )}
    </div>
  );
}
