<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { ApiError, apiOf } from '#lib/api/client.js';
  import PortalCard from '#lib/components/PortalCard.svelte';
  import { watchStreams } from '#lib/live.js';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const running = $derived(data.tiles.filter((t) => t.status === 'open' || t.status === 'paused' || t.status === 'closed'));
  const past = $derived(data.tiles.filter((t) => t.status === 'drawn' || t.status === 'completed' || t.status === 'cancelled'));
  let busy = $state<string | null>(null);
  let errors = $state<Record<string, string>>({});
  const api = apiOf((...a) => globalThis.fetch(...a));

  $effect(() => watchStreams(data.tiles.map((t) => `giveaway:${t.id}`)));

  async function act(id: string, what: 'register' | 'withdraw') {
    busy = id;
    errors = { ...errors, [id]: '' };
    try {
      await api.post(`/api/portal/giveaways/${id}/${what}`);
      await invalidate('api:portal');
    } catch (e) {
      errors = { ...errors, [id]: e instanceof ApiError ? e.message : S.serverError };
    } finally {
      busy = null;
    }
  }
</script>

<svelte:head><title>{L.portal.title} · {L.brand}</title></svelte:head>

<section class="stack tight">
  <span class="lbl">{data.me.displayName}</span>
  <h1>{L.portal.title}</h1>
</section>

<section class="stack" aria-label={L.portal.running}>
  <h2>{L.portal.running}</h2>
  {#if running.length === 0}
    <p class="hint">{S.portal.noParticipations}</p>
  {:else}
    <div class="grid">
      {#each running as tile (tile.id)}
        <PortalCard {tile} busy={busy === tile.id} error={errors[tile.id] || null} onjoin={() => act(tile.id, 'register')} onwithdraw={() => act(tile.id, 'withdraw')} />
      {/each}
    </div>
  {/if}
</section>

{#if past.length > 0}
  <section class="stack" aria-label={L.portal.past}>
    <h2>{L.portal.past}</h2>
    <div class="grid">
      {#each past as tile (tile.id)}
        <PortalCard {tile} busy={false} error={null} onjoin={() => undefined} onwithdraw={() => undefined} />
      {/each}
    </div>
  </section>
{/if}

<section class="panel" aria-label={L.portal.data}>
  <div class="panel-body">
    <span class="lbl">{L.portal.data}</span>
    <span>{S.portal.dataIntro}</span>
    <a class="btn" href="/portal/data">{L.actions.viewData}</a>
  </div>
</section>

<style>
  .tight {
    gap: 6px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
    gap: 18px;
  }
  .panel .btn {
    align-self: flex-start;
  }
</style>
