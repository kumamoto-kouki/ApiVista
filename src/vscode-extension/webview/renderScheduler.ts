import type { Core } from "cytoscape";

/**
 * Cytoscape の `render pan zoom resize` イベントを 1 本だけ購読し、登録済みの更新関数(カード位置・
 * ゾーン・SVG 線・ミニマップ)を **requestAnimationFrame でフレーム単位にコアレッシング**して実行する。
 *
 * 従来は各描画モジュールが個別に `cy.on("render pan zoom resize", …)` を登録していたため、1 フレーム内で
 * 複数の render イベントが発火するたびに 5 系統の更新が重複実行され、パン/ズームがカクついていた。
 * 本スケジューラに集約することで、1 フレームあたり最大 1 回・登録順に一括実行する。
 *
 * 安定性: `cy.destroy()` 後に遅延 rAF が発火しても、`detach` で updater をクリア＋rAF をキャンセルするため
 * no-op になる。フレーム実行時も `cy` の有効性を確認してから呼ぶ。
 */

/** rAF 相当(Webview は browser、非対応環境は ~60fps の setTimeout フォールバック)。 */
const requestFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === "function"
    ? (cb): number => requestAnimationFrame(cb)
    : (cb): number => setTimeout(cb, 16) as unknown as number;

const cancelFrame: (id: number) => void =
  typeof cancelAnimationFrame === "function"
    ? (id): void => cancelAnimationFrame(id)
    : (id): void => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);

const updaters = new Set<() => void>();
let attachedCy: Core | undefined;
let pendingFrameId: number | undefined;

/** フレーム本体: 予約を解除し、cy が生きていれば登録 updater を登録順に 1 回ずつ実行する。 */
function runFrame(): void {
  pendingFrameId = undefined;
  if (!attachedCy) return;
  for (const fn of updaters) fn();
}

/** render イベント受信時: フレーム未予約なら rAF を 1 つ予約する(予約済みなら無視＝コアレッシング)。 */
function scheduleFrame(): void {
  if (pendingFrameId !== undefined) return;
  pendingFrameId = requestFrame(runFrame);
}

/** 毎フレーム実行したい更新関数を登録する。 */
export function registerFrameUpdater(fn: () => void): void {
  updaters.add(fn);
}

/** 登録済みの更新関数を解除する。 */
export function unregisterFrameUpdater(fn: () => void): void {
  updaters.delete(fn);
}

/** Cytoscape の描画イベントをスケジューラへ接続する(cy 生成直後に 1 回)。 */
export function attachRenderScheduler(cy: Core): void {
  attachedCy = cy;
  cy.on("render pan zoom resize", scheduleFrame);
}

/** スケジューラを切り離し、登録 updater をクリア＋保留中フレームをキャンセルする(cy 破棄時)。 */
export function detachRenderScheduler(cy?: Core): void {
  (cy ?? attachedCy)?.off("render pan zoom resize", scheduleFrame);
  attachedCy = undefined;
  updaters.clear();
  if (pendingFrameId !== undefined) {
    cancelFrame(pendingFrameId);
    pendingFrameId = undefined;
  }
}
