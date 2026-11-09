<script lang="ts">
  // Ziehung (NEW_DESIGN.md 7.2): vor der Ziehung die Vorschau des Topfs, danach der Nachweis mit Gewinnern, Bedingungen und Ausschlüssen.
  import type { GiveawayDetail, ParticipantView, WinnerStatus } from '../api/types.js';
  import { dateTime, number, percent } from '../format.js';
  import { reasonText } from '../gate-text.js';
  import { L } from '../texts/labels.js';
  import { S } from '../texts/sentences.js';
  import Button from './Button.svelte';
  import Confirm from './Confirm.svelte';
  import Name from './Name.svelte';
  import WinnerStatusSelect from './WinnerStatusSelect.svelte';

  interface Props {
    detail: GiveawayDetail;
    rows: ParticipantView[];
    busy: boolean;
    error: string | null;
    onwinnerstatus: (pid: string, status: WinnerStatus) => void;
    onredraw: (pid: string, reason: string) => void;
  }

  let { detail, rows, busy, error, onwinnerstatus, onredraw }: Props = $props();
  let redrawing = $state<string | null>(null);

  const nameOf = (pid: string) => rows.find((r) => r.pid === pid)?.displayName ?? L.participant.deletedWith(pid);
  const pool = $derived(rows.filter((r) => r.inPool).sort((a, b) => b.weight - a.weight));
  const notInPool = $derived(rows.length - pool.length);
  const unit = $derived(detail.kernel.display.unit);
  const canRedraw = $derived(detail.status === 'drawn');
</script>

{#if detail.draw}
  <section class="panel" aria-label={L.detail.proof}>
    <div class="panel-body">
      <span class="lbl">{L.detail.proof} · {dateTime(detail.draw.at)}</span>
      <h2>{L.detail.winners}</h2>
      <ul class="plain">
        {#each detail.winners as w (w.pid)}
          <li class="row between">
            <span class="winner"><Name pid={w.pid} displayName={w.displayName} /></span>
            <span class="row">
              <WinnerStatusSelect value={w.status} disabled={busy || detail.status !== 'drawn'} onchange={(s) => onwinnerstatus(w.pid, s)} />
              {#if canRedraw}<Button kind="ghost" onclick={() => (redrawing = w.pid)}>{L.actions.redraw}</Button>{/if}
            </span>
          </li>
        {/each}
      </ul>
      {#if redrawing}
        <Confirm
          title={L.actions.redraw}
          text={`${S.draw.redrawFor(nameOf(redrawing))} ${S.confirm.redraw}`}
          reason
          confirmLabel={L.actions.redraw}
          {busy}
          onconfirm={(reason) => {
            const pid = redrawing!;
            redrawing = null;
            onredraw(pid, reason ?? '');
          }}
          oncancel={() => (redrawing = null)}
        />
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <details>
        <summary>{L.detail.gatesChecked} · {L.detail.poolCount(detail.draw.pool.length)}</summary>
        <div class="table-wrap">
          <table>
            <thead><tr><th>{L.columns.participant}</th><th class="num">{L.columns.weight}</th><th>{L.columns.gates}</th></tr></thead>
            <tbody>
              {#each detail.draw.gates as g (g.pid)}
                <tr>
                  <td><Name pid={g.pid} displayName={nameOf(g.pid)} /></td>
                  <td class="num">{number(detail.draw.pool.find((p) => p.pid === g.pid)?.weight ?? 0)}</td>
                  <td class={g.ok ? 'tone-ok' : 'tone-warn'}>{g.ok ? L.gates.ok : g.reasons.map((r) => reasonText(r, detail.channels)).join(', ')}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="hint">
          {L.detail.excluded}: {detail.draw.excluded.length === 0 ? S.draw.excludedNone : detail.draw.excluded.map(nameOf).join(', ')}
        </p>
        <p class="hint mono">{L.detail.mode} {detail.draw.mode} · {L.detail.random} {detail.draw.random.join(', ')} · {L.detail.poolHash} {detail.draw.poolHash}</p>
        <p class="hint">{S.draw.proofHint}</p>
      </details>
    </div>
  </section>
{:else if detail.status === 'closed' || detail.status === 'open' || detail.status === 'paused'}
  <section class="panel" aria-label={L.detail.preview}>
    <div class="panel-body">
      <span class="lbl">{L.detail.preview}</span>
      <span>{S.draw.winnersCount(detail.settings.winnersCount)} {S.draw.previewHint}</span>
      {#if pool.length === 0}
        <p class="hint">{detail.kernel.display.emptyPool}</p>
      {:else}
        <div class="table-wrap">
          <table>
            <thead><tr><th>{L.columns.participant}</th><th class="num">{L.columns.weight}</th><th class="num">{L.columns.chance}</th></tr></thead>
            <tbody>
              {#each pool as r (r.pid)}
                <tr>
                  <td><Name pid={r.pid} displayName={r.displayName} /></td>
                  <td class="num">{unit ? `${number(r.weight)} ${unit}` : number(r.weight)}</td>
                  <td class="num">{percent(r.chance)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      {#if notInPool > 0}<span class="hint">{S.draw.notInPool(notInPool)}</span>{/if}
    </div>
  </section>
{/if}

<style>
  .plain {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .between {
    justify-content: space-between;
  }
  .winner {
    font-weight: 600;
  }
  details {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  summary {
    cursor: pointer;
    margin-bottom: 8px;
  }
</style>
