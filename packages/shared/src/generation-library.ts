export type CharacterSource = "danbooru" | "original";
export type CharacterRelation = "representation" | "favorite";
export type AssetSafety = "safe" | "nsfw";
export type PromptAssetType = "artist_string" | "style" | "outfit" | "trait" | "composition";

/** Identity comes from the authenticated transport, never from model arguments. */
export interface GenerationLibraryActor {
  botId: string;
  source: "panel" | "telegram";
  telegramUserId?: number;
  isAdmin: boolean;
}

export interface CharacterInput {
  name: string;
  aliases: string[];
  appearance: string;
  defaultOutfit: string;
  notes: string;
  copyright?: string;
  ownerTelegramId?: number;
}

export interface LibraryCharacter extends CharacterInput {
  id: number;
  botId: string;
  source: CharacterSource;
  canonicalTag: string | null;
  postCount: number | null;
  wikiSummary: string | null;
  sourceUrl: string | null;
  sourceFetchedAt: string | null;
  queryCount: number;
  firstQueriedAt: string | null;
  lastQueriedAt: string | null;
  createdAt: string;
  updatedAt: string;
  bindingCount: number;
}

export interface DanbooruCharacterResult {
  tag: string;
  label: string;
  matchedAlias?: string;
  postCount?: number;
  otherNames: string[];
  wikiSummary?: string;
  postsUrl: string;
}

export interface CharacterBinding {
  characterId: number;
  relation: CharacterRelation;
  isDefault: boolean;
  character: LibraryCharacter;
}

export interface PromptAssetInput {
  name: string;
  type: PromptAssetType;
  content: string;
  notes: string;
  safety: AssetSafety;
  pinned: boolean;
}

export interface PromptAsset extends PromptAssetInput {
  id: number;
  botId: string;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationLibrarySettings {
  charactersEnabled: boolean;
  assetsEnabled: boolean;
  injectionEnabled: boolean;
  nsfwEnabled: boolean;
}

export const DEFAULT_GENERATION_LIBRARY_SETTINGS: GenerationLibrarySettings = {
  charactersEnabled: true,
  assetsEnabled: true,
  injectionEnabled: false,
  nsfwEnabled: false,
};

export interface LibraryListQuery {
  search?: string;
  page?: number;
  limit?: number;
  source?: CharacterSource;
  type?: PromptAssetType;
  safety?: AssetSafety;
  sort?: "frequency" | "recent";
}
export interface LibraryPage<T> {
  data: T[];
  total: number;
}

export interface GenerationMaterialSelection {
  characterIds?: number[];
  /** Only for an explicit request to depict this person. */
  personTelegramId?: number;
  assetIds?: number[];
  excludedAssetIds?: number[];
  skipPinned?: boolean;
  /** Omit stored default clothing when the user requests a different outfit. */
  skipDefaultOutfit?: boolean;
  safetyMode?: AssetSafety;
  /** Explicitly bypass the library if it is unavailable. */
  skipLibrary?: boolean;
}

export interface GenerationMaterialSnapshot {
  originalPrompt: string;
  safetyMode: AssetSafety;
  characters: Array<{ id: number; name: string; content: string; version: string }>;
  assets: Array<{ id: number; name: string; content: string; version: string }>;
}

export interface GenerationLibraryPort {
  getSettings(actor: GenerationLibraryActor): Promise<GenerationLibrarySettings>;
  updateSettings(
    actor: GenerationLibraryActor,
    input: GenerationLibrarySettings,
  ): Promise<GenerationLibrarySettings>;
  listCharacters(
    actor: GenerationLibraryActor,
    query?: LibraryListQuery,
    countQuery?: boolean,
  ): Promise<LibraryPage<LibraryCharacter>>;
  saveCharacter(
    actor: GenerationLibraryActor,
    input: CharacterInput,
    id?: number,
  ): Promise<LibraryCharacter>;
  deleteCharacter(actor: GenerationLibraryActor, id: number): Promise<void>;
  recordDanbooru(
    actor: GenerationLibraryActor,
    results: DanbooruCharacterResult[],
    fetchedAt: Date,
  ): Promise<void>;
  getBindings(actor: GenerationLibraryActor, telegramId: number): Promise<CharacterBinding[]>;
  setBinding(
    actor: GenerationLibraryActor,
    telegramId: number,
    input: { characterId: number; relation: CharacterRelation; isDefault: boolean },
  ): Promise<void>;
  removeBinding(
    actor: GenerationLibraryActor,
    telegramId: number,
    characterId: number,
    relation: CharacterRelation,
  ): Promise<void>;
  listAssets(
    actor: GenerationLibraryActor,
    query?: LibraryListQuery,
  ): Promise<LibraryPage<PromptAsset>>;
  saveAsset(
    actor: GenerationLibraryActor,
    input: PromptAssetInput,
    id?: number,
  ): Promise<PromptAsset>;
  deleteAsset(actor: GenerationLibraryActor, id: number): Promise<void>;
  resolveMaterials(
    actor: GenerationLibraryActor,
    prompt: string,
    selection: GenerationMaterialSelection,
  ): Promise<{ prompt: string; snapshot: GenerationMaterialSnapshot }>;
}
export type GenerationLibraryErrorCode =
  | "invalid_input"
  | "forbidden"
  | "not_found"
  | "privacy_denied"
  | "characters_disabled"
  | "assets_disabled"
  | "nsfw_disabled"
  | "no_default_character"
  | "too_many_selections"
  | "prompt_too_long";

export class GenerationLibraryError extends Error {
  constructor(
    readonly code: GenerationLibraryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GenerationLibraryError";
  }
}
