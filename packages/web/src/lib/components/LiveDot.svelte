<script lang="ts">
  import { L } from '../texts/labels.js';
  import type { LiveState } from '../ws.js';
  import Icon from './Icon.svelte';

  let { state }: { state: LiveState } = $props();
</script>

<span class="live live-{state} lbl" title={L.live[state]}>
  <Icon name={state === 'connected' ? 'live' : 'offline'} size={13} />
  <span>{L.live[state]}</span>
</span>

<style>
  .live {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .live-connected {
    color: var(--ok);
  }
  .live-reconnecting {
    color: var(--warn);
  }
</style>
