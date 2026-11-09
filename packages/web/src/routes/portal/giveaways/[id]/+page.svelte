<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { Action } from '#lib/action.svelte.js';
  import type { GateResult } from '#lib/api/types.js';
  import Button from '#lib/components/Button.svelte';
  import GateList from '#lib/components/GateList.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import LegalLinks from '#lib/components/LegalLinks.svelte';
  import StateBadge from '#lib/components/StateBadge.svelte';
  import TicketForm from '#lib/components/TicketForm.svelte';
  import ViewerLines from '#lib/components/ViewerLines.svelte';
  import { date, percent } from '#lib/format.js';
  import { watchStreams } from '#lib/live.js';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const d = $derived(data.detail);
  const base = $derived(`/api/portal/giveaways/${d.id}`);
  const dep = $derived(`api:stream:giveaway:${d.id}`);
  const join = new Action();
  const gatesCheck = new Action();
  const ticketCmd = new Action();
  let liveResult = $state<GateResult | null>(null);
  const result = $derived(liveResult ?? d.lastGateResult);
  const participantCommands = $derived(d.kernel.commands.filter((c) => c.issuer === 'participant'));
  const refresh = () => invalidate(dep);
  const running = $derived(d.status === 'open' || d.status === 'paused' || d.status === 'closed');

  $effect(() => watchStreams([`giveaway:${d.id}`]));

  const register = () => join.run((api) => api.post(`${base}/register`), refresh);
  const withdraw = () => join.run((api) => api.post(`${base}/withdraw`), refresh);
  const checkGates = () =>
    gatesCheck.run(
      (api) => api.get<GateResult>(`${base}/gates`),
      (r) => {
        liveResult = r;
      },
    );
  const buy = (type: string, count: number) => ticketCmd.run((api) => api.post(`${base}/kernel-commands`, { type, args: { count } }), refresh);
</script>

<svelte:head><title>{d.prize} · {L.brand}</title></svelte:head>

<section class="stack tight">
  <a href="/portal" class="hint">{L.portal.title}</a>
  <div class="row between">
    <span class="lbl">{d.kernel.label} · {d.channels.map((c) => c.displayName).join(', ')}</span>
    <StateBadge status={d.status} size="sm" />
  </div>
  <h1>{d.prize}</h1>
  {#if d.sponsor}<span class="hint">{L.fields.sponsor}: {d.sponsor}</span>{/if}
</section>

<div class="cols">
  <section class="card stack">
    {#if d.winner}
      <div class="line tone-ok"><Icon name="star" stroke={2.5} /><span>{S.portal.won}</span></div>
      <span>{S.portal.claim(date(d.winner.claimDeadline))}</span>
      <span>{d.winner.contact ? S.portal.contact(d.winner.contact) : S.portal.noContact}</span>
      <span class="hint">{L.detail.winnerStatus}: {L.winner[d.winner.status]}</span>
    {:else if d.status === 'cancelled'}
      <div class="line tone-muted"><Icon name="x" /><span>{S.portal.cancelled}</span></div>
    {:else if d.status === 'drawn' || d.status === 'completed'}
      <div class="line tone-muted"><Icon name="circle" /><span>{S.portal.notWon}</span></div>
    {:else if d.view.inPool}
      <div class="line tone-ok"><Icon name="check" stroke={2.5} /><span>{S.portal.inPool}</span></div>
    {:else if d.registered}
      <div class="line"><Icon name="circle" /><span>{S.portal.registered}</span></div>
    {:else}
      <div class="line"><Icon name="dot" /><span>{S.portal.notRegistered}</span></div>
    {/if}

    {#if running && d.view.inPool}
      <div class="chance">
        <span class="lbl">{L.columns.myChance}</span>
        <span class="display big">{percent(d.chance)}</span>
        <span class="hint">{S.chanceHint}</span>
      </div>
    {/if}

    {#if d.status === 'open'}
      <div class="row">
        {#if d.registered}
          <Button busy={join.busy} onclick={withdraw}>{L.actions.withdraw}</Button>
        {:else}
          <Button kind="primary" busy={join.busy} onclick={register}>{L.actions.join}</Button>
        {/if}
        {#if join.error}<span class="error" role="alert">{join.error}</span>{/if}
      </div>
      {#if !d.registered && d.keyword}<span class="hint">{S.portal.keywordHint(d.keyword)}</span>{/if}
    {:else if d.status === 'paused'}
      <span class="hint">{S.portal.paused}</span>
    {:else if d.status === 'closed'}
      <span class="hint">{S.portal.closed}</span>
    {/if}

    {#if d.status === 'open' && d.registered}
      {#each participantCommands as c (c.type)}
        <TicketForm command={c} busy={ticketCmd.busy} error={ticketCmd.error} onsubmit={(n) => buy(c.type, n)} />
      {/each}
    {/if}
  </section>

  <section class="card stack">
    <ViewerLines lines={d.view.lines} title={L.columns.myTime} />
    <div class="stack">
      <span class="lbl">{L.columns.gates}</span>
      <GateList gates={d.gates} channels={d.channels} {result} />
      {#if running && d.gates.length > 0}
        <div class="row">
          <Button kind="ghost" busy={gatesCheck.busy} onclick={checkGates}>{L.actions.checkGates}</Button>
          {#if gatesCheck.error}<span class="error" role="alert">{gatesCheck.error}</span>{/if}
          {#if liveResult}<span class={liveResult.ok ? 'tone-ok' : 'tone-warn'}>{liveResult.ok ? S.portal.gatesOk : S.portal.gatesMissing}</span>{/if}
        </div>
      {/if}
    </div>
    <div class="stack">
      <span class="lbl">{L.legal.title}</span>
      <LegalLinks legal={d.legal} />
    </div>
  </section>
</div>

<style>
  .tight {
    gap: 6px;
  }
  .between {
    justify-content: space-between;
  }
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr));
    gap: 20px;
    align-items: start;
  }
  .card {
    border: 1px solid var(--border);
    padding: 18px;
    gap: 14px;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }
  .chance {
    border-top: 1px solid var(--border);
    padding-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .big {
    font-size: 2.125rem;
    line-height: 1.15;
  }
</style>
