<!--
  Fixture: nested-directory component for Nuxt auto-import naming (Issue 2).

  Verifies:
  - design fileMap.componentIndex: a component at `components/base/Button.vue`
    must be indexed as `BaseButton` (directory prefix `base` + file `Button`,
    PascalCase). This is the resolution target for `<BaseButton/>` referenced
    in components/UserList.vue.
  - No API calls / no children: pure leaf component node `BaseButton`.
-->
<script setup lang="ts">
defineProps<{ label: string }>()
</script>

<template>
  <button>{{ label }}</button>
</template>
