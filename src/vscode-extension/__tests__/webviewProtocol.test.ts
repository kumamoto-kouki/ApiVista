import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../../route-linkage/models.js";
import type { LinkageOutput } from "../../route-linkage/models.js";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../webviewProtocol.js";

/** テスト用の最小限の `LinkageOutput`。連携データの内容自体は本タスクの検証対象ではない。 */
const SAMPLE_LINKAGE_OUTPUT: LinkageOutput = {
  schemaVersion: SCHEMA_VERSION,
  linkages: [],
  unmatchedRoutes: [],
  unmatchedApiCalls: [],
  functions: [],
  files: [],
  warnings: [],
};

/**
 * `WebviewToHostMessage` を `switch` で判別し、各分岐で正しいプロパティのみ
 * アクセス可能であることを実証するヘルパー（型の絞り込みの実証が目的）。
 */
function describeWebviewToHostMessage(message: WebviewToHostMessage): string {
  switch (message.type) {
    case "ready":
      // "ready" 分岐では payload プロパティは存在しない（型上アクセス不可）。
      return "ready";
    case "nodeClick":
      // "nodeClick" 分岐では payload.file / payload.line にアクセス可能。
      return `nodeClick:${message.payload.file}:${message.payload.line}`;
    case "copyLinked":
      // "copyLinked" 分岐では payload.file / payload.line / payload.side にアクセス可能。
      return `copyLinked:${message.payload.file}:${message.payload.line}:${message.payload.side}`;
  }
}

describe("webviewProtocol", () => {
  it("constructs a HostToWebviewMessage of type 'linkageData' carrying a LinkageOutput payload", () => {
    const message: HostToWebviewMessage = { type: "linkageData", payload: SAMPLE_LINKAGE_OUTPUT };

    expect(message.type).toBe("linkageData");
    expect(message.payload).toBe(SAMPLE_LINKAGE_OUTPUT);
    expect(message.payload.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("constructs a WebviewToHostMessage of type 'ready' with no payload", () => {
    const message: WebviewToHostMessage = { type: "ready" };

    expect(message.type).toBe("ready");
    expect("payload" in message).toBe(false);
  });

  it("constructs a WebviewToHostMessage of type 'nodeClick' carrying a file/line payload", () => {
    const message: WebviewToHostMessage = {
      type: "nodeClick",
      payload: { file: "backend/app/routes.py", line: 42 },
    };

    expect(message.type).toBe("nodeClick");
    expect(message.payload.file).toBe("backend/app/routes.py");
    expect(message.payload.line).toBe(42);
  });

  it("narrows to the 'ready' branch via discriminated-union switch", () => {
    const message: WebviewToHostMessage = { type: "ready" };

    expect(describeWebviewToHostMessage(message)).toBe("ready");
  });

  it("narrows to the 'nodeClick' branch via discriminated-union switch, exposing payload.file/line", () => {
    const message: WebviewToHostMessage = {
      type: "nodeClick",
      payload: { file: "frontend/src/api/users.ts", line: 7 },
    };

    expect(describeWebviewToHostMessage(message)).toBe("nodeClick:frontend/src/api/users.ts:7");
  });

  it("constructs a WebviewToHostMessage of type 'copyLinked' carrying a file/line/side payload", () => {
    const message: WebviewToHostMessage = {
      type: "copyLinked",
      payload: { file: "backend/routes/users.py", line: 10, side: "backend" },
    };

    expect(message.type).toBe("copyLinked");
    expect(message.payload.file).toBe("backend/routes/users.py");
    expect(message.payload.line).toBe(10);
    expect(message.payload.side).toBe("backend");
  });

  it("narrows to the 'copyLinked' branch via discriminated-union switch, exposing payload.side", () => {
    const message: WebviewToHostMessage = {
      type: "copyLinked",
      payload: { file: "frontend/api/users.ts", line: 5, side: "frontend" },
    };

    expect(describeWebviewToHostMessage(message)).toBe(
      "copyLinked:frontend/api/users.ts:5:frontend",
    );
  });
});
