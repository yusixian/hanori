import { Button } from "@/components/ui/button";
import type { PluginBotState, PluginLoginStart, PluginLoginState } from "@cos-tool-bot/shared";
import QRCode from "qrcode";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PluginRequestError, type PluginsApi } from "./api";

const waiting = (status: PluginLoginState["status"]) =>
  status === "waiting" || status === "scanned";

export function PluginQrLoginDialog({
  pluginId,
  botId,
  request,
  api,
  onClose,
  onConnected,
  onConflict,
}: {
  pluginId: string;
  botId: string;
  request: PluginLoginStart;
  api: Pick<PluginsApi, "startLogin" | "pollLogin" | "cancelLogin">;
  onClose: () => void;
  onConnected: (state: PluginBotState) => void;
  onConflict?: () => void;
}) {
  const { t } = useTranslation("plugins");
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<PluginLoginState["status"] | "starting">("starting");
  const [image, setImage] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const callbacks = useRef({ onConnected, onConflict });
  useEffect(() => {
    callbacks.current = { onConnected, onConflict };
  }, [onConnected, onConflict]);
  useLayoutEffect(() => {
    dialog.current?.showModal();
    const element = dialog.current;
    return () => element?.close();
  }, []);

  useEffect(() => {
    let active = true;
    let running = true;
    let session: PluginLoginState | null = null;
    let cancelled = false;
    let qrReady = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    setStatus("starting");
    setImage(null);
    setAccount(null);
    function cancel() {
      if (!session || !waiting(session.status) || cancelled) return;
      cancelled = true;
      void api.cancelLogin(pluginId, botId, session.id).catch(() => undefined);
    }
    function fail(error?: unknown, mayHaveSaved = false) {
      if (!active || !running) return;
      running = false;
      setImage(null);
      const conflict = error instanceof PluginRequestError && error.conflict;
      setStatus(conflict ? "conflict" : mayHaveSaved ? "save_unknown" : "failed");
      if (conflict || mayHaveSaved) callbacks.current.onConflict?.();
      cancel();
    }
    async function receive(value: PluginLoginState) {
      if (!active || !running) return;
      if (session && value.id !== session.id) {
        fail();
        return;
      }
      session = value;
      if (value.status === "saving") {
        setImage(null);
        setStatus("saving");
        pollTimer = setTimeout(() => {
          void poll();
        }, 2_000);
        return;
      }
      if (value.status === "connected") {
        if (!value.botState) {
          fail(undefined, true);
          return;
        }
        running = false;
        setImage(null);
        setStatus("connected");
        setAccount(value.account?.name ?? null);
        callbacks.current.onConnected(value.botState);
        return;
      }
      if (!waiting(value.status)) {
        running = false;
        setImage(null);
        setStatus(value.status);
        if (value.status === "conflict" || value.status === "save_unknown")
          callbacks.current.onConflict?.();
        return;
      }
      // The server owns expiry: a local clock or late response must not undo a save already begun.
      setStatus(value.status);
      if (value.qrUrl) {
        const data = await QRCode.toDataURL(value.qrUrl, {
          width: 280,
          margin: 2,
          errorCorrectionLevel: "M",
        });
        if (!active || !running) return;
        qrReady = true;
        setImage(data);
      } else if (!qrReady && value.status === "waiting") {
        fail();
        return;
      }
      if (active && running)
        pollTimer = setTimeout(() => {
          void poll();
        }, 2_000);
    }
    async function poll() {
      if (!active || !running || !session) return;
      try {
        await receive(await api.pollLogin(pluginId, botId, session.id));
      } catch (error) {
        fail(error, true);
      }
    }
    void api
      .startLogin(pluginId, botId, {
        expectedRevision: request.expectedRevision,
        manifestHash: request.manifestHash,
      })
      .then(async (value) => {
        if (!active) {
          session = value;
          cancel();
          return;
        }
        await receive(value);
      })
      .catch(fail);
    return () => {
      active = false;
      running = false;
      clearTimeout(pollTimer);
      cancel();
    };
  }, [api, pluginId, botId, request.expectedRevision, request.manifestHash, attempt]);

  const retry = status === "expired" || status === "failed" || status === "cancelled";
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      className="bg-card text-foreground backdrop:bg-code/30 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-auto rounded-2xl border p-5 shadow-xl"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
        <h2 id={titleId} className="text-lg font-semibold">
          {t("login.title")}
        </h2>
        <p className="text-muted-foreground text-sm">{t("login.description")}</p>
        {image ? (
          <img
            src={image}
            alt={t("login.qrAlt")}
            className="mx-auto aspect-square w-full max-w-[280px]"
          />
        ) : null}
        <p
          role={
            status === "failed" || status === "conflict" || status === "save_unknown"
              ? "alert"
              : "status"
          }
        >
          {t(`login.status.${status}`)}
        </p>
        {account ? <p>{t("login.account", { name: account })}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          {retry ? (
            <Button onClick={() => setAttempt((value) => value + 1)}>{t("login.retry")}</Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            {t("login.close")}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
