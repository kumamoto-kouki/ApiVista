/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Core } from "cytoscape";
import {
  attachRenderScheduler,
  detachRenderScheduler,
  registerFrameUpdater,
  unregisterFrameUpdater,
} from "../renderScheduler.js";

/** `cy.on/off` を捕捉し、登録された `render pan zoom resize` ハンドラを手動発火できる最小モック。 */
function makeCyMock(): { cy: Core; fire: () => void; offCalls: number } {
  let handler: (() => void) | undefined;
  let offCalls = 0;
  const cy = {
    on: (_events: string, fn: () => void) => {
      handler = fn;
    },
    off: () => {
      offCalls += 1;
      handler = undefined;
    },
  } as unknown as Core;
  return {
    cy,
    fire: () => handler?.(),
    get offCalls() {
      return offCalls;
    },
  } as { cy: Core; fire: () => void; offCalls: number };
}

describe("renderScheduler", () => {
  let rafCallbacks: Array<() => void>;

  beforeEach(() => {
    rafCallbacks = [];
    // rAF をキューに積むだけのスタブにして、flush を明示制御する。
    vi.stubGlobal("requestAnimationFrame", (cb: () => void): number => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
      rafCallbacks[id - 1] = () => {};
    });
  });

  afterEach(() => {
    detachRenderScheduler();
    vi.unstubAllGlobals();
  });

  /** 予約済みの rAF をすべて実行する。 */
  function flushFrame(): void {
    const pending = rafCallbacks;
    rafCallbacks = [];
    for (const cb of pending) cb();
  }

  it("複数の render イベントを 1 フレーム 1 回に集約する（coalescing）", () => {
    const { cy, fire } = makeCyMock();
    const updater = vi.fn();
    attachRenderScheduler(cy);
    registerFrameUpdater(updater);

    // 1 フレーム内に render イベントが複数回来ても rAF は 1 つだけ予約される。
    fire();
    fire();
    fire();
    expect(updater).not.toHaveBeenCalled(); // フレーム実行までは走らない

    flushFrame();
    expect(updater).toHaveBeenCalledTimes(1);

    // 次フレーム: 再びイベント → もう一度だけ実行。
    fire();
    flushFrame();
    expect(updater).toHaveBeenCalledTimes(2);
  });

  it("登録した複数 updater を 1 フレームでまとめて実行する", () => {
    const { cy, fire } = makeCyMock();
    const a = vi.fn();
    const b = vi.fn();
    attachRenderScheduler(cy);
    registerFrameUpdater(a);
    registerFrameUpdater(b);

    fire();
    flushFrame();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("unregisterFrameUpdater で解除した updater は呼ばれない", () => {
    const { cy, fire } = makeCyMock();
    const a = vi.fn();
    attachRenderScheduler(cy);
    registerFrameUpdater(a);
    unregisterFrameUpdater(a);

    fire();
    flushFrame();
    expect(a).not.toHaveBeenCalled();
  });

  it("detach 後は保留フレームが発火しても updater を呼ばない（cy 破棄後の安全性）", () => {
    const { cy, fire } = makeCyMock();
    const a = vi.fn();
    attachRenderScheduler(cy);
    registerFrameUpdater(a);

    fire(); // rAF を予約
    detachRenderScheduler(cy); // 破棄: updater クリア＋rAF キャンセル

    flushFrame(); // 取りこぼした rAF が万一発火しても
    expect(a).not.toHaveBeenCalled(); // no-op
  });
});
