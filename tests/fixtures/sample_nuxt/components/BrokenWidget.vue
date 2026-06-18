<!--
  Fixture: intentionally invalid SFC (unterminated `<script setup>` block).

  Verifies Req 4.1 on the SFC path: `@vue/compiler-sfc` parse / ts-morph
  diagnostics detect the error, sfc.extractSfc returns `script = null`, the file
  is skipped at Pass0 with a recorded warning, and other files still analyze.
  Never referenced by other fixtures.

  This file is OUTSIDE tsconfig include, so it does not break the tsc build.
-->
<script setup lang="ts">
const broken = useFetch('/api/broken'
