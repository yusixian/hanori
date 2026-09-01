import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { authFetch } from "@/lib/client";
import { BookOpenText, Loader2, Pencil, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";

interface BuiltInSkillView {
  id: string;
  name: string;
  displayName: string;
  description: string;
  summary: string;
  source: string;
  digest: string;
  resources: string[];
  enabled: boolean;
}

interface CustomSkillView {
  id: string;
  name: string;
  displayName: string;
  description: string;
  instructions: string;
  resources: Record<string, string>;
  enabled: boolean;
}

interface SkillsView {
  builtIns: BuiltInSkillView[];
  customSkills: CustomSkillView[];
}

interface ResourceDraft {
  id: string;
  path: string;
  content: string;
}

function snapshot(data: SkillsView): string {
  return JSON.stringify({
    enabledBuiltInIds: data.builtIns.filter((skill) => skill.enabled).map((skill) => skill.id),
    customSkills: data.customSkills,
  });
}

function CustomSkillEditor({
  initial,
  onCancel,
  onApply,
}: {
  initial?: CustomSkillView;
  onCancel: () => void;
  onApply: (skill: CustomSkillView) => void;
}) {
  const { t } = useTranslation("bots");
  const [name, setName] = useState(initial?.name ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [resources, setResources] = useState<ResourceDraft[]>(
    Object.entries(initial?.resources ?? {}).map(([path, content]) => ({
      id: crypto.randomUUID(),
      path,
      content,
    })),
  );
  const valid =
    /^[a-z0-9][a-z0-9-]*$/.test(name) &&
    displayName.trim().length > 0 &&
    description.trim().length > 0 &&
    instructions.trim().length > 0 &&
    resources.every(
      (resource) =>
        resource.path.length > 0 &&
        !resource.path.startsWith("/") &&
        !resource.path.includes("\\") &&
        !resource.path.split("/").some((part) => part === "" || part === ".."),
    ) &&
    new Set(resources.map((resource) => resource.path)).size === resources.length;

  return (
    <Card className="border-primary/30">
      <CardHeader>
        <CardTitle>
          {t(initial ? "skills.editor.editTitle" : "skills.editor.createTitle")}
        </CardTitle>
        <CardDescription>{t("skills.editor.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="skill-name">{t("skills.editor.name")}</Label>
            <Input
              id="skill-name"
              value={name}
              maxLength={64}
              placeholder="my-image-workflow"
              onChange={(event) => setName(event.target.value.toLowerCase())}
            />
            <p className="text-muted-foreground text-xs">{t("skills.editor.nameHint")}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="skill-display-name">{t("skills.editor.displayName")}</Label>
            <Input
              id="skill-display-name"
              value={displayName}
              maxLength={100}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="skill-description">{t("skills.editor.triggerDescription")}</Label>
          <Textarea
            id="skill-description"
            value={description}
            maxLength={1_000}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">{t("skills.editor.triggerHint")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="skill-instructions">{t("skills.editor.instructions")}</Label>
          <Textarea
            id="skill-instructions"
            className="min-h-72 font-mono text-xs leading-5"
            value={instructions}
            maxLength={100_000}
            placeholder="# My Skill\n\nDescribe the workflow..."
            onChange={(event) => setInstructions(event.target.value)}
          />
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label>{t("skills.editor.resources")}</Label>
              <p className="text-muted-foreground text-xs">{t("skills.editor.resourcesHint")}</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setResources((current) => [
                  ...current,
                  { id: crypto.randomUUID(), path: "", content: "" },
                ])
              }
            >
              <Plus className="size-4" />
              {t("skills.editor.addResource")}
            </Button>
          </div>
          {resources.map((resource) => (
            <div key={resource.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex gap-2">
                <Input
                  aria-label={t("skills.editor.resourcePath")}
                  value={resource.path}
                  maxLength={200}
                  placeholder="references/example.md"
                  onChange={(event) =>
                    setResources((current) =>
                      current.map((item) =>
                        item.id === resource.id ? { ...item, path: event.target.value } : item,
                      ),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("skills.editor.removeResource")}
                  onClick={() =>
                    setResources((current) => current.filter((item) => item.id !== resource.id))
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              <Textarea
                aria-label={t("skills.editor.resourceContent")}
                className="min-h-40 font-mono text-xs leading-5"
                value={resource.content}
                maxLength={100_000}
                onChange={(event) =>
                  setResources((current) =>
                    current.map((item) =>
                      item.id === resource.id ? { ...item, content: event.target.value } : item,
                    ),
                  )
                }
              />
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>
            {t("skills.editor.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!valid}
            onClick={() =>
              onApply({
                id: initial?.id ?? crypto.randomUUID(),
                name: name.trim(),
                displayName: displayName.trim(),
                description: description.trim(),
                instructions: instructions.trim(),
                resources: Object.fromEntries(
                  resources.map((resource) => [resource.path, resource.content]),
                ),
                enabled: initial?.enabled ?? true,
              })
            }
          >
            {t("skills.editor.apply")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function BotSkillsPage() {
  const { botId } = useParams<{ botId: string }>();
  const { t } = useTranslation("bots");
  const [data, setData] = useState<SkillsView>();
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [revision, setRevision] = useState("0");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [editing, setEditing] = useState<CustomSkillView | "new">();
  const dirty = useMemo(() => !!data && snapshot(data) !== savedSnapshot, [data, savedSnapshot]);

  const load = useCallback(async () => {
    if (!botId) return;
    setLoading(true);
    setMessage(undefined);
    try {
      const response = await authFetch(`/api/bots/${encodeURIComponent(botId)}/skills`);
      const body = (await response.json()) as {
        ok?: boolean;
        data?: SkillsView;
        revision?: string;
        error?: string;
      };
      if (!response.ok || !body.ok || !body.data || !body.revision) {
        throw new Error(body.error ?? "load_failed");
      }
      setData(body.data);
      setRevision(body.revision);
      setSavedSnapshot(snapshot(body.data));
      setEditing(undefined);
    } catch {
      setMessage(t("skills.loadError"));
    } finally {
      setLoading(false);
    }
  }, [botId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!botId || !data || editing) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const response = await authFetch(`/api/bots/${encodeURIComponent(botId)}/skills`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision,
          enabledBuiltInIds: data.builtIns
            .filter((skill) => skill.enabled)
            .map((skill) => skill.id),
          customSkills: data.customSkills,
        }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        data?: SkillsView;
        revision?: string;
        code?: string;
        error?: string;
      };
      if (
        response.status === 503 &&
        body.code === "saved_apply_failed" &&
        typeof body.revision === "string"
      ) {
        setRevision(body.revision);
        setSavedSnapshot(snapshot(data));
        setMessage(t("skills.savedApplyFailed"));
        return;
      }
      if (!response.ok || !body.ok || !body.data || !body.revision) {
        throw new Error(body.code ?? body.error ?? "save_failed");
      }
      setData(body.data);
      setRevision(body.revision);
      setSavedSnapshot(snapshot(body.data));
      setMessage(t("skills.saved"));
    } catch (error) {
      setMessage(
        error instanceof Error && error.message === "stale_revision"
          ? t("skills.conflict")
          : t("skills.saveError"),
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-64 items-center justify-center" role="status">
        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
        <span className="sr-only">{t("skills.loading")}</span>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-3xl p-6 text-center">
        <p className="text-muted-foreground">{message ?? t("skills.loadError")}</p>
        <Button className="mt-4" variant="outline" onClick={() => void load()}>
          <RefreshCw className="size-4" />
          {t("skills.refresh")}
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-muted-foreground text-sm font-medium">{t("skills.eyebrow")}</p>
          <h1 className="text-2xl font-bold tracking-tight">{t("skills.title")}</h1>
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">{t("skills.description")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={saving}>
            <RefreshCw className="size-4" />
            {t("skills.refresh")}
          </Button>
          <Button onClick={() => void save()} disabled={!dirty || saving || !!editing}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            {t("skills.save")}
          </Button>
        </div>
      </header>

      {message ? (
        <p className="bg-muted rounded-lg px-3 py-2 text-sm" role="status">
          {message}
        </p>
      ) : null}

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">{t("skills.builtIns.title")}</h2>
          <p className="text-muted-foreground text-sm">{t("skills.builtIns.description")}</p>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {data.builtIns.map((skill) => (
            <Card key={skill.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">{skill.displayName}</CardTitle>
                    <CardDescription className="mt-1 font-mono text-xs">
                      {skill.name}
                    </CardDescription>
                  </div>
                  <Switch
                    checked={skill.enabled}
                    aria-label={t("skills.toggle", { name: skill.displayName })}
                    onCheckedChange={(enabled) =>
                      setData((current) =>
                        current
                          ? {
                              ...current,
                              builtIns: current.builtIns.map((item) =>
                                item.id === skill.id ? { ...item, enabled } : item,
                              ),
                            }
                          : current,
                      )
                    }
                  />
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-muted-foreground text-sm leading-6">{skill.summary}</p>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="default">{t("skills.bundled")}</Badge>
                  <Badge variant="muted">{skill.digest}</Badge>
                  {skill.resources.length > 0 ? (
                    <Badge variant="muted">
                      {t("skills.resourceCount", { count: skill.resources.length })}
                    </Badge>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{t("skills.custom.title")}</h2>
            <p className="text-muted-foreground text-sm">{t("skills.custom.description")}</p>
          </div>
          <Button variant="outline" onClick={() => setEditing("new")} disabled={!!editing}>
            <Plus className="size-4" />
            {t("skills.custom.add")}
          </Button>
        </div>
        {data.customSkills.length === 0 && !editing ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
              <BookOpenText className="text-muted-foreground size-8" />
              <p className="font-medium">{t("skills.custom.empty")}</p>
              <p className="text-muted-foreground text-sm">{t("skills.custom.emptyHint")}</p>
            </CardContent>
          </Card>
        ) : null}
        <div className="space-y-3">
          {data.customSkills.map((skill) => (
            <Card key={skill.id}>
              <CardContent className="flex flex-col gap-4 pt-5 sm:flex-row sm:items-center sm:justify-between sm:pt-6">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{skill.displayName}</h3>
                    <Badge variant="muted" className="font-mono">
                      {skill.name}
                    </Badge>
                    <Badge variant="muted">
                      {t("skills.resourceCount", { count: Object.keys(skill.resources).length })}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground mt-1 text-sm leading-6">
                    {skill.description}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={skill.enabled}
                    aria-label={t("skills.toggle", { name: skill.displayName })}
                    onCheckedChange={(enabled) =>
                      setData((current) =>
                        current
                          ? {
                              ...current,
                              customSkills: current.customSkills.map((item) =>
                                item.id === skill.id ? { ...item, enabled } : item,
                              ),
                            }
                          : current,
                      )
                    }
                  />
                  <Button variant="outline" size="sm" onClick={() => setEditing(skill)}>
                    <Pencil className="size-4" />
                    {t("skills.custom.edit")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("skills.custom.delete")}
                    onClick={() => {
                      if (
                        !window.confirm(
                          t("skills.custom.confirmDelete", { name: skill.displayName }),
                        )
                      )
                        return;
                      setData((current) =>
                        current
                          ? {
                              ...current,
                              customSkills: current.customSkills.filter(
                                (item) => item.id !== skill.id,
                              ),
                            }
                          : current,
                      );
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        {editing ? (
          <CustomSkillEditor
            key={editing === "new" ? "new" : editing.id}
            initial={editing === "new" ? undefined : editing}
            onCancel={() => setEditing(undefined)}
            onApply={(skill) => {
              setData((current) =>
                current
                  ? {
                      ...current,
                      customSkills: current.customSkills.some((item) => item.id === skill.id)
                        ? current.customSkills.map((item) => (item.id === skill.id ? skill : item))
                        : [...current.customSkills, skill],
                    }
                  : current,
              );
              setEditing(undefined);
            }}
          />
        ) : null}
      </section>
    </div>
  );
}
