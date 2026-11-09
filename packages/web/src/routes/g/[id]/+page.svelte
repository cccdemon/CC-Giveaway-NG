<script lang="ts">
  import LegalLinks from '#lib/components/LegalLinks.svelte';
  import StateBadge from '#lib/components/StateBadge.svelte';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const g = $derived(data.giveaway);
  const loginHref = $derived(`/api/auth/twitch/login?return=${encodeURIComponent(`/portal/giveaways/${g.id}`)}`);
</script>

<svelte:head><title>{g.prize} · {L.brand}</title></svelte:head>

<section class="stack narrow">
  <div class="row between">
    <span class="lbl">{g.kernel.label} · {g.channels.map((c) => c.displayName).join(', ')}</span>
    <StateBadge status={g.status} size="sm" />
  </div>
  <h1>{g.prize}</h1>
  {#if g.sponsor}<span class="hint">{L.fields.sponsor}: {g.sponsor}</span>{/if}
  {#if data.me}
    <p class="hint">{S.portal.publicNoPortal}</p>
  {:else}
    <p>{S.portal.publicIntro}</p>
    <a class="btn btn-primary" href={loginHref}>{L.actions.loginAndJoin}</a>
  {/if}
  {#if g.keyword}<span class="hint">{S.portal.keywordHint(g.keyword)}</span>{/if}
  <dl>
    <dt>{L.fields.winnersCount}</dt>
    <dd>{g.winnersCount}</dd>
    <dt>{L.fields.claimDays}</dt>
    <dd>{g.claimDays}</dd>
    <dt>{L.fields.counting}</dt>
    <dd>{g.counting === 'registered' ? L.fields.countingRegistered : L.fields.countingFirstSeen}</dd>
  </dl>
  <div class="stack">
    <span class="lbl">{L.legal.title}</span>
    <LegalLinks legal={g.legal} />
  </div>
</section>

<style>
  .narrow {
    max-width: 720px;
    gap: 14px;
  }
  .between {
    justify-content: space-between;
  }
  .narrow .btn {
    align-self: flex-start;
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 16px;
    font-size: 0.9375rem;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
  }
</style>
