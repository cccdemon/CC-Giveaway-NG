<script lang="ts">
  import { Action } from '#lib/action.svelte.js';
  import Button from '#lib/components/Button.svelte';
  import Confirm from '#lib/components/Confirm.svelte';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const view = new Action();
  const del = new Action();
  let json = $state<string | null>(null);
  let confirming = $state(false);

  const show = () =>
    view.run(
      (api) => api.get<unknown>('/api/me/data'),
      (d) => {
        json = JSON.stringify(d, null, 2);
      },
    );
  const remove = () =>
    del.run(
      (api) => api.del('/api/me'),
      () => {
        // Nach der Löschung gibt es keine Sitzung mehr: ganze Seite neu, ohne Live-Verbindung und Zustand.
        globalThis.location.href = '/';
      },
    );
</script>

<svelte:head><title>{L.portal.data} · {L.brand}</title></svelte:head>

<section class="stack tight">
  <a href="/portal" class="hint">{L.portal.title}</a>
  <span class="lbl">{data.me.displayName}</span>
  <h1>{L.portal.data}</h1>
  <p>{S.portal.dataIntro}</p>
</section>

<section class="stack">
  <div class="row">
    <Button busy={view.busy} onclick={show}>{L.actions.viewData}</Button>
    <a class="btn" href="/api/me/data" download="meine-daten.json">{L.actions.download}</a>
    <Button kind="danger" onclick={() => (confirming = true)}>{L.actions.deleteAll}</Button>
  </div>
  {#if view.error}<p class="error" role="alert">{view.error}</p>{/if}
  <p class="hint">{S.portal.deleteHint}</p>
  {#if confirming}
    <Confirm title={L.actions.deleteAll} text={`${S.portal.deleteHint} ${S.portal.deleteConfirm}`} confirmLabel={L.actions.deleteAll} danger busy={del.busy} onconfirm={remove} oncancel={() => (confirming = false)} />
  {/if}
  {#if del.error}<p class="error" role="alert">{del.error}</p>{/if}
  {#if json}
    <pre class="json">{json}</pre>
  {/if}
</section>

<style>
  .tight {
    gap: 6px;
  }
  .json {
    border: 1px solid var(--border);
    padding: 14px;
    overflow: auto;
    max-height: 70vh;
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    margin: 0;
  }
</style>
