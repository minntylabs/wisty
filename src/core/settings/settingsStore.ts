import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";
import { Store } from "@tauri-apps/plugin-store";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  FontStyle,
  FormatViewMode,
  MAX_REMEMBERED_POSITIONS,
  RememberedPosition,
  ThemeMode
} from "./settingsTypes";

const SETTINGS_FILE = "settings.json";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const isThemeMode = (value: unknown): value is ThemeMode => value === "light" || value === "dark";

const isFontStyle = (value: unknown): value is FontStyle => value === "normal" || value === "italic" || value === "oblique";

const isFormatViewMode = (value: unknown): value is FormatViewMode => value === "formatted" || value === "plain";

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isRememberedPosition = (value: unknown): value is RememberedPosition => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<RememberedPosition>;
  return isPositiveInteger(candidate.topLine)
    && isPositiveInteger(candidate.cursorLine)
    && isPositiveInteger(candidate.cursorColumn);
};

const parseRememberedPositions = (value: unknown): Record<string, RememberedPosition> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([path, position]) => path.length > 0 && isRememberedPosition(position))
  ) as Record<string, RememberedPosition>;
};

/**
 * Re-inserts `filePath` last so plain object key order doubles as recency, then
 * drops the oldest entries once over the cap. File paths are never integer-like
 * keys, so insertion order is preserved.
 */
const withRememberedPosition = (
  positions: Record<string, RememberedPosition>,
  filePath: string,
  position: RememberedPosition
): Record<string, RememberedPosition> => {
  const entries = Object.entries(positions).filter(([path]) => path !== filePath);
  entries.push([filePath, position]);
  return Object.fromEntries(entries.slice(-MAX_REMEMBERED_POSITIONS));
};

type SettingKey = keyof AppSettings;

