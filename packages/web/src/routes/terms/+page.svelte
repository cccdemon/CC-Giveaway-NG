<script lang="ts">
  import { goto, invalidate } from '$app/navigation';
  import { Action } from '#lib/action.svelte.js';
  import Button from '#lib/components/Button.svelte';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const action = new Action();
  const current = $derived(data.me.termsVersion >= data.terms.version);

  const accept = () =>
    action.run(
      (api) => api.post('/api/me/terms', { version: data.terms.version }),
      async () => {
        await invalidate('api:me');
        await goto(data.ret);
      },
    );
</script>

<svelte:head><title>{L.terms.title} · {L.brand}</title></svelte:head>

<section class="stack narrow">
  <span class="lbl">{L.terms.version(data.terms.version)}</span>
  <h1>{L.terms.title}</h1>
  <p>{S.terms.intro}</p>
  {#if data.terms.text}
    <pre class="terms">{data.terms.text}</pre>
  {:else}
    <ul>
      {#each S.terms.duties as duty (duty)}
        <li>{duty}</li>
      {/each}
    </ul>
  {/if}
  {#if current}
    <p class="tone-ok">{S.terms.accepted(data.me.termsVersion)}</p>
    <a class="btn" href={data.ret}>{L.actions.toOverview}</a>
  {:else}
    {#if data.me.termsVersion > 0}<p class="tone-warn">{S.terms.outdated}</p>{/if}
    <div class="row">
      <Button kind="primary" busy={action.busy} onclick={accept}>{L.actions.accept}</Button>
      {#if action.error}<span class="error" role="alert">{action.error}</span>{/if}
    </div>
  {/if}
</section>

<style>
  .narrow {
    max-width: 720px;
    gap: 16px;
  }
  .terms {
    white-space: pre-wrap;
    font-family: var(--font-text);
    border: 1px solid var(--border);
    padding: 14px 18px;
    margin: 0;
    max-height: 60vh;
    overflow: auto;
  }
  ul {
    margin: 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
</style>
