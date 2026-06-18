<!--
  Fixture: dynamic URL segment normalization via template literal.

  Verifies:
  - Req 1.3 / astUtils.normalizeUrlTemplate: `$fetch(`/api/users/${id}`)` keeps
    the static skeleton and normalizes the dynamic segment to a placeholder,
    producing urlPattern `/api/users/{}`.
  - Req 1.4: the `$fetch` call sits inside the named function `loadUser`, so its
    enclosingFunctionId is `loadUser` (NOT the component node), exercising
    nearest-enclosing-definition attribution.
-->
<script setup lang="ts">
const route = { params: { id: '1' } }

async function loadUser() {
  const id = route.params.id
  // Template literal -> normalized urlPattern "/api/users/{}"
  const user = await $fetch(`/api/users/${id}`)
  return user
}

loadUser()
</script>

<template>
  <div>user detail</div>
</template>
