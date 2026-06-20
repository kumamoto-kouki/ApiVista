// Fixture: auto-import composable with several axios call shapes.
//
// Verifies:
// - Req 1.1/1.2: `axios.get` / `axios.post` attribute-call shapes -> methods
//   GET / POST extracted from the call name.
// - Req 1.3: template-literal dynamic URL `/api/users/${userId}` ->
//   normalized urlPattern `/api/users/{}`.
// - Req 1.5 (unrecognized client): `customClient.fetchData(...)` is NOT a
//   recognized pattern ($fetch/useFetch/axios) and MUST NOT be extracted.
// - Req 4.2 (fully dynamic URL): `axios.get(buildUrl())` has a URL skeleton
//   that is itself dynamic (function result), cannot be pattern-normalized ->
//   excluded from results + warning recorded.
// - Req 2.1 auto-import: `fetchUsers` is referenced by components/UserList.vue
//   with no explicit import (resolved via exportIndex).

import axios from "axios";

// Stand-in for an unrelated, non-recognized HTTP client (Req 1.5).
const customClient = {
  fetchData(_url: string): Promise<unknown> {
    return Promise.resolve(null);
  },
};

function buildUrl(): string {
  return "/api/" + Math.random().toString();
}

// axios.get -> GET, literal URL "/api/users".
export function fetchUsers(): Promise<unknown> {
  return axios.get("/api/users");
}

// axios.post -> POST, literal URL "/api/users".
export function createUser(name: string): Promise<unknown> {
  return axios.post("/api/users", { name });
}

// Template-literal dynamic segment -> "/api/users/{}".
export function fetchUser(userId: string): Promise<unknown> {
  return axios.get(`/api/users/${userId}`);
}

// Fully dynamic URL skeleton (Req 4.2): excluded + warning.
export function fetchDynamic(): Promise<unknown> {
  return axios.get(buildUrl());
}

// Unrecognized client call (Req 1.5): must NOT be extracted as an API call.
export function fetchViaCustom(): Promise<unknown> {
  return customClient.fetchData("/api/custom");
}
