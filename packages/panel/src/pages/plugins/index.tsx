import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePanelRole } from "@/hooks/use-can-manage-bot";
import type {
  PluginBotState,
  PluginCatalogEntry,
  PluginConfigUpdate,
  PluginInstallRequest,
  PluginLoginStart,
} from "@cos-tool-bot/shared";
import { Puzzle, RefreshCw } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { PluginRequestError, pluginsApi, type PluginsApi } from "./api";
import { PluginConfigForm } from "./config-form";
import { MediaJobsPanel } from "./media-jobs";
import { PluginQrLoginDialog } from "./qr-login-dialog";
import { YtdlpCookiesHelp, YtdlpSetupGuide } from "./ytdlp-setup-guide";

const fullSha = /^[a-f0-9]{40}$/i;
const githubRepository = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const selectClass =
  "border-input h-10 w-full min-w-0 rounded-lg border bg-white px-3 text-base md:text-sm";
function errorKey(error: unknown) {
  return error instanceof PluginRequestError && error.conflict ? "conflict" : "failed";
}

export function PluginsPage() {
  const role = usePanelRole();
  const { t } = useTranslation("plugins");
  if (role === null) return <p role="status">{t("loading")}</p>;
  if (role !== "owner" && role !== "admin") return <p role="alert">{t("accessDenied")}</p>;
  return <PluginMarketplace />;
}

export function PluginMarketplace({ api = pluginsApi }: { api?: PluginsApi }) {
  const { t } = useTranslation("plugins");
  const [catalog, setCatalog] = useState<PluginCatalogEntry[]>([]);
  const [bots, setBots] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [botId, setBotId] = useState("");
  const [install, setInstall] = useState<PluginCatalogEntry | "git" | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([api.catalog(), api.bots()])
      .then(([entries, availableBots]) => {
        if (!active) return;
        setCatalog(entries);
        setBots(availableBots);
        setBotId((current) =>
          availableBots.some((bot) => bot.id === current) ? current : (availableBots[0]?.id ?? ""),
        );
      })
      .catch(() => {
        if (active) setError("loadFailed");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, generation]);
  function replace(entry: PluginCatalogEntry) {
    setCatalog((current) =>
      current.some((item) => item.manifest.id === entry.manifest.id)
        ? current.map((item) => (item.manifest.id === entry.manifest.id ? entry : item))
        : [...current, entry],
    );
  }
  const selected = catalog.find((entry) => entry.manifest.id === selection && entry.installed);
  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Puzzle className="h-6 w-6" />
            {t("title")}
          </h1>
          <p className="text-muted-foreground mt-2 text-sm">{t("description")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => setGeneration((value) => value + 1)}
            disabled={loading}
          >
            <RefreshCw className="h-4 w-4" />
            {t("refresh")}
          </Button>
          <Button onClick={() => setInstall("git")}>{t("installGit")}</Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {t(error)}
        </p>
      ) : null}
      {loading ? <p role="status">{t("loading")}</p> : null}
      <section
        aria-label={t("catalog")}
        className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3"
      >
        {!loading && !error && catalog.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("empty")}</p>
        ) : null}
        {catalog.map((entry) => (
          <Card key={entry.manifest.id} className="min-w-0">
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-start gap-2">
                <h2 className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">
                  {entry.manifest.name}
                </h2>
                <Badge variant={entry.installed ? "success" : "muted"}>
                  {t(entry.installed ? "installed" : "available")}
                </Badge>
              </div>
              <p className="text-muted-foreground text-sm [overflow-wrap:anywhere]">
                {entry.manifest.description}
              </p>
              <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
                {entry.manifest.author} · {entry.manifest.version} ·{" "}
                {t(entry.source === "builtin" ? "builtin" : "thirdParty")}
              </p>
              <Button
                variant={selection === entry.manifest.id ? "default" : "outline"}
                className="w-full"
                onClick={() =>
                  entry.installed ? setSelection(entry.manifest.id) : setInstall(entry)
                }
              >
                {t(entry.installed ? "configure" : "install")}
              </Button>
            </CardContent>
          </Card>
        ))}
      </section>
      {selected ? (
        <section className="min-w-0 space-y-4" aria-label={t("settings")}>
          <h2 className="text-lg font-semibold [overflow-wrap:anywhere]">
            {selected.manifest.name}
          </h2>
          <div className="max-w-md space-y-2">
            <Label htmlFor="plugin-bot">{t("bot")}</Label>
            <select
              id="plugin-bot"
              className={selectClass}
              value={botId}
              onChange={(event) => setBotId(event.target.value)}
            >
              {bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
            {bots.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("noBots")}</p>
            ) : null}
          </div>
          {botId ? (
            <BotPluginSettings
              key={JSON.stringify([selected.manifest.id, selected.revision, botId])}
              entry={selected}
              botId={botId}
              api={api}
            />
          ) : null}
          <PluginVersions
            key={JSON.stringify([selected.manifest.id, selected.revision])}
            entry={selected}
            api={api}
            onChanged={replace}
            onRemoved={() => {
              setSelection((current) => (current === selected.manifest.id ? null : current));
              setGeneration((value) => value + 1);
            }}
          />
        </section>
      ) : null}
      {install ? (
        <InstallDialog
          entry={install}
          api={api}
          onClose={() => setInstall(null)}
          onInstalled={(entry) => {
            replace(entry);
            setSelection(entry.manifest.id);
            setInstall(null);
          }}
        />
      ) : null}
    </div>
  );
}

