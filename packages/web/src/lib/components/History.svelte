<script lang="ts">
  // Verlauf (NEW_DESIGN.md 5.3): je Eintrag „Rückgängig“ oder der Grund, warum nicht. Aufgehobene durchgestrichen.
  import type { HistoryEntry } from '../api/types.js';
  import { dateTime } from '../format.js';
  import { historyText } from '../history-text.js';
  import { streamerMode } from '../mask.js';
  import { L } from '../texts/labels.js';
  import { S } from '../texts/sentences.js';
  import Button from './Button.svelte';
  import Name from './Name.svelte';

  interface Props {
    entries: HistoryEntry[];
    names: Record<string, string>;
    onrevert: (e: HistoryEntry) => void;
    busyId?: string | null;
  }

  let { entries, names, onrevert, busyId = null }: Props = $props();
</script>

{#if entries.length === 0}
  <p class="hint">{S.detail.noHistory}</p>
{:else}
  <ol class="history">
    {#each entries as e (e.id)}
      <li class="entry">
        <div class="row between">
          <span class="lbl">
            {dateTime(e.at)} ·
            {#if e.actor.kind === 'user'}<Name pid={e.actor.pid} displayName={e.actor.displayName} />{:else}{L.detail.system} · {e.actor.name}{/if}
          </span>
          {#if e.reverted}
            <span class="hint">{L.reverted}</span>
          {:else if e.reversal.kind === 'none'}
            <span class="hint" title={e.reversal.why}>{L.notReversible}</span>
          {:else}
            <Button kind="ghost" icon="undo" busy={busyId === e.id} onclick={() => onrevert(e)}>{L.actions.revert}</Button>
          {/if}
        </div>
        <span class:struck={e.reverted}>{historyText(e, names, $streamerMode)}</span>
        {#if e.reason}<span class="hint">{L.columns.reason}: {e.reason}</span>{/if}
      </li>
    {/each}
  </ol>
{/if}

<style>
  .history {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
  }
  .entry {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .entry:last-child {
    border-bottom: none;
  }
  .between {
    justify-content: space-between;
    align-items: center;
  }
</style>
