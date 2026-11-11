import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { client } from "@/lib/client";
import type { PromptSnapshot, PromptVersion, PromptVersionSummary } from "@cos-tool-bot/shared";

async function result<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error ?? String(response.status));
  return body.data;
}
export function PromptVersions({ botId }: { botId: string }) {
  const { t } = useTranslation("aiSettings");
  const prefix = useId();
  const [open, setOpen] = useState(false),
    [versions, setVersions] = useState<PromptVersionSummary[]>([]),
    [activeId, setActiveId] = useState<string | null>(null),
    [source, setSource] = useState("working");
  const [draft, setDraft] = useState<PromptSnapshot | null>(null),
    [baseline, setBaseline] = useState<PromptSnapshot | null>(null);
  const [comparison, setComparison] = useState("working"),
    [draftOrigin, setDraftOrigin] = useState("");
  const [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [fileName, setFileName] = useState("");
  const [baselinePreviews, setBaselinePreviews] = useState<PromptVersion["previews"] | null>(null);
  const [previews, setPreviews] = useState<PromptVersion["previews"] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const api = client.api.bots[":botId"]["prompt-versions"];
  const reload = async () => {
    const data = await result<{ activeId: string | null; versions: PromptVersionSummary[] }>(
      await api.$get({ param: { botId } }),
    );
    setVersions(data.versions);
    setActiveId(data.activeId);
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (open) void run(reload);
  }, [open, botId]);
  const [selected, setSelected] = useState<PromptVersion | null>(null);
  useEffect(() => {
    let current = true;
    setSelected(null);
    if (source !== "working")
      void (async () => {
        try {
          const value = await result<PromptVersion>(
            await api[":id"].$get({ param: { botId, id: source } }),
          );
          if (current) setSelected(value);
        } catch (error) {
          if (current) setError(error instanceof Error ? error.message : String(error));
        }
      })();
    return () => {
      current = false;
    };
  }, [source, botId]);
  const change = (update: Partial<PromptSnapshot>) => {
    setDraft((previous) => (previous ? { ...previous, ...update } : null));
    setPreviews(null);
  };
  const load = async () => {
    const snapshot =
      source === "working"
        ? (await result<{ snapshot: PromptSnapshot }>(await api.working.$get({ param: { botId } })))
            .snapshot
        : selected?.snapshot;
    if (!snapshot) return;
    setDraft(structuredClone(snapshot));
    setBaseline(structuredClone(snapshot));
    setComparison(source);
    setDraftOrigin(selected?.name ?? t("promptVersions.working"));
    setName("");
    setDescription("");
    setPreviews(null);
  };
  const changed =
    baseline && draft
      ? Object.keys(draft).filter(
          (key) =>
            JSON.stringify(draft[key as keyof PromptSnapshot]) !==
            JSON.stringify(baseline[key as keyof PromptSnapshot]),
        )
      : [];
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle className="text-base">{t("promptVersions.title")}</CardTitle>
        <Button type="button" variant="outline" onClick={() => setOpen(!open)}>
          {t(open ? "promptVersions.close" : "promptVersions.open")}
        </Button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-5">
          <p className="text-muted-foreground text-sm">{t("promptVersions.help")}</p>
          <p className="text-sm font-medium">
            {t("promptVersions.active")}:{" "}
            {versions.find((version) => version.id === activeId)?.name ??
              t("promptVersions.working")}
          </p>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="text-sm">
              {notice}
            </p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1 space-y-1">
              <label htmlFor={`${prefix}-source`} className="text-sm">
                {t("promptVersions.source")}
              </label>
              <Select
                id={`${prefix}-source`}
                value={source}
                onChange={(event) => setSource(event.target.value)}
              >
                <option value="working">{t("promptVersions.working")}</option>
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {`${version.name}${version.id === activeId ? ` · ${t("promptVersions.active")}` : ""}`}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              type="button"
              disabled={busy || (source !== "working" && !selected)}
              onClick={() => void run(load)}
            >
              {t("promptVersions.load")}
            </Button>
          </div>
          {selected && (
            <div className="space-y-3 rounded-lg border p-3">
              <p className="text-sm whitespace-pre-wrap">{selected.description}</p>
              <p className="text-muted-foreground text-xs break-all">
                {t("promptVersions.application")}: {selected.applicationVersion} ·{" "}
                {new Date(selected.createdAt).toLocaleString()}
              </p>
              <p className="text-sm">
                {t("promptVersions.savedTokens", {
                  private: selected.previews.private.estimatedTokens,
                  group: selected.previews.group.estimatedTokens,
                })}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={busy || selected.id === activeId}
                  onClick={() =>
                    void run(async () => {
                      await result(
                        await api.activate.$post({ param: { botId }, json: { id: selected.id } }),
                      );
                      await reload();
                      setNotice(t("promptVersions.activated"));
                    })
                  }
                >
                  {t("promptVersions.activate")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || selected.id === activeId}
                  onClick={() =>
                    void run(async () => {
                      await result(await api[":id"].$delete({ param: { botId, id: selected.id } }));
                      setSource("working");
                      await reload();
                    })
                  }
                >
                  {t("promptVersions.delete")}
                </Button>
              </div>
            </div>
          )}
          {activeId && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await result(await api.activate.$post({ param: { botId }, json: { id: null } }));
                  await reload();
                })
              }
            >
              {t("promptVersions.useWorking")}
            </Button>
          )}
          {draft && (
            <div className="space-y-4 border-t pt-4">
              <h3 className="font-semibold">{t("promptVersions.draft")}</h3>
              <p className="text-muted-foreground text-sm">
                {t("promptVersions.draftOrigin")}: {draftOrigin}
              </p>
              <label className="block space-y-1 text-sm">
                {t("promptVersions.compareSource")}
                <Select
                  disabled={busy}
                  aria-label={t("promptVersions.compareSource")}
                  value={comparison}
                  onChange={(event) => {
                    const id = event.target.value;
                    void run(async () => {
                      const value =
                        id === "working"
                          ? (
                              await result<{ snapshot: PromptSnapshot }>(
                                await api.working.$get({ param: { botId } }),
                              )
                            ).snapshot
                          : (
                              await result<PromptVersion>(
                                await api[":id"].$get({ param: { botId, id } }),
                              )
                            ).snapshot;
                      setComparison(id);
                      setBaseline(value);
                      setPreviews(null);
                    });
                  }}
                >
                  <option value="working">{t("promptVersions.working")}</option>
                  {versions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block space-y-1 text-sm">
                {t("promptVersions.name")}
                <Input value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label className="block space-y-1 text-sm">
                {t("promptVersions.description")}
                <Input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              {(["behavioralPrompt", "groupBehavioralPrompt", "systemPrompt"] as const).map(
                (field) => (
                  <label key={field} className="block space-y-1 text-sm">
                    {t(`promptVersions.${field}`)}
                    <Textarea
                      aria-label={t(`promptVersions.${field}`)}
                      rows={5}
                      value={draft[field]}
                      onChange={(event) => change({ [field]: event.target.value })}
                    />
                  </label>
                ),
              )}
              <h4 className="font-medium">{t("promptVersions.files")}</h4>
              <label className="block space-y-1 text-sm">
                {t("promptVersions.maxInjectionBytes")}
                <Input
                  type="number"
                  min={0}
                  max={1048576}
                  value={draft.maxInjectionBytes}
                  onChange={(event) => change({ maxInjectionBytes: Number(event.target.value) })}
                />
              </label>
              {draft.files.map((file, index) => (
                <details key={index} className="rounded-lg border p-3">
                  <summary className="cursor-pointer break-all">
                    {file.name} ·{" "}
                    {t(file.enabled ? "promptVersions.injected" : "promptVersions.reference")}
                  </summary>
                  <div className="mt-3 space-y-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={file.enabled}
                        onChange={(event) =>
                          change({
                            files: draft.files.map((item, i) =>
                              i === index ? { ...item, enabled: event.target.checked } : item,
                            ),
                          })
                        }
                      />
                      {t("promptVersions.inject")}
                    </label>
                    <Textarea
                      aria-label={`${t("promptVersions.content")} ${file.name}`}
                      rows={8}
                      value={file.content}
                      onChange={(event) =>
                        change({
                          files: draft.files.map((item, i) =>
                            i === index ? { ...item, content: event.target.value } : item,
                          ),
                        })
                      }
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => change({ files: draft.files.filter((_, i) => i !== index) })}
                    >
                      {t("promptVersions.removeFile")}
                    </Button>
                  </div>
                </details>
              ))}
              <div className="flex flex-wrap gap-2">
                <Input
                  aria-label={t("promptVersions.fileName")}
                  className="min-w-44 flex-1"
                  value={fileName}
                  onChange={(event) => setFileName(event.target.value)}
                  placeholder="REFERENCE.md"
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    !/^[^/\\]+\.md$/.test(fileName) ||
                    draft.files.some((file) => file.name === fileName)
                  }
                  onClick={() => {
                    change({
                      files: [...draft.files, { name: fileName, content: "", enabled: false }],
                    });
                    setFileName("");
                  }}
                >
                  {t("promptVersions.addFile")}
                </Button>
              </div>
              <h4 className="font-medium">{t("promptVersions.skills")}</h4>
              {draft.skills.map((skill, index) => (
                <details key={skill.id} className="rounded-lg border p-3">
                  <summary className="cursor-pointer">
                    {skill.displayName} ·{" "}
                    {t(skill.enabled ? "promptVersions.enabled" : "promptVersions.disabled")}
                  </summary>
                  <div className="mt-3 space-y-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={skill.enabled}
                        onChange={(event) =>
                          change({
                            skills: draft.skills.map((item, i) =>
                              i === index ? { ...item, enabled: event.target.checked } : item,
                            ),
                          })
                        }
                      />
                      {t("promptVersions.enabled")}
                    </label>
                    <label className="block space-y-1 text-sm">
                      {t("promptVersions.skillDescription")}
                      <Input
                        value={skill.description}
                        onChange={(event) =>
                          change({
                            skills: draft.skills.map((item, i) =>
                              i === index
                                ? {
                                    ...item,
                                    description: event.target.value,
                                    summary: event.target.value,
                                  }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <Textarea
                      aria-label={`${t("promptVersions.content")} ${skill.name}`}
                      rows={8}
                      value={skill.instructions}
                      onChange={(event) =>
                        change({
                          skills: draft.skills.map((item, i) =>
                            i === index ? { ...item, instructions: event.target.value } : item,
                          ),
                        })
                      }
                    />
                    {Object.entries(skill.resources).map(([resource, content]) => (
                      <label key={resource} className="block space-y-1 text-sm">
                        {resource}
                        <Textarea
                          rows={6}
                          value={content}
                          onChange={(event) =>
                            change({
                              skills: draft.skills.map((item, i) =>
                                i === index
                                  ? {
                                      ...item,
                                      resources: {
                                        ...item.resources,
                                        [resource]: event.target.value,
                                      },
                                    }
                                  : item,
                              ),
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                </details>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={busy}
                  variant="outline"
                  onClick={() =>
                    void run(async () => {
                      const [current, original] = await Promise.all([
                        result<PromptVersion["previews"]>(
                          await api.preview.$post({ param: { botId }, json: { snapshot: draft } }),
                        ),
                        baseline
                          ? result<PromptVersion["previews"]>(
                              await api.preview.$post({
                                param: { botId },
                                json: { snapshot: baseline },
                              }),
                            )
                          : Promise.resolve(null),
                      ]);
                      setPreviews(current);
                      setBaselinePreviews(original);
                    })
                  }
                >
                  {t("promptVersions.preview")}
                </Button>
                <Button
                  type="button"
                  disabled={busy || !name.trim()}
                  onClick={() =>
                    void run(async () => {
                      const saved = await result<PromptVersion>(
                        await api.$post({
                          param: { botId },
                          json: { name, description, snapshot: draft },
                        }),
                      );
                      await reload();
                      setSource(saved.id);
                      setNotice(t("promptVersions.saved"));
                    })
                  }
                >
                  {t("promptVersions.save")}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">{t("promptVersions.previewHelp")}</p>
              {previews && (
                <div className="space-y-3">
                  <p>
                    {t("promptVersions.previewTokens", {
                      private: previews.private.estimatedTokens,
                      group: previews.group.estimatedTokens,
                    })}
                    {baselinePreviews &&
                      ` · Δ ${previews.private.estimatedTokens - baselinePreviews.private.estimatedTokens} / ${previews.group.estimatedTokens - baselinePreviews.group.estimatedTokens}`}
                  </p>
                  {(["private", "group"] as const).map((mode) => (
                    <details key={mode}>
                      <summary>{t(`promptVersions.${mode}`)}</summary>
                      <pre className="max-h-96 overflow-auto rounded border p-3 text-xs break-words whitespace-pre-wrap">
                        {previews[mode].fullPrompt}
                      </pre>
                    </details>
                  ))}
                </div>
              )}
              <details open={changed.length > 0}>
                <summary>
                  {t("promptVersions.diff")} ({changed.length})
                </summary>
                {changed.map((key) => (
                  <div key={key} className="mt-3">
                    <h4 className="text-sm font-medium">{t(`promptVersions.${key}`)}</h4>
                    <div className="grid gap-3 md:grid-cols-2">
                      {[baseline, draft].map((snapshot, index) => (
                        <div key={index}>
                          <p className="text-muted-foreground text-xs">
                            {t(index === 0 ? "promptVersions.before" : "promptVersions.after")}
                          </p>
                          <pre className="max-h-64 overflow-auto rounded border p-3 text-xs break-words whitespace-pre-wrap">
                            {typeof snapshot?.[key as keyof PromptSnapshot] === "string"
                              ? String(snapshot[key as keyof PromptSnapshot])
                              : JSON.stringify(snapshot?.[key as keyof PromptSnapshot], null, 2)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </details>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
