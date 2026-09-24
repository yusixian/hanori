import { Badge } from "@/components/ui/badge";
import { Pagination } from "@/components/ui/pagination";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { BotMemoryKind } from "@cos-tool-bot/shared";
import { client } from "@/lib/client";
import {
  AlertTriangle,
  Archive,
  Check,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useParams, useSearchParams } from "react-router";

type MemoryKind = BotMemoryKind;

interface MemoryItem {
  id: number;
  botId: string;
  telegramId: number | null;
  content: string;
  category: string | null;
  kind: MemoryKind | null;
  scopeChatId: number | null;
  origin: string | null;
  sourceChatId: number | null;
  sourceMessageId: number | null;
  sourceUserId: number | null;
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CreateForm {
  content: string;
  category: string;
  telegramId: string;
  kind: MemoryKind | "";
  scopeChatId: string;
  expiresAt: string;
}

type EditForm = CreateForm;

const emptyCreateForm: CreateForm = {
  content: "",
  category: "",
  telegramId: "",
  kind: "",
  scopeChatId: "",
  expiresAt: "",
};

type LoadError = "initial" | "stale" | null;
type MutationKind = "create" | "save" | "retire" | "delete" | "duplicate-cleanup";

const memoryKinds: MemoryKind[] = ["fact", "preference", "event", "commitment", "relationship"];

function toLocalDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function validOptionalChatId(value: string): boolean {
  return !value.trim() || isTelegramId(value.trim());
}

function validOptionalDate(value: string): boolean {
  return !value || !Number.isNaN(new Date(value).getTime());
}

function memoryStatus(memory: MemoryItem): "active" | "expired" | "retired" {
  if (!memory.isActive) return "retired";
  if (memory.expiresAt && new Date(memory.expiresAt).getTime() <= Date.now()) return "expired";
  return "active";
}

async function requireSuccessfulMutation(response: Response, message: string): Promise<void> {
  let result: { ok?: boolean };
  try {
    result = (await response.json()) as { ok?: boolean };
  } catch {
    throw new Error(message);
  }
  if (!response.ok || result.ok !== true) throw new Error(message);
}

interface MemoryQuery {
  page: number;
  search: string;
  category: string;
  telegramId: string;
}

interface MemoryFilterForm {
  search: string;
  category: string;
  scope: "all" | "general" | "user";
  telegramId: string;
}

interface MemoryDuplicateCandidate {
  candidateId: number;
  survivorId: number;
  expectedCandidateUpdatedAt: string;
  expectedSurvivorUpdatedAt: string;
  content: string;
  telegramId: number | null;
  scopeChatId: number | null;
  kind: string | null;
  category: string | null;
}

interface MemoryDuplicatePreview {
  data: MemoryDuplicateCandidate[];
  hasMore: boolean;
  batchMax: number;
}

const maximumDuplicateBatchSize = 50;

function isTelegramId(value: string) {
  return /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value));
}

function readMemoryQuery(value: string): MemoryQuery {
  const params = new URLSearchParams(value);
  const page = Number(params.get("page") ?? "1");
  const rawId = (params.get("telegramId") ?? "").trim();
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    search: (params.get("search") ?? "").trim(),
    category: (params.get("category") ?? "").trim(),
    telegramId: isTelegramId(rawId) ? String(Number(rawId)) : rawId,
  };
}

function filterKey(query: MemoryQuery) {
  return JSON.stringify([query.search, query.category, query.telegramId]);
}

function queryToForm(query: MemoryQuery): MemoryFilterForm {
  return {
    search: query.search,
    category: query.category,
    scope: !query.telegramId ? "all" : query.telegramId === "general" ? "general" : "user",
    telegramId: query.telegramId === "general" ? "" : query.telegramId,
  };
}

export function BotMemoriesPage() {
  const { botId } = useParams<{ botId: string }>();
  return botId ? <BotMemoriesContent key={botId} botId={botId} /> : null;
}

