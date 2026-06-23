/**
 * languageStyle.ts の単体テスト。拡張子→言語スタイル（色/ラベル/SVG）の対応を検証する。
 */
import { describe, expect, it } from "vitest";

import { languageStyleForPath, LEGEND_LANGUAGES } from "../languageStyle.js";

describe("languageStyleForPath", () => {
  it(".py を Python として返す", () => {
    const s = languageStyleForPath("backend/routers/posts.py");
    expect(s.id).toBe("python");
    expect(s.label).toBe("Python");
    expect(s.color).toBe("#306998");
    expect(s.iconSvg).toContain("<svg");
  });

  it(".ts / .tsx を TypeScript として返す", () => {
    expect(languageStyleForPath("composables/usePosts.ts").id).toBe("typescript");
    expect(languageStyleForPath("components/Foo.tsx").id).toBe("typescript");
  });

  it(".vue を Vue として返す", () => {
    expect(languageStyleForPath("pages/index.vue").id).toBe("vue");
  });

  it(".js / .mjs / .jsx を JavaScript として返す", () => {
    expect(languageStyleForPath("a.js").id).toBe("javascript");
    expect(languageStyleForPath("a.mjs").id).toBe("javascript");
    expect(languageStyleForPath("a.jsx").id).toBe("javascript");
  });

  it("未知拡張子・未指定・拡張子なしは unknown を返す", () => {
    expect(languageStyleForPath("a.rb").id).toBe("unknown");
    expect(languageStyleForPath("Makefile").id).toBe("unknown");
    expect(languageStyleForPath(undefined).id).toBe("unknown");
    expect(languageStyleForPath("").id).toBe("unknown");
  });

  it("大文字拡張子も判定する", () => {
    expect(languageStyleForPath("A.PY").id).toBe("python");
  });

  it("LEGEND_LANGUAGES は主要4言語を含む", () => {
    expect(LEGEND_LANGUAGES.map((l) => l.id)).toEqual([
      "python",
      "typescript",
      "vue",
      "javascript",
    ]);
  });
});
