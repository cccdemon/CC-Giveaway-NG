<script lang="ts">
  // Verwarnungen einer Person (NEW_DESIGN.md 11.4): Datum und Grund, in der Verwaltung mit Rücknahme.
  import { dateTime } from '../format.js';
  import { L } from '../texts/labels.js';
  import Button from './Button.svelte';

  interface Props {
    warnings: { eventId: string; reason: string; at: string }[];
    onwithdraw?: (eventId: string) => void;
    busy?: boolean;
  }

  let { warnings, onwithdraw, busy = false }: Props = $props();
</script>

{#if warnings.length > 0}
  <ul class="warnings">
    {#each warnings as w (w.eventId)}
      <li class="row between">
        <span class="row"><span class="lbl">{dateTime(w.at)}</span><span>{w.reason}</span></span>
        {#if onwithdraw}<Button kind="ghost" {busy} onclick={() => onwithdraw(w.eventId)}>{L.admin.withdraw}</Button>{/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .warnings {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.9375rem;
  }
  .between {
    justify-content: space-between;
  }
</style>