function BotMemoriesContent({ botId }: { botId: string }) {
  const { t, i18n } = useTranslation("botData");
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const [historyRevision, setHistoryRevision] = useState(0);
  const requestedQuery = searchParams.toString();
  const [activeQuery, setActiveQuery] = useState(requestedQuery);
  const query = useMemo(() => readMemoryQuery(activeQuery), [activeQuery]);
  const { page, search, category: filterCategory, telegramId: filterTelegramId } = query;
  const submittedFiltersRef = useRef(filterKey(query));
  const validQuery =
    !filterTelegramId || filterTelegramId === "general" || isTelegramId(filterTelegramId);
  const [filterForm, setFilterForm] = useState(() => queryToForm(query));
  const [filterError, setFilterError] = useState(false);
  const filterIdRef = useRef<HTMLInputElement>(null);
  const filterComposingRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [loadedQueryKey, setLoadedQueryKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<LoadError>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [categories, setCategories] = useState<string[]>([]);
  const [categoriesReloadToken, setCategoriesReloadToken] = useState(0);
  const [editingMemory, setEditingMemory] = useState<MemoryItem | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [createForm, setCreateForm] = useState<CreateForm>(emptyCreateForm);
  const [showCreate, setShowCreate] = useState(false);
  const [pendingMutation, setPendingMutation] = useState<{
    kind: MutationKind;
    memoryId?: number;
  } | null>(null);
  const [duplicatePreviewOpen, setDuplicatePreviewOpen] = useState(false);
  const [duplicatePreview, setDuplicatePreview] = useState<MemoryDuplicatePreview | null>(null);
  const [duplicatePreviewLoading, setDuplicatePreviewLoading] = useState(false);
  const [duplicatePreviewError, setDuplicatePreviewError] = useState(false);
  const [duplicateCleanupNotice, setDuplicateCleanupNotice] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [confirmationRequired, setConfirmationRequired] = useState(false);
  const [mutationRecoveryPending, setMutationRecoveryPending] = useState(false);
  const listRequestRef = useRef(0);
  const duplicatePreviewRequestRef = useRef(0);
  const loadedQueryKeyRef = useRef<string | null>(null);
  const mutationInFlightRef = useRef(false);
  const mutationRecoveryRef = useRef(false);
  const mountedRef = useRef(false);
  const limit = 20;
  const queryKey = JSON.stringify([page, filterCategory, filterTelegramId, search]);
  const hasCurrentData = validQuery && loadedQueryKey === queryKey;
  const hasConfirmedEmptyData =
    hasCurrentData && memories.length === 0 && !loading && loadError === null;
  const mutationPending = pendingMutation !== null;
  const operationPending = mutationPending || mutationRecoveryPending || duplicatePreviewLoading;
  const queryNavigationPending =
    JSON.stringify(readMemoryQuery(requestedQuery)) !== JSON.stringify(query);
  const navigationHeld =
    operationPending || confirmationRequired || mutationError !== null || editingId !== null;
  const mutationControlsLocked =
    operationPending || confirmationRequired || (queryNavigationPending && !navigationHeld);
  const queryControlsLocked = mutationControlsLocked || navigationHeld;
  const displayMemories =
    editingMemory && !memories.some((item) => item.id === editingMemory.id)
      ? [editingMemory, ...memories]
      : memories;
  const draftTelegramId =
    filterForm.scope === "all"
      ? ""
      : filterForm.scope === "general"
        ? "general"
        : filterForm.telegramId.trim();
  const unappliedFilters =
    filterForm.search.trim() !== search ||
    filterForm.category !== filterCategory ||
    draftTelegramId !== filterTelegramId;
  const hasFilters = !!(
    search ||
    filterCategory ||
    filterTelegramId ||
    filterForm.search ||
    filterForm.category ||
    filterForm.scope !== "all"
  );
  const categoryOptions = [
    ...new Set([...categories, filterForm.category, filterCategory].filter(Boolean)),
  ];
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const dateTimeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );
  const createFieldsValid =
    validOptionalChatId(createForm.scopeChatId) && validOptionalDate(createForm.expiresAt);
  const editFieldsValid =
    editForm !== null &&
    validOptionalChatId(editForm.scopeChatId) &&
    validOptionalDate(editForm.expiresAt);

  useEffect(() => {
    // Router transitions may coalesce PUSH then POP back to the same location context.
    const onPopState = () => setHistoryRevision((value) => value + 1);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Compare the last submitted filters even when a rapid Back skips the intermediate render.
  // A page-only navigation leaves unapplied filter inputs intact.
  useLayoutEffect(() => {
    if (navigationHeld) return;
    const next = readMemoryQuery(location.search);
    const nextFilterKey = filterKey(next);
    if (submittedFiltersRef.current !== nextFilterKey) {
      submittedFiltersRef.current = nextFilterKey;
      setFilterForm(queryToForm(next));
      setFilterError(false);
    }
    setActiveQuery(location.search);
  }, [location, navigationHeld, historyRevision]);

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
    const isConfirmationRequest = mutationRecoveryRef.current;
    if (!validQuery) {
      setLoading(false);
      setLoadError(null);
      return () => controller.abort();
    }
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
        if (isConfirmationRequest) {
          setConfirmationRequired(false);
          setMutationError(null);
        }
      } catch {
        if (controller.signal.aborted || requestId !== listRequestRef.current) return;
        setLoadError(loadedQueryKeyRef.current === queryKey ? "stale" : "initial");
      } finally {
        if (!controller.signal.aborted && requestId === listRequestRef.current) {
          setLoading(false);
          if (isConfirmationRequest) {
            mutationRecoveryRef.current = false;
            setMutationRecoveryPending(false);
          }
        }
      }
    })();

    return () => controller.abort();
  }, [botId, filterCategory, filterTelegramId, page, queryKey, reloadToken, search, validQuery]);

  useEffect(() => {
    setSuccessMessage(null);
  }, [queryKey]);

  const updateQuery = (nextQuery: MemoryQuery) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries({
      search: nextQuery.search,
      category: nextQuery.category,
      telegramId: nextQuery.telegramId,
      page: nextQuery.page > 1 ? String(nextQuery.page) : "",
    })) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (next.toString() === requestedQuery) setReloadToken((value) => value + 1);
    else {
      submittedFiltersRef.current = filterKey(nextQuery);
      setSearchParams(next);
    }
  };

  const refreshList = () => {
    if (mutationInFlightRef.current || mutationRecoveryRef.current) return;
    if (mutationError !== null || confirmationRequired) {
      mutationRecoveryRef.current = true;
      setMutationRecoveryPending(true);
      setConfirmationRequired(true);
    }
    setReloadToken((value) => value + 1);
    setCategoriesReloadToken((value) => value + 1);
  };

  const handleSearch = () => {
    if (
      mutationInFlightRef.current ||
      mutationRecoveryRef.current ||
      queryControlsLocked ||
      filterComposingRef.current
    )
      return;
    if (filterForm.scope === "user" && !isTelegramId(filterForm.telegramId.trim())) {
      setFilterError(true);
      filterIdRef.current?.focus();
      return;
    }
    const nextQuery = {
      page: 1,
      search: filterForm.search.trim(),
      category: filterForm.category.trim(),
      telegramId:
        filterForm.scope === "user"
          ? String(Number(filterForm.telegramId.trim()))
          : draftTelegramId,
    };
    setFilterError(false);
    setFilterForm(queryToForm(nextQuery));
    updateQuery(nextQuery);
  };

  const clearFilters = () => {
    if (mutationInFlightRef.current || mutationRecoveryRef.current || queryControlsLocked) return;
    const nextQuery = { page: 1, search: "", category: "", telegramId: "" };
    setFilterError(false);
    setFilterForm(queryToForm(nextQuery));
    updateQuery(nextQuery);
  };

  const refreshListAfterMutation = () => {
    mutationRecoveryRef.current = true;
    setMutationRecoveryPending(true);
    setConfirmationRequired(true);
    setReloadToken((value) => value + 1);
    setCategoriesReloadToken((value) => value + 1);
  };

  const refreshDuplicatePreview = async (): Promise<boolean> => {
    const requestId = ++duplicatePreviewRequestRef.current;
    setDuplicatePreviewLoading(true);
    setDuplicatePreviewError(false);
    try {
      const response = await client.api.bots[":botId"].memories["duplicate-preview"].$get({
        param: { botId },
      });
      const result = (await response.json()) as {
        ok?: boolean;
        data?: MemoryDuplicateCandidate[];
        hasMore?: boolean;
        batchMax?: number;
      };
      if (
        !response.ok ||
        result.ok !== true ||
        !Array.isArray(result.data) ||
        result.data.length > maximumDuplicateBatchSize ||
        typeof result.hasMore !== "boolean" ||
        typeof result.batchMax !== "number" ||
        result.batchMax < 1 ||
        result.batchMax > maximumDuplicateBatchSize ||
        result.data.length > result.batchMax
      )
        throw new Error("Duplicate preview request failed");
      if (requestId !== duplicatePreviewRequestRef.current) return false;
      setDuplicatePreview({
        data: result.data,
        hasMore: result.hasMore,
        batchMax: result.batchMax,
      });
      return true;
    } catch {
      if (requestId === duplicatePreviewRequestRef.current) {
        setDuplicatePreview(null);
        setDuplicatePreviewError(true);
      }
      return false;
    } finally {
      if (requestId === duplicatePreviewRequestRef.current) setDuplicatePreviewLoading(false);
    }
  };

  const toggleDuplicatePreview = () => {
    if (operationPending || confirmationRequired || mutationError !== null) return;
    if (duplicatePreviewOpen) {
      setDuplicatePreviewOpen(false);
      return;
    }
    setDuplicatePreviewOpen(true);
    setDuplicateCleanupNotice(null);
    void refreshDuplicatePreview();
  };

  const handleRetireDuplicateBatch = async () => {
    const preview = duplicatePreview;
    const batchMax = Math.min(preview?.batchMax ?? 0, maximumDuplicateBatchSize);
    const candidates = preview?.data.slice(0, batchMax) ?? [];
    if (
      candidates.length === 0 ||
      mutationInFlightRef.current ||
      mutationRecoveryRef.current ||
      operationPending ||
      confirmationRequired ||
      mutationError !== null ||
      !window.confirm(t("memories.duplicateCleanup.confirm", { count: candidates.length }))
    )
      return;

    mutationInFlightRef.current = true;
    setPendingMutation({ kind: "duplicate-cleanup" });
    setMutationError(null);
    setDuplicateCleanupNotice(null);
    try {
      const response = await client.api.bots[":botId"].memories["retire-duplicates"].$post({
        param: { botId },
        json: {
          candidates: candidates.map(
            ({
              candidateId,
              survivorId,
              expectedCandidateUpdatedAt,
              expectedSurvivorUpdatedAt,
            }) => ({
              candidateId,
              survivorId,
              expectedCandidateUpdatedAt,
              expectedSurvivorUpdatedAt,
            }),
          ),
        },
      });
      if (response.status === 409) {
        refreshListAfterMutation();
        const previewRefreshed = await refreshDuplicatePreview();
        setDuplicateCleanupNotice(
          t(
            previewRefreshed
              ? "memories.duplicateCleanup.stale"
              : "memories.duplicateCleanup.stalePreviewFailed",
          ),
        );
        return;
      }
      const result = (await response.json()) as { ok?: boolean; retiredCount?: number };
      if (!response.ok || result.ok !== true) throw new Error("Duplicate cleanup failed");
      setDuplicateCleanupNotice(
        t("memories.duplicateCleanup.retiredSuccess", {
          count: result.retiredCount ?? candidates.length,
        }),
      );
      refreshListAfterMutation();
      await refreshDuplicatePreview();
    } catch {
      refreshListAfterMutation();
      const previewRefreshed = await refreshDuplicatePreview();
      setDuplicateCleanupNotice(
        t(
          previewRefreshed
            ? "memories.duplicateCleanup.outcomeUnknown"
            : "memories.duplicateCleanup.outcomeUnknownPreviewFailed",
        ),
      );
    } finally {
      mutationInFlightRef.current = false;
      if (mountedRef.current) setPendingMutation(null);
    }
  };

  const handleDelete = async (memoryId: number) => {
    if (
      mutationInFlightRef.current ||
      mutationRecoveryRef.current ||
      mutationControlsLocked ||
      editingId !== null ||
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
        refreshListAfterMutation();
      }
    } catch {
      if (mountedRef.current) setMutationError(t("common.deleteFailed"));
    } finally {
      mutationInFlightRef.current = false;
      if (mountedRef.current) setPendingMutation(null);
    }
  };

  const handleRetire = async (memoryId: number) => {
    if (
      mutationInFlightRef.current ||
      mutationRecoveryRef.current ||
      mutationControlsLocked ||
      editingId !== null ||
      !window.confirm(t("memories.retireConfirm"))
    )
      return;
    mutationInFlightRef.current = true;
    setPendingMutation({ kind: "retire", memoryId });
    setMutationError(null);
    setSuccessMessage(null);
    try {
      const response = await client.api.bots[":botId"].memories[":memoryId"].retire.$post({
        param: { botId, memoryId: String(memoryId) },
        json: {},
      });
      await requireSuccessfulMutation(response, t("memories.retireFailed"));
      if (mountedRef.current) {
        setSuccessMessage(t("memories.retiredSuccess"));
        refreshListAfterMutation();
      }
    } catch {
      if (mountedRef.current) setMutationError(t("memories.retireFailed"));
    } finally {
      mutationInFlightRef.current = false;
      if (mountedRef.current) setPendingMutation(null);
    }
  };

  const startEdit = (m: MemoryItem) => {
    if (mutationControlsLocked || editingId !== null) return;
    setEditingMemory(m);
    setEditingId(m.id);
    setEditForm({
      content: m.content,
      category: m.category ?? "",
      telegramId: m.telegramId != null ? String(m.telegramId) : "",
      kind: m.kind ?? "",
      scopeChatId: m.scopeChatId != null ? String(m.scopeChatId) : "",
      expiresAt: toLocalDateTime(m.expiresAt),
    });
  };

  const cancelEdit = () => {
    setEditingMemory(null);
    setEditingId(null);
    setEditForm(null);
  };

  const handleSave = async () => {
    if (
      !editForm ||
      !editingMemory ||
      !editFieldsValid ||
      editingId === null ||
      mutationInFlightRef.current ||
      mutationRecoveryRef.current ||
      mutationControlsLocked
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
          expectedUpdatedAt: editingMemory.updatedAt,
          category: editForm.category.trim() || null,
          telegramId: tid ? Number(tid) : null,
          kind: editForm.kind || null,
          scopeChatId: editForm.scopeChatId.trim() ? Number(editForm.scopeChatId.trim()) : null,
          expiresAt:
            editForm.expiresAt === toLocalDateTime(editingMemory.expiresAt)
              ? editingMemory.expiresAt
              : editForm.expiresAt
                ? new Date(editForm.expiresAt).toISOString()
                : null,
        },
      });
      await requireSuccessfulMutation(response, t("common.saveFailed"));
      if (mountedRef.current) {
        cancelEdit();
        setSuccessMessage(t("common.saved"));
        refreshListAfterMutation();
      }
    } catch {
      if (mountedRef.current) setMutationError(t("common.saveFailed"));
    } finally {
      mutationInFlightRef.current = false;
      if (mountedRef.current) setPendingMutation(null);
    }
  };

  const handleCreate = async () => {
    if (
      !createForm.content.trim() ||
      !createFieldsValid ||
      mutationInFlightRef.current ||
      mutationRecoveryRef.current ||
      mutationControlsLocked ||
      !validQuery
    )
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
          kind: createForm.kind || undefined,
          scopeChatId: createForm.scopeChatId.trim()
            ? Number(createForm.scopeChatId.trim())
            : undefined,
          expiresAt: createForm.expiresAt
            ? new Date(createForm.expiresAt).toISOString()
            : undefined,
        },
      });
      await requireSuccessfulMutation(response, t("common.createFailed"));
      if (mountedRef.current) {
        setShowCreate(false);
        setCreateForm(emptyCreateForm);
        setSuccessMessage(t("common.created"));
        refreshListAfterMutation();
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
          onClick={() => {
            if (
              !showCreate &&
              !createForm.content &&
              !createForm.category &&
              !createForm.telegramId &&
              isTelegramId(filterTelegramId)
            ) {
              setCreateForm({ ...emptyCreateForm, telegramId: filterTelegramId });
            }
            setShowCreate(!showCreate);
          }}
          disabled={mutationControlsLocked || !validQuery}
        >
          <Plus className="h-4 w-4" />
          {t("memories.add")}
        </Button>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 pb-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-sm">{t("memories.duplicateCleanup.title")}</CardTitle>
            <p className="text-muted-foreground text-sm wrap-anywhere">
              {t("memories.duplicateCleanup.description")}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full shrink-0 sm:w-auto"
            onClick={toggleDuplicatePreview}
            disabled={operationPending || confirmationRequired || mutationError !== null}
          >
            {duplicatePreviewLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : duplicatePreviewOpen ? (
              <X className="h-4 w-4" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            {duplicatePreviewOpen
              ? t("memories.duplicateCleanup.hidePreview")
              : t("memories.duplicateCleanup.reviewAction")}
          </Button>
        </CardHeader>
        {duplicatePreviewOpen && (
          <CardContent className="space-y-3">
            {duplicateCleanupNotice && (
              <p role="status" className="text-sm">
                {duplicateCleanupNotice}
              </p>
            )}
            {duplicatePreviewLoading && (
              <p role="status" className="text-muted-foreground text-sm">
                {t("memories.duplicateCleanup.loading")}
              </p>
            )}
            {duplicatePreviewError && (
              <div role="alert" className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <p className="text-destructive text-sm">
                  {t("memories.duplicateCleanup.previewFailed")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full sm:w-auto"
                  disabled={operationPending || confirmationRequired}
                  onClick={() => void refreshDuplicatePreview()}
                >
                  <RefreshCw className="size-3.5" />
                  {t("common.retry")}
                </Button>
              </div>
            )}
            {duplicatePreview &&
              !duplicatePreviewLoading &&
              (duplicatePreview.data.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {t("memories.duplicateCleanup.empty")}
                </p>
              ) : (
                <>
                  <p className="text-sm">
                    {t("memories.duplicateCleanup.batchSummary", {
                      count: duplicatePreview.data.length,
                      max: Math.min(duplicatePreview.batchMax, maximumDuplicateBatchSize),
                    })}
                  </p>
                  <ol className="max-h-72 space-y-2 overflow-y-auto pr-1">
                    {duplicatePreview.data.map((candidate) => (
                      <li
                        key={candidate.candidateId}
                        className="bg-muted/40 min-w-0 rounded-md border px-3 py-2"
                      >
                        <p className="text-sm font-medium wrap-anywhere">
                          {t("memories.duplicateCleanup.candidateAndSurvivor", {
                            candidateId: candidate.candidateId,
                            survivorId: candidate.survivorId,
                          })}
                        </p>
                        <p className="text-muted-foreground mt-1 text-sm wrap-anywhere whitespace-pre-wrap">
                          {candidate.content}
                        </p>
                        <p className="text-muted-foreground mt-1 text-xs wrap-anywhere">
                          {candidate.telegramId == null
                            ? t("memories.general")
                            : t("memories.user", { id: candidate.telegramId })}
                          {candidate.scopeChatId != null && (
                            <> · {t("memories.chatScope", { id: candidate.scopeChatId })}</>
                          )}
                          {candidate.kind && <> · {t(`memories.kinds.${candidate.kind}`)}</>}
                          {candidate.category && <> · {candidate.category}</>}
                        </p>
                      </li>
                    ))}
                  </ol>
                  {duplicatePreview.hasMore && (
                    <p className="text-muted-foreground text-sm">
                      {t("memories.duplicateCleanup.moreBatches", {
                        max: Math.min(duplicatePreview.batchMax, maximumDuplicateBatchSize),
                      })}
                    </p>
                  )}
                  {editingId !== null && (
                    <p role="status" className="text-muted-foreground text-sm">
                      {t("memories.duplicateCleanup.finishEditing")}
                    </p>
                  )}
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full sm:w-auto"
                      onClick={handleRetireDuplicateBatch}
                      disabled={
                        mutationControlsLocked ||
                        editingId !== null ||
                        duplicatePreviewLoading ||
                        duplicatePreview.data.length === 0
                      }
                    >
                      {pendingMutation?.kind === "duplicate-cleanup" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Archive className="h-4 w-4" />
                      )}
                      {t("memories.duplicateCleanup.retireBatch", {
                        count: duplicatePreview.data.length,
                      })}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full sm:w-auto"
                      onClick={() => void refreshDuplicatePreview()}
                      disabled={operationPending || confirmationRequired}
                    >
                      <RefreshCw className="size-3.5" />
                      {t("memories.duplicateCleanup.refreshPreview")}
                    </Button>
                  </div>
                </>
              ))}
          </CardContent>
        )}
      </Card>

      {mutationError && (
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/5 text-destructive flex flex-col gap-3 rounded-lg border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <span>{mutationError}</span>
          <Button variant="outline" size="sm" onClick={refreshList} disabled={operationPending}>
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="create-mem-kind" className="text-muted-foreground text-xs">
                  {t("memories.kind")}
                </label>
                <Select
                  id="create-mem-kind"
                  value={createForm.kind}
                  onChange={(event) =>
                    setCreateForm({ ...createForm, kind: event.target.value as MemoryKind | "" })
                  }
                  disabled={mutationControlsLocked}
                >
                  <option value="">{t("memories.kindUnspecified")}</option>
                  {memoryKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`memories.kinds.${kind}`)}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label htmlFor="create-mem-chat-id" className="text-muted-foreground text-xs">
                  {t("memories.chatScopeOptional")}
                </label>
                <Input
                  id="create-mem-chat-id"
                  inputMode="numeric"
                  value={createForm.scopeChatId}
                  onChange={(event) =>
                    setCreateForm({ ...createForm, scopeChatId: event.target.value })
                  }
                  aria-invalid={!validOptionalChatId(createForm.scopeChatId)}
                  placeholder={t("memories.allChatsPlaceholder")}
                  disabled={mutationControlsLocked}
                />
              </div>
              <div>
                <label htmlFor="create-mem-expiry" className="text-muted-foreground text-xs">
                  {t("memories.expiresAtOptional")}
                </label>
                <Input
                  id="create-mem-expiry"
                  type="datetime-local"
                  value={createForm.expiresAt}
                  onChange={(event) =>
                    setCreateForm({ ...createForm, expiresAt: event.target.value })
                  }
                  aria-invalid={!validOptionalDate(createForm.expiresAt)}
                  disabled={mutationControlsLocked}
                />
              </div>
            </div>
            {!createFieldsValid && (
              <p role="alert" className="text-destructive text-sm">
                {t("memories.invalidDetails")}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleCreate}
                disabled={
                  mutationControlsLocked ||
                  !validQuery ||
                  !createForm.content.trim() ||
                  !createFieldsValid
                }
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

      <form
        className="space-y-3"
        aria-label={t("memories.filters")}
        onSubmit={(event) => {
          event.preventDefault();
          handleSearch();
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229 ||
              filterComposingRef.current)
          )
            event.preventDefault();
        }}
        onCompositionStart={() => {
          filterComposingRef.current = true;
        }}
        onCompositionEnd={() => {
          filterComposingRef.current = false;
        }}
      >
        <fieldset
          disabled={queryControlsLocked}
          className="grid min-w-0 grid-cols-2 items-end gap-3 border-0 p-0 xl:flex"
        >
          <div className="col-span-2 flex min-w-0 flex-col gap-1.5 xl:flex-1">
            <label htmlFor="memory-filter-search" className="text-muted-foreground text-xs">
              {t("common.search")}
            </label>
            <Input
              id="memory-filter-search"
              value={filterForm.search}
              onChange={(event) => setFilterForm({ ...filterForm, search: event.target.value })}
              placeholder={t("memories.searchPlaceholder")}
              disabled={queryControlsLocked}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5 xl:w-40">
            <label htmlFor="memory-filter-category" className="text-muted-foreground text-xs">
              {t("memories.category")}
            </label>
            <Select
              id="memory-filter-category"
              value={filterForm.category}
              disabled={queryControlsLocked}
              className="[&>span:first-child]:min-w-0 [&>span:first-child]:truncate [&>span:last-child]:shrink-0"
              onChange={(event) => setFilterForm({ ...filterForm, category: event.target.value })}
            >
              <option value="">{t("memories.allCategories")}</option>
              {categoryOptions.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5 xl:w-40">
            <label htmlFor="memory-filter-scope" className="text-muted-foreground text-xs">
              {t("memories.scope")}
            </label>
            <Select
              id="memory-filter-scope"
              value={filterForm.scope}
              disabled={queryControlsLocked}
              onChange={(event) => {
                const scope = event.target.value;
                if (scope === "all" || scope === "general" || scope === "user")
                  setFilterForm({ ...filterForm, scope });
                setFilterError(false);
              }}
            >
              <option value="all">{t("memories.allMemories")}</option>
              <option value="general">{t("memories.generalOnly")}</option>
              <option value="user">{t("memories.specificUser")}</option>
            </Select>
          </div>
          {filterForm.scope === "user" && (
            <div className="col-span-2 flex min-w-0 flex-col gap-1.5 xl:w-40">
              <label htmlFor="memory-filter-user-id" className="text-muted-foreground text-xs">
                {t("memories.telegramId")}
              </label>
              <Input
                id="memory-filter-user-id"
                ref={filterIdRef}
                value={filterForm.telegramId}
                inputMode="numeric"
                onChange={(event) => {
                  setFilterForm({ ...filterForm, telegramId: event.target.value });
                  setFilterError(false);
                }}
                aria-invalid={filterError || !validQuery}
                aria-describedby={filterError || !validQuery ? "memory-filter-error" : undefined}
                placeholder={t("memories.userIdPlaceholder")}
                disabled={queryControlsLocked}
              />
            </div>
          )}
          <div className="col-span-2 flex flex-wrap gap-2 xl:shrink-0">
            <Button type="submit" variant="outline" size="sm" disabled={queryControlsLocked}>
              <Search className="h-4 w-4" />
              {t("common.search")}
            </Button>
            {hasFilters && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                disabled={queryControlsLocked}
              >
                {t("common.clearFilters")}
              </Button>
            )}
          </div>
        </fieldset>
        {(filterError || !validQuery) && (
          <p id="memory-filter-error" role="alert" className="text-destructive text-sm">
            {t("memories.invalidUserId")}
          </p>
        )}
        {unappliedFilters && (
          <p className="text-muted-foreground text-xs">{t("memories.unappliedFilters")}</p>
        )}
      </form>
      {navigationHeld && (
        <p role="status" className="text-muted-foreground text-sm">
          {editingId !== null ? t("memories.finishEditing") : t("memories.confirmBeforeFiltering")}
          {queryNavigationPending && <> {t("memories.navigationWaiting")}</>}
        </p>
      )}
      {validQuery && (
        <p className="text-muted-foreground text-sm wrap-anywhere">
          {t("memories.showingScope", {
            scope:
              filterTelegramId === "general"
                ? t("memories.generalOnly")
                : filterTelegramId
                  ? t("memories.userScope", { id: filterTelegramId })
                  : t("memories.allMemories"),
          })}
          {" · "}
          {filterCategory
            ? t("memories.categoryScope", { category: filterCategory })
            : t("memories.allCategories")}
          {search && <> · {t("memories.searchScope", { search })}</>}
        </p>
      )}

      {loadError === "stale" && hasCurrentData && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between"
        >
          <span className="flex items-start gap-2">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t("common.refreshFailed")}
          </span>
          <Button variant="outline" size="sm" disabled={loading} onClick={refreshList}>
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            {t("common.retry")}
          </Button>
        </div>
      )}

      {!validQuery ? null : loadError === "initial" && !hasCurrentData ? (
        <Card role="alert">
          <CardContent className="flex flex-col items-start gap-4 px-5 py-8">
            <p className="text-sm">{t("common.loadFailed")}</p>
            <Button size="sm" disabled={loading} onClick={refreshList}>
              <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
              {t("common.retry")}
            </Button>
          </CardContent>
        </Card>
      ) : (loading || !hasCurrentData) && !hasCurrentData ? (
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      ) : hasConfirmedEmptyData && editingId === null ? (
        <p className="text-muted-foreground text-sm">{t("memories.empty")}</p>
      ) : hasCurrentData ? (
        <div className="space-y-3">
          {displayMemories.map((m) => (
            <Card key={m.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={memoryStatus(m) === "active" ? "default" : "muted"}>
                      {t(`memories.${memoryStatus(m)}`)}
                    </Badge>
                    <Badge variant="muted">
                      {m.kind ? t(`memories.kinds.${m.kind}`) : t("memories.kindUnspecified")}
                    </Badge>
                    {m.category && <Badge variant="default">{m.category}</Badge>}
                    {m.telegramId != null ? (
                      <Badge variant="warning">{t("memories.user", { id: m.telegramId })}</Badge>
                    ) : (
                      <Badge variant="muted">{t("memories.general")}</Badge>
                    )}
                    {m.scopeChatId != null && (
                      <Badge variant="muted">
                        {t("memories.chatScope", { id: m.scopeChatId })}
                      </Badge>
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
                    {!memories.some((item) => item.id === m.id) && (
                      <p role="status" className="text-muted-foreground text-sm">
                        {t("memories.retainedDraft")}
                      </p>
                    )}
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
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <div>
                        <label
                          htmlFor={`edit-mem-kind-${m.id}`}
                          className="text-muted-foreground text-xs"
                        >
                          {t("memories.kind")}
                        </label>
                        <Select
                          id={`edit-mem-kind-${m.id}`}
                          value={editForm.kind}
                          onChange={(event) =>
                            setEditForm({
                              ...editForm,
                              kind: event.target.value as MemoryKind | "",
                            })
                          }
                          disabled={mutationControlsLocked}
                        >
                          <option value="">{t("memories.kindUnspecified")}</option>
                          {memoryKinds.map((kind) => (
                            <option key={kind} value={kind}>
                              {t(`memories.kinds.${kind}`)}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div>
                        <label
                          htmlFor={`edit-mem-chat-id-${m.id}`}
                          className="text-muted-foreground text-xs"
                        >
                          {t("memories.chatScopeOptional")}
                        </label>
                        <Input
                          id={`edit-mem-chat-id-${m.id}`}
                          inputMode="numeric"
                          value={editForm.scopeChatId}
                          onChange={(event) =>
                            setEditForm({ ...editForm, scopeChatId: event.target.value })
                          }
                          aria-invalid={!validOptionalChatId(editForm.scopeChatId)}
                          placeholder={t("memories.allChatsPlaceholder")}
                          disabled={mutationControlsLocked}
                        />
                      </div>
                      <div>
                        <label
                          htmlFor={`edit-mem-expiry-${m.id}`}
                          className="text-muted-foreground text-xs"
                        >
                          {t("memories.expiresAtOptional")}
                        </label>
                        <Input
                          id={`edit-mem-expiry-${m.id}`}
                          type="datetime-local"
                          value={editForm.expiresAt}
                          onChange={(event) =>
                            setEditForm({ ...editForm, expiresAt: event.target.value })
                          }
                          aria-invalid={!validOptionalDate(editForm.expiresAt)}
                          disabled={mutationControlsLocked}
                        />
                      </div>
                    </div>
                    {!editFieldsValid && (
                      <p role="alert" className="text-destructive text-sm">
                        {t("memories.invalidDetails")}
                      </p>
                    )}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={handleSave}
                        disabled={mutationControlsLocked || !editFieldsValid}
                      >
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
                    <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      {m.origin && (
                        <span>
                          {t("memories.origin", {
                            origin:
                              m.origin === "admin" || m.origin === "agent"
                                ? t(`memories.origins.${m.origin}`)
                                : m.origin,
                          })}
                        </span>
                      )}
                      {m.sourceChatId != null && (
                        <span>{t("memories.sourceChat", { id: m.sourceChatId })}</span>
                      )}
                      {m.sourceMessageId != null && (
                        <span>{t("memories.sourceMessage", { id: m.sourceMessageId })}</span>
                      )}
                      {m.sourceUserId != null && (
                        <span>{t("memories.sourceUser", { id: m.sourceUserId })}</span>
                      )}
                      {m.expiresAt && (
                        <span>
                          {t("memories.expiresAt", {
                            date: dateTimeFormatter.format(new Date(m.expiresAt)),
                          })}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <span className="text-muted-foreground text-xs">
                        {t("memories.createdAt", {
                          date: dateTimeFormatter.format(new Date(m.createdAt)),
                        })}
                      </span>
                      <div className="flex flex-wrap items-center gap-1">
                        {m.isActive && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRetire(m.id)}
                            disabled={mutationControlsLocked || editingId !== null}
                          >
                            {pendingMutation?.kind === "retire" &&
                            pendingMutation.memoryId === m.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Archive className="h-4 w-4" />
                            )}
                            {t("memories.retireAction")}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => startEdit(m)}
                          title={t("memories.editTitle")}
                          aria-label={t("memories.editTitle")}
                          disabled={mutationControlsLocked || editingId !== null || !m.isActive}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(m.id)}
                          title={t("memories.deleteTitle")}
                          aria-label={t("memories.deleteTitle")}
                          disabled={mutationControlsLocked || editingId !== null}
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
        <fieldset disabled={queryControlsLocked} className="min-w-0 border-0 p-0">
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={(nextPage) => {
              if (mutationInFlightRef.current || mutationRecoveryRef.current || queryControlsLocked)
                return;
              updateQuery({ ...query, page: nextPage });
            }}
          />
        </fieldset>
      )}
    </div>
  );
}
