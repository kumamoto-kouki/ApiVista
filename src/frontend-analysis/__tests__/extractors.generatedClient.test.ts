import { Project, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";

import { extractGeneratedClientApiCalls } from "../extractors/generatedClient.js";
import type { ApiCallCandidate } from "../extractors/apiCalls.js";

/** 単発の in-memory ts-morph SourceFile を作るヘルパ（.ts 経路 = segments 恒等）。 */
const scratch = new Project({ useInMemoryFileSystem: true });
function makeSource(fileId: string, code: string): SourceFile {
  return scratch.createSourceFile(`scratch/${fileId}`, code, { overwrite: true });
}

function byUrl(calls: ApiCallCandidate[], url: string): ApiCallCandidate | undefined {
  return calls.find((c) => c.urlPattern === url);
}

describe("extractGeneratedClientApiCalls — openapi-generator (typescript-axios) パターン", () => {
  it("ParamCreator メソッドの localVarPath + method リテラルから endpoint を抽出する", () => {
    // openapi-generator が生成する典型形（パスパラメータは .replace で差し込む）。
    const sf = makeSource(
      "libs/client/apis/devices-api.ts",
      [
        "export const DevicesApiAxiosParamCreator = function (configuration) {",
        "  return {",
        "    deviceSearch: async (options = {}) => {",
        "      const localVarPath = `/v1/devices/`;",
        "      const localVarRequestOptions = { method: 'GET', ...options };",
        "      return { url: localVarPath, options: localVarRequestOptions };",
        "    },",
        "    deviceShow: async (deviceId, options = {}) => {",
        "      const localVarPath = `/v1/devices/{device_id}`",
        '        .replace(`{${"device_id"}}`, encodeURIComponent(String(deviceId)));',
        "      const localVarRequestOptions = { method: 'GET', ...options };",
        "      return { url: localVarPath, options: localVarRequestOptions };",
        "    },",
        "    deviceStore: async (body, options = {}) => {",
        "      const localVarPath = `/v1/devices/`;",
        "      const localVarRequestOptions = { method: 'POST', ...options };",
        "      return { url: localVarPath, options: localVarRequestOptions };",
        "    },",
        "  };",
        "};",
      ].join("\n"),
    );

    const calls = extractGeneratedClientApiCalls(sf, "libs/client/apis/devices-api.ts", []);

    // 3 オペレーション。GET /v1/devices/ は search と store(POST) で path 共有なので件数で確認。
    expect(calls).toHaveLength(3);

    const show = byUrl(calls, "/v1/devices/{device_id}");
    expect(show?.method).toBe("GET");

    const store = calls.find((c) => c.method === "POST" && c.urlPattern === "/v1/devices/");
    expect(store).toBeDefined();

    const search = calls.find((c) => c.method === "GET" && c.urlPattern === "/v1/devices/");
    expect(search).toBeDefined();
  });

  it("localVarPath が無いファイル（手書きコンポーネント等）では何も抽出しない", () => {
    const sf = makeSource(
      "pages/index.vue.ts",
      ["const x = 1;", 'function f() { return fetch("/whatever"); }'].join("\n"),
    );
    expect(extractGeneratedClientApiCalls(sf, "pages/index.vue.ts", [])).toEqual([]);
  });

  it("method リテラルが無い場合は既定 GET", () => {
    const sf = makeSource(
      "libs/client/apis/x-api.ts",
      [
        "const f = () => {",
        "  const localVarPath = `/v1/things/`;",
        "  return localVarPath;",
        "};",
      ].join("\n"),
    );
    const calls = extractGeneratedClientApiCalls(sf, "libs/client/apis/x-api.ts", []);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.urlPattern).toBe("/v1/things/");
  });

  it("骨格が動的（変数）な localVarPath は除外する", () => {
    const sf = makeSource(
      "libs/client/apis/y-api.ts",
      [
        "const f = (base) => {",
        "  const localVarPath = base + '/v1/things/';",
        "  const localVarRequestOptions = { method: 'GET' };",
        "  return localVarPath;",
        "};",
      ].join("\n"),
    );
    expect(extractGeneratedClientApiCalls(sf, "libs/client/apis/y-api.ts", [])).toEqual([]);
  });
});
