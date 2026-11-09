<script lang="ts">
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const loginHref = $derived(`/api/auth/twitch/login?return=${encodeURIComponent(data.ret ?? '/giveaways')}`);
</script>

<section class="start">
  <span class="lbl">{L.brand}</span>
  <h1>{S.startTitle}</h1>
  <a class="btn btn-primary" href={loginHref}>{L.actions.login}</a>
  <p>{S.startForStreamers}</p>
  <p>{S.startForViewers}</p>
</section>

<style>
  .start {
    max-width: 640px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding-top: 24px;
  }
  .start .btn {
    align-self: flex-start;
  }
</style>
