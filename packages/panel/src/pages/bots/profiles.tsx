import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { client } from "@/lib/client";
import { Check, Loader2, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";

interface ProfileItem {
  id: number;
  telegramId: number;
  username: string | null;
  displayName: string | null;
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

export function BotProfilesPage() {
  const { botId } = useParams<{ botId: string }>();
  const [profiles, setProfiles] = useState<ProfileItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(emptyCreateForm);
  const [showCreate, setShowCreate] = useState(false);
  const limit = 20;

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
    } catch {
      // ignore
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
    if (!botId || !window.confirm("Delete this profile?")) return;
    try {
      await client.api.bots[":botId"].profiles[":profileId"].$delete({
        param: { botId, profileId: String(profileId) },
      });
      loadProfiles();
    } catch {
      // ignore
    }
  };

  const startEdit = (p: ProfileItem) => {
    setEditingId(p.id);
    setEditForm(profileToEditForm(p));
    setExpandedId(p.id);
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
    } catch {
      // ignore
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
      await client.api.bots[":botId"].profiles.$post({
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
      setShowCreate(false);
      setCreateForm(emptyCreateForm);
      loadProfiles();
    } catch {
      // ignore
    } finally {
      setCreating(false);
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">People Profiles</h1>
        <span className="text-muted-foreground text-sm">{total} total</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => setShowCreate(!showCreate)}
        >
          <Plus className="h-4 w-4" />
          Add Profile
        </Button>
      </div>

      {showCreate && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">New Profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-muted-foreground text-xs">Telegram ID *</label>
                <Input
                  value={createForm.telegramId}
                  onChange={(e) => setCreateForm({ ...createForm, telegramId: e.target.value })}
                  placeholder="123456789"
                />
              </div>
              <div>
                <label className="text-muted-foreground text-xs">Display Name</label>
                <Input
                  value={createForm.displayName}
                  onChange={(e) => setCreateForm({ ...createForm, displayName: e.target.value })}
                />
              </div>
              <div>
                <label className="text-muted-foreground text-xs">Username</label>
                <Input
                  value={createForm.username}
                  onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
                />
              </div>
              <div>
                <label className="text-muted-foreground text-xs">Relationship</label>
                <Input
                  value={createForm.relationship}
                  onChange={(e) => setCreateForm({ ...createForm, relationship: e.target.value })}
                />
              </div>
            </div>
            <div>
              <label className="text-muted-foreground text-xs">Notes</label>
              <textarea
                className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                rows={3}
                value={createForm.notes}
                onChange={(e) => setCreateForm({ ...createForm, notes: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-muted-foreground text-xs">Traits (comma separated)</label>
                <Input
                  value={createForm.traits}
                  onChange={(e) => setCreateForm({ ...createForm, traits: e.target.value })}
                  placeholder="friendly, creative"
                />
              </div>
              <div>
                <label className="text-muted-foreground text-xs">Interests (comma separated)</label>
                <Input
                  value={createForm.interests}
                  onChange={(e) => setCreateForm({ ...createForm, interests: e.target.value })}
                  placeholder="music, coding"
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

      <div className="flex gap-2">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by name, username, notes..."
          className="max-w-sm"
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        />
        <Button variant="outline" size="sm" onClick={handleSearch}>
          <Search className="h-4 w-4" />
          Search
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
            Clear
          </Button>
        )}
      </div>

      {loading ? (
        <p className="text-muted-foreground text-sm">Loading...</p>
      ) : profiles.length === 0 ? (
        <p className="text-muted-foreground text-sm">No profiles found.</p>
      ) : (
        <div className="space-y-3">
          {profiles.map((p) => (
            <Card key={p.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    className="flex items-center gap-3 text-left"
                    onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                  >
                    <CardTitle className="text-sm">
                      {p.displayName || "Unknown"}{" "}
                      {p.username && (
                        <span className="text-muted-foreground font-normal">@{p.username}</span>
                      )}
                    </CardTitle>
                    <span className="text-muted-foreground font-mono text-xs">
                      ID: {p.telegramId}
                    </span>
                  </button>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground text-xs">
                      Last seen: {new Date(p.lastSeen).toLocaleDateString()}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => startEdit(p)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(p.id)}>
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              {expandedId === p.id && (
                <CardContent className="space-y-3 pt-0">
                  {editingId === p.id && editForm ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-muted-foreground text-xs">Display Name</label>
                          <Input
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
                          <label className="text-muted-foreground text-xs">Username</label>
                          <Input
                            value={editForm.username}
                            onChange={(e) => setEditForm({ ...editForm, username: e.target.value })}
                          />
                        </div>
                        <div>
                          <label className="text-muted-foreground text-xs">Relationship</label>
                          <Input
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
                        <label className="text-muted-foreground text-xs">Notes</label>
                        <textarea
                          className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                          rows={3}
                          value={editForm.notes}
                          onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-muted-foreground text-xs">
                            Traits (comma separated)
                          </label>
                          <Input
                            value={editForm.traits}
                            onChange={(e) => setEditForm({ ...editForm, traits: e.target.value })}
                          />
                        </div>
                        <div>
                          <label className="text-muted-foreground text-xs">
                            Interests (comma separated)
                          </label>
                          <Input
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
                      {(p.traits?.length ?? 0) > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {p.traits!.map((t) => (
                            <Badge key={t} variant="default">
                              {t}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {(p.interests?.length ?? 0) > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {p.interests!.map((i) => (
                            <Badge key={i} variant="muted">
                              {i}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {p.relationship && (
                        <div>
                          <span className="text-muted-foreground text-xs">Relationship:</span>{" "}
                          <span className="text-sm">{p.relationship}</span>
                        </div>
                      )}
                      {p.notes && (
                        <div>
                          <span className="text-muted-foreground text-xs">Notes:</span>
                          <p className="mt-1 text-sm whitespace-pre-wrap">{p.notes}</p>
                        </div>
                      )}
                      <div className="text-muted-foreground text-xs">
                        First seen: {new Date(p.firstSeen).toLocaleString()}
                      </div>
                    </>
                  )}
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span className="text-sm">
            {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
