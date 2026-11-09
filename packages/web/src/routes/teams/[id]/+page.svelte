<script lang="ts">
  import { goto, invalidate } from '$app/navigation';
  import { Action } from '#lib/action.svelte.js';
  import type { Invite } from '#lib/api/types.js';
  import Button from '#lib/components/Button.svelte';
  import Confirm from '#lib/components/Confirm.svelte';
  import { dateTime } from '#lib/format.js';
  import { watchStreams } from '#lib/live.js';
  import { maskName } from '#lib/mask.js';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const team = $derived(data.team);
  const action = new Action();
  let renaming = $state(false);
  let newName = $state('');
  let confirming = $state<'leave' | 'deactivate' | null>(null);
  let copied = $state(false);

  const origin = $derived(globalThis.location?.origin ?? '');
  const inviteUrl = (inviteId: string) => `${origin}/teams/join/${inviteId}`;
  const refresh = () => invalidate(`api:stream:team:${team.teamId}`);

  $effect(() => watchStreams([`team:${team.teamId}`]));

  const rename = () =>
    action.run(
      (api) => api.put(`/api/teams/${team.teamId}/name`, { name: newName.trim() }),
      async () => {
        renaming = false;
        await refresh();
      },
    );
  const invite = () => action.run((api) => api.post<Invite>(`/api/teams/${team.teamId}/invites`), refresh);
  const revoke = (inviteId: string) => action.run((api) => api.del(`/api/teams/${team.teamId}/invites/${inviteId}`), refresh);
  const unban = (pid: string) => action.run((api) => api.del(`/api/teams/${team.teamId}/bans/${pid}`), refresh);
  const leave = () =>
    action.run(
      (api) => api.post(`/api/teams/${team.teamId}/leave`),
      () => goto('/teams'),
    );
  const toggleActive = () =>
    action.run(
      (api) => api.post(`/api/teams/${team.teamId}/${team.active ? 'deactivate' : 'reactivate'}`),
      async () => {
        confirming = null;
        await refresh();
      },
    );
  async function copy(inviteId: string) {
    try {
      await navigator.clipboard.writeText(inviteUrl(inviteId));
      copied = true;
    } catch {
      copied = false;
    }
  }
</script>

<svelte:head><title>{team.name} · {L.brand}</title></svelte:head>

<section class="row between">
  <div class="stack tight">
    <span class="lbl">{L.nav.team} · {team.active ? L.team.active : L.team.inactive}</span>
    {#if renaming}
      <form class="row" onsubmit={(e) => { e.preventDefault(); void rename(); }}>
        <input type="text" bind:value={newName} maxlength="80" aria-label={L.fields.teamName} required />
        <Button type="submit" busy={action.busy}>{L.actions.save}</Button>
        <Button kind="ghost" onclick={() => (renaming = false)}>{L.actions.abort}</Button>
      </form>
    {:else}
      <h1>{team.name}</h1>
    {/if}
  </div>
  <div class="row">
    {#if !renaming}
      <Button kind="ghost" onclick={() => { newName = team.name; renaming = true; }}>{L.actions.rename}</Button>
    {/if}
    <Button kind="ghost" onclick={() => (confirming = 'deactivate')}>{team.active ? L.actions.deactivate : L.actions.reactivate}</Button>
    <Button kind="ghost" onclick={() => (confirming = 'leave')}>{L.actions.leave}</Button>
  </div>
</section>

{#if !team.active}
  <p class="tone-warn">{S.team.inactive}</p>
{/if}
{#if action.error}<p class="error" role="alert">{action.error}</p>{/if}

{#if confirming === 'leave'}
  <Confirm title={L.actions.leave} text={S.team.leaveConfirm} confirmLabel={L.actions.leave} danger busy={action.busy} onconfirm={leave} oncancel={() => (confirming = null)} />
{:else if confirming === 'deactivate'}
  <Confirm
    title={team.active ? L.actions.deactivate : L.actions.reactivate}
    text={S.team.deactivateConfirm}
    confirmLabel={team.active ? L.actions.deactivate : L.actions.reactivate}
    busy={action.busy}
    onconfirm={toggleActive}
    oncancel={() => (confirming = null)}
  />
{/if}

<div class="cols">
  <section class="stack" aria-label={L.columns.members}>
    <h2>{L.columns.members}</h2>
    <ul class="list">
      {#each team.members as m (m.pid)}
        <li>{m.displayName}</li>
      {/each}
    </ul>
  </section>

  <section class="stack" aria-label={L.columns.invites}>
    <h2>{L.columns.invites}</h2>
    <span class="hint">{S.team.inviteHint}</span>
    {#if team.invites.length === 0}
      <span class="hint">{S.team.noInvites}</span>
    {/if}
    <ul class="list">
      {#each team.invites as inv (inv.inviteId)}
        <li class="stack tight">
          <code class="mono wrap">{inviteUrl(inv.inviteId)}</code>
          <div class="row">
            <span class="hint">{L.team.expires} {dateTime(inv.expiresAt)}</span>
            <Button kind="ghost" onclick={() => copy(inv.inviteId)}>{L.actions.copy}</Button>
            <Button kind="ghost" onclick={() => revoke(inv.inviteId)}>{L.actions.revoke}</Button>
          </div>
        </li>
      {/each}
    </ul>
    <div class="row">
      <Button kind="primary" busy={action.busy} disabled={!team.active} onclick={invite}>{L.actions.invite}</Button>
      {#if copied}<span class="tone-ok">{S.copied}</span>{/if}
    </div>
  </section>

  <section class="stack" aria-label={L.columns.banned}>
    <h2>{L.columns.banned}</h2>
    <span class="hint">{S.team.bannedHint}</span>
    {#if team.banned.length === 0}
      <span class="hint">{S.team.noBans}</span>
    {/if}
    <ul class="list">
      {#each team.banned as pid (pid)}
        <li class="row between"><span>{maskName(pid)}</span><Button kind="ghost" onclick={() => unban(pid)}>{L.actions.unban}</Button></li>
      {/each}
    </ul>
  </section>
</div>

<style>
  .between {
    justify-content: space-between;
    align-items: flex-end;
  }
  .tight {
    gap: 6px;
  }
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
    gap: 28px;
    align-items: start;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
  }
  .list > li {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .list > li:last-child {
    border-bottom: none;
  }
  .wrap {
    overflow-wrap: anywhere;
  }
</style>
