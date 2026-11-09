<script lang="ts">
  // Boost (NEW_DESIGN.md 6.3): Faktor 2–10, Dauer 1 min bis 24 h. Der Server lehnt ohne aktiven Kanal ab, der Text steht am Knopf.
  import { L } from '../texts/labels.js';
  import { S } from '../texts/sentences.js';
  import Button from './Button.svelte';
  import Field from './Field.svelte';

  interface Props {
    busy: boolean;
    error: string | null;
    onstart: (boost: { factor: number; durationSec: number }) => void;
    oncancel: () => void;
  }

  let { busy, error, onstart, oncancel }: Props = $props();
  let factor = $state(2);
  let minutes = $state(15);
  const id = $props.id();

  function submit(e: SubmitEvent) {
    e.preventDefault();
    onstart({ factor: Math.round(factor), durationSec: Math.round(minutes) * 60 });
  }
</script>

<form class="panel" onsubmit={submit}>
  <div class="panel-body">
    <span class="lbl">{L.actions.boost}</span>
    <span class="hint">{S.detail.boostHint}</span>
    <div class="row">
      <Field label={L.fields.factor} for="{id}-factor">
        <input id="{id}-factor" type="number" min="2" max="10" step="1" bind:value={factor} required />
      </Field>
      <Field label={L.fields.durationMin} for="{id}-minutes">
        <input id="{id}-minutes" type="number" min="1" max="1440" step="1" bind:value={minutes} required />
      </Field>
    </div>
    <div class="row">
      <Button type="submit" icon="bolt" {busy}>{L.actions.boost}</Button>
      <Button kind="ghost" onclick={oncancel}>{L.actions.abort}</Button>
      {#if error}<span class="error" role="alert">{error}</span>{/if}
    </div>
  </div>
</form>
