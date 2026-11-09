<script lang="ts">
  import { invalidate } from '$app/navigation';
  import Button from '#lib/components/Button.svelte';
  import ChannelStatus from '#lib/components/ChannelStatus.svelte';
  import { dateTime, number, relative } from '#lib/format.js';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const ops = $derived(data.ops);
  let busy = $state(false);
  async function reload() {
    busy = true;
    await invalidate('api:admin:ops');
    busy = false;
  }
</script>

<svelte:head><title>{L.admin.ops} · {L.brand}</title></svelte:head>

<section class="row between">
  <h1>{L.admin.ops}</h1>
  <Button kind="primary" {busy} onclick={reload}>{L.actions.reload}</Button>
</section>

<section class="panel" aria-label={L.admin.health}>
  <div class="panel-body">
    <span class="lbl">{L.admin.health}</span>
    <span class="tone-ok">{S.admin.dbOk}</span>
    <span class="lbl">{L.admin.workers}</span>
    {#if ops.workers.length === 0}
      <span class="hint">{S.admin.noWorkers}</span>
    {:else}
      {#each ops.workers as w (w.worker)}
        <span>{L.admin.worker} {w.worker} · {L.channel.count(w.channels)} · {relative(w.lastUpdate)}</span>
      {/each}
    {/if}
    <span class="lbl">{L.nav.giveaways}</span>
    <span class="mono">
      {L.status.draft} {ops.giveaways.draft} · {L.status.open} {ops.giveaways.open} · {L.status.paused} {ops.giveaways.paused} · {L.status.closed} {ops.giveaways.closed} · {L.status.drawn} {ops.giveaways.drawn} · {L.status.completed} {ops.giveaways.completed} · {L.status.cancelled} {ops.giveaways.cancelled}
    </span>
  </div>
</section>

<section class="stack" aria-label={L.columns.channels}>
  <h2>{L.columns.channels}</h2>
  {#if ops.channels.length === 0}
    <span class="hint">{S.admin.noChannels}</span>
  {:else}
    <div class="list">
      {#each ops.channels as ch (ch.pid)}
        <div class="item"><ChannelStatus v={ch} name={ch.displayName} /></div>
      {/each}
    </div>
  {/if}
</section>

<section class="stack" aria-label={L.admin.denied}>
  <h2>{L.admin.denied}</h2>
  <span class="hint">{S.admin.deniedHint}</span>
  {#if ops.denied.length === 0}
    <span class="hint">{S.admin.noDenied}</span>
  {:else}
    <div class="table-wrap">
      <table>
        <thead><tr><th>{L.admin.action}</th><th>{L.columns.reason}</th><th class="num">{L.fields.count}</th><th>{L.admin.lastAt}</th></tr></thead>
        <tbody>
          {#each ops.denied as d (d.action + d.reason)}
            <tr><td class="mono">{d.action}</td><td class="mono">{d.reason}</td><td class="num">{number(d.count)}</td><td>{dateTime(d.lastAt)}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<section class="stack" aria-label={L.admin.browserErrors}>
  <h2>{L.admin.browserErrors}</h2>
  <span class="hint">{S.admin.browserErrorsHint}</span>
  {#if ops.browserErrors.length === 0}
    <span class="hint">{S.admin.noBrowserErrors}</span>
  {:else}
    <div class="table-wrap">
      <table>
        <thead><tr><th>{L.columns.at}</th><th>{L.admin.message}</th><th>URL</th></tr></thead>
        <tbody>
          {#each ops.browserErrors as e, i (i)}
            <tr><td>{dateTime(e.at)}</td><td class="mono wrap">{e.message}</td><td class="mono wrap">{e.url ?? '–'}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .between {
    justify-content: space-between;
    align-items: flex-end;
  }
  .list {
    border: 1px solid var(--border);
  }
  .item {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .item:last-child {
    border-bottom: none;
  }
  .wrap {
    overflow-wrap: anywhere;
  }
</style>
