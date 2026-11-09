<script lang="ts">
  // Rechtstexte (NEW_DESIGN.md 9.4): Impressum-URL, Teilnahmebedingungen als Text oder URL, Datenschutz-URL. Checkliste, keine Mustertexte.
  import type { LegalTexts } from '../api/types.js';
  import { L } from '../texts/labels.js';
  import { S } from '../texts/sentences.js';
  import Button from './Button.svelte';
  import Field from './Field.svelte';

  interface Props {
    value: LegalTexts;
    onsubmit: (legal: LegalTexts) => void;
    busy?: boolean;
    error?: string | null;
    saved?: boolean;
    /** Beschriftung des Speichern-Knopfs. */
    submitLabel?: string;
    /** Kupfer für den Speichern-Knopf. Aus, wenn die Ansicht schon eine Hauptaktion hat (Assistent). */
    primary?: boolean;
  }

  let { value, onsubmit, busy = false, error = null, saved = false, submitLabel = L.actions.save, primary = true }: Props = $props();
  const id = $props.id();

  // Das Formular startet mit den übergebenen Werten und gehört danach der Person. Die Seite baut es per {#key} neu auf.
  // svelte-ignore state_referenced_locally
  const start = value;
  let impressum = $state(start.impressumUrl ?? '');
  let privacy = $state(start.privacyUrl ?? '');
  let mode = $state<'text' | 'url'>(start.terms && 'url' in start.terms ? 'url' : 'text');
  let termsText = $state(start.terms && 'text' in start.terms ? start.terms.text : '');
  let termsUrl = $state(start.terms && 'url' in start.terms ? start.terms.url : '');

  const clean = (s: string): string | null => (s.trim() === '' ? null : s.trim());

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const text = clean(termsText);
    const url = clean(termsUrl);
    onsubmit({
      impressumUrl: clean(impressum),
      terms: mode === 'text' ? (text ? { text } : null) : url ? { url } : null,
      privacyUrl: clean(privacy),
    });
  }
</script>

<form class="legal stack" onsubmit={submit}>
  <Field label={L.fields.impressumUrl} for="{id}-impressum">
    <input id="{id}-impressum" type="url" bind:value={impressum} placeholder="https://" maxlength="500" />
  </Field>

  <fieldset class="terms">
    <legend class="lbl">{L.legal.terms}</legend>
    <div class="row">
      <label class="row"><input type="radio" name="{id}-mode" value="text" bind:group={mode} /> {L.fields.termsText}</label>
      <label class="row"><input type="radio" name="{id}-mode" value="url" bind:group={mode} /> {L.fields.termsUrl}</label>
    </div>
    {#if mode === 'text'}
      <Field label={L.fields.terms} for="{id}-terms-text">
        <textarea id="{id}-terms-text" bind:value={termsText} maxlength="20000" rows="8"></textarea>
      </Field>
    {:else}
      <Field label={L.fields.terms} for="{id}-terms-url">
        <input id="{id}-terms-url" type="url" bind:value={termsUrl} placeholder="https://" maxlength="500" />
      </Field>
    {/if}
  </fieldset>

  <Field label={L.fields.privacyUrl} for="{id}-privacy">
    <input id="{id}-privacy" type="url" bind:value={privacy} placeholder="https://" maxlength="500" />
  </Field>

  <div class="checklist">
    <span class="lbl">{L.legal.checklist}</span>
    <ul aria-label={L.legal.checklist}>
      {#each S.legal.checklist as item (item)}
        <li>{item}</li>
      {/each}
    </ul>
    <span class="hint">{S.legal.noTemplates}</span>
  </div>

  <div class="row">
    <Button type="submit" kind={primary ? 'primary' : 'default'} {busy}>{submitLabel}</Button>
    {#if saved}<span class="tone-ok">{S.saved}</span>{/if}
    {#if error}<span class="error" role="alert">{error}</span>{/if}
  </div>
</form>

<style>
  .legal {
    gap: 18px;
    max-width: 720px;
  }
  .terms {
    border: 1px solid var(--border);
    padding: 14px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin: 0;
  }
  legend {
    padding: 0 6px;
    color: var(--accent-2);
  }
  .checklist {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  ul {
    margin: 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.9375rem;
  }
</style>
