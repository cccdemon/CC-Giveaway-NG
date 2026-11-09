<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    help?: string;
    error?: string | null;
    /** id des Eingabe-Elements, für `for`. Ohne id umschließt das Label das Element. */
    for?: string;
    children: Snippet;
  }

  let { label, help, error = null, for: forId, children }: Props = $props();
</script>

{#if forId}
  <div class="field">
    <label class="lbl" for={forId}>{label}</label>
    {@render children()}
    {#if help}<span class="hint">{help}</span>{/if}
    {#if error}<span class="error" role="alert">{error}</span>{/if}
  </div>
{:else}
  <label class="field">
    <span class="lbl">{label}</span>
    {@render children()}
    {#if help}<span class="hint">{help}</span>{/if}
    {#if error}<span class="error" role="alert">{error}</span>{/if}
  </label>
{/if}
