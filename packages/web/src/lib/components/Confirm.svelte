<script lang="ts">
  // Rückfrage als Panel in der Seite, nie als Browser-Dialog (NEW_DESIGN.md 11.1).
  import { L } from '../texts/labels.js';
  import { S } from '../texts/sentences.js';
  import Button from './Button.svelte';

  interface Props {
    title: string;
    text: string;
    /** Grund Pflicht (Rückgängig, Ersatzziehung). */
    reason?: boolean;
    confirmLabel: string;
    danger?: boolean;
    busy?: boolean;
    onconfirm: (reason?: string) => void;
    oncancel: () => void;
  }

  let { title, text, reason = false, confirmLabel, danger = false, busy = false, onconfirm, oncancel }: Props = $props();
  let value = $state('');
  let problem = $state<string | null>(null);
  let box = $state<HTMLDivElement | null>(null);
  const id = $props.id();

  $effect(() => {
    box?.focus();
  });

  function go() {
    if (reason && value.trim() === '') {
      problem = S.reasonRequired;
      return;
    }
    onconfirm(reason ? value.trim() : undefined);
  }
</script>

<div class="panel panel-warn confirm" role="dialog" aria-labelledby="{id}-title" aria-describedby="{id}-text" tabindex="-1" bind:this={box}>
  <h3 id="{id}-title">{title}</h3>
  <p id="{id}-text">{text}</p>
  {#if reason}
    <label class="field">
      <span class="lbl">{L.fields.reason}</span>
      <input type="text" bind:value maxlength="500" aria-invalid={problem !== null || undefined} />
    </label>
    {#if problem}<p class="error" role="alert">{problem}</p>{/if}
  {/if}
  <div class="row">
    <Button kind={danger ? 'danger' : 'default'} onclick={go} {busy}>{confirmLabel}</Button>
    <Button kind="ghost" onclick={oncancel}>{L.actions.abort}</Button>
  </div>
</div>

<style>
  .confirm {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .confirm:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  h3 {
    margin: 0;
    font-size: 1.125rem;
  }
  p {
    margin: 0;
  }
</style>
