<!--
  Fixture: page with a top-level `useFetch` directly under `<script setup>`.

  Verifies:
  - Req 1.1/1.2: `useFetch` recognized, default method GET (no method option).
  - Req 1.4 / design "component-node convention": the top-level `useFetch`
    call is NOT inside a named function, so its `enclosingFunctionId` must be
    THIS .vue's single component node (`Users`).
  - Req 2.1 (component edge): template references `<UserList/>`, producing a
    `Users` -> `UserList` directed edge via componentIndex resolution, which
    connects page -> component -> composable -> API reachability.
-->
<script setup lang="ts">
// Top-level call (not wrapped in a named function): belongs to component node `Users`.
const { data: users } = useFetch('/api/users')
</script>

<template>
  <div>
    <h1>Users</h1>
    <!-- PascalCase child reference, resolves to components/UserList.vue -->
    <UserList :users="users" />
  </div>
</template>
