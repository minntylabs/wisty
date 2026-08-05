export type ThemeMode = "light" | "dark";

export type FontStyle = "normal" | "italic" | "oblique";

/** Live rendering mode for Markdown-style formatting. */
export type FormatViewMode = "formatted" | "plain";

export const FONT_PRESETS = {
  sans: "Noto Sans, Liberation Sans, sans-serif",
  serif: "Noto Serif, Liberation Serif, serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace"
} as const;

/**
 * Where the user was in a file, stored as line/column rather than pixel offsets
 * or absolute positions. Pixels are invalidated by any change of font, window
 * size or wrapping; line and column survive all of those, and degrade gracefully
 * to a clamp when the file has been edited elsewhere since.
 */
export type RememberedPosition = {
  topLine: number;
  cursorLine: number;
  cursorColumn: number;
};

/**
 * How many files may have a remembered position. Entries are opt-in, so this is
 * only a backstop against unbounded growth — eviction is least-recently-touched.
 */
export const MAX_REMEMBERED_POSITIONS = 200;

export type AppSettings = {
  themeMode: ThemeMode;
  fontFamily: string;
  fontSize: number;
  fontStyle: FontStyle;
  fontWeight: number;
  textWrapEnabled: boolean;
  activeLineHighlightEnabled: boolean;
  formatViewMode: FormatViewMode;
  /**
   * Whether time markers show as speaker icons in transcript containers.
   *
   * Only affects .tsf documents, which are the only ones that have markers.
   * A preference rather than a mode: a transcript being read wants them out
   * of the way, one being corrected wants them to hand, and that changes
   * several times in a sitting.
   */
  markersVisible: boolean;
  statusBarEnabled: boolean;
  spellCheckEnabled: boolean;
  spellCheckLanguage: string;
  lastDirectory: string;
  recentFiles: string[];
  /**
   * Keyed by absolute file path. Presence is the opt-in: a file is restored on
   * open precisely when it has an entry here, so there is no separate flag to
   * keep in sync and nothing is ever restored that the user did not ask for.
   */
  rememberedPositions: Record<string, RememberedPosition>;
};

export const DEFAULT_SETTINGS: AppSettings = {
  themeMode: "light",
  fontFamily: FONT_PRESETS.mono,
  fontSize: 14,
  fontStyle: "normal",
  fontWeight: 400,
  textWrapEnabled: true,
  activeLineHighlightEnabled: false,
  formatViewMode: "plain",
  markersVisible: true,
  statusBarEnabled: true,
  spellCheckEnabled: false,
  spellCheckLanguage: "en_US",
  lastDirectory: "",
  recentFiles: [],
  rememberedPositions: {}
};
