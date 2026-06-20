import { describe, expect, it } from "vitest";

import { canonicalize, matchKind, methodEquals } from "../pathMatch.js";

describe("canonicalize", () => {
  it("splits a literal-only path into segments", () => {
    expect(canonicalize("/api/users")).toEqual(["api", "users"]);
  });

  it("folds a backend-style named placeholder '{id}' to '{}'", () => {
    expect(canonicalize("/api/users/{id}")).toEqual(["api", "users", "{}"]);
  });

  it("folds a frontend-style anonymous placeholder '{}' to the same result", () => {
    expect(canonicalize("/api/users/{}")).toEqual(["api", "users", "{}"]);
  });

  it("folds multiple mixed dynamic segments", () => {
    expect(canonicalize("/api/{resource}/items/{}")).toEqual(["api", "{}", "items", "{}"]);
  });

  it("returns an empty array for an empty string", () => {
    expect(canonicalize("")).toEqual([]);
  });

  it("returns an empty array for the bare root '/'", () => {
    expect(canonicalize("/")).toEqual([]);
  });

  it("drops a trailing slash", () => {
    expect(canonicalize("/api/users/")).toEqual(["api", "users"]);
  });

  it("collapses consecutive slashes", () => {
    expect(canonicalize("/api//users")).toEqual(["api", "users"]);
  });

  it("works without a leading slash", () => {
    expect(canonicalize("api/users")).toEqual(["api", "users"]);
  });
});

describe("methodEquals", () => {
  it("returns true for identical uppercase methods", () => {
    expect(methodEquals("GET", "GET")).toBe(true);
  });

  it("returns false for different methods", () => {
    expect(methodEquals("GET", "POST")).toBe(false);
  });

  it("is case-insensitive ('GET' vs 'get')", () => {
    expect(methodEquals("GET", "get")).toBe(true);
  });

  it("returns true when both sides are lowercase and equal", () => {
    expect(methodEquals("post", "post")).toBe(true);
  });
});

describe("matchKind", () => {
  it("returns 'exact' when dynamic segment notations differ but otherwise match", () => {
    expect(matchKind("/api/users/{id}", "/api/users/{}")).toBe("exact");
  });

  it("returns 'exact' for a fully literal identical path", () => {
    expect(matchKind("/api/health", "/api/health")).toBe("exact");
  });

  it("returns 'exact' when both paths are the bare root", () => {
    expect(matchKind("/", "/")).toBe("exact");
  });

  it("returns 'suffix' when the api pattern is a literal tail of the route (baseURL diff)", () => {
    expect(matchKind("/api/users", "/users")).toBe("suffix");
  });

  it("returns 'suffix' when the route is a literal tail of the api pattern", () => {
    expect(matchKind("/users", "/api/users")).toBe("suffix");
  });

  it("returns 'suffix' for a tail match that includes a dynamic segment alongside a literal", () => {
    expect(matchKind("/api/items/{item_id}", "/items/{}")).toBe("suffix");
  });

  it("returns null for a pure-wildcard tail match (literal-required guard, single segment)", () => {
    expect(matchKind("/api/{id}", "/{}")).toBe(null);
  });

  it("returns null for a pure-wildcard tail match (literal-required guard, two segments)", () => {
    expect(matchKind("/api/{a}/{b}", "/{}/{}")).toBe(null);
  });

  it("returns null for entirely different literal paths", () => {
    expect(matchKind("/api/users", "/api/orders")).toBe(null);
  });

  it("returns null when the tail does not align despite differing lengths", () => {
    expect(matchKind("/api/users", "/api/orders/extra")).toBe(null);
  });

  it("returns null when one side is the bare root and the other is not", () => {
    expect(matchKind("/", "/api/users")).toBe(null);
  });
});
