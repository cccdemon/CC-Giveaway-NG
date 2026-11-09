<script lang="ts">
  // Kachel der Übersicht (NEW_DESIGN.md 11.1): Kern, Zustand, Gewinn, Zahlen, erste Warnung, Meldefrist nach der Ziehung.
  import type { Tile, WinnerStatus } from '../api/types.js';
  import { daysUntil, number, relative } from '../format.js';
  import { L } from '../texts/labels.js';
  import { S } from '../texts/sentences.js';
  import StateBadge from './StateBadge.svelte';

  let { tile, now = new Date() }: { tile: Tile; now?: Date } = $props();

  const DAY_MS = 86_400_000;
  const claim = $derived.by(() => {
    if (!tile.drawnAt) return null;
    const days = daysUntil(new Date(Date.parse(tile.drawnAt) + tile.claimDays * DAY_MS).toISOString(), now);
    if (days <= 0) return { text: S.overview.claimExpired, tone: 'err' as const };
    return { text: days === 1 ? S.overview.claimRunningOne : S.overview.claimRunning(days), tone: days <= 3 ? ('warn' as const) : ('text' as const) };
  });
  const winnerSummary = $derived(
    (Object.entries(tile.winnerStatuses) as [WinnerStatus, number][])
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${L.winner[k]}`)
      .join(' · '),
  );
  const warning = $derived(tile.warnings[0] ?? null);
  const toneOf = (level: 'rot' | 'gelb' | 'hinweis') => (level === 'rot' ? 'tone-err' : level === 'gelb' ? 'tone-warn' : 'tone-info');
</script>

<a class="tile" href="/giveaways/{tile.id}">
  <div class="head">
    <span class="lbl">{tile.kernelLabel}</span>
    <StateBadge status={tile.status} size="sm" />
  </div>
  <h2>{tile.prize}</h2>
  <div class="stats">
    <div class="stat"><span class="lbl">{L.columns.registered}</span><span class="val">{number(tile.registeredCount)}</span></div>
    <div class="stat"><span class="lbl">{L.columns.inPool}</span><span class="val">{number(tile.poolSize)}</span></div>
    <div class="stat"><span class="lbl">{L.columns.lastActive}</span><span class="val small">{relative(tile.updatedAt, now)}</span></div>
  </div>
  {#if claim}
    <span class="line {claim.tone === 'err' ? 'tone-err' : claim.tone === 'warn' ? 'tone-warn' : ''}">{claim.text}</span>
  {/if}
  {#if winnerSummary}
    <span class="line">{winnerSummary}</span>
  {/if}
  {#if warning}
    <span class="line {toneOf(warning.level)}">{warning.text}</span>
  {/if}
</a>

<style>
  .tile {
    border: 1px solid var(--border);
    padding: 20px 22px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    text-decoration: none;
    color: var(--text);
    min-width: 0;
  }
  .tile:hover {
    border-color: var(--accent-2);
    color: var(--text);
  }
  .head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  h2 {
    font-size: 1.3125rem;
    overflow-wrap: anywhere;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .stat {
    display: flex;
    flex-direction: column;
  }
  .val {
    font-size: 1.3125rem;
    font-family: var(--font-mono);
  }
  .val.small {
    font-size: 1rem;
  }
  .line {
    font-size: 0.875rem;
  }
</style>
