<!--
  Fixture: component that calls an auto-imported composable and renders a
  nested-directory child component.

  Verifies:
  - Req 2.1 / auto-import name index: `fetchUsers` comes from
    composables/useUserApi.ts with NO explicit import statement (Nuxt
    auto-import). callGraph must resolve it via exportIndex -> the composable's
    FunctionNode, producing `UserList` -> `fetchUsers` edge.
  - Req 2.1 (component edge, Nuxt directory-prefix naming, Issue 2): template
    uses `<BaseButton/>`, which resolves to components/base/Button.vue whose
    componentIndex key is `BaseButton` (directory prefix `base` + file `Button`).
  - Component node `UserList` (single node per .vue).
-->
<script setup lang="ts">
// `fetchUsers` is auto-imported (no import line) -> resolved via exportIndex.
async function loadUsers() {
  const list = await fetchUsers()
  return list
}

loadUsers()
</script>

<template>
  <div>
    <ul></ul>
    <!-- Nested-directory component: components/base/Button.vue -> BaseButton -->
    <BaseButton label="reload" />
  </div>
</template>