export const createSettingsStore = () => {
  const [state, setState] = createStore<AppSettings>({ ...DEFAULT_SETTINGS });
  const [ready, setReady] = createSignal(false);
  let backingStore: Store | null = null;

  /**
   * Keys changed before the store could accept them.
   *
   * Two things used to lose a setting silently. A write arriving before `load`
   * finished was dropped, and then overwritten by `load`'s own wholesale
   * `setState`. And a `load` that *failed* never set `ready` at all, so every
   * preference for the rest of the session was applied to the screen and thrown
   * away — the user told once, at startup, and never again.
   *
   * So a write that cannot be made is remembered instead of discarded, and
   * replayed from the live state once there is somewhere to put it.
   */
  const unsaved = new Set<SettingKey>();

  const saveSetting = async <K extends SettingKey>(key: K, value: AppSettings[K]) => {
    if (!ready() || !backingStore) {
      unsaved.add(key);
      return;
    }
    await backingStore.set(key, value);
    await backingStore.save();
  };

  /**
   * Writes out whatever was changed while the store was unavailable.
   *
   * From `state` rather than from what was queued: only the latest value of
   * each key matters, and that is what the app is already showing.
   */
  const flushUnsaved = async () => {
    if (unsaved.size === 0 || !backingStore) {
      return;
    }
    const keys = [...unsaved];
    unsaved.clear();
    for (const key of keys) {
      await backingStore.set(key, state[key]);
    }
    await backingStore.save();
  };

  const setThemeMode = async (themeMode: ThemeMode) => {
    setState({ themeMode });
    await saveSetting("themeMode", themeMode);
  };

  const setFontFamily = async (fontFamily: string) => {
    setState({ fontFamily });
    await saveSetting("fontFamily", fontFamily);
  };

  const setFontSize = async (fontSize: number) => {
    const next = clamp(Math.round(fontSize), 9, 40);
    setState({ fontSize: next });
    await saveSetting("fontSize", next);
  };

  const setFontStyle = async (fontStyle: FontStyle) => {
    setState({ fontStyle });
    await saveSetting("fontStyle", fontStyle);
  };

  const setFontWeight = async (fontWeight: number) => {
    const next = clamp(Math.round(fontWeight), 100, 900);
    setState({ fontWeight: next });
    await saveSetting("fontWeight", next);
  };

  const setTextWrapEnabled = async (enabled: boolean) => {
    setState({ textWrapEnabled: enabled });
    await saveSetting("textWrapEnabled", enabled);
  };

  const setActiveLineHighlightEnabled = async (enabled: boolean) => {
    setState({ activeLineHighlightEnabled: enabled });
    await saveSetting("activeLineHighlightEnabled", enabled);
  };

  const setMarkersVisible = async (markersVisible: boolean) => {
    setState({ markersVisible });
    await saveSetting("markersVisible", markersVisible);
  };

  const setFormatViewMode = async (formatViewMode: FormatViewMode) => {
    setState({ formatViewMode });
    await saveSetting("formatViewMode", formatViewMode);
  };

  const setStatusBarEnabled = async (enabled: boolean) => {
    setState({ statusBarEnabled: enabled });
    await saveSetting("statusBarEnabled", enabled);
  };

  const setSpellCheckEnabled = async (enabled: boolean) => {
    setState({ spellCheckEnabled: enabled });
    await saveSetting("spellCheckEnabled", enabled);
  };

  const setSpellCheckLanguage = async (language: string) => {
    setState({ spellCheckLanguage: language });
    await saveSetting("spellCheckLanguage", language);
  };

  const setLastDirectory = async (lastDirectory: string) => {
    setState({ lastDirectory });
    await saveSetting("lastDirectory", lastDirectory);
  };

  const addRecentFile = async (filePath: string) => {
    const filtered = state.recentFiles.filter((f) => f !== filePath);
    const next = [filePath, ...filtered].slice(0, 3);
    setState({ recentFiles: next });
    await saveSetting("recentFiles", next);
  };

  const setRecentFiles = async (recentFiles: string[]) => {
    const next = recentFiles.slice(0, 3);
    setState({ recentFiles: next });
    await saveSetting("recentFiles", next);
  };

  const removeRecentFile = async (filePath: string) => {
    const next = state.recentFiles.filter((f) => f !== filePath);
    if (next.length === state.recentFiles.length) {
      return;
    }
    setState({ recentFiles: next });
    await saveSetting("recentFiles", next);
  };

  const rememberPosition = async (filePath: string, position: RememberedPosition) => {
    if (!filePath) {
      return;
    }
    const next = withRememberedPosition(state.rememberedPositions, filePath, position);
    setState({ rememberedPositions: next });
    await saveSetting("rememberedPositions", next);
  };

  const forgetPosition = async (filePath: string) => {
    if (!(filePath in state.rememberedPositions)) {
      return;
    }
    const { [filePath]: _removed, ...next } = state.rememberedPositions;
    setState({ rememberedPositions: next });
    await saveSetting("rememberedPositions", next);
  };

  /** Follows a document to its new path on Save As, rather than orphaning the entry. */
  const moveRememberedPosition = async (fromPath: string, toPath: string) => {
    const position = state.rememberedPositions[fromPath];
    if (!position || fromPath === toPath) {
      return;
    }
    const { [fromPath]: _removed, ...rest } = state.rememberedPositions;
    const next = withRememberedPosition(rest, toPath, position);
    setState({ rememberedPositions: next });
    await saveSetting("rememberedPositions", next);
  };

  const setRememberedPositions = async (positions: Record<string, RememberedPosition>) => {
    setState({ rememberedPositions: positions });
    await saveSetting("rememberedPositions", positions);
  };

  const load = async () => {
    backingStore = await Store.load(SETTINGS_FILE);
    try {
      await readInto();
    } finally {
      // Ready as soon as there is somewhere to write, whether or not reading
      // worked. A settings file that could not be read is a reason to fall back
      // to defaults, not a reason to stop saving for the rest of the session.
      setReady(true);
      await flushUnsaved();
    }
  };

  const readInto = async () => {
    if (!backingStore) {
      return;
    }
    const loadedThemeMode = await backingStore.get("themeMode");
    const loadedFontFamily = await backingStore.get("fontFamily");
    const loadedFontSize = await backingStore.get("fontSize");
    const loadedFontStyle = await backingStore.get("fontStyle");
    const loadedFontWeight = await backingStore.get("fontWeight");
    const loadedTextWrapEnabled = await backingStore.get("textWrapEnabled");
    const loadedActiveLineHighlightEnabled = await backingStore.get("activeLineHighlightEnabled");
    const loadedFormatViewMode = await backingStore.get("formatViewMode");
    const loadedMarkersVisible = await backingStore.get("markersVisible");
    const loadedStatusBarEnabled = await backingStore.get("statusBarEnabled");
    const loadedSpellCheckEnabled = await backingStore.get("spellCheckEnabled");
    const loadedSpellCheckLanguage = await backingStore.get("spellCheckLanguage");
    const loadedLastDirectory = await backingStore.get("lastDirectory");
    const loadedRecentFiles = await backingStore.get("recentFiles");
    const loadedRememberedPositions = await backingStore.get("rememberedPositions");

    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

    const fromDisk: AppSettings = {
      themeMode: isThemeMode(loadedThemeMode) ? loadedThemeMode : (prefersDark ? "dark" : "light"),
      fontFamily: typeof loadedFontFamily === "string" && loadedFontFamily.trim().length > 0
        ? loadedFontFamily
        : DEFAULT_SETTINGS.fontFamily,
      fontSize: typeof loadedFontSize === "number" ? clamp(loadedFontSize, 9, 40) : DEFAULT_SETTINGS.fontSize,
      fontStyle: isFontStyle(loadedFontStyle) ? loadedFontStyle : DEFAULT_SETTINGS.fontStyle,
      fontWeight: typeof loadedFontWeight === "number" ? clamp(loadedFontWeight, 100, 900) : DEFAULT_SETTINGS.fontWeight,
      textWrapEnabled: typeof loadedTextWrapEnabled === "boolean" ? loadedTextWrapEnabled : DEFAULT_SETTINGS.textWrapEnabled,
      activeLineHighlightEnabled: typeof loadedActiveLineHighlightEnabled === "boolean"
        ? loadedActiveLineHighlightEnabled
        : DEFAULT_SETTINGS.activeLineHighlightEnabled,
      formatViewMode: isFormatViewMode(loadedFormatViewMode) ? loadedFormatViewMode : DEFAULT_SETTINGS.formatViewMode,
      markersVisible: typeof loadedMarkersVisible === "boolean"
        ? loadedMarkersVisible
        : DEFAULT_SETTINGS.markersVisible,
      statusBarEnabled: typeof loadedStatusBarEnabled === "boolean"
        ? loadedStatusBarEnabled
        : DEFAULT_SETTINGS.statusBarEnabled,
      spellCheckEnabled: typeof loadedSpellCheckEnabled === "boolean"
        ? loadedSpellCheckEnabled
        : DEFAULT_SETTINGS.spellCheckEnabled,
      spellCheckLanguage: typeof loadedSpellCheckLanguage === "string" && loadedSpellCheckLanguage.trim().length > 0
        ? loadedSpellCheckLanguage
        : DEFAULT_SETTINGS.spellCheckLanguage,
      lastDirectory: typeof loadedLastDirectory === "string" ? loadedLastDirectory : DEFAULT_SETTINGS.lastDirectory,
      recentFiles: Array.isArray(loadedRecentFiles) && loadedRecentFiles.every((f) => typeof f === "string")
        ? (loadedRecentFiles as string[]).slice(0, 3)
        : DEFAULT_SETTINGS.recentFiles,
      rememberedPositions: parseRememberedPositions(loadedRememberedPositions)
    };

    // Anything changed while this was reading wins. The file is what was on
    // disk before the change, so applying it wholesale would undo, on screen,
    // something the user had already done.
    setState(
      Object.fromEntries(
        Object.entries(fromDisk).filter(([key]) => !unsaved.has(key as SettingKey))
      ) as Partial<AppSettings>
    );
  };

  return {
    state,
    ready,
    load,
    actions: {
      setThemeMode,
      setFontFamily,
      setFontSize,
      setFontStyle,
      setFontWeight,
      setTextWrapEnabled,
      setActiveLineHighlightEnabled,
      setFormatViewMode,
      setMarkersVisible,
      setStatusBarEnabled,
      setSpellCheckEnabled,
      setSpellCheckLanguage,
      setLastDirectory,
      addRecentFile,
      setRecentFiles,
      removeRecentFile,
      rememberPosition,
      forgetPosition,
      moveRememberedPosition,
      setRememberedPositions
    }
  };
};
