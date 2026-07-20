import { Badge } from "@/components/ui/badge";
import { AuthImage } from "@/components/ui/auth-image";
import { Pagination } from "@/components/ui/pagination";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/lib/client";
import { cn } from "@/lib/utils";
import { Check, Loader2, Pencil, Plus, Search, Trash2, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";

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
  const { t, i18n } = useTranslation("botData");
  const { botId } = useParams<{ botId: string }>();
  const [profiles, setProfiles] = useState<ProfileItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [expandedNotes, setExpandedNotes] = useState<Set<number>>(new Set());
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(emptyCreateForm);
  const [showCreate, setShowCreate] = useState(false);
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

  const loadProfiles = useCallback(async () => {
    if (!botId) return;
    setLoading(true);
    try {
      const res = await client.api.bots[":botId"].profiles.$get({
        param: { botId },
        query: {
          page: String(page),
          limit: String(limit),
          ...(search ? { search } : {}),
        },
      });
      const json = await res.json();
      if (json.ok) {
        setProfiles(json.data as ProfileItem[]);
        setTotal(json.total);
      }
    } catch (err) {
      console.error("Failed to load profiles:", err);
    } finally {
      setLoading(false);
    }
  }, [botId, page, search]);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const handleSearch = () => {
    setPage(1);
    setSearch(searchInput);
  };

  const handleDelete = async (profileId: number) => {
    if (!botId || !window.confirm(t("profiles.deleteConfirm"))) return;
    try {
      await client.api.bots[":botId"].profiles[":profileId"].$delete({
        param: { botId, profileId: String(profileId) },
      });
      loadProfiles();
    } catch (err) {
      console.error("Failed to delete profile:", err);
    }
  };

  const startEdit = (p: ProfileItem) => {
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
    setEditingId(null);
    setEditForm(null);
  };

  const handleSave = async () => {
    if (!botId || !editForm || editingId === null) return;
    setSaving(true);
    try {
      const traits = parseList(editForm.traits);
      const interests = parseList(editForm.interests);
      await client.api.bots[":botId"].profiles[":profileId"].$put({
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
      cancelEdit();
      loadProfiles();
    } catch (err) {
      console.error("Failed to save profile:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async () => {
    if (!botId) return;
    const telegramId = Number(createForm.telegramId);
    if (!telegramId || Number.isNaN(telegramId)) return;
    setCreating(true);
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
      if (!response.ok) {
        throw new Error(`Failed to create profile: HTTP ${response.status}`);
      }
      setShowCreate(false);
      setCreateForm(emptyCreateForm);
      loadProfiles();
    } catch (err) {
      console.error("Failed to create profile:", err);
    } finally {
      setCreating(false);
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">{t("profiles.title")}</h1>
        <span className="text-muted-foreground text-sm">
          {t("common.total", { value: numberFormatter.format(total) })}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => setShowCreate(!showCreate)}
        >
          <Plus className="h-4 w-4" />
          {t("profiles.add")}
        </Button>
      </div>

      {showCreate && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("profiles.new")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
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
                disabled={creating || !createForm.telegramId}
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
                }}
              >
                <X className="h-4 w-4" />
                {t("common.cancel")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-2">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t("profiles.searchPlaceholder")}
          className="max-w-sm"
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        />
        <Button variant="outline" size="sm" onClick={handleSearch}>
          <Search className="h-4 w-4" />
          {t("common.search")}
        </Button>
        {search && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setSearchInput("");
              setPage(1);
            }}
          >
            {t("common.clear")}
          </Button>
        )}
      </div>

      {loading ? (
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      ) : profiles.length === 0 ? (
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
                  <div className="space-y-3">
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
                      <Button size="sm" onClick={handleSave} disabled={saving}>
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
                  </div>
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
                          onClick={() => startEdit(p)}
                          title={t("profiles.editTitle")}
                          aria-label={t("profiles.editTitle")}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
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

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
