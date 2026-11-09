<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { Action } from '#lib/action.svelte.js';
  import type { LegalTexts } from '#lib/api/types.js';
  import LegalForm from '#lib/components/LegalForm.svelte';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const action = new Action();

  const save = (legal: LegalTexts) => action.run((api) => api.put('/api/me/profile', { legal }), () => invalidate('api:me'));
  const complete = $derived(data.me.legal.impressumUrl !== null && data.me.legal.terms !== null && data.me.legal.privacyUrl !== null);
</script>

<svelte:head><title>{L.legal.title} · {L.brand}</title></svelte:head>

<section class="stack">
  <span class="lbl">{complete ? L.legal.present : L.legal.missing}</span>
  <h1>{L.legal.title}</h1>
  <p>{S.legal.intro}</p>
  <p class="hint">{S.legal.profileHint} {S.legal.frozenHint}</p>
</section>

{#key data.me.legal}
  <LegalForm value={data.me.legal} onsubmit={save} busy={action.busy} error={action.error} saved={action.done} />
{/key}
