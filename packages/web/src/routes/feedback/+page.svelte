<script lang="ts">
  import { Action } from '#lib/action.svelte.js';
  import Button from '#lib/components/Button.svelte';
  import Field from '#lib/components/Field.svelte';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';

  const action = new Action();
  let text = $state('');

  function submit(e: SubmitEvent) {
    e.preventDefault();
    void action.run(
      (api) => api.post('/api/feedback', { text: text.trim() }),
      () => {
        text = '';
      },
    );
  }
</script>

<svelte:head><title>{L.nav.feedback} · {L.brand}</title></svelte:head>

<form class="stack narrow" onsubmit={submit}>
  <h1>{L.nav.feedback}</h1>
  <p>{S.feedback.intro}</p>
  <Field label={L.fields.text} for="feedback-text">
    <textarea id="feedback-text" bind:value={text} rows="8" maxlength="2000" required></textarea>
  </Field>
  <div class="row">
    <Button type="submit" kind="primary" busy={action.busy}>{L.actions.send}</Button>
    {#if action.done}<span class="tone-ok">{S.feedback.sent}</span>{/if}
    {#if action.error}<span class="error" role="alert">{action.error}</span>{/if}
  </div>
  <span class="hint">{S.feedback.privacy}</span>
</form>

<style>
  .narrow {
    max-width: 720px;
    gap: 14px;
  }
  textarea {
    width: 100%;
  }
</style>