function BotPluginSettings({
  entry,
  botId,
  api,
}: {
  entry: PluginCatalogEntry;
  botId: string;
  api: PluginsApi;
}) {
  const { t } = useTranslation("plugins");
  const isYtdlp = entry.manifest.id === "hanori.ytdlp";
  const displayManifest = isYtdlp
    ? {
        ...entry.manifest,
        config: entry.manifest.config.map((field) => ({
          ...field,
          label: t(`ytdlp.fields.${field.key}.label`, { defaultValue: field.label }),
          description: t(`ytdlp.fields.${field.key}.description`, {
            defaultValue: field.description ?? "",
            value: field.default,
          }),
        })),
      }
    : entry.manifest;
  const [state, setState] = useState<PluginBotState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [reload, setReload] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [loginRequest, setLoginRequest] = useState<PluginLoginStart | null>(null);
  const mounted = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setState(null);
    api
      .botState(entry.manifest.id, botId)
      .then((value) => {
        if (active) {
          setState(value);
          setError(null);
          setConflict(false);
        }
      })
      .catch(() => {
        if (active) setError("loadFailed");
      });
    return () => {
      active = false;
    };
  }, [api, entry.manifest.id, botId, reload]);
  async function save(configuration?: PluginConfigUpdate, enabled?: boolean) {
    if (!state || busy.current || conflict) throw new PluginRequestError(conflict);
    busy.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.saveBot(entry.manifest.id, botId, {
        expectedRevision: state.revision,
        manifestHash: state.manifestHash,
        ...(configuration ? { configuration } : {}),
        ...(enabled === undefined ? {} : { enabled }),
      });
      if (mounted.current) {
        setState(updated);
        setNotice(configuration ? "config.saved" : enabled ? "enabledNotice" : "disabledNotice");
      }
    } catch (failure) {
      if (mounted.current) {
        setError(errorKey(failure));
        if (failure instanceof PluginRequestError && failure.conflict) setConflict(true);
      }
      throw failure;
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  async function testConnection() {
    if (busy.current || conflict || !state?.enabled || state.needsReview) return;
    busy.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.test(entry.manifest.id, botId);
      if (mounted.current) setNotice(result.success ? "testSuccess" : "testFailed");
    } catch (failure) {
      if (mounted.current) setError(errorKey(failure));
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return (
    <Card className="min-w-0">
      <CardContent className="space-y-5 p-4 sm:p-5">
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {t(error)}
          </p>
        ) : null}
        {conflict || (!state && error) ? (
          <Button
            variant="outline"
            disabled={pending || loginRequest !== null}
            onClick={() => {
              setNotice(null);
              setReload((value) => value + 1);
            }}
          >
            {t("reloadConfiguration")}
          </Button>
        ) : null}
        {!state && !error ? <p role="status">{t("loading")}</p> : null}
        {state ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Badge
                variant={
                  state.runtime.status === "ready"
                    ? "success"
                    : state.runtime.status === "error"
                      ? "destructive"
                      : "muted"
                }
              >
                {t(`status.${state.runtime.status}`)}
              </Badge>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={
                    pending ||
                    loginRequest !== null ||
                    conflict ||
                    (!state.enabled && state.needsReview)
                  }
                  onClick={() => {
                    void save(undefined, !state.enabled).catch(() => undefined);
                  }}
                >
                  {t(state.enabled ? "disable" : "enable")}
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    pending ||
                    loginRequest !== null ||
                    conflict ||
                    !state.enabled ||
                    state.needsReview
                  }
                  onClick={() => {
                    void testConnection();
                  }}
                >
                  {t("test")}
                </Button>
              </div>
            </div>
            {state.needsReview ? <p className="text-warning text-sm">{t("reviewHint")}</p> : null}
            {state.runtime.status === "error" ? (
              <p className="text-destructive text-sm">{t("runtimeError")}</p>
            ) : null}
            {isYtdlp ? (
              <YtdlpSetupGuide />
            ) : (
              <p className="text-muted-foreground text-sm">{t("savedTestHint")}</p>
            )}
            {entry.manifest.login ? (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  disabled={
                    pending || conflict || state.needsReview || dirty || loginRequest !== null
                  }
                  onClick={() =>
                    setLoginRequest({
                      expectedRevision: state.revision,
                      manifestHash: state.manifestHash,
                    })
                  }
                >
                  {t("login.button")}
                </Button>
                {dirty ? (
                  <p className="text-muted-foreground text-sm">{t("login.draftHint")}</p>
                ) : null}
              </div>
            ) : null}
            <PluginConfigForm
              manifest={displayManifest}
              fieldHelp={isYtdlp ? { cookies: <YtdlpCookiesHelp /> } : undefined}
              configuration={state.configuration}
              revision={state.revision}
              scopeKey={`${entry.manifest.id}/${botId}/${reload}`}
              disabled={pending || conflict || loginRequest !== null}
              onDirtyChange={setDirty}
              onSave={(configuration) => save(configuration)}
            />
            {entry.manifest.id === "hanori.bilibili" ? (
              <MediaJobsPanel key={`${botId}/${state.revision}/${reload}`} botId={botId} />
            ) : null}
          </>
        ) : null}
        {notice ? (
          <p role="status" className="text-muted-foreground text-sm">
            {t(notice)}
          </p>
        ) : null}
        {loginRequest ? (
          <PluginQrLoginDialog
            pluginId={entry.manifest.id}
            botId={botId}
            request={loginRequest}
            api={api}
            onClose={() => setLoginRequest(null)}
            onConflict={() => {
              setConflict(true);
              setError("conflict");
            }}
            onConnected={(updated) => {
              setState(updated);
              setError(null);
              setConflict(false);
            }}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function Modal({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      className="bg-card text-foreground backdrop:bg-code/30 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl overflow-auto rounded-2xl border p-5 shadow-xl"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id={id} className="mb-4 text-lg font-semibold">
        {title}
      </h2>
      {children}
    </dialog>
  );
}

function InstallDialog({
  entry,
  api,
  onClose,
  onInstalled,
}: {
  entry: PluginCatalogEntry | "git";
  api: PluginsApi;
  onClose: () => void;
  onInstalled: (entry: PluginCatalogEntry) => void;
}) {
  const { t } = useTranslation("plugins");
  const [repository, setRepository] = useState("");
  const [commit, setCommit] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!trusted || busy.current) return;
    if (entry === "git" && (!githubRepository.test(repository) || !fullSha.test(commit))) {
      setError("invalidSource");
      return;
    }
    const request: PluginInstallRequest =
      entry === "git"
        ? { repository, commit: commit.toLowerCase(), trustHostAccess: true }
        : { builtinId: entry.manifest.id, trustHostAccess: true };
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      onInstalled(await api.install(request));
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <Modal
      title={entry === "git" ? t("installGit") : t("installName", { name: entry.manifest.name })}
      onClose={onClose}
      busy={pending}
    >
      <form onSubmit={submit} className="min-w-0 space-y-4">
        {entry === "git" ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="plugin-repository">{t("repository")}</Label>
              <Input
                id="plugin-repository"
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
                placeholder="https://github.com/owner/repository"
                disabled={pending}
              />
              <p className="text-muted-foreground text-sm">{t("repositoryHint")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="plugin-commit">{t("commit")}</Label>
              <Input
                id="plugin-commit"
                value={commit}
                onChange={(event) => setCommit(event.target.value)}
                disabled={pending}
                maxLength={40}
              />
              <p className="text-muted-foreground text-sm">{t("commitHint")}</p>
            </div>
          </>
        ) : (
          <p className="text-muted-foreground text-sm [overflow-wrap:anywhere]">
            {entry.manifest.description}
          </p>
        )}
        <p className="rounded-lg border p-3 text-sm">{t("trustNotice")}</p>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={trusted}
            onChange={(event) => setTrusted(event.target.checked)}
            disabled={pending}
            className="accent-primary mt-0.5 h-5 w-5 shrink-0"
          />
          <span>{t("trustConfirm")}</span>
        </label>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {t(error)}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" disabled={!trusted || pending}>
            {t(pending ? "installing" : "install")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PluginVersions({
  entry,
  api,
  onChanged,
  onRemoved,
}: {
  entry: PluginCatalogEntry;
  api: PluginsApi;
  onChanged: (entry: PluginCatalogEntry) => void;
  onRemoved: () => void;
}) {
  const { t } = useTranslation("plugins");
  const [commit, setCommit] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const busy = useRef(false);
  async function run(action: "update" | "rollback" | "remove") {
    if (busy.current) return;
    if (action === "update" && !fullSha.test(commit)) {
      setError("invalidCommit");
      return;
    }
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      if (action === "remove") {
        await api.remove(entry.manifest.id, entry.revision);
        onRemoved();
      } else
        onChanged(
          action === "update"
            ? await api.update(entry.manifest.id, commit.toLowerCase(), entry.revision)
            : await api.rollback(entry.manifest.id, entry.revision),
        );
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <Card className="min-w-0">
      <CardContent className="min-w-0 space-y-4 p-4 sm:p-5">
        <h3 className="font-semibold">{t("installation")}</h3>
        {entry.repository ? (
          <p className="text-muted-foreground text-sm [overflow-wrap:anywhere]">
            {entry.repository}
          </p>
        ) : null}
        {entry.commit ? (
          <p className="text-muted-foreground font-mono text-xs [overflow-wrap:anywhere]">
            {entry.commit}
          </p>
        ) : null}
        <p className="text-muted-foreground text-sm">{t("updateHint")}</p>
        {entry.source === "git" ? (
          <>
            <div className="max-w-xl space-y-2">
              <Label htmlFor="plugin-update-commit">{t("updateCommit")}</Label>
              <Input
                id="plugin-update-commit"
                value={commit}
                maxLength={40}
                disabled={pending}
                onChange={(event) => setCommit(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={pending || !fullSha.test(commit)}
                onClick={() => {
                  void run("update");
                }}
              >
                {t("update")}
              </Button>
              {entry.previousCommit ? (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    void run("rollback");
                  }}
                >
                  {t("rollback")}
                </Button>
              ) : null}
            </div>
            {entry.previousCommit ? (
              <p className="text-muted-foreground font-mono text-xs [overflow-wrap:anywhere]">
                {t("previousCommit", { commit: entry.previousCommit })}
              </p>
            ) : null}
          </>
        ) : null}
        {!removeOpen && error ? (
          <p role="alert" className="text-destructive text-sm">
            {t(error)}
          </p>
        ) : null}
        <Button variant="destructive" disabled={pending} onClick={() => setRemoveOpen(true)}>
          {t("remove")}
        </Button>
        {removeOpen ? (
          <Modal
            title={t("removeTitle", { name: entry.manifest.name })}
            onClose={() => setRemoveOpen(false)}
            busy={pending}
          >
            <p className="mb-4 text-sm">{t("removeHint")}</p>
            {error ? (
              <p role="alert" className="text-destructive mb-4 text-sm">
                {t(error)}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" disabled={pending} onClick={() => setRemoveOpen(false)}>
                {t("cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={pending}
                onClick={() => {
                  void run("remove");
                }}
              >
                {t("confirmRemove")}
              </Button>
            </div>
          </Modal>
        ) : null}
      </CardContent>
    </Card>
  );
}
