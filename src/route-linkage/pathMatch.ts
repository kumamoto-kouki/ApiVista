/**
 * URLパス正規化・判定(design.md「System Flow: パスマッチング判定」、Req2.1-2.3)。
 *
 * backend は名前付きプレースホルダ `{name}`、frontend は匿名プレースホルダ `{}` で
 * 動的セグメントを表現する(両抽出器の `models.ts` 参照)。`canonicalize` はこの表記差を
 * 吸収し、パラメータ名に依存しない単一のワイルドカードセグメント `"{}"` へ畳む。
 *
 * `matchKind` は exact 優先 + リテラル必須ガードで過剰連携(over-matching)を防ぐ:
 * - exact: 全長一致かつ全セグメントが `segEq` で整合
 * - suffix: 短い方が長い方の末尾に `segEq` で整合し、かつ重なり区間に
 *   少なくとも1つのリテラル(非 `"{}"`)同値一致を含む場合のみ成立。
 *   純ワイルドカード同士の末尾一致だけでは suffix にしない(over-matching対策)。
 * - それ以外は null。method 判定は持たない(`methodEquals` が別途担う)。
 */
import type { MatchKind } from "./models.js";

/** セグメント全体が `{...}` で囲まれているかを動的セグメントの判定基準とする。 */
const DYNAMIC_SEGMENT_PATTERN = /^\{.*\}$/;

/**
 * パスを `/` で分割し、空セグメントを除去したうえで動的セグメントを `"{}"` に畳む。
 *
 * 空セグメント除去により、先頭/末尾スラッシュ・連続スラッシュの差異が自然に吸収される。
 */
export function canonicalize(path: string): string[] {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => (DYNAMIC_SEGMENT_PATTERN.test(segment) ? "{}" : segment));
}

/** HTTPメソッドの大文字小文字を区別せず比較する(防御的に正規化して比較)。 */
export function methodEquals(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/** 動的セグメントはパラメータ名非依存のワイルドカードとして等価に扱う。 */
function segEq(x: string, y: string): boolean {
  return x === y || x === "{}" || y === "{}";
}

/**
 * 正準化済みセグメント配列から一致種別を判定する(`matchKind` の本体)。
 *
 * `matchRoutes` のように同じパスを多数回照合する呼び出し元は、`canonicalize` を
 * 事前に1回だけ実行して本関数へ渡すことで、N×M 回の再正準化を回避できる。
 *
 * 全長一致なら exact、長さが異なる場合のみ末尾一致(リテラル必須ガード付き)で
 * suffix を判定する。同長で不一致の場合は null(suffix は非対称な末尾関係のため
 * 同長ケースに適用しない)。
 */
export function matchKindSegs(routeSegs: string[], apiSegs: string[]): MatchKind | null {
  if (routeSegs.length === apiSegs.length) {
    return routeSegs.every((seg, i) => segEq(seg, apiSegs[i])) ? "exact" : null;
  }

  const [shorter, longer] =
    routeSegs.length < apiSegs.length ? [routeSegs, apiSegs] : [apiSegs, routeSegs];
  if (shorter.length === 0) {
    return null;
  }

  const offset = longer.length - shorter.length;
  let hasLiteralMatch = false;
  for (let i = 0; i < shorter.length; i++) {
    const shorterSeg = shorter[i];
    const longerSeg = longer[offset + i];
    if (!segEq(shorterSeg, longerSeg)) {
      return null;
    }
    if (shorterSeg !== "{}" && longerSeg !== "{}") {
      hasLiteralMatch = true;
    }
  }

  return hasLiteralMatch ? "suffix" : null;
}

/**
 * `routePath`(backend)と `apiUrlPattern`(frontend)の一致種別を判定する。
 *
 * 両パスを `canonicalize` してから `matchKindSegs` に委譲する薄いラッパ。
 * 単発照合や既存の公開APIとして利用する。
 */
export function matchKind(routePath: string, apiUrlPattern: string): MatchKind | null {
  return matchKindSegs(canonicalize(routePath), canonicalize(apiUrlPattern));
}
