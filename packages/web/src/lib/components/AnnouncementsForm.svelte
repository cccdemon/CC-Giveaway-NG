<script lang="ts">
  // Chat-Ansagen (NEW_DESIGN.md 10.3, 7.2 Schritt 6): stumm, Link, je Art eine Vorlage mit dem Standardtext als Platzhalter.
  import { kindLabel, kindsForKernel, TEMPLATE_MAX } from '../announcements.js';
  import type { AnnouncementKind, AnnouncementSettings } from '../api/types.js';
  import { L } from '../texts/labels.js';
  import { S } from '../texts/sentences.js';
  import Button from './Button.svelte';
  import Field from './Field.svelte';

  interface Props {
    kinds: AnnouncementKind[];
    kernelId: string | null;
    value: AnnouncementSettings;
    onchange: (v: AnnouncementSettings) => void;
    /** Fehler je Art. */
    errors?: Record<string, string>;
  }

  let { kinds, kernelId, value, onchange, errors = {} }: Props = $props();
  const id = $props.id();
  const shown = $derived(kindsForKernel(kinds, kernelId));

  function setText(kind: string, text: string) {
    const texts = { ...value.texts };
    if (text === '') delete texts[kind];
    else texts[kind] = text;
    onchange({ ...value, texts });
  }
</script>

<div class="stack">
  <p class="hint">{S.announcements.intro}</p>
  <label class="row"><input type="checkbox" checked={value.muted} onchange={(e) => onchange({ ...value, muted: e.currentTarget.checked })} /> {L.announcements.muted}</label>
  <span class="hint">{S.announcements.mutedHint}</span>
  <label class="row"><input type="checkbox" checked={value.links} onchange={(e) => onchange({ ...value, links: e.currentTarget.checked })} /> {L.announcements.links}</label>
  <span class="hint">{S.announcements.linkHint}</span>
  {#each shown as k (k.kind)}
    <Field label={kindLabel(k.kind)} help="{L.announcements.placeholders}: {k.placeholders.join(' ')}" error={errors[k.kind] ?? null} for="{id}-{k.kind}">
      <div class="row">
        <textarea
          id="{id}-{k.kind}"
          rows="2"
          maxlength={TEMPLATE_MAX}
          placeholder={k.default}
          value={value.texts[k.kind] ?? ''}
          disabled={value.muted && k.kind !== 'winner'}
          oninput={(e) => setText(k.kind, e.currentTarget.value)}
        ></textarea>
        {#if value.texts[k.kind] !== undefined}
          <Button kind="ghost" onclick={() => setText(k.kind, '')}>{L.announcements.reset}</Button>
        {/if}
      </div>
    </Field>
  {/each}
</div>

<style>
  textarea {
    flex: 1 1 auto;
    min-width: 0;
    resize: vertical;
  }
</style>
