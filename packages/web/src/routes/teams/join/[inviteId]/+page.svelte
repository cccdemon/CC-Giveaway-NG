<script lang="ts">
  import { goto } from '$app/navigation';
  import { Action } from '#lib/action.svelte.js';
  import Button from '#lib/components/Button.svelte';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const action = new Action();
  const loginHref = $derived(`/api/auth/twitch/login?return=${encodeURIComponent(`/teams/join/${data.inviteId}`)}`);
  const join = () =>
    action.run(
      (api) => api.post(`/api/teams/join/${data.inviteId}`),
      () => goto(`/teams/${data.invite.teamId}`),
    );
</script>

<svelte:head><title>{data.invite.name} · {L.brand}</title></svelte:head>

<section class="stack narrow">
  <span class="lbl">{L.team.inviteLink}</span>
  <h1>{S.team.joinIntro(data.invite.name)}</h1>
  {#if !data.invite.valid}
    <p class="tone-warn">{S.team.joinInvalid}</p>
  {:else if !data.me}
    <p>{S.team.joinNeedsLogin}</p>
    <a class="btn btn-primary" href={loginHref}>{L.actions.login}</a>
  {:else}
    <p class="hint">{S.team.foundHint}</p>
    <div class="row">
      <Button kind="primary" busy={action.busy} onclick={join}>{L.actions.joinTeam}</Button>
      {#if action.error}<span class="error" role="alert">{action.error}</span>{/if}
    </div>
  {/if}
</section>

<style>
  .narrow {
    max-width: 720px;
    gap: 16px;
  }
  .narrow .btn {
    align-self: flex-start;
  }
</style>
