<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { Action } from '#lib/action.svelte.js';
  import Button from '#lib/components/Button.svelte';
  import Confirm from '#lib/components/Confirm.svelte';
  import Field from '#lib/components/Field.svelte';
  import { dateTime } from '#lib/format.js';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const action = new Action();
  let text = $state('');
  let confirming = $state(false);

  const publish = () =>
    action.run(
      (api) => api.post('/api/admin/terms', { text: text.trim() }),
      async () => {
        confirming = false;
        text = '';
        await Promise.all([invalidate('api:terms'), invalidate('api:me')]);
      },
    );
</script>

<svelte:head><title>{L.terms.title} · {L.nav.admin} · {L.brand}</title></svelte:head>

<section class="stack">
  <span class="lbl">{L.terms.version(data.terms.version)}{#if data.terms.publishedAt} · {dateTime(data.terms.publishedAt)}{/if}</span>
  <h1>{L.terms.title}</h1>
  {#if data.terms.text}
    <pre class="terms">{data.terms.text}</pre>
  {:else}
    <p class="hint">{S.admin.noTermsYet}</p>
  {/if}
</section>

<section class="panel">
  <div class="panel-body stack">
    <span class="lbl">{L.admin.newTerms}</span>
    <span class="hint">{S.admin.termsHint}</span>
    <Field label={L.admin.termsText} for="terms-text">
      <textarea id="terms-text" bind:value={text} rows="14" maxlength="50000"></textarea>
    </Field>
    <div class="row">
      <Button kind="primary" disabled={text.trim() === ''} onclick={() => (confirming = true)}>{L.admin.publish}</Button>
      {#if action.error}<span class="error" role="alert">{action.error}</span>{/if}
      {#if action.done}<span class="tone-ok">{S.admin.published}</span>{/if}
    </div>
    {#if confirming}
      <Confirm title={L.admin.publish} text={S.admin.publishConfirm} confirmLabel={L.admin.publish} busy={action.busy} onconfirm={publish} oncancel={() => (confirming = false)} />
    {/if}
  </div>
</section>

<style>
  .terms {
    white-space: pre-wrap;
    font-family: var(--font-text);
    font-size: 0.9375rem;
    border: 1px solid var(--border);
    padding: 14px 18px;
    margin: 0;
    max-height: 50vh;
    overflow: auto;
  }
  textarea {
    width: 100%;
    min-height: 280px;
    font-family: var(--font-text);
  }
</style>
