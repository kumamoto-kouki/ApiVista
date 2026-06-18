<!--
  Fixture: `<script>` + `<script setup>` co-existing (Issue 1, line mapping).

  Verifies:
  - design sfc.extractSfc: when both a classic `<script>` block and a
    `<script setup>` block exist, the extracted content is concatenated while
    each block contributes a distinct `segment` (combined-script line range ->
    original .vue start line). A single startLine offset would misreport the
    line of calls in the SECOND block, so this exercises per-segment mapping.
  - Req 3.3: the `useFetch` in the `<script setup>` block (lower in the file)
    must map back to its real .vue line via its own segment.
  - Component node `LegacyWidget`.
-->
<script lang="ts">
// Classic script block (appears first). Defines a helper used below.
export function legacyHelper(): string {
  return 'legacy'
}
</script>

<script setup lang="ts">
// Setup block (appears second). Its line numbers must be corrected by its own
// segment, independent of the classic block's segment above.
const label = legacyHelper()
const { data: widget } = useFetch('/api/widgets')
</script>

<template>
  <div>{{ label }} {{ widget }}</div>
</template>
