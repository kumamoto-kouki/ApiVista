function resolveCssVar(varName: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(varName).trim();
  return value === "" ? fallback : value;
}

export function buildTheme() {
  return {
    route: resolveCssVar("--vscode-charts-blue", "#3794ff"),
    apiCall: resolveCssVar("--vscode-charts-green", "#89d185"),
    file: resolveCssVar("--vscode-charts-purple", "#c586c0"),
    function: resolveCssVar("--vscode-charts-yellow", "#d7ba7d"),
    unmatched: resolveCssVar("--vscode-charts-red", "#f14c4c"),
    edge: resolveCssVar("--vscode-editorLineNumber-foreground", "#8a8a8a"),
    edgeHi: resolveCssVar("--vscode-foreground", "#e8e8e8"),
    cardBg: resolveCssVar("--vscode-editorWidget-background", "#252526"),
    border: resolveCssVar("--vscode-widget-border", "#2b2b2b"),
    selected: resolveCssVar("--vscode-focusBorder", "#0078d4"),
    text: resolveCssVar("--vscode-foreground", "#cccccc"),
    textSub: resolveCssVar("--vscode-descriptionForeground", "#9d9d9d"),
  };
}

export type Theme = ReturnType<typeof buildTheme>;
