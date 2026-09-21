import { Badge } from "@/components/ui/badge";
import { AuthImage } from "@/components/ui/auth-image";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCanManageBot } from "@/hooks/use-can-manage-bot";
import { client } from "@/lib/client";
import {
  getCharacterBindings,
  listLibraryCharacters,
  removeCharacterBinding,
  setCharacterBinding,
} from "@/lib/generation-library-client";
import { cn } from "@/lib/utils";
import type { CharacterBinding, CharacterRelation, LibraryCharacter } from "@cos-tool-bot/shared";
import { Check, Loader2, Pencil, Plus, Search, Trash2, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

interface ProfileItem {
  id: number;
  telegramId: number;
  username: string | null;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  languageCode: string | null;
  isPremium: boolean;
  hasAvatar: boolean;
  avatarVersion: string | null;
  notes: string | null;
  traits: string[] | null;
  interests: string[] | null;
  relationship: string | null;
  firstSeen: string;
  lastSeen: string;
}

interface EditForm {
  displayName: string;
  username: string;
  relationship: string;
  notes: string;
  traits: string;
  interests: string;
}

interface CreateForm extends EditForm {
  telegramId: string;
}

function profileToEditForm(p: ProfileItem): EditForm {
  return {
    displayName: p.displayName ?? "",
    username: p.username ?? "",
    relationship: p.relationship ?? "",
    notes: p.notes ?? "",
    traits: (p.traits ?? []).join(", "),
    interests: (p.interests ?? []).join(", "),
  };
}

const emptyCreateForm: CreateForm = {
  telegramId: "",
  displayName: "",
  username: "",
  relationship: "",
  notes: "",
  traits: "",
  interests: "",
};

function parseList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function emptyToNull(s: string): string | null {
  return s.trim() === "" ? null : s.trim();
}

function ProfileAvatarFallback({ label }: { label: string }) {
  return (
    <div role="img" aria-label={label} className="flex h-full w-full items-center justify-center">
      <UserRound className="text-muted-foreground h-5 w-5" />
    </div>
  );
}

export function BotProfilesPage() {
  const { botId } = useParams<{ botId: string }>();
  return <BotProfilesContent key={botId} botId={botId} />;
}

function BotProfilesContent({ botId }: { botId: string | undefined }) {
  const { t, i18n } = useTranslation("botData");
  const canManageBot = useCanManageBot();
  const [result, setResult] = useState<{
    key: string;
    profiles: ProfileItem[];
    total: number;
  } | null>(null);
  const [listState, setListState] = useState({ key: "", pending: true, failed: false });
  const [refresh, setRefresh] = useState(0);
  const listRequestRef = useRef(0);
  const mountedRef = useRef(false);
  const mutationRef = useRef(false);
  const recoveryRef = useRef(false);
  const [pendingAction, setPendingAction] = useState<"create" | "save" | "delete" | null>(null);
  const [mutationError, setMutationError] = useState<"create" | "save" | "delete" | null>(null);
  const [success, setSuccess] = useState<"created" | "saved" | "deleted" | null>(null);
  const busy = pendingAction !== null;
  const creating = pendingAction === "create";
  const saving = pendingAction === "save";
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [expandedNotes, setExpandedNotes] = useState<Set<number>>(new Set());
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [createForm, setCreateForm] = useState<CreateForm>(emptyCreateForm);
  const [showCreate, setShowCreate] = useState(false);
  const [bindingTelegramId, setBindingTelegramId] = useState<number | null>(null);
  const [bindingsByTelegramId, setBindingsByTelegramId] = useState<
    Record<number, CharacterBinding[]>
  >({});
  const [bindingCandidates, setBindingCandidates] = useState<LibraryCharacter[]>([]);
  const [bindingSearchInput, setBindingSearchInput] = useState("");
  const [bindingSearch, setBindingSearch] = useState("");
  const [bindingComposing, setBindingComposing] = useState(false);
  const [bindingRelation, setBindingRelation] = useState<CharacterRelation>("representation");
  const [bindingDefault, setBindingDefault] = useState(true);
  const [bindingsLoading, setBindingsLoading] = useState(false);
  const [bindingCandidatesLoading, setBindingCandidatesLoading] = useState(false);
  const [bindingSaving, setBindingSaving] = useState(false);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const activeBindingTelegramIdRef = useRef<number | null>(null);
  const bindingsRequestRef = useRef(0);
  const bindingCandidatesRequestRef = useRef(0);
  const limit = 20;
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );
  const dateTimeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );

  const queryKey = JSON.stringify([page, search]);
  const currentResult = result?.key === queryKey ? result : null;
  const profiles = currentResult?.profiles ?? [];
  const total = currentResult?.total ?? 0;
  const loading = listState.key !== queryKey || listState.pending;
  const loadFailed = listState.key === queryKey && listState.failed;
  const controlsDisabled = busy || (mutationError !== null && loading);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeBindingTelegramIdRef.current = null;
      bindingsRequestRef.current += 1;
      bindingCandidatesRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const requestId = ++listRequestRef.current;
    const controller = new AbortController();
    const isCurrent = () => mountedRef.current && requestId === listRequestRef.current;
    setListState({ key: queryKey, pending: true, failed: false });
    const load = async () => {
      try {
        if (!botId) throw new Error("Missing Bot");
        const res = await client.api.bots[":botId"].profiles.$get(
          {
            param: { botId },
            query: { page: String(page), limit: String(limit), ...(search ? { search } : {}) },
          },
          { init: { signal: controller.signal } },
        );
        if (!res.ok) throw new Error("Profile request failed");
        const json = await res.json();
        if (!json.ok) throw new Error("Profile request failed");
        if (isCurrent()) {
          setResult({ key: queryKey, profiles: json.data as ProfileItem[], total: json.total });
          setListState({ key: queryKey, pending: false, failed: false });
        }
      } catch {
        if (isCurrent()) setListState({ key: queryKey, pending: false, failed: true });
      } finally {
        if (isCurrent()) recoveryRef.current = false;
      }
    };
    void load();
    return () => {
      listRequestRef.current += 1;
      controller.abort();
    };
  }, [botId, page, search, queryKey, refresh]);

  const refreshProfiles = () => {
    if (mutationError) {
      recoveryRef.current = true;
      setListState({ key: queryKey, pending: true, failed: false });
    }
    setRefresh((value) => value + 1);
  };

  useEffect(() => {
    bindingsRequestRef.current += 1;
    bindingCandidatesRequestRef.current += 1;
    activeBindingTelegramIdRef.current = null;
    setBindingTelegramId(null);
    setBindingsByTelegramId({});
    setBindingCandidates([]);
    setBindingSearchInput("");
    setBindingSearch("");
    setBindingError(null);
  }, [botId]);

  useEffect(() => {
    if (bindingComposing) return;
    const timer = window.setTimeout(() => setBindingSearch(bindingSearchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [bindingComposing, bindingSearchInput]);

  const loadBindings = useCallback(
    async (telegramId: number) => {
      if (!mountedRef.current || !botId || activeBindingTelegramIdRef.current !== telegramId)
        return;
      const requestId = ++bindingsRequestRef.current;
      setBindingsLoading(true);
      setBindingError(null);
      try {
        const bindings = await getCharacterBindings(botId, telegramId);
        if (
          requestId !== bindingsRequestRef.current ||
          activeBindingTelegramIdRef.current !== telegramId
        ) {
          return;
        }
        setBindingsByTelegramId((current) => ({ ...current, [telegramId]: bindings }));
      } catch (err) {
        if (
          requestId !== bindingsRequestRef.current ||
          activeBindingTelegramIdRef.current !== telegramId
        ) {
          return;
        }
        setBindingError(err instanceof Error ? err.message : t("profiles.bindingsLoadFailed"));
      } finally {
        if (requestId === bindingsRequestRef.current) setBindingsLoading(false);
      }
    },
    [botId, t],
  );

  const loadBindingCandidates = useCallback(async () => {
    if (!botId || bindingTelegramId === null) return;
    const telegramId = bindingTelegramId;
    const requestId = ++bindingCandidatesRequestRef.current;
    setBindingCandidatesLoading(true);
    setBindingError(null);
    try {
      const result = await listLibraryCharacters(botId, {
        search: bindingSearch || undefined,
        page: 1,
        limit: 20,
        sort: "recent",
      });
      if (
        requestId !== bindingCandidatesRequestRef.current ||
        activeBindingTelegramIdRef.current !== telegramId
      ) {
        return;
      }
      setBindingCandidates(result.data);
    } catch (err) {
      if (
        requestId !== bindingCandidatesRequestRef.current ||
        activeBindingTelegramIdRef.current !== telegramId
      ) {
        return;
      }
      setBindingError(err instanceof Error ? err.message : t("profiles.bindingsLoadFailed"));
    } finally {
      if (requestId === bindingCandidatesRequestRef.current) setBindingCandidatesLoading(false);
    }
  }, [bindingSearch, bindingTelegramId, botId, t]);

  useEffect(() => {
    if (bindingTelegramId !== null) void loadBindingCandidates();
  }, [bindingTelegramId, loadBindingCandidates]);

  const toggleBindings = (profile: ProfileItem) => {
    bindingsRequestRef.current += 1;
    bindingCandidatesRequestRef.current += 1;
    setBindingsLoading(false);
    setBindingCandidatesLoading(false);
    if (bindingTelegramId === profile.telegramId) {
      activeBindingTelegramIdRef.current = null;
      setBindingTelegramId(null);
      setBindingCandidates([]);
      setBindingError(null);
      return;
    }
    activeBindingTelegramIdRef.current = profile.telegramId;
    setBindingTelegramId(profile.telegramId);
    setBindingSearchInput("");
    setBindingSearch("");
    setBindingRelation("representation");
    setBindingDefault(true);
    void loadBindings(profile.telegramId);
  };

  const handleAddBinding = async (telegramId: number, characterId: number) => {
    if (!botId || !canManageBot) return;
    setBindingSaving(true);
    setBindingError(null);
    try {
      await setCharacterBinding(botId, telegramId, {
        characterId,
        relation: bindingRelation,
        isDefault: bindingRelation === "representation" && bindingDefault,
      });
      await loadBindings(telegramId);
    } catch (err) {
      setBindingError(err instanceof Error ? err.message : t("profiles.bindingSaveFailed"));
    } finally {
      setBindingSaving(false);
    }
  };

  const handleRemoveBinding = async (telegramId: number, binding: CharacterBinding) => {
    if (!botId || !canManageBot) return;
    setBindingSaving(true);
    setBindingError(null);
    try {
      await removeCharacterBinding(botId, telegramId, binding.characterId, binding.relation);
      await loadBindings(telegramId);
    } catch (err) {
      setBindingError(err instanceof Error ? err.message : t("profiles.bindingSaveFailed"));
    } finally {
      setBindingSaving(false);
    }
  };

  const handleSearch = () => {
    if (mutationRef.current || recoveryRef.current) return;
    setSuccess(null);
    setPage(1);
    setSearch(searchInput);
  };

  const beginMutation = (action: "create" | "save" | "delete") => {
    if (mutationRef.current || recoveryRef.current) return false;
    mutationRef.current = true;
    setPendingAction(action);
    setMutationError(null);
    setSuccess(null);
    return true;
  };
  const finishMutation = () => {
    mutationRef.current = false;
    if (mountedRef.current) setPendingAction(null);
  };

  const handleDelete = async (profileId: number) => {
    if (
      !botId ||
      mutationRef.current ||
      recoveryRef.current ||
      !window.confirm(t("profiles.deleteConfirm"))
    )
      return;
    if (!beginMutation("delete")) return;
    try {
      const res = await client.api.bots[":botId"].profiles[":profileId"].$delete({
        param: { botId, profileId: String(profileId) },
      });
      if (!res.ok || !(await res.json()).ok) throw new Error("Profile deletion failed");
      if (!mountedRef.current) return;
      setSuccess("deleted");
      refreshProfiles();
    } catch {
      if (mountedRef.current) setMutationError("delete");
    } finally {
      finishMutation();
    }
  };

  const startEdit = (p: ProfileItem) => {
    if (mutationRef.current || recoveryRef.current) return;
    setMutationError(null);
    setSuccess(null);
    setEditingId(p.id);
    setEditForm(profileToEditForm(p));
  };

  const toggleNotes = (id: number) => {
    setExpandedNotes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const cancelEdit = () => {
    if (mutationRef.current || recoveryRef.current) return;
    setMutationError(null);
    setEditingId(null);
    setEditForm(null);
  };

  const handleSave = async () => {
    if (!botId || !editForm || editingId === null) return;
    if (!beginMutation("save")) return;
    try {
      const traits = parseList(editForm.traits);
      const interests = parseList(editForm.interests);
      const res = await client.api.bots[":botId"].profiles[":profileId"].$put({
        param: { botId, profileId: String(editingId) },
        json: {
          displayName: emptyToNull(editForm.displayName),
          username: emptyToNull(editForm.username),
          relationship: emptyToNull(editForm.relationship),
          notes: emptyToNull(editForm.notes),
          traits: traits.length > 0 ? traits : null,
          interests: interests.length > 0 ? interests : null,
        },
      });
      if (!res.ok || !(await res.json()).ok) throw new Error("Profile save failed");
      if (!mountedRef.current) return;
      setEditingId(null);
      setEditForm(null);
      setSuccess("saved");
      refreshProfiles();
    } catch {
      if (mountedRef.current) setMutationError("save");
    } finally {
      finishMutation();
    }
  };

  const handleCreate = async () => {
    if (!botId || mutationRef.current || recoveryRef.current) return;
    const telegramId = Number(createForm.telegramId);
    if (!telegramId || !Number.isFinite(telegramId)) {
      setMutationError("create");
      return;
    }
    if (!beginMutation("create")) return;
    try {
      const traits = parseList(createForm.traits);
      const interests = parseList(createForm.interests);
      const response = await client.api.bots[":botId"].profiles.$post({
        param: { botId },
        json: {
          telegramId,
          displayName: emptyToNull(createForm.displayName),
          username: emptyToNull(createForm.username),
          relationship: emptyToNull(createForm.relationship),
          notes: emptyToNull(createForm.notes),
          traits: traits.length > 0 ? traits : undefined,
          interests: interests.length > 0 ? interests : undefined,
        },
      });
      if (!response.ok || !(await response.json()).ok) throw new Error("Profile creation failed");
      if (!mountedRef.current) return;
      setShowCreate(false);
      setCreateForm(emptyCreateForm);
      setSuccess("created");
      refreshProfiles();
    } catch {
      if (mountedRef.current) setMutationError("create");
    } finally {
      finishMutation();
    }
  };

  const renderMutationError = (action: "create" | "save" | "delete") =>
    mutationError === action && (
      <div
        role="alert"
        className="border-destructive/30 bg-destructive/5 text-destructive flex flex-col gap-3 rounded-lg border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
      >
        <p>{t(`common.${action}Failed`)}</p>
        <Button variant="outline" size="sm" disabled={loading || busy} onClick={refreshProfiles}>
          {t("common.refreshList")}
        </Button>
      </div>
    );

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-bold">{t("profiles.title")}</h1>
          {currentResult && !(total === 0 && (loading || loadFailed)) && (
            <span className="text-muted-foreground shrink-0 text-sm whitespace-nowrap">
              {t("common.total", { value: numberFormatter.format(total) })}
            </span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-full shrink-0 sm:ml-auto sm:w-auto"
          disabled={controlsDisabled}
          onClick={() => {
            setShowCreate(!showCreate);
            setMutationError(null);
            setSuccess(null);
          }}
        >
          <Plus className="h-4 w-4" />
          {t("profiles.add")}
        </Button>
      </div>

      {success && (
        <p
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
        >
          {t(`common.${success}`)}
        </p>
      )}
      {busy && (
        <p role="status" className="text-muted-foreground text-sm">
          {t("common.submitting")}
        </p>
      )}
      {renderMutationError("delete")}

      {showCreate && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("profiles.new")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {renderMutationError("create")}
            <fieldset disabled={controlsDisabled} className="min-w-0 space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="create-telegram-id" className="text-muted-foreground text-xs">
                    {t("profiles.telegramId")} *
                  </label>
                  <Input
                    id="create-telegram-id"
                    value={createForm.telegramId}
                    onChange={(e) => setCreateForm({ ...createForm, telegramId: e.target.value })}
                    placeholder="123456789"
                  />
                </div>
                <div>
                  <label htmlFor="create-display-name" className="text-muted-foreground text-xs">
                    {t("profiles.displayName")}
                  </label>
                  <Input
                    id="create-display-name"
                    value={createForm.displayName}
                    onChange={(e) => setCreateForm({ ...createForm, displayName: e.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor="create-username" className="text-muted-foreground text-xs">
                    {t("profiles.username")}
                  </label>
                  <Input
                    id="create-username"
                    value={createForm.username}
                    onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor="create-relationship" className="text-muted-foreground text-xs">
                    {t("profiles.relationship")}
                  </label>
                  <Input
                    id="create-relationship"
                    value={createForm.relationship}
                    onChange={(e) => setCreateForm({ ...createForm, relationship: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <label htmlFor="create-notes" className="text-muted-foreground text-xs">
                  {t("profiles.notes")}
                </label>
                <Textarea
                  id="create-notes"
                  className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                  rows={3}
                  value={createForm.notes}
                  onChange={(e) => setCreateForm({ ...createForm, notes: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="create-traits" className="text-muted-foreground text-xs">
                    {t("profiles.traits")}
                  </label>
                  <Input
                    id="create-traits"
                    value={createForm.traits}
                    onChange={(e) => setCreateForm({ ...createForm, traits: e.target.value })}
                    placeholder={t("profiles.traitsPlaceholder")}
                  />
                </div>
                <div>
                  <label htmlFor="create-interests" className="text-muted-foreground text-xs">
                    {t("profiles.interests")}
                  </label>
                  <Input
                    id="create-interests"
                    value={createForm.interests}
                    onChange={(e) => setCreateForm({ ...createForm, interests: e.target.value })}
                    placeholder={t("profiles.interestsPlaceholder")}
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleCreate}
                  disabled={controlsDisabled || !createForm.telegramId}
                >
                  {creating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                  {t("common.create")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowCreate(false);
                    setCreateForm(emptyCreateForm);
                    setMutationError(null);
                  }}
                >
                  <X className="h-4 w-4" />
                  {t("common.cancel")}
                </Button>
              </div>
            </fieldset>
          </CardContent>
        </Card>
      )}

      <fieldset disabled={controlsDisabled} className="flex min-w-0 flex-col gap-2 sm:flex-row">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t("profiles.searchPlaceholder")}
          className="w-full sm:max-w-sm"
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        />
        <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={handleSearch}>
          <Search className="h-4 w-4" />
          {t("common.search")}
        </Button>
        {search && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => {
              setSuccess(null);
              setSearch("");
              setSearchInput("");
              setPage(1);
            }}
          >
            {t("common.clear")}
          </Button>
        )}
      </fieldset>

      {loadFailed && (
        <div
          role="alert"
          className={cn(
            "flex flex-col gap-3 rounded-lg border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between",
            currentResult
              ? "border-amber-200 bg-amber-50 text-amber-950"
              : "border-destructive/30 bg-destructive/5 text-destructive",
          )}
        >
          <p>{t(currentResult ? "common.refreshFailed" : "common.loadFailed")}</p>
          <Button variant="outline" size="sm" disabled={controlsDisabled} onClick={refreshProfiles}>
            {t("common.retry")}
          </Button>
        </div>
      )}
      {loading && (
        <p role="status" className="text-muted-foreground text-sm">
          {t("common.loading")}
        </p>
      )}
      {!currentResult ||
      (profiles.length === 0 && (loading || loadFailed)) ? null : profiles.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("profiles.empty")}</p>
      ) : (
        <div className="space-y-3">
          {profiles.map((p) => (
            <Card key={p.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="bg-muted h-10 w-10 shrink-0 overflow-hidden rounded-full">
                      {p.hasAvatar && botId ? (
                        <AuthImage
                          src={`/api/bots/${botId}/profiles/${p.id}/avatar?v=${encodeURIComponent(p.avatarVersion ?? "current")}`}
                          alt={t("profiles.avatarAlt", {
                            name: p.displayName || t("common.unknown"),
                          })}
                          className="h-full w-full object-cover"
                          placeholderSize={40}
                          fallback={
                            <div className="flex h-full w-full items-center justify-center">
                              <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
                            </div>
                          }
                          errorFallback={
                            <ProfileAvatarFallback
                              label={t("profiles.avatarAlt", {
                                name: p.displayName || t("common.unknown"),
                              })}
                            />
                          }
                        />
                      ) : (
                        <ProfileAvatarFallback
                          label={t("profiles.avatarAlt", {
                            name: p.displayName || t("common.unknown"),
                          })}
                        />
                      )}
                    </div>
                    <CardTitle className="truncate text-sm">
                      {p.displayName || t("common.unknown")}{" "}
                      {p.username && (
                        <span className="text-muted-foreground font-normal">@{p.username}</span>
                      )}
                    </CardTitle>
                    <span className="text-muted-foreground shrink-0 font-mono text-xs">
                      {t("profiles.profileId", { id: p.telegramId })}
                    </span>
                  </div>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {t("profiles.lastSeen", { date: dateFormatter.format(new Date(p.lastSeen)) })}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 pt-0">
                {editingId === p.id && editForm ? (
                  <>
                    {renderMutationError("save")}
                    <fieldset disabled={controlsDisabled} className="min-w-0 space-y-3">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <label
                            htmlFor={`edit-display-name-${p.id}`}
                            className="text-muted-foreground text-xs"
                          >
                            {t("profiles.displayName")}
                          </label>
                          <Input
                            id={`edit-display-name-${p.id}`}
                            value={editForm.displayName}
                            onChange={(e) =>
                              setEditForm({
                                ...editForm,
                                displayName: e.target.value,
                              })
                            }
                          />
                        </div>
                        <div>
                          <label
                            htmlFor={`edit-username-${p.id}`}
                            className="text-muted-foreground text-xs"
                          >
                            {t("profiles.username")}
                          </label>
                          <Input
                            id={`edit-username-${p.id}`}
                            value={editForm.username}
                            onChange={(e) => setEditForm({ ...editForm, username: e.target.value })}
                          />
                        </div>
                        <div>
                          <label
                            htmlFor={`edit-relationship-${p.id}`}
                            className="text-muted-foreground text-xs"
                          >
                            {t("profiles.relationship")}
                          </label>
                          <Input
                            id={`edit-relationship-${p.id}`}
                            value={editForm.relationship}
                            onChange={(e) =>
                              setEditForm({
                                ...editForm,
                                relationship: e.target.value,
                              })
                            }
                          />
                        </div>
                      </div>
                      <div>
                        <label
                          htmlFor={`edit-notes-${p.id}`}
                          className="text-muted-foreground text-xs"
                        >
                          {t("profiles.notes")}
                        </label>
                        <Textarea
                          id={`edit-notes-${p.id}`}
                          className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                          rows={3}
                          value={editForm.notes}
                          onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                        />
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <label
                            htmlFor={`edit-traits-${p.id}`}
                            className="text-muted-foreground text-xs"
                          >
                            {t("profiles.traits")}
                          </label>
                          <Input
                            id={`edit-traits-${p.id}`}
                            value={editForm.traits}
                            onChange={(e) => setEditForm({ ...editForm, traits: e.target.value })}
                          />
                        </div>
                        <div>
                          <label
                            htmlFor={`edit-interests-${p.id}`}
                            className="text-muted-foreground text-xs"
                          >
                            {t("profiles.interests")}
                          </label>
                          <Input
                            id={`edit-interests-${p.id}`}
                            value={editForm.interests}
                            onChange={(e) =>
                              setEditForm({
                                ...editForm,
                                interests: e.target.value,
                              })
                            }
                          />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={handleSave} disabled={controlsDisabled}>
                          {saving ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Check className="h-4 w-4" />
                          )}
                          {t("common.save")}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={cancelEdit}>
                          <X className="h-4 w-4" />
                          {t("common.cancel")}
                        </Button>
                      </div>
                    </fieldset>
                  </>
                ) : (
                  <>
                    {p.relationship && (
                      <p className="text-muted-foreground text-sm">{p.relationship}</p>
                    )}
                    {(p.languageCode || p.isPremium) && (
                      <div className="flex flex-wrap gap-1.5">
                        {p.languageCode && (
                          <Badge variant="muted">
                            {t("profiles.language", { language: p.languageCode })}
                          </Badge>
                        )}
                        {p.isPremium && (
                          <Badge variant="muted">{t("profiles.telegramPremium")}</Badge>
                        )}
                      </div>
                    )}
                    {((p.traits?.length ?? 0) > 0 || (p.interests?.length ?? 0) > 0) && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {p.traits?.map((t) => (
                          <Badge key={t} variant="default">
                            {t}
                          </Badge>
                        ))}
                        {(p.traits?.length ?? 0) > 0 && (p.interests?.length ?? 0) > 0 && (
                          <span className="text-muted-foreground mx-1 text-xs">|</span>
                        )}
                        {p.interests?.map((i) => (
                          <Badge key={i} variant="muted">
                            {i}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {p.notes && (
                      <button
                        type="button"
                        className="w-full text-left"
                        onClick={() => toggleNotes(p.id)}
                      >
                        <span
                          className={cn(
                            "block text-sm whitespace-pre-wrap",
                            !expandedNotes.has(p.id) && "line-clamp-3",
                          )}
                        >
                          {p.notes}
                        </span>
                      </button>
                    )}
                    <div className="border-t pt-2">
                      <Link
                        to={`/bots/${encodeURIComponent(botId ?? "")}/memories?telegramId=${p.telegramId}`}
                        aria-label={t("profiles.viewUserMemories", { id: p.telegramId })}
                        aria-disabled={controlsDisabled || undefined}
                        tabIndex={controlsDisabled ? -1 : undefined}
                        onClick={(event) => {
                          if (controlsDisabled || mutationRef.current || recoveryRef.current)
                            event.preventDefault();
                        }}
                        className={cn(
                          "focus-visible:ring-ring mr-3 inline-flex min-h-9 items-center rounded-md text-sm underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2",
                          controlsDisabled && "pointer-events-none opacity-50",
                        )}
                      >
                        {t("profiles.viewMemories")}
                      </Link>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => toggleBindings(p)}
                        disabled={bindingSaving || controlsDisabled}
                        aria-expanded={bindingTelegramId === p.telegramId}
                      >
                        {bindingTelegramId === p.telegramId
                          ? t("profiles.closeBindings")
                          : t("profiles.manageBindings")}
                      </Button>
                      {bindingTelegramId === p.telegramId && (
                        <BindingEditor
                          key={`${botId ?? ""}:${p.telegramId}`}
                          telegramId={p.telegramId}
                          bindings={bindingsByTelegramId[p.telegramId] ?? []}
                          candidates={bindingCandidates}
                          search={bindingSearchInput}
                          relation={bindingRelation}
                          defaultRepresentation={bindingDefault}
                          canManage={canManageBot}
                          bindingsLoading={bindingsLoading}
                          candidatesLoading={bindingCandidatesLoading}
                          saving={bindingSaving || controlsDisabled}
                          error={bindingError}
                          onSearchChange={setBindingSearchInput}
                          onCompositionStart={() => setBindingComposing(true)}
                          onCompositionEnd={() => setBindingComposing(false)}
                          onRelationChange={(relation) => {
                            setBindingRelation(relation);
                            if (relation === "favorite") setBindingDefault(false);
                          }}
                          onDefaultChange={setBindingDefault}
                          onAdd={(characterId) => void handleAddBinding(p.telegramId, characterId)}
                          onRemove={(binding) => void handleRemoveBinding(p.telegramId, binding)}
                          t={t}
                        />
                      )}
                    </div>
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-muted-foreground text-xs">
                        {t("profiles.firstSeen", {
                          date: dateTimeFormatter.format(new Date(p.firstSeen)),
                        })}
                      </span>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={controlsDisabled}
                          onClick={() => startEdit(p)}
                          title={t("profiles.editTitle")}
                          aria-label={t("profiles.editTitle")}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={controlsDisabled}
                          onClick={() => handleDelete(p.id)}
                          title={t("profiles.deleteTitle")}
                          aria-label={t("profiles.deleteTitle")}
                        >
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

      <fieldset disabled={controlsDisabled} className="min-w-0">
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={(nextPage) => {
            if (mutationRef.current || recoveryRef.current) return;
            setSuccess(null);
            setPage(nextPage);
          }}
        />
      </fieldset>
    </div>
  );
}

function BindingEditor({
  telegramId,
  bindings,
  candidates,
  search,
  relation,
  defaultRepresentation,
  canManage,
  bindingsLoading,
  candidatesLoading,
  saving,
  error,
  onSearchChange,
  onCompositionStart,
  onCompositionEnd,
  onRelationChange,
  onDefaultChange,
  onAdd,
  onRemove,
  t,
}: {
  telegramId: number;
  bindings: CharacterBinding[];
  candidates: LibraryCharacter[];
  search: string;
  relation: CharacterRelation;
  defaultRepresentation: boolean;
  canManage: boolean;
  bindingsLoading: boolean;
  candidatesLoading: boolean;
  saving: boolean;
  error: string | null;
  onSearchChange: (value: string) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onRelationChange: (value: CharacterRelation) => void;
  onDefaultChange: (value: boolean) => void;
  onAdd: (characterId: number) => void;
  onRemove: (binding: CharacterBinding) => void;
  t: ReturnType<typeof useTranslation<"botData">>["t"];
}) {
  const hasBinding = (characterId: number, nextRelation: CharacterRelation) =>
    bindings.some(
      (binding) => binding.characterId === characterId && binding.relation === nextRelation,
    );

  return (
    <div className="bg-muted/40 mt-3 space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{t("profiles.bindingsTitle")}</p>
          <p className="text-muted-foreground text-xs">
            {t("profiles.bindingsDescription", { id: telegramId })}
          </p>
        </div>
        {!canManage && <Badge variant="muted">{t("profiles.readOnly")}</Badge>}
      </div>

      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      {bindingsLoading ? (
        <p className="text-muted-foreground text-xs">{t("common.loading")}</p>
      ) : bindings.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t("profiles.noBindings")}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {bindings.map((binding) => (
            <Badge
              key={`${binding.characterId}-${binding.relation}`}
              variant={binding.isDefault ? "default" : "muted"}
            >
              {binding.character.name} · {t(`profiles.relations.${binding.relation}`)}
              {binding.isDefault ? ` · ${t("profiles.defaultBinding")}` : ""}
              {canManage && (
                <button
                  type="button"
                  className="ml-1 rounded-full hover:text-red-600"
                  onClick={() => onRemove(binding)}
                  disabled={saving}
                  aria-label={t("profiles.removeBinding", { name: binding.character.name })}
                >
                  ×
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          placeholder={t("profiles.bindingSearchPlaceholder")}
          aria-label={t("profiles.bindingSearchPlaceholder")}
        />
        <Select
          value={relation}
          onChange={(event) => onRelationChange(event.target.value as CharacterRelation)}
          aria-label={t("profiles.bindingRelation")}
        >
          <option value="representation">{t("profiles.relations.representation")}</option>
          <option value="favorite">{t("profiles.relations.favorite")}</option>
        </Select>
      </div>
      {relation === "representation" && (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={defaultRepresentation}
            onChange={(event) => onDefaultChange(event.target.checked)}
            disabled={!canManage || saving}
          />
          {t("profiles.defaultRepresentation")}
        </label>
      )}

      {candidatesLoading ? (
        <p className="text-muted-foreground text-xs">{t("common.loading")}</p>
      ) : candidates.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t("profiles.noCharacterMatches")}</p>
      ) : (
        <div className="max-h-48 space-y-1 overflow-y-auto">
          {candidates.map((candidate) => {
            const alreadyBound = hasBinding(candidate.id, relation);
            return (
              <div
                key={candidate.id}
                className="flex items-center justify-between gap-3 rounded-md border bg-white px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">{candidate.name}</p>
                  <p className="text-muted-foreground text-xs">
                    {t(`profiles.characterSources.${candidate.source}`)}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onAdd(candidate.id)}
                  disabled={!canManage || saving || alreadyBound}
                >
                  {alreadyBound ? t("profiles.bound") : t("profiles.addBinding")}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
