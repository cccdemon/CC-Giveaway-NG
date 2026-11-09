<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { Action as Cmd } from '#lib/action.svelte.js';
  import type { GiveawaySettings, HistoryEntry, TeamDetail, WinnerStatus } from '#lib/api/types.js';
  import ActionBar from '#lib/components/ActionBar.svelte';
  import BoostForm from '#lib/components/BoostForm.svelte';
  import Confirm from '#lib/components/Confirm.svelte';
  import CorrectionForm from '#lib/components/CorrectionForm.svelte';
  import DrawPanel from '#lib/components/DrawPanel.svelte';
  import History from '#lib/components/History.svelte';
  import Panel from '#lib/components/Panel.svelte';
  import Participants from '#lib/components/Participants.svelte';
  import SettingsPanel from '#lib/components/SettingsPanel.svelte';
  import StateBadge from '#lib/components/StateBadge.svelte';
  import StatusBlock from '#lib/components/StatusBlock.svelte';
  import { dateTime } from '#lib/format.js';
  import { watchStreams } from '#lib/live.js';
  import { actionsOf, activityOf, type Action } from '#lib/status.js';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const detail = $derived(data.detail);
  const base = $derived(`/api/giveaways/${detail.id}`);
  const dep = $derived(`api:stream:giveaway:${detail.id}`);

  const cmd = new Cmd();
  const panelCmd = new Cmd();
  const drawCmd = new Cmd();
  const revertCmd = new Cmd();
  let busy = $state<Action | null>(null);
  let panel = $state<'boost' | 'correct' | 'settings' | null>(null);
  let reverting = $state<HistoryEntry | null>(null);
  /** Zählt das Öffnen des Einstellungs-Panels: das Formular lebt, bis die Person es schließt, nicht bis zum nächsten Live-Ereignis. */
  let settingsOpened = $state(0);
  let channelOptions = $state<{ pid: string; displayName: string }[] | null>(null);
  const teamCmd = new Cmd();

  const view = $derived(actionsOf({ status: detail.status, boost: detail.boost, kernel: detail.kernel, winners: detail.winners }));
  const kernelLabels = $derived(Object.fromEntries(detail.kernel.commands.map((c) => [c.type, c.label])));
  const drawing = $derived(busy === 'draw' ? 'draw' : drawCmd.busy ? 'redraw' : null);
  const activity = $derived(activityOf(detail.status, drawing));
  const lastAt = $derived(data.history.entries[0]?.at ?? null);
  const channelLine = $derived(detail.channels.length === 1 ? L.channel.one : L.channel.count(detail.channels.length));
  const refresh = () => invalidate(dep);

  $effect(() => watchStreams([`giveaway:${detail.id}`]));

  async function onaction(a: Action) {
    if (a === 'boost' || a === 'correct' || a === 'settings') {
      panel = panel === a ? null : a;
      panelCmd.reset();
      if (panel === 'settings') {
        settingsOpened += 1;
        if (channelOptions === null) await loadChannelOptions();
      }
      return;
    }
    busy = a;
    if (a === 'stopBoost') await cmd.run((api) => api.del(`${base}/boost`), refresh);
    else if (a.startsWith('kernel:')) await cmd.run((api) => api.post(`${base}/kernel-commands`, { type: a.slice('kernel:'.length), args: {} }), refresh);
    else await cmd.run((api) => api.post(`${base}/${a}`), refresh);
    busy = null;
  }
  /** Solo-Team: der eigene Kanal. Sonst die Mitglieder des Teams, einmal je Seite. */
  async function loadChannelOptions() {
    if (detail.teamId === data.me.soloTeamId) {
      channelOptions = [{ pid: data.me.pid, displayName: data.me.displayName }];
      return;
    }
    const team = await teamCmd.run((api) => api.get<TeamDetail>(`/api/teams/${detail.teamId}`));
    channelOptions = team?.members ?? [];
  }
  const closePanel = async () => {
    panel = null;
    await refresh();
  };
  const startBoost = (b: { factor: number; durationSec: number }) => panelCmd.run((api) => api.post(`${base}/boost`, b), closePanel);
  const correct = (c: { channel: string; pid: string; sec: number; reason: string }) => panelCmd.run((api) => api.post(`${base}/corrections`, c), closePanel);
  const saveSettings = (settings: Partial<GiveawaySettings>) => panelCmd.run((api) => api.put(`${base}/settings`, { settings }), closePanel);
  const setWinnerStatus = (pid: string, status: WinnerStatus) => drawCmd.run((api) => api.put(`${base}/winners/${pid}`, { status }), refresh);
  const redraw = (pid: string, reason: string) => drawCmd.run((api) => api.post(`${base}/redraw`, { replace: pid, reason }), refresh);
  const revert = (reason?: string) => {
    const e = reverting;
    reverting = null;
    if (!e) return;
    void revertCmd.run((api) => api.post(`${base}/revert`, { eventId: e.id, reason }), refresh);
  };
