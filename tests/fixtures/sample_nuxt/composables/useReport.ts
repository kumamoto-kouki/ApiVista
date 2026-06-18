// Fixture: explicit imports using Nuxt path aliases `~/` and `@/`.
//
// Verifies:
// - design resolveSpecifierToFileId: `~/` and `@/` alias specifiers resolve to
//   frontendRoot-relative fileIds (explicit-import resolution path), as opposed
//   to the auto-import name-index path used by useUserApi.ts.
// - The resolved callee `fetchUsers` (from `~/composables/useUserApi`) and
//   `createUser` (from `@/composables/useUserApi`) produce `buildReport` ->
//   `fetchUsers` / `createUser` edges via explicit-import resolution.

import { fetchUsers } from "~/composables/useUserApi";
import { createUser } from "@/composables/useUserApi";

export async function buildReport(): Promise<unknown> {
  const users = await fetchUsers();
  await createUser("reporter");
  return users;
}
