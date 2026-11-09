<script lang="ts">
  import { goto } from '$app/navigation';
  import { Action } from '#lib/action.svelte.js';
  import Button from '#lib/components/Button.svelte';
  import Field from '#lib/components/Field.svelte';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const action = new Action();
  let name = $state('');

  function found(e: SubmitEvent) {
    e.preventDefault();
    void action.run(
      (api) => api.post<{ teamId: string }>('/api/teams', { name: name.trim() }),
      (r) => goto(`/teams/${r.teamId}`),
    );
  }
</script>

<svelte:head><title>{L.team.title} · {L.brand}</title></svelte:head>

<section class="stack">
  <span class="lbl">{data.me.displayName}</span>
  <h1>{L.team.title}</h1>
  <p>{S.team.intro}</p>
</section>

<section class="stack" aria-label={L.team.title}>
  <div class="table-wrap">
    <table>
      <thead><tr><th>{L.fields.name}</th><th>{L.columns.members}</th><th>{L.columns.status}</th></tr></thead>
      <tbody>
        <tr>
          <td>{L.solo}</td>
          <td>{L.team.oneMember}</td>
          <td class="hint-cell">{S.team.soloHint}</td>
        </tr>
        {#each data.teams.teams as t (t.teamId)}
          <tr>
            <td><a href="/teams/{t.teamId}">{t.name}</a></td>
            <td>{t.memberCount === 1 ? L.team.oneMember : L.team.memberCount(t.memberCount)}</td>
            <td class={t.active ? 'tone-ok' : 'tone-muted'}>{t.active ? L.team.active : L.team.inactive}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<form class="panel" onsubmit={found}>
  <div class="panel-body">
    <span class="lbl">{L.actions.found}</span>
    <span class="hint">{S.team.foundHint}</span>
    <div class="row">
      <Field label={L.fields.teamName} for="team-name">
        <input id="team-name" type="text" bind:value={name} maxlength="80" required />
      </Field>
      <Button type="submit" kind="primary" busy={action.busy}>{L.actions.found}</Button>
    </div>
    {#if action.error}<span class="error" role="alert">{action.error}</span>{/if}
  </div>
</form>

<style>
  .hint-cell {
    color: var(--muted);
    font-size: 0.875rem;
  }
  .row {
    align-items: flex-end;
  }
</style>
