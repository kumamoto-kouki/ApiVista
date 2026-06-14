import { describe, expect, it } from "vitest";

import type { AnalysisOutput } from "../models.js";
import { SCHEMA_VERSION } from "../models.js";

describe("models", () => {
  it("pins SCHEMA_VERSION to 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("type-checks a constructed AnalysisOutput literal", () => {
    const output: AnalysisOutput = {
      schemaVersion: SCHEMA_VERSION,
      routes: [
        {
          method: "GET",
          path: "/api/items/{item_id}",
          handler: { file: "routers/items.py", line: 10 },
          entryFunctionId: "sample_app.routers.items:get_item",
          schemaRefs: [
            {
              className: "ItemResponse",
              location: { file: "routers/items.py", line: 3 },
              role: "response",
            },
          ],
        },
      ],
      functions: [
        {
          id: "sample_app.routers.items:get_item",
          name: "get_item",
          file: "routers/items.py",
          location: { file: "routers/items.py", line: 10 },
          calls: ["sample_app.routers.items:format_item_label"],
        },
      ],
      files: [{ id: "routers/items.py", path: "routers/items.py", dependsOn: [] }],
      warnings: [{ target: "routers/broken.py", reason: "syntax error" }],
    };

    expect(output.schemaVersion).toBe(1);
    expect(output.routes[0]?.schemaRefs[0]?.role).toBe("response");
  });
});
