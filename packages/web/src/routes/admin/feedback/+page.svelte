<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { Action } from '#lib/action.svelte.js';
  import Name from '#lib/components/Name.svelte';
  import { dateTime } from '#lib/format.js';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const action = new Action();
  const toggle = (id: number, done: boolean) => action.run((api) => api.put(`/api/admin/feedback/${id}`, { done }), () => invalidate('api:admin:feedback'));
</script>

<svelte:head><title>{L.admin.feedback} · {L.brand}</title></svelte:head>

<section class="row between">
  <h1>{L.admin.feedback}</h1>
  <nav class="row" aria-label={L.admin.feedback}>
    <a href="/admin/feedback" class:active={!data.done}>{L.admin.open}</a>
    <a href="/admin/feedback?done=true" class:active={data.done}>{L.admin.done}</a>
  </nav>
</section>
{#if action.error}<p class="error" role="alert">{action.error}</p>{/if}

{#if data.rows.length === 0}
  <p class="hint">{S.admin.noFeedback}</p>
{:else}
  <ul class="list">
    {#each data.rows as f (f.id)}
      <li class="item stack">
        <div class="row between">
          <span class="lbl">{dateTime(f.at)} · <Name pid={f.pid} displayName={f.displayName} /></span>
          <label class="row"><input type="checkbox" checked={f.done} disabled={action.busy} onchange={(e) => toggle(f.id, (e.currentTarget as HTMLInputElement).checked)} /> {L.admin.done}</label>
        </div>
        <p class="text">{f.text}</p>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .between {
    justify-content: space-between;
    align-items: flex-end;
  }
  nav a.active {
    border-bottom: 2px solid var(--accent-2);
    text-decoration: none;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
  }
  .item {
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    gap: 6px;
  }
  .item:last-child {
    border-bottom: none;
  }
  .text {
    white-space: pre-wrap;
  }
</style>
