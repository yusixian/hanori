import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useCanManageBot } from "@/hooks/use-can-manage-bot";
import { authFetch } from "@/lib/client";
import {
  deleteLibraryAsset,
  deleteLibraryCharacter,
  getLibrarySettings,
  listLibraryAssets,
  listLibraryCharacters,
  saveLibraryAsset,
  saveLibraryCharacter,
  updateLibrarySettings,
} from "@/lib/generation-library-client";
import type {
  AssetSafety,
  CharacterInput,
  GenerationLibrarySettings,
  LibraryCharacter,
  PromptAsset,
  PromptAssetInput,
  PromptAssetType,
} from "@cos-tool-bot/shared";
import { Loader2, Pencil, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";

const CHARACTER_PAGE_SIZE = 10;
const ASSET_PAGE_SIZE = 10;

type Tab = "characters" | "assets";

interface ProfileOption {
  telegramId: number;
  username: string | null;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
}

interface CharacterFormState {
  name: string;
  aliases: string;
  appearance: string;
  defaultOutfit: string;
  notes: string;
  copyright: string;
  ownerTelegramId: string;
}

interface AssetFormState {
  name: string;
  type: PromptAssetType | "";
  content: string;
  notes: string;
  safety: AssetSafety | "";
  pinned: boolean;
}

const emptyCharacterForm: CharacterFormState = {
  name: "",
  aliases: "",
  appearance: "",
  defaultOutfit: "",
  notes: "",
  copyright: "",
  ownerTelegramId: "",
};

const emptyAssetForm: AssetFormState = {
  name: "",
  type: "",
  content: "",
  notes: "",
  safety: "",
  pinned: false,
};

const assetTypes: PromptAssetType[] = ["artist_string", "style", "outfit", "trait", "composition"];

function useImeDebouncedValue(value: string, composing: boolean, delay = 350): string {
  const [debounced, setDebounced] = useState(value.trim());

  useEffect(() => {
    if (composing) return;
    const timer = window.setTimeout(() => setDebounced(value.trim()), delay);
    return () => window.clearTimeout(timer);
  }, [composing, delay, value]);

  return debounced;
}

function parseAliases(value: string): string[] {
  return value
    .split(",")
    .map((alias) => alias.trim())
    .filter(Boolean);
}

function characterToForm(character: LibraryCharacter): CharacterFormState {
  return {
    name: character.name,
    aliases: character.aliases.join(", "),
    appearance: character.appearance,
    defaultOutfit: character.defaultOutfit,
    notes: character.notes,
    copyright: character.copyright ?? "",
    ownerTelegramId: character.ownerTelegramId ? String(character.ownerTelegramId) : "",
  };
}

function assetToForm(asset: PromptAsset): AssetFormState {
  return {
    name: asset.name,
    type: asset.type,
    content: asset.content,
    notes: asset.notes,
    safety: asset.safety,
    pinned: asset.pinned,
  };
}

function profileLabel(profile: ProfileOption, unknownLabel: string): string {
  const name =
    profile.displayName || [profile.firstName, profile.lastName].filter(Boolean).join(" ");
  return `${name || unknownLabel}${profile.username ? ` @${profile.username}` : ""} (${profile.telegramId})`;
}

export function BotGenerationLibraryPage() {
  const { botId } = useParams<{ botId: string }>();
  if (!botId) return null;
  return <GenerationLibraryContent key={botId} botId={botId} />;
}

function GenerationLibraryContent({ botId }: { botId: string }) {
  const { t, i18n } = useTranslation("botData");
  const canManage = useCanManageBot();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );

  const [tab, setTab] = useState<Tab>("characters");
  const [settingsDraft, setSettingsDraft] = useState<GenerationLibrarySettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [characters, setCharacters] = useState<LibraryCharacter[]>([]);
  const [charactersTotal, setCharactersTotal] = useState(0);
  const [characterPage, setCharacterPage] = useState(1);
  const [characterSearchInput, setCharacterSearchInput] = useState("");
  const [characterComposing, setCharacterComposing] = useState(false);
  const characterSearch = useImeDebouncedValue(characterSearchInput, characterComposing);
  const [characterSource, setCharacterSource] = useState<"" | "danbooru" | "original">("");
  const [characterSort, setCharacterSort] = useState<"frequency" | "recent">("recent");
  const [charactersLoading, setCharactersLoading] = useState(true);
  const [assets, setAssets] = useState<PromptAsset[]>([]);
  const [assetsTotal, setAssetsTotal] = useState(0);
  const [assetPage, setAssetPage] = useState(1);
  const [assetSearchInput, setAssetSearchInput] = useState("");
  const [assetComposing, setAssetComposing] = useState(false);
  const assetSearch = useImeDebouncedValue(assetSearchInput, assetComposing);
  const [assetType, setAssetType] = useState<"" | PromptAssetType>("");
  const [assetSafety, setAssetSafety] = useState<"" | AssetSafety>("");
  const [assetSort, setAssetSort] = useState<"frequency" | "recent">("recent");
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [characterForm, setCharacterForm] = useState<CharacterFormState | null>(null);
  const [editingCharacterId, setEditingCharacterId] = useState<number | null>(null);
  const [editingCharacterSource, setEditingCharacterSource] = useState<
    LibraryCharacter["source"] | null
  >(null);
  const [assetForm, setAssetForm] = useState<AssetFormState | null>(null);
  const [editingAssetId, setEditingAssetId] = useState<number | null>(null);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [ownerProfileSearchInput, setOwnerProfileSearchInput] = useState("");
  const [ownerProfileComposing, setOwnerProfileComposing] = useState(false);
  const ownerProfileSearch = useImeDebouncedValue(ownerProfileSearchInput, ownerProfileComposing);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [mutationLoading, setMutationLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settingsRequestRef = useRef(0);
  const charactersRequestRef = useRef(0);
  const assetsRequestRef = useRef(0);
  const profilesRequestRef = useRef(0);

  const loadSettings = useCallback(async () => {
    if (!botId) return;
    const requestId = ++settingsRequestRef.current;
    setSettingsLoading(true);
    try {
      const value = await getLibrarySettings(botId);
      if (requestId !== settingsRequestRef.current) return;
      setSettingsDraft(value);
    } catch (err) {
      if (requestId !== settingsRequestRef.current) return;
      setError(err instanceof Error ? err.message : t("generationLibrary.loadFailed"));
    } finally {
      if (requestId === settingsRequestRef.current) setSettingsLoading(false);
    }
  }, [botId, t]);

  const loadCharacters = useCallback(async () => {
    if (!botId) return;
    const requestId = ++charactersRequestRef.current;
    setCharactersLoading(true);
    try {
      const result = await listLibraryCharacters(botId, {
        search: characterSearch || undefined,
        page: characterPage,
        limit: CHARACTER_PAGE_SIZE,
        source: characterSource || undefined,
        sort: characterSort,
      });
      if (requestId !== charactersRequestRef.current) return;
      setCharacters(result.data);
      setCharactersTotal(result.total);
    } catch (err) {
      if (requestId !== charactersRequestRef.current) return;
      setError(err instanceof Error ? err.message : t("generationLibrary.loadFailed"));
    } finally {
      if (requestId === charactersRequestRef.current) setCharactersLoading(false);
    }
  }, [botId, characterPage, characterSearch, characterSort, characterSource, t]);

  const loadAssets = useCallback(async () => {
    if (!botId) return;
    const requestId = ++assetsRequestRef.current;
    setAssetsLoading(true);
    try {
      const result = await listLibraryAssets(botId, {
        search: assetSearch || undefined,
        page: assetPage,
        limit: ASSET_PAGE_SIZE,
        type: assetType || undefined,
        safety: assetSafety || undefined,
        sort: assetSort,
      });
      if (requestId !== assetsRequestRef.current) return;
      setAssets(result.data);
      setAssetsTotal(result.total);
    } catch (err) {
      if (requestId !== assetsRequestRef.current) return;
      setError(err instanceof Error ? err.message : t("generationLibrary.loadFailed"));
    } finally {
      if (requestId === assetsRequestRef.current) setAssetsLoading(false);
    }
  }, [assetPage, assetSafety, assetSearch, assetSort, assetType, botId, t]);

  useEffect(() => {
    settingsRequestRef.current += 1;
    charactersRequestRef.current += 1;
    assetsRequestRef.current += 1;
    profilesRequestRef.current += 1;
    setSettingsDraft(null);
    setCharacters([]);
    setCharactersTotal(0);
    setCharacterPage(1);
    setAssets([]);
    setAssetsTotal(0);
    setAssetPage(1);
    setCharacterForm(null);
    setAssetForm(null);
    setEditingCharacterId(null);
    setEditingCharacterSource(null);
    setEditingAssetId(null);
    setProfiles([]);
    setOwnerProfileSearchInput("");
    setError(null);
  }, [botId]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    void loadCharacters();
  }, [loadCharacters]);

  useEffect(() => {
    if (tab === "assets") void loadAssets();
  }, [loadAssets, tab]);

  useEffect(() => {
    setCharacterPage(1);
  }, [characterSearch]);

  useEffect(() => {
    setAssetPage(1);
  }, [assetSearch]);

  const loadProfiles = useCallback(async () => {
    if (!botId) return;
    const requestId = ++profilesRequestRef.current;
    setProfilesLoading(true);
    try {
      const params = new URLSearchParams({ page: "1", limit: "20" });
      if (ownerProfileSearch) params.set("search", ownerProfileSearch);
      const response = await authFetch(
        `/api/bots/${encodeURIComponent(botId)}/profiles?${params.toString()}`,
      );
      const body = (await response.json()) as {
        ok?: boolean;
        data?: ProfileOption[];
        error?: string;
      };
      if (!response.ok || body.ok !== true || !Array.isArray(body.data)) {
        throw new Error(body.error || `Profiles request failed (HTTP ${response.status})`);
      }
      if (requestId !== profilesRequestRef.current) return;
      setProfiles(body.data);
    } catch (err) {
      if (requestId !== profilesRequestRef.current) return;
      setError(err instanceof Error ? err.message : t("generationLibrary.loadProfilesFailed"));
    } finally {
      if (requestId === profilesRequestRef.current) setProfilesLoading(false);
    }
  }, [botId, ownerProfileSearch, t]);

  useEffect(() => {
    if (characterForm !== null && editingCharacterId === null) void loadProfiles();
  }, [characterForm !== null, editingCharacterId, loadProfiles]);

  const openNewCharacter = () => {
    setEditingCharacterId(null);
    setEditingCharacterSource("original");
    setCharacterForm(emptyCharacterForm);
    setOwnerProfileSearchInput("");
  };

  const openEditCharacter = (character: LibraryCharacter) => {
    setEditingCharacterId(character.id);
    setEditingCharacterSource(character.source);
    setCharacterForm(characterToForm(character));
    setOwnerProfileSearchInput("");
  };

  const handleSaveCharacter = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!botId || !characterForm) return;
    if (!characterForm.name.trim() || !characterForm.appearance.trim()) {
      setError(t("generationLibrary.characterRequired"));
      return;
    }
    setMutationLoading(true);
    try {
      const input: CharacterInput = {
        name: characterForm.name.trim(),
        aliases: parseAliases(characterForm.aliases),
        appearance: characterForm.appearance.trim(),
        defaultOutfit: characterForm.defaultOutfit.trim(),
        notes: characterForm.notes.trim(),
        copyright: characterForm.copyright.trim() || undefined,
        ownerTelegramId:
          editingCharacterSource === "original" && characterForm.ownerTelegramId
            ? Number(characterForm.ownerTelegramId)
            : undefined,
      };
      await saveLibraryCharacter(botId, input, editingCharacterId ?? undefined);
      setCharacterForm(null);
      setError(null);
      await loadCharacters();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("generationLibrary.saveFailed"));
    } finally {
      setMutationLoading(false);
    }
  };

  const handleDeleteCharacter = async (character: LibraryCharacter) => {
    if (!botId) return;
    const confirmed = window.confirm(
      t("generationLibrary.deleteCharacterConfirm", {
        name: character.name,
        count: character.bindingCount,
      }),
    );
    if (!confirmed) return;
    setMutationLoading(true);
    try {
      await deleteLibraryCharacter(botId, character.id);
      setError(null);
      await loadCharacters();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("generationLibrary.deleteFailed"));
    } finally {
      setMutationLoading(false);
    }
  };

  const openNewAsset = () => {
    setEditingAssetId(null);
    setAssetForm(emptyAssetForm);
  };

  const openEditAsset = (asset: PromptAsset) => {
    setEditingAssetId(asset.id);
    setAssetForm(assetToForm(asset));
  };

  const handleSaveAsset = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!botId || !assetForm) return;
    if (!assetForm.name.trim() || !assetForm.content.trim() || !assetForm.type) {
      setError(t("generationLibrary.assetRequired"));
      return;
    }
    if (!assetForm.safety) {
      setError(t("generationLibrary.safetyRequired"));
      return;
    }
    setMutationLoading(true);
    try {
      const input: PromptAssetInput = {
        name: assetForm.name.trim(),
        type: assetForm.type,
        content: assetForm.content.trim(),
        notes: assetForm.notes.trim(),
        safety: assetForm.safety,
        pinned: assetForm.pinned,
      };
      await saveLibraryAsset(botId, input, editingAssetId ?? undefined);
      setAssetForm(null);
      setError(null);
      await loadAssets();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("generationLibrary.saveFailed"));
    } finally {
      setMutationLoading(false);
    }
  };

  const handleDeleteAsset = async (asset: PromptAsset) => {
    if (
      !botId ||
      !window.confirm(t("generationLibrary.deleteAssetConfirm", { name: asset.name }))
    ) {
      return;
    }
    setMutationLoading(true);
    try {
      await deleteLibraryAsset(botId, asset.id);
      setError(null);
      await loadAssets();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("generationLibrary.deleteFailed"));
    } finally {
      setMutationLoading(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!botId || !settingsDraft || !canManage) return;
    setSettingsSaving(true);
    try {
      const value = await updateLibrarySettings(botId, settingsDraft);
      setSettingsDraft(value);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("generationLibrary.saveFailed"));
    } finally {
      setSettingsSaving(false);
    }
  };

  const characterTotalPages = Math.ceil(charactersTotal / CHARACTER_PAGE_SIZE);
  const assetTotalPages = Math.ceil(assetsTotal / ASSET_PAGE_SIZE);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-muted-foreground text-xs font-semibold tracking-[0.16em] uppercase">
            {t("generationLibrary.eyebrow")}
          </p>
          <h1 className="mt-1 text-2xl font-bold">{t("generationLibrary.title")}</h1>
          <p className="text-muted-foreground mt-2 max-w-3xl text-sm">
            {t("generationLibrary.description")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void (tab === "characters" ? loadCharacters() : loadAssets())}
        >
          <RefreshCw className="h-4 w-4" />
          {t("generationLibrary.refresh")}
        </Button>
      </div>

      {error && (
        <Card className="border-danger-border bg-danger-soft/60">
          <CardContent className="text-destructive flex items-start justify-between gap-4 pt-5 text-sm">
            <p role="alert">{error}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setError(null)}
              aria-label={t("common.close")}
            >
              <X className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("generationLibrary.settingsTitle")}</CardTitle>
          <CardDescription>{t("generationLibrary.settingsDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {settingsLoading || !settingsDraft ? (
            <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
          ) : (
            <div className="space-y-4">
              {(
                [
                  ["charactersEnabled", "charactersEnabled", "charactersEnabledDescription"],
                  ["assetsEnabled", "assetsEnabled", "assetsEnabledDescription"],
                  ["injectionEnabled", "injectionEnabled", "injectionEnabledDescription"],
                  ["nsfwEnabled", "nsfwEnabled", "nsfwEnabledDescription"],
                ] as const
              ).map(([key, labelKey, descriptionKey]) => (
                <div key={key} className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{t(`generationLibrary.${labelKey}`)}</p>
                    <p className="text-muted-foreground text-xs">
                      {t(`generationLibrary.${descriptionKey}`)}
                    </p>
                  </div>
                  <Switch
                    checked={settingsDraft[key]}
                    disabled={!canManage || settingsSaving}
                    onCheckedChange={(checked) =>
                      setSettingsDraft((current) =>
                        current ? { ...current, [key]: checked } : current,
                      )
                    }
                    aria-label={t(`generationLibrary.${labelKey}`)}
                  />
                </div>
              ))}
              {canManage && (
                <div className="flex justify-end pt-1">
                  <Button
                    size="sm"
                    onClick={() => void handleSaveSettings()}
                    disabled={settingsSaving}
                  >
                    {settingsSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t("common.save")}
                  </Button>
                </div>
              )}
              {!canManage && (
                <p className="text-muted-foreground text-xs">{t("generationLibrary.readOnly")}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="border-b">
        <div className="flex gap-5" role="tablist" aria-label={t("generationLibrary.tabsLabel")}>
          {(["characters", "assets"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              className={`border-b-2 px-1 pb-3 text-sm font-semibold transition-colors ${
                tab === item
                  ? "border-primary text-primary"
                  : "text-muted-foreground hover:text-foreground border-transparent"
              }`}
              onClick={() => setTab(item)}
            >
              {t(`generationLibrary.tabs.${item}`)}
            </button>
          ))}
        </div>
      </div>

      {tab === "characters" ? (
        <section
          role="tabpanel"
          aria-label={t("generationLibrary.tabs.characters")}
          className="space-y-4"
        >
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div className="relative w-full lg:max-w-md">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
              <Input
                value={characterSearchInput}
                onChange={(event) => setCharacterSearchInput(event.target.value)}
                onCompositionStart={() => setCharacterComposing(true)}
                onCompositionEnd={() => setCharacterComposing(false)}
                placeholder={t("generationLibrary.characterSearchPlaceholder")}
                className="pl-9"
              />
            </div>
            <Select
              value={characterSource}
              onChange={(event) => {
                setCharacterSource(event.target.value as "" | "danbooru" | "original");
                setCharacterPage(1);
              }}
              aria-label={t("generationLibrary.source")}
            >
              <option value="">{t("generationLibrary.allSources")}</option>
              <option value="danbooru">{t("generationLibrary.danbooru")}</option>
              <option value="original">{t("generationLibrary.original")}</option>
            </Select>
            <Select
              value={characterSort}
              onChange={(event) => {
                setCharacterSort(event.target.value as "frequency" | "recent");
                setCharacterPage(1);
              }}
              aria-label={t("generationLibrary.sort")}
            >
              <option value="recent">{t("generationLibrary.recent")}</option>
              <option value="frequency">{t("generationLibrary.frequency")}</option>
            </Select>
            {canManage && (
              <Button
                size="sm"
                className="shrink-0 whitespace-nowrap lg:ml-auto"
                onClick={openNewCharacter}
                disabled={mutationLoading}
              >
                <Plus className="h-4 w-4" />
                {t("generationLibrary.addCharacter")}
              </Button>
            )}
          </div>

          {characterForm && canManage && (
            <CharacterFormCard
              form={characterForm}
              profiles={profiles}
              profilesLoading={profilesLoading}
              ownerProfileSearch={ownerProfileSearchInput}
              characterSource={editingCharacterSource ?? "original"}
              editing={editingCharacterId !== null}
              saving={mutationLoading}
              onChange={setCharacterForm}
              onOwnerProfileSearchChange={setOwnerProfileSearchInput}
              onOwnerProfileCompositionStart={() => setOwnerProfileComposing(true)}
              onOwnerProfileCompositionEnd={() => setOwnerProfileComposing(false)}
              onOwnerProfileSelect={(telegramId) =>
                setCharacterForm({ ...characterForm, ownerTelegramId: telegramId })
              }
              onCancel={() => setCharacterForm(null)}
              onSubmit={handleSaveCharacter}
              t={t}
            />
          )}

          {charactersLoading ? (
            <LoadingRow label={t("common.loading")} />
          ) : characters.length === 0 ? (
            <EmptyRow label={t("generationLibrary.charactersEmpty")} />
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              {characters.map((character) => (
                <CharacterCard
                  key={character.id}
                  character={character}
                  canManage={canManage}
                  mutationLoading={mutationLoading}
                  dateFormatter={dateFormatter}
                  numberFormatter={numberFormatter}
                  onEdit={() => openEditCharacter(character)}
                  onDelete={() => void handleDeleteCharacter(character)}
                  t={t}
                />
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground text-xs">
              {t("common.total", { value: numberFormatter.format(charactersTotal) })}
            </span>
            <Pagination
              page={characterPage}
              totalPages={characterTotalPages}
              onPageChange={setCharacterPage}
            />
          </div>
        </section>
      ) : (
        <section
          role="tabpanel"
          aria-label={t("generationLibrary.tabs.assets")}
          className="space-y-4"
        >
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div className="relative w-full lg:max-w-md">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
              <Input
                value={assetSearchInput}
                onChange={(event) => setAssetSearchInput(event.target.value)}
                onCompositionStart={() => setAssetComposing(true)}
                onCompositionEnd={() => setAssetComposing(false)}
                placeholder={t("generationLibrary.assetSearchPlaceholder")}
                className="pl-9"
              />
            </div>
            <Select
              value={assetType}
              onChange={(event) => {
                setAssetType(event.target.value as "" | PromptAssetType);
                setAssetPage(1);
              }}
              aria-label={t("generationLibrary.assetType")}
            >
              <option value="">{t("generationLibrary.allAssetTypes")}</option>
              {assetTypes.map((type) => (
                <option key={type} value={type}>
                  {t(`generationLibrary.assetTypes.${type}`)}
                </option>
              ))}
            </Select>
            <Select
              value={assetSafety}
              onChange={(event) => {
                setAssetSafety(event.target.value as "" | AssetSafety);
                setAssetPage(1);
              }}
              aria-label={t("generationLibrary.safety")}
            >
              <option value="">{t("generationLibrary.allSafety")}</option>
              <option value="safe">{t("generationLibrary.safe")}</option>
              <option value="nsfw">{t("generationLibrary.nsfw")}</option>
            </Select>
            <Select
              value={assetSort}
              onChange={(event) => {
                setAssetSort(event.target.value as "frequency" | "recent");
                setAssetPage(1);
              }}
              aria-label={t("generationLibrary.sort")}
            >
              <option value="recent">{t("generationLibrary.recent")}</option>
              <option value="frequency">{t("generationLibrary.frequency")}</option>
            </Select>
            {canManage && (
              <Button
                size="sm"
                className="shrink-0 whitespace-nowrap lg:ml-auto"
                onClick={openNewAsset}
                disabled={mutationLoading}
              >
                <Plus className="h-4 w-4" />
                {t("generationLibrary.addAsset")}
              </Button>
            )}
          </div>

          {assetForm && canManage && (
            <AssetFormCard
              form={assetForm}
              editing={editingAssetId !== null}
              saving={mutationLoading}
              onChange={setAssetForm}
              onCancel={() => setAssetForm(null)}
              onSubmit={handleSaveAsset}
              t={t}
            />
          )}

          {assetsLoading ? (
            <LoadingRow label={t("common.loading")} />
          ) : assets.length === 0 ? (
            <EmptyRow label={t("generationLibrary.assetsEmpty")} />
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              {assets.map((asset) => (
                <AssetCard
                  key={asset.id}
                  asset={asset}
                  canManage={canManage}
                  mutationLoading={mutationLoading}
                  dateFormatter={dateFormatter}
                  numberFormatter={numberFormatter}
                  onEdit={() => openEditAsset(asset)}
                  onDelete={() => void handleDeleteAsset(asset)}
                  t={t}
                />
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground text-xs">
              {t("common.total", { value: numberFormatter.format(assetsTotal) })}
            </span>
            <Pagination page={assetPage} totalPages={assetTotalPages} onPageChange={setAssetPage} />
          </div>
        </section>
      )}
    </div>
  );
}

function LoadingRow({ label }: { label: string }) {
  return <p className="text-muted-foreground py-8 text-center text-sm">{label}</p>;
}

function EmptyRow({ label }: { label: string }) {
  return (
    <p className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
      {label}
    </p>
  );
}

function CharacterFormCard({
  form,
  profiles,
  profilesLoading,
  ownerProfileSearch,
  characterSource,
  editing,
  saving,
  onChange,
  onOwnerProfileSearchChange,
  onOwnerProfileCompositionStart,
  onOwnerProfileCompositionEnd,
  onOwnerProfileSelect,
  onCancel,
  onSubmit,
  t,
}: {
  form: CharacterFormState;
  profiles: ProfileOption[];
  profilesLoading: boolean;
  ownerProfileSearch: string;
  characterSource: LibraryCharacter["source"];
  editing: boolean;
  saving: boolean;
  onChange: (form: CharacterFormState) => void;
  onOwnerProfileSearchChange: (value: string) => void;
  onOwnerProfileCompositionStart: () => void;
  onOwnerProfileCompositionEnd: () => void;
  onOwnerProfileSelect: (telegramId: string) => void;
  onCancel: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  t: ReturnType<typeof useTranslation<"botData">>["t"];
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          {t(
            editing
              ? characterSource === "danbooru"
                ? "generationLibrary.editDanbooruCharacter"
                : "generationLibrary.editCharacter"
              : "generationLibrary.newCharacter",
          )}
        </CardTitle>
        <CardDescription>
          {t(
            characterSource === "danbooru"
              ? "generationLibrary.danbooruEditDescription"
              : "generationLibrary.originalCharacterDescription",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("generationLibrary.characterName")} required>
              <Input
                value={form.name}
                disabled={characterSource === "danbooru"}
                onChange={(event) => onChange({ ...form, name: event.target.value })}
              />
            </Field>
            <Field
              label={t("generationLibrary.characterAliases")}
              hint={t("generationLibrary.characterAliasesHint")}
            >
              <Input
                value={form.aliases}
                disabled={characterSource === "danbooru"}
                onChange={(event) => onChange({ ...form, aliases: event.target.value })}
              />
            </Field>
          </div>
          <Field label={t("generationLibrary.appearance")} required>
            <Textarea
              value={form.appearance}
              onChange={(event) => onChange({ ...form, appearance: event.target.value })}
              rows={4}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("generationLibrary.defaultOutfit")}>
              <Textarea
                value={form.defaultOutfit}
                onChange={(event) => onChange({ ...form, defaultOutfit: event.target.value })}
                rows={3}
              />
            </Field>
            <Field label={t("generationLibrary.notes")}>
              <Textarea
                value={form.notes}
                onChange={(event) => onChange({ ...form, notes: event.target.value })}
                rows={3}
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("generationLibrary.copyright")}>
              <Input
                value={form.copyright}
                onChange={(event) => onChange({ ...form, copyright: event.target.value })}
              />
            </Field>
            <Field
              label={t("generationLibrary.ownerProfile")}
              hint={t("generationLibrary.ownerProfileHint")}
            >
              <div className="space-y-2">
                <Input
                  value={ownerProfileSearch}
                  onChange={(event) => onOwnerProfileSearchChange(event.target.value)}
                  onCompositionStart={onOwnerProfileCompositionStart}
                  onCompositionEnd={onOwnerProfileCompositionEnd}
                  placeholder={t("generationLibrary.ownerProfileSearchPlaceholder")}
                  disabled={editing || characterSource === "danbooru" || profilesLoading}
                />
                {form.ownerTelegramId ? (
                  <div className="bg-background flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs">
                    <span>
                      {t("generationLibrary.selectedProfile", { id: form.ownerTelegramId })}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onChange({ ...form, ownerTelegramId: "" })}
                      disabled={editing || characterSource === "danbooru"}
                    >
                      {t("common.clear")}
                    </Button>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    {t("generationLibrary.adminMaintained")}
                  </p>
                )}
                {profilesLoading ? (
                  <p className="text-muted-foreground text-xs">{t("common.loading")}</p>
                ) : profiles.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    {t("generationLibrary.noProfiles")}
                  </p>
                ) : (
                  <div className="max-h-32 space-y-1 overflow-y-auto">
                    {profiles.map((profile) => (
                      <button
                        key={profile.telegramId}
                        type="button"
                        className={`block w-full rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                          form.ownerTelegramId === String(profile.telegramId)
                            ? "border-primary bg-accent"
                            : "hover:bg-background bg-white"
                        }`}
                        onClick={() => onOwnerProfileSelect(String(profile.telegramId))}
                        disabled={editing || characterSource === "danbooru"}
                      >
                        {profileLabel(profile, t("common.unknown"))}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </Field>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("common.save")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
              <X className="h-4 w-4" />
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function AssetFormCard({
  form,
  editing,
  saving,
  onChange,
  onCancel,
  onSubmit,
  t,
}: {
  form: AssetFormState;
  editing: boolean;
  saving: boolean;
  onChange: (form: AssetFormState) => void;
  onCancel: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  t: ReturnType<typeof useTranslation<"botData">>["t"];
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          {t(editing ? "generationLibrary.editAsset" : "generationLibrary.newAsset")}
        </CardTitle>
        <CardDescription>{t("generationLibrary.assetDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("generationLibrary.assetName")} required>
              <Input
                value={form.name}
                onChange={(event) => onChange({ ...form, name: event.target.value })}
              />
            </Field>
            <Field label={t("generationLibrary.assetType")} required>
              <Select
                value={form.type}
                onChange={(event) =>
                  onChange({ ...form, type: event.target.value as PromptAssetType | "" })
                }
              >
                <option value="">{t("generationLibrary.chooseAssetType")}</option>
                {assetTypes.map((type) => (
                  <option key={type} value={type}>
                    {t(`generationLibrary.assetTypes.${type}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={t("generationLibrary.content")} required>
            <Textarea
              value={form.content}
              onChange={(event) => onChange({ ...form, content: event.target.value })}
              rows={4}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("generationLibrary.notes")}>
              <Textarea
                value={form.notes}
                onChange={(event) => onChange({ ...form, notes: event.target.value })}
                rows={3}
              />
            </Field>
            <Field
              label={t("generationLibrary.safety")}
              required
              hint={t("generationLibrary.safetyHint")}
            >
              <Select
                value={form.safety}
                onChange={(event) =>
                  onChange({ ...form, safety: event.target.value as AssetSafety | "" })
                }
              >
                <option value="">{t("generationLibrary.chooseSafety")}</option>
                <option value="safe">{t("generationLibrary.safe")}</option>
                <option value="nsfw">{t("generationLibrary.nsfw")}</option>
              </Select>
            </Field>
          </div>
          <label className="flex items-center gap-3 text-sm">
            <Switch
              checked={form.pinned}
              onCheckedChange={(checked) => onChange({ ...form, pinned: checked })}
            />
            <span>
              <span className="block font-medium">{t("generationLibrary.pinned")}</span>
              <span className="text-muted-foreground block text-xs">
                {t("generationLibrary.pinnedDescription")}
              </span>
            </span>
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("common.save")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
              <X className="h-4 w-4" />
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5 text-sm">
      <span className="font-medium">
        {label}
        {required ? " *" : ""}
      </span>
      {children}
      {hint && <span className="text-muted-foreground block text-xs">{hint}</span>}
    </label>
  );
}

function CharacterCard({
  character,
  canManage,
  mutationLoading,
  dateFormatter,
  numberFormatter,
  onEdit,
  onDelete,
  t,
}: {
  character: LibraryCharacter;
  canManage: boolean;
  mutationLoading: boolean;
  dateFormatter: Intl.DateTimeFormat;
  numberFormatter: Intl.NumberFormat;
  onEdit: () => void;
  onDelete: () => void;
  t: ReturnType<typeof useTranslation<"botData">>["t"];
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-base">{character.name}</CardTitle>
            <p className="text-muted-foreground mt-1 text-xs">
              {character.aliases.join(", ") || t("generationLibrary.noAliases")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Badge variant={character.source === "original" ? "success" : "muted"}>
              {t(`generationLibrary.${character.source}`)}
            </Badge>
            {canManage && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onEdit}
                  disabled={mutationLoading}
                  aria-label={t("generationLibrary.editCharacter")}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onDelete}
                  disabled={mutationLoading}
                  aria-label={t("generationLibrary.deleteCharacter")}
                >
                  <Trash2 className="text-destructive h-4 w-4" />
                </Button>
              </>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="whitespace-pre-wrap">
          {character.appearance || t("generationLibrary.notProvided")}
        </p>
        {character.defaultOutfit && (
          <p>
            <span className="text-muted-foreground">{t("generationLibrary.defaultOutfit")}:</span>{" "}
            {character.defaultOutfit}
          </p>
        )}
        {character.notes && (
          <p className="text-muted-foreground whitespace-pre-wrap">{character.notes}</p>
        )}
        {character.canonicalTag && (
          <p className="font-mono text-xs break-all">{character.canonicalTag}</p>
        )}
        {character.wikiSummary && (
          <p className="text-muted-foreground line-clamp-3 text-xs">{character.wikiSummary}</p>
        )}
        <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span>
            {t("generationLibrary.queryCount", {
              count: numberFormatter.format(character.queryCount),
            })}
          </span>
          <span>
            {t("generationLibrary.bindingCount", {
              count: numberFormatter.format(character.bindingCount),
            })}
          </span>
          {character.postCount !== null && (
            <span>
              {t("generationLibrary.postCount", {
                count: numberFormatter.format(character.postCount),
              })}
            </span>
          )}
          <span>
            {t("generationLibrary.updatedAt", {
              date: dateFormatter.format(new Date(character.updatedAt)),
            })}
          </span>
        </div>
        {character.source === "danbooru" && (
          <p className="text-muted-foreground text-xs">{t("generationLibrary.danbooruReadOnly")}</p>
        )}
      </CardContent>
    </Card>
  );
}

function AssetCard({
  asset,
  canManage,
  mutationLoading,
  dateFormatter,
  numberFormatter,
  onEdit,
  onDelete,
  t,
}: {
  asset: PromptAsset;
  canManage: boolean;
  mutationLoading: boolean;
  dateFormatter: Intl.DateTimeFormat;
  numberFormatter: Intl.NumberFormat;
  onEdit: () => void;
  onDelete: () => void;
  t: ReturnType<typeof useTranslation<"botData">>["t"];
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-base">{asset.name}</CardTitle>
            <p className="text-muted-foreground mt-1 text-xs">
              {t(`generationLibrary.assetTypes.${asset.type}`)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Badge variant={asset.safety === "nsfw" ? "destructive" : "success"}>
              {t(`generationLibrary.${asset.safety}`)}
            </Badge>
            {asset.pinned && <Badge variant="warning">{t("generationLibrary.pinned")}</Badge>}
            {canManage && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onEdit}
                  disabled={mutationLoading}
                  aria-label={t("generationLibrary.editAsset")}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onDelete}
                  disabled={mutationLoading}
                  aria-label={t("generationLibrary.deleteAsset")}
                >
                  <Trash2 className="text-destructive h-4 w-4" />
                </Button>
              </>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="whitespace-pre-wrap">{asset.content}</p>
        {asset.notes && <p className="text-muted-foreground whitespace-pre-wrap">{asset.notes}</p>}
        <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span>
            {t("generationLibrary.useCount", { count: numberFormatter.format(asset.useCount) })}
          </span>
          {asset.lastUsedAt && (
            <span>
              {t("generationLibrary.lastUsedAt", {
                date: dateFormatter.format(new Date(asset.lastUsedAt)),
              })}
            </span>
          )}
          <span>
            {t("generationLibrary.updatedAt", {
              date: dateFormatter.format(new Date(asset.updatedAt)),
            })}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
