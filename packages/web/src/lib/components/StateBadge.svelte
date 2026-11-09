<script lang="ts">
  import type { GiveawayStatus } from '../api/types.js';
  import { STATUS_VIEW } from '../status.js';
  import Icon from './Icon.svelte';

  let { status, size = 'md' }: { status: GiveawayStatus; size?: 'sm' | 'md' } = $props();
  const view = $derived(STATUS_VIEW[status]);
</script>

<span class="state tone-{view.tone} state-{size}">
  <Icon name={view.icon} size={size === 'sm' ? 14 : 16} stroke={2.5} />
  <span>{view.word}</span>
</span>

<style>
  .state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 13px;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .state-md {
    padding: 6px 12px;
    border: 1px solid currentColor;
  }
</style>
