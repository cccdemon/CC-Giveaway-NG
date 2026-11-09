<script lang="ts">
  // Bedingungen mit Status (NEW_DESIGN.md 6.5): „erfüllt“ oder der Grund in Worten, ohne Prüfung „noch nicht geprüft“.
  import type { GateConfig, GateResult } from '../api/types.js';
  import { gateText, reasonText } from '../gate-text.js';
  import { L } from '../texts/labels.js';
  import Icon from './Icon.svelte';

  interface Props {
    gates: GateConfig[];
    channels: { pid: string; displayName: string }[];
    result: GateResult | null;
  }

  let { gates, channels, result }: Props = $props();

  /** Gründe, die zu einer Bedingung gehören. */
  function reasonsOf(g: GateConfig): string[] {
    if (!result) return [];
    return result.reasons.filter((r) => {
      switch (g.id) {
        case 'follow':
          return r.startsWith('follow:') || r === 'follow_min';
        case 'account_age':
          return r === 'account_age';
        case 'follow_age':
          return r === 'follow_age';
        case 'presence':
          return r === 'presence';
      }
    });
  }
  const other = $derived(result ? result.reasons.filter((r) => !r.startsWith('follow:') && !['follow_min', 'account_age', 'follow_age', 'presence'].includes(r)) : []);
</script>

{#if gates.length === 0}
  <span class="hint">{L.gates.none}</span>
{:else}
  <ul class="gates">
    {#each gates as g, i (i)}
      {@const reasons = reasonsOf(g)}
      <li class="row between">
        <span>{gateText(g, channels)}</span>
        {#if !result}
          <span class="hint">{L.gates.unchecked}</span>
        {:else if reasons.length === 0}
          <span class="state tone-ok"><Icon name="check" size={14} stroke={2.5} /><span>{L.gates.ok}</span></span>
        {:else}
          <span class="state tone-warn"><Icon name="warn" size={14} /><span>{reasons.map((r) => reasonText(r, channels)).join(', ')}</span></span>
        {/if}
      </li>
    {/each}
    {#each other as r (r)}
      <li class="row between"><span></span><span class="state tone-warn"><Icon name="warn" size={14} /><span>{reasonText(r, channels)}</span></span></li>
    {/each}
  </ul>
{/if}

<style>
  .gates {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.9375rem;
  }
  .between {
    justify-content: space-between;
    gap: 10px;
  }
  .state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    text-align: right;
  }
</style>
