/**
 * ファイル拡張子から言語スタイル（配色・ラベル・SVG ロゴ）を導出する（webview 用）。
 *
 * 枠の配色をノード種別ではなく拡張子別にし、各枠左上に言語ロゴを表示するために使う。
 * `vscode` 非依存・純関数。SVG は外部取得せずインライン文字列として同梱する。
 *
 * SVG ロゴは各言語ブランドカラーの簡易マーク（公式ロゴの簡略表現）。`viewBox="0 0 24 24"` に
 * 統一し、呼び出し側で span の innerHTML に挿入してサイズ指定する。
 */

export interface LanguageStyle {
  /** 言語識別子（例 "python"）。 */
  id: string;
  /** 凡例・ツールチップ用の表示名。 */
  label: string;
  /** ブランドカラー（枠 border / バッジ背景）。 */
  color: string;
  /** インライン SVG ロゴ（簡易）。`width`/`height` は呼び出し側で指定。 */
  iconSvg: string;
}

const PYTHON: LanguageStyle = {
  id: "python",
  label: "Python",
  color: "#3776AB",
  // 2 つの絡み合うブロック（Python ロゴの簡略表現）。
  iconSvg:
    '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">' +
    '<path fill="#3776AB" d="M11.9 2c-2 0-3.6.3-3.6 2.4v1.7h3.7v.5H5.6C3.5 6.6 2.6 8 2.6 10.6c0 2.6.8 4 2.9 4h1.3v-2c0-2.1 1.8-3.9 3.9-3.9h3.7c1.7 0 3-1.4 3-3.1V4.4C17.4 2.4 15.8 2 13.8 2h-1.9zM9.8 3.3c.4 0 .7.3.7.7s-.3.7-.7.7-.7-.3-.7-.7.3-.7.7-.7z"/>' +
    '<path fill="#FFD43B" d="M12.1 22c2 0 3.6-.3 3.6-2.4v-1.7H12v-.5h6.4c2.1 0 3-1.4 3-4s-.9-4-3-4h-1.3v2c0 2.1-1.8 3.9-3.9 3.9H9.5c-1.7 0-3 1.4-3 3.1v2.6C6.6 21.6 8.2 22 10.2 22h1.9zM14.2 20.7c-.4 0-.7-.3-.7-.7s.3-.7.7-.7.7.3.7.7-.3.7-.7.7z"/>' +
    "</svg>",
};

const TYPESCRIPT: LanguageStyle = {
  id: "typescript",
  label: "TypeScript",
  color: "#3178C6",
  iconSvg:
    '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">' +
    '<rect width="24" height="24" rx="3" fill="#3178C6"/>' +
    '<path fill="#fff" d="M13.1 11.9v-1.6h-6v1.6h2v6h2v-6h2zM14 17.1c.5.3 1.2.5 2 .5 1.7 0 2.9-.9 2.9-2.4 0-1.2-.7-1.8-2-2.3-.9-.3-1.2-.5-1.2-.9 0-.3.3-.5.8-.5.6 0 1.2.2 1.7.5l.5-1.4c-.6-.3-1.3-.4-2.1-.4-1.6 0-2.7.9-2.7 2.3 0 1.2.8 1.8 2 2.2.9.3 1.1.5 1.1.9 0 .4-.3.6-.9.6-.7 0-1.4-.2-2-.6V17.1z"/>' +
    "</svg>",
};

const VUE: LanguageStyle = {
  id: "vue",
  label: "Vue",
  color: "#41B883",
  iconSvg:
    '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">' +
    '<path fill="#41B883" d="M2 3.5h4.2L12 13l5.8-9.5H22L12 20.5z"/>' +
    '<path fill="#35495E" d="M6.2 3.5h3.3L12 7.6l2.5-4.1h3.3L12 13z"/>' +
    "</svg>",
};

const JAVASCRIPT: LanguageStyle = {
  id: "javascript",
  label: "JavaScript",
  color: "#F7DF1E",
  iconSvg:
    '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">' +
    '<rect width="24" height="24" rx="3" fill="#F7DF1E"/>' +
    '<path fill="#1f1f1f" d="M7.6 18.5l1.5-.9c.3.5.6.9 1.2.9.6 0 .9-.2.9-1.1V11h1.9v6.4c0 1.9-1.1 2.8-2.7 2.8-1.5 0-2.3-.8-2.8-1.7zM14.1 18.3l1.5-.9c.4.6.9 1.1 1.8 1.1.7 0 1.2-.4 1.2-.9 0-.6-.5-.8-1.3-1.2l-.4-.2c-1.3-.6-2.2-1.2-2.2-2.7 0-1.3 1-2.3 2.6-2.3 1.1 0 2 .4 2.5 1.4l-1.4.9c-.3-.5-.6-.7-1.1-.7-.5 0-.8.3-.8.7 0 .5.3.7 1.1 1l.4.2c1.5.6 2.4 1.2 2.4 2.8 0 1.6-1.2 2.4-2.9 2.4-1.6 0-2.7-.8-3.2-1.8z"/>' +
    "</svg>",
};

const UNKNOWN: LanguageStyle = {
  id: "unknown",
  label: "その他",
  color: "#9d9d9d",
  iconSvg:
    '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">' +
    '<rect width="24" height="24" rx="3" fill="#6e6e6e"/>' +
    '<path fill="#fff" d="M11 16h2v2h-2zm1-9c-1.7 0-3 1.3-3 3h2c0-.6.4-1 1-1s1 .4 1 1c0 .5-.3.8-.8 1.2-.7.5-1.2 1.1-1.2 2.1v.4h2v-.3c0-.6.3-.9.9-1.4.6-.5 1.1-1.1 1.1-2 0-1.7-1.3-3-3-3z"/>' +
    "</svg>",
};

/** 拡張子（小文字, ドット無し）→ 言語スタイル。 */
const BY_EXT: Record<string, LanguageStyle> = {
  py: PYTHON,
  ts: TYPESCRIPT,
  tsx: TYPESCRIPT,
  mts: TYPESCRIPT,
  cts: TYPESCRIPT,
  vue: VUE,
  js: JAVASCRIPT,
  mjs: JAVASCRIPT,
  cjs: JAVASCRIPT,
  jsx: JAVASCRIPT,
};

/** 凡例表示順（重複言語は1回のみ）。 */
export const LEGEND_LANGUAGES: LanguageStyle[] = [PYTHON, TYPESCRIPT, VUE, JAVASCRIPT];

/** パス末尾の拡張子を小文字で返す（拡張子なしは空文字）。 */
function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * ファイルパスから言語スタイルを返す。未知拡張子・未指定は `UNKNOWN`。
 *
 * @param path 相対/絶対いずれのファイルパスでも可（拡張子のみ使用）。
 */
export function languageStyleForPath(path: string | undefined): LanguageStyle {
  if (!path) return UNKNOWN;
  return BY_EXT[extOf(path)] ?? UNKNOWN;
}
