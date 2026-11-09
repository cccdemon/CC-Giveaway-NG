<script lang="ts">
  import type { WinnerStatus } from '../api/types.js';
  import { L } from '../texts/labels.js';

  interface Props {
    value: WinnerStatus;
    onchange: (s: WinnerStatus) => void;
    disabled?: boolean;
    label?: string;
  }

  let { value, onchange, disabled = false, label = L.detail.winnerStatus }: Props = $props();
  const STATUSES: WinnerStatus[] = ['pending', 'reported', 'shipped', 'done', 'forfeited'];
</script>

<select {value} {disabled} aria-label={label} onchange={(e) => onchange((e.currentTarget as HTMLSelectElement).value as WinnerStatus)}>
  {#each STATUSES as s (s)}
    <option value={s}>{L.winner[s]}</option>
  {/each}
</select>
