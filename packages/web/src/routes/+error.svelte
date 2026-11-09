<script lang="ts">
  import { page } from '$app/state';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
</script>

<section class="stack">
  <span class="lbl">{S.errorTitle(page.status)}</span>
  <h1>{page.status === 404 ? S.notFound : (page.error?.message ?? S.serverError)}</h1>
  <a class="btn" href="/">{L.actions.toStart}</a>
</section>
