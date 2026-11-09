<script lang="ts">
  // Karte im Portal (NEW_DESIGN.md 11.3): Status, Topf-Satz, Chance, Teilnehmen oder Rückzug. Ablehnung als Text am Knopf.
  import type { PortalTile } from '../api/types.js';
  import { percent } from '../format.js';
  import { L } from '../texts/labels.js';
  import { S } from '../texts/sentences.js';
  import Button from './Button.svelte';
  import Icon from './Icon.svelte';
  import StateBadge from './StateBadge.svelte';

  interface Props {
    tile: PortalTile;
    onjoin: () => void;
    onwithdraw: () => void;
    busy: boolean;
    error: string | null;
  }

  let { tile, onjoin, onwithdraw, busy, error }: Props = $props();
  const running = $derived(tile.status === 'open' || tile.status === 'paused' || tile.status === 'closed');
  const past = $derived(!running);
  const line = $derived.by(() => {
    if (tile.status === 'cancelled') return { text: S.portal.cancelled, tone: 'tone-muted', icon: 'x' as const };
    if (past) return tile.winnerStatus ? { text: S.portal.won, tone: 'tone-ok', icon: 'star' as const } : { text: S.portal.notWon, tone: 'tone-muted', icon: 'circle' as const };
    if (tile.inPool) return { text: S.portal.inPool, tone: 'tone-ok', icon: 'check' as const };
    if (tile.registered) return { text: S.portal.registered, tone: 'tone-text', icon: 'circle' as const };
    return { text: S.portal.notRegistered, tone: 'tone-text', icon: 'dot' as const };
  });
</script>

<section class="card" aria-label={tile.prize}>
  <div class="row between">
    <span class="lbl">{tile.kernelLabel}</span>
    <StateBadge status={tile.status} size="sm" />
  </div>
  <h2><a href="/portal/giveaways/{tile.id}">{tile.prize}</a></h2>
  <div class="line {line.tone}"><Icon name={line.icon} stroke={2.5} /><span>{line.text}</span></div>
  {#if running && tile.inPool}
    <div class="chance">
      <span class="lbl">{L.columns.myChance}</span>
      <span class="display big">{percent(tile.chance)}</span>
    </div>
  {/if}
  {#if tile.status === 'open'}
    <div class="row">
      {#if tile.registered}
        <Button {busy} onclick={onwithdraw}>{L.actions.withdraw}</Button>
      {:else}
        <Button {busy} onclick={onjoin}>{L.actions.join}</Button>
      {/if}
    </div>
  {:else if tile.status === 'paused'}
    <span class="hint">{S.portal.paused}</span>
  {:else if tile.status === 'closed'}
    <span class="hint">{S.portal.closed}</span>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .card {
    border: 1px solid var(--border);
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  .between {
    justify-content: space-between;
  }
  h2 {
    font-size: 1.0625rem;
    line-height: 1.35;
  }
  h2 a {
    text-decoration: none;
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