</script>

<svelte:head><title>{detail.settings.prize} · {L.brand}</title></svelte:head>

<section class="row between head">
  <div class="stack tight">
    <span class="lbl">{detail.kernel.label}{#if detail.kernel.display.beta} · {L.beta}{/if} · {channelLine}</span>
    <h1>{detail.settings.prize}</h1>
    <span class="hint">
      {#if detail.settings.sponsor}{L.fields.sponsor}: {detail.settings.sponsor} · {/if}
      {#if detail.settings.keyword}{L.detail.keyword} <code>{detail.settings.keyword}</code> · {/if}
      {#if detail.closedAt}{L.status.closed} {dateTime(detail.closedAt)}{/if}
    </span>
  </div>
  <StateBadge status={detail.status} />
</section>

<StatusBlock {detail} {activity} busy={drawing !== null} updatedAt={lastAt} />

{#each detail.channels.filter((c) => c.warning) as ch (ch.pid)}
  <Panel tone={ch.warning!.level === 'rot' ? 'error' : ch.warning!.level === 'gelb' ? 'warn' : 'info'} alert>
    <span><strong>{ch.displayName}:</strong> {ch.warning!.text} {ch.pid === data.me.pid ? S.detail.reconnectOwn : S.detail.reconnectOther(ch.displayName)}</span>
    {#if ch.pid === data.me.pid}
      <a class="btn" href="/api/auth/twitch/connect?return={encodeURIComponent(`/giveaways/${detail.id}`)}">{L.actions.reconnect}</a>
    {/if}
  </Panel>
{/each}

{#if detail.boost}
  <Panel tone="info" alert>
    <span>{L.detail.boostActive(detail.boost.factor)} {L.detail.until} {dateTime(detail.boost.until)}.</span>
  </Panel>
{/if}
{#if detail.purgedAt}
  <p class="hint">{S.detail.purged(dateTime(detail.purgedAt))}</p>
{/if}

<ActionBar {view} {kernelLabels} {busy} error={cmd.error} {onaction} />

{#if panel === 'boost'}
  <BoostForm busy={panelCmd.busy} error={panelCmd.error} onstart={startBoost} oncancel={() => (panel = null)} />
{:else if panel === 'correct'}
  <CorrectionForm channels={detail.channels} rows={data.participants} busy={panelCmd.busy} error={panelCmd.error} onsubmit={correct} oncancel={() => (panel = null)} />
{:else if panel === 'settings'}
  {#key settingsOpened}
    <SettingsPanel settings={detail.settings} kernel={detail.kernel} channelOptions={channelOptions ?? []} busy={panelCmd.busy} error={panelCmd.error ?? teamCmd.error} onsave={saveSettings} oncancel={() => (panel = null)} />
  {/key}
{/if}

<DrawPanel {detail} rows={data.participants} busy={drawCmd.busy} error={drawCmd.error} onwinnerstatus={setWinnerStatus} onredraw={redraw} />

<div class="cols">
  <Participants rows={data.participants} unit={detail.kernel.display.unit} />

  <section class="stack" aria-label={L.columns.history}>
    <h2>{L.columns.history}</h2>
    {#if reverting}
      <Confirm title={L.actions.revert} text={S.confirm.revert} reason confirmLabel={L.actions.revert} busy={revertCmd.busy} onconfirm={revert} oncancel={() => (reverting = null)} />
    {/if}
    {#if revertCmd.error}<p class="error" role="alert">{revertCmd.error}</p>{/if}
    <History entries={data.history.entries} names={data.history.names} onrevert={(e) => (reverting = e)} />
    <a href="/giveaways/{detail.id}/history">{L.actions.fullHistory}</a>
  </section>
</div>

<style>
  .head {
    justify-content: space-between;
    align-items: flex-end;
  }
  .tight {
    gap: 6px;
  }
  .cols {
    display: flex;
    flex-wrap: wrap;
    gap: 28px;
    align-items: flex-start;
  }
  .cols > :global(:first-child) {
    flex: 999 1 560px;
    min-width: 0;
  }
  .cols > :global(:last-child) {
    flex: 1 1 360px;
    min-width: 0;
  }
</style>
