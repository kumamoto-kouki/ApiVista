import { describe, expect, it } from "vitest";

import { makeFileId, makeFunctionId } from "../ids.js";

describe("makeFunctionId", () => {
  it("joins module path and qualname with a colon", () => {
    expect(makeFunctionId("composables/useUserApi", "fetchUsers")).toBe(
      "composables/useUserApi:fetchUsers",
    );
  });

  it("preserves nested qualnames", () => {
    expect(makeFunctionId("composables/useUserApi", "useUserApi.fetchUsers")).toBe(
      "composables/useUserApi:useUserApi.fetchUsers",
    );
  });

  it("preserves component-node qualnames (PascalCase component name)", () => {
    expect(makeFunctionId("pages/users", "Users")).toBe("pages/users:Users");
  });

  it("is deterministic for the same input", () => {
    const a = makeFunctionId("composables/useUserApi", "fetchUsers");
    const b = makeFunctionId("composables/useUserApi", "fetchUsers");
    expect(a).toBe(b);
  });
});

describe("makeFileId", () => {
  it("returns a POSIX path relative to frontendRoot", () => {
    expect(makeFileId("/x/frontend", "/x/frontend/composables/useUserApi.ts")).toBe(
      "composables/useUserApi.ts",
    );
  });

  it("returns the bare filename for a file directly under frontendRoot", () => {
    expect(makeFileId("/x/frontend", "/x/frontend/app.vue")).toBe("app.vue");
  });

  it("produces POSIX forward slashes for nested files", () => {
    expect(makeFileId("/x/frontend", "/x/frontend/components/base/Button.vue")).toBe(
      "components/base/Button.vue",
    );
    expect(makeFileId("/x/frontend", "/x/frontend/components/base/Button.vue")).not.toContain("\\");
  });

  it("is deterministic for the same input", () => {
    const a = makeFileId("/x/frontend", "/x/frontend/pages/users.vue");
    const b = makeFileId("/x/frontend", "/x/frontend/pages/users.vue");
    expect(a).toBe(b);
  });
});
