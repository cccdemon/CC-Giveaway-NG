<script lang="ts">
  import { goto, invalidate } from '$app/navigation';
  import { Action } from '#lib/action.svelte.js';
  import type { AdminStreamer } from '#lib/api/types.js';
  import Button from '#lib/components/Button.svelte';
  import Confirm from '#lib/components/Confirm.svelte';
  import WarningList from '#lib/components/WarningList.svelte';
  import { dateTime } from '#lib/format.js';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const action = new Action();
  // svelte-ignore state_referenced_locally
  let q = $state(data.q);
  let pending = $state<{ kind: 'ban' | 'lift' | 'warn' | 'withdraw'; s: AdminStreamer; eventId?: string } | null>(null);
  const refresh = () => invalidate('api:admin:streamers');

  function search(e: SubmitEvent) {
    e.preventDefault();
    void goto(`/admin/streamers?q=${encodeURIComponent(q.trim())}`);
  }
  const titleOf = (p: NonNullable<typeof pending>) => (p.kind === 'ban' ? L.admin.ban : p.kind === 'lift' ? L.admin.lift : p.kind === 'warn' ? L.admin.warn : L.admin.withdraw);
  const textOf = (p: NonNullable<typeof pending>) => (p.kind === 'ban' ? S.admin.banConfirm(p.s.displayName) : p.kind === 'lift' ? S.admin.liftConfirm(p.s.displayName) : p.kind === 'warn' ? S.admin.warnConfirm(p.s.displayName) : S.admin.withdrawConfirm);

  function confirmed(reason?: string) {
    const p = pending;
    pending = null;
    if (!p) return;
    const r = reason ?? '';
    void action.run((api) => {
      switch (p.kind) {
        case 'ban':
          return api.post('/api/admin/bans', { pid: p.s.pid, reason: r });
        case 'lift':
          return api.post(`/api/admin/bans/${p.s.pid}/lift`, { reason: r });
        case 'warn':
          return api.post('/api/admin/warnings', { pid: p.s.pid, reason: r });
        case 'withdraw':
          return api.post(`/api/admin/warnings/${p.eventId}/withdraw`, { pid: p.s.pid, reason: r });
      }
    }, refresh);
  }
</script>

<svelte:head><title>{L.admin.streamers} · {L.brand}</title></svelte:head>

<section class="row between">
  <h1>{L.admin.streamers}</h1>
  <form class="row" onsubmit={search}>
    <input type="search" bind:value={q} aria-label={L.fields.search} placeholder={L.admin.searchHint} />
    <Button type="submit" kind="primary">{L.fields.search}</Button>
  </form>
</section>

{#if action.error}<p class="error" role="alert">{action.error}</p>{/if}
{#if pending}
  <Confirm title={titleOf(pending)} text={textOf(pending)} reason confirmLabel={titleOf(pending)} danger={pending.kind === 'ban'} busy={action.busy} onconfirm={confirmed} oncancel={() => (pending = null)} />
{/if}

{#if data.streamers.length === 0}
  <p class="hint">{S.admin.noResults}</p>
{:else}
  <ul class="list">
    {#each data.streamers as s (s.pid)}
      <li class="item stack">
        <div class="row between">
          <span class="stack tight">
            <strong>{s.displayName}</strong>
            <span class="lbl">{s.login} · {s.channelConnected ? L.channel.ready : L.channel.notConnected} · {L.terms.version(s.termsVersion)}</span>
          </span>
          <span class="row">
            <Button kind="ghost" onclick={() => (pending = { kind: 'warn', s })}>{L.admin.warn}</Button>
            {#if s.banned}
              <Button onclick={() => (pending = { kind: 'lift', s })}>{L.admin.lift}</Button>
            {:else}
              <Button kind="danger" onclick={() => (pending = { kind: 'ban', s })}>{L.admin.ban}</Button>
            {/if}
          </span>
        </div>
        {#if s.banned}
          <span class="tone-err">{S.admin.bannedSince(dateTime(s.banned.since), s.banned.reason)}</span>
        {/if}
        <WarningList warnings={s.warnings} busy={action.busy} onwithdraw={(eventId) => (pending = { kind: 'withdraw', s, eventId })} />
      </li>
    {/each}
  </ul>
{/if}

<style>
  .between {
    justify-content: space-between;
    align-items: flex-end;
  }
  .tight {
    gap: 2px;
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
    gap: 8px;
  }
  .item:last-child {
    border-bottom: none;
  }
</style>
