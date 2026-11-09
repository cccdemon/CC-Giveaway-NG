<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { Action } from '#lib/action.svelte.js';
  import Button from '#lib/components/Button.svelte';
  import ChannelStatus from '#lib/components/ChannelStatus.svelte';
  import Confirm from '#lib/components/Confirm.svelte';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const action = new Action();
  let confirming = $state(false);

  const connectHref = '/api/auth/twitch/connect?return=%2Fchannel';
  const disconnect = () =>
    action.run(
      (api) => api.del('/api/me/channel'),
      async () => {
        confirming = false;
        await Promise.all([invalidate('api:me'), invalidate('api:channel')]);
      },
    );
</script>

<svelte:head><title>{L.nav.channel} · {L.brand}</title></svelte:head>

<section class="stack">
  <span class="lbl">{data.me.displayName}</span>
  <h1>{L.nav.channel}</h1>
  <p>{S.channel.intro}</p>
</section>

<section class="panel">
  <div class="panel-body">
    <ChannelStatus v={data.channel} name={data.me.displayName} />
    {#if !data.channel.connected}
      <p>{S.channel.notConnected}</p>
    {/if}
    <span class="hint">{S.channel.coverageHint}</span>
    <div class="scopes">
      <span class="lbl">{L.columns.scopes}</span>
      <ul>
        <li>{L.channel.scopeFollowers} <code>moderator:read:followers</code></li>
        <li>{L.channel.scopeChatters} <code>moderator:read:chatters</code></li>
        <li>{L.channel.scopeBot} <code>channel:bot</code></li>
      </ul>
    </div>
    <div class="row">
      <a class="btn btn-primary" href={connectHref}>{data.channel.connected ? L.actions.reconnect : L.actions.connect}</a>
      {#if data.channel.connected}
        <Button kind="ghost" onclick={() => (confirming = true)}>{L.actions.disconnect}</Button>
      {/if}
      {#if action.error}<span class="error" role="alert">{action.error}</span>{/if}
    </div>
    {#if confirming}
      <Confirm title={L.actions.disconnect} text={S.channel.disconnectConfirm} confirmLabel={L.actions.disconnect} danger busy={action.busy} onconfirm={disconnect} oncancel={() => (confirming = false)} />
    {/if}
  </div>
</section>

<style>
  ul {
    margin: 0;
    padding-left: 20px;
    font-size: 0.9375rem;
  }
  .scopes {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
</style>
