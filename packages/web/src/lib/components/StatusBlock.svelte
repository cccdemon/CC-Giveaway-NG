<script lang="ts">
  // Statusblock (NEW_DESIGN.md 11.2): Tätigkeit mit Fortschritt, Topf, je Kanal live/offline, Signal, Zuschauer, Abdeckung.
  import type { GiveawayDetail } from '../api/types.js';
  import { number, relative } from '../format.js';
  import { L } from '../texts/labels.js';
  import { S } from '../texts/sentences.js';
  import ChannelStatus from './ChannelStatus.svelte';

  interface Props {
    detail: GiveawayDetail;
    activity: string;
    busy: boolean;
    /** Zeitpunkt des letzten Ereignisses (Push oder Verlauf). */
    updatedAt: string | null;
    now?: Date;
  }

  let { detail, activity, busy, updatedAt, now = new Date() }: Props = $props();
  const notEligible = $derived(Math.max(0, detail.registeredCount - detail.pool.size));
  const unit = $derived(detail.kernel.display.unit);
</script>

<section class="block" aria-label={L.columns.status}>
  <div class="cell">
    <span class="lbl">{L.columns.activity}</span>
    <span class="big">{activity}</span>
    {#if busy}<div class="bar bar-indeterminate" aria-hidden="true"><span></span></div>{/if}
  </div>
  <div class="cell">
    <span class="lbl">{L.columns.pool}</span>
    <span class="big">{S.detail.poolLine(detail.pool.size, notEligible)}</span>
    <span class="hint">
      {#if unit}{number(detail.pool.weight)} {unit} · {/if}{L.participant.count(detail.registeredCount)}{#if updatedAt} · {L.detail.lastCalc} {relative(updatedAt, now)}{/if}
    </span>
  </div>
  <div class="cell channels">
    <span class="lbl">{L.columns.channels}</span>
    {#each detail.channels as ch (ch.pid)}
      <ChannelStatus v={ch} name={ch.displayName} {now} compact />
    {/each}
  </div>
</section>

<style>
  .block {
    border: 1px solid var(--border);
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
  }
  .cell {
    padding: 18px 22px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-right: 1px solid var(--border);
    min-width: 0;
  }
  .cell:last-child {
    border-right: none;
  }
  .big {
    font-size: 1.125rem;
  }
  .channels {
    gap: 10px;
  }
</style>
