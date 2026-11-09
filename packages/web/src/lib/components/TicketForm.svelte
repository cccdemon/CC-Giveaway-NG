<script lang="ts">
  // Teilnehmer-Befehl eines Kerns mit Anzahl (NEW_DESIGN.md 8.3 Ticketkauf). Argumente: count.
  import type { KernelCommandSpec } from '../api/types.js';
  import { L } from '../texts/labels.js';
  import { S } from '../texts/sentences.js';
  import Button from './Button.svelte';

  interface Props {
    command: KernelCommandSpec;
    busy: boolean;
    error: string | null;
    onsubmit: (count: number) => void;
  }

  let { command, busy, error, onsubmit }: Props = $props();
  let count = $state(1);
  const id = $props.id();

  function submit(e: SubmitEvent) {
    e.preventDefault();
    onsubmit(Math.max(1, Math.round(count)));
  }
</script>

<form class="tickets" onsubmit={submit}>
  <span class="lbl">{command.label}</span>
  <span class="hint">{S.portal.ticketsIntro}</span>
  <div class="row">
    <label class="row"><span class="hint">{L.fields.count}</span><input id="{id}-count" type="number" min="1" max="1000" step="1" bind:value={count} /></label>
    <Button type="submit" {busy}>{command.label}</Button>
  </div>
  {#if command.chat}<span class="hint">{S.portal.ticketsHint(command.chat.word)}</span>{/if}
  {#if error}<span class="error" role="alert">{error}</span>{/if}
</form>

<style>
  .tickets {
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }
  input {
    width: 5em;
  }
</style>
