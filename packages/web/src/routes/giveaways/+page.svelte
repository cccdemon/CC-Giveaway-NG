<script lang="ts">
  import ChannelStatus from '#lib/components/ChannelStatus.svelte';
  import Tile from '#lib/components/Tile.svelte';
  import { watchStreams } from '#lib/live.js';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const running = $derived(data.tiles.filter((t) => t.status === 'draft' || t.status === 'open' || t.status === 'paused' || t.status === 'closed'));
  const finished = $derived(data.tiles.filter((t) => t.status === 'drawn' || t.status === 'completed'));
  const cancelled = $derived(data.tiles.filter((t) => t.status === 'cancelled'));
  const teamLine = $derived(data.teams.teams.length === 0 ? L.solo : data.teams.teams.length === 1 ? L.team.one : L.team.count(data.teams.teams.length));
  const needsReconnect = $derived(!data.channel.connected || data.channel.warning !== null);

  $effect(() => watchStreams(data.tiles.map((t) => `giveaway:${t.id}`)));
</script>

<svelte:head><title>{L.nav.overview} · {L.brand}</title></svelte:head>

<section class="row between">
  <div class="stack tight">
    <span class="lbl">{data.me?.displayName} · {teamLine}</span>
    <h1>{L.nav.overview}</h1>
  </div>
  <a class="btn btn-primary" href="/giveaways/new">{L.actions.start}</a>
</section>

<section class="panel" aria-label={L.columns.connection}>
  <div class="panel-body">
    <span class="lbl">{L.columns.connection}</span>
    <ChannelStatus v={data.channel} name={data.me?.displayName} compact />
    {#if data.channel.warning}<span class="tone-warn">{data.channel.warning.text}</span>{/if}
    {#if needsReconnect}
      <a class="link" href="/api/auth/twitch/connect?return=%2Fgiveaways">{data.channel.connected ? L.actions.reconnect : L.actions.connect}</a>
    {/if}
  </div>
</section>

<section class="stack" aria-label={L.columns.running}>
  <h2>{L.columns.running}</h2>
  {#if running.length === 0}
    <p class="hint">{S.overview.noGiveaways}</p>
  {:else}
    <div class="grid">
      {#each running as tile (tile.id)}
        <Tile {tile} />
      {/each}
    </div>
  {/if}
</section>

{#if finished.length > 0}
  <section class="stack" aria-label={L.columns.finished}>
    <h2>{L.columns.finished}</h2>
    <span class="hint">{S.overview.finishedHint}</span>
    <div class="grid">
      {#each finished as tile (tile.id)}
        <Tile {tile} />
      {/each}
    </div>
  </section>
{/if}

{#if cancelled.length > 0}
  <section class="stack" aria-label={L.columns.cancelled}>
    <h2>{L.columns.cancelled}</h2>
    <div class="grid">
      {#each cancelled as tile (tile.id)}
        <Tile {tile} />
      {/each}
    </div>
  </section>
{/if}

<style>
  .between {
    justify-content: space-between;
    align-items: flex-end;
  }
  .tight {
    gap: 6px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr));
    gap: 20px;
  }
  .link {
    font-size: 0.875rem;
    align-self: flex-start;
  }
</style>
