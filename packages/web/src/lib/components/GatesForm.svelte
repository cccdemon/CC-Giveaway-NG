<script lang="ts">
  // Bedingungen (NEW_DESIGN.md 6.5): Follow mit drei Modi, Mindestalter Konto, Mindestalter Follow, Anwesenheit. Nur unterstützte Bedingungen.
  import type { GateConfig, GateId } from '../api/types.js';
  import { L } from '../texts/labels.js';
  import { S } from '../texts/sentences.js';

  interface Props {
    supported: GateId[];
    channels: { pid: string; displayName: string }[];
    value: GateConfig[];
    onchange: (gates: GateConfig[]) => void;
    error?: string | null;
  }

  let { supported, channels, value, onchange, error = null }: Props = $props();
  const id = $props.id();

  // Startwerte aus value, danach führt das Formular. Die Seite baut es per {#key} neu auf, wenn sich die Kanäle ändern.
  // svelte-ignore state_referenced_locally
  const start = value;
  const followStart = start.find((g): g is Extract<GateConfig, { id: 'follow' }> => g.id === 'follow');
  const accountStart = start.find((g): g is Extract<GateConfig, { id: 'account_age' }> => g.id === 'account_age');
  const followAgeStart = start.find((g): g is Extract<GateConfig, { id: 'follow_age' }> => g.id === 'follow_age');
  const presenceStart = start.find((g): g is Extract<GateConfig, { id: 'presence' }> => g.id === 'presence');

  let follow = $state(followStart !== undefined);
  let followMode = $state<'all' | 'min' | 'channel'>(followStart?.mode ?? 'all');
  // svelte-ignore state_referenced_locally
  let followMin = $state(followStart?.min ?? Math.min(2, Math.max(1, channels.length)));
  // svelte-ignore state_referenced_locally
  let followChannel = $state(followStart?.channel ?? channels[0]?.pid ?? '');
  let accountAge = $state(accountStart !== undefined);
  let accountDays = $state(accountStart?.days ?? 30);
  let followAge = $state(followAgeStart !== undefined);
  let followAgeDays = $state(followAgeStart?.days ?? 7);
  let presence = $state(presenceStart !== undefined);
  // svelte-ignore state_referenced_locally
  let presenceMin = $state(presenceStart?.minChannels ?? Math.min(2, Math.max(1, channels.length)));

  const has = (g: GateId) => supported.includes(g);

  function emit() {
    const out: GateConfig[] = [];
    if (has('follow') && follow) {
      if (followMode === 'all') out.push({ id: 'follow', mode: 'all' });
      else if (followMode === 'min') out.push({ id: 'follow', mode: 'min', min: Math.round(followMin) });
      else out.push({ id: 'follow', mode: 'channel', channel: followChannel });
    }
    if (has('account_age') && accountAge) out.push({ id: 'account_age', days: Math.round(accountDays) });
    if (has('follow_age') && followAge) out.push({ id: 'follow_age', days: Math.round(followAgeDays) });
    if (has('presence') && presence) out.push({ id: 'presence', minChannels: Math.round(presenceMin) });
    onchange(out);
  }
</script>

<div class="gates">
  <span class="hint">{S.wizard.gatesIntro}</span>
  {#if has('follow')}
    <fieldset class="gate">
      <legend class="lbl">{L.gates.follow}</legend>
      <label class="row"><input type="checkbox" bind:checked={follow} onchange={emit} /> <strong>{L.gates.follow} {L.gates.required}</strong></label>
      {#if follow}
        <div class="row indent">
          <label class="row"><input type="radio" name="{id}-fmode" value="all" bind:group={followMode} onchange={emit} /> {L.gates.followAllOption}</label>
          <label class="row">
            <input type="radio" name="{id}-fmode" value="min" bind:group={followMode} onchange={emit} /> {L.gates.followMinOption}
          </label>
          <input type="number" min="1" max={channels.length} bind:value={followMin} oninput={emit} aria-label="{L.gates.followMinOption} {L.gates.channelsSuffix}" disabled={followMode !== 'min'} />
          <span>{L.gates.channelsSuffix}</span>
          <label class="row"><input type="radio" name="{id}-fmode" value="channel" bind:group={followMode} onchange={emit} /> {L.gates.followChannelOption}</label>
          <select bind:value={followChannel} onchange={emit} aria-label={L.fields.channel} disabled={followMode !== 'channel'}>
            {#each channels as c (c.pid)}<option value={c.pid}>{c.displayName}</option>{/each}
          </select>
        </div>
      {/if}
    </fieldset>
  {/if}
  {#if has('account_age') || has('follow_age')}
    <fieldset class="gate">
      <legend class="lbl">{L.gates.accountAgeTitle} · {L.gates.followAgeTitle}</legend>
      {#if has('account_age')}
        <div class="row">
          <label class="row"><input type="checkbox" bind:checked={accountAge} onchange={emit} /> {L.gates.accountAgeTitle}</label>
          <input type="number" min="1" max="3650" bind:value={accountDays} oninput={emit} aria-label="{L.gates.accountAgeTitle} {L.fields.days}" disabled={!accountAge} />
          <span>{L.fields.days}</span>
        </div>
      {/if}
      {#if has('follow_age')}
        <div class="row">
          <label class="row"><input type="checkbox" bind:checked={followAge} onchange={emit} /> {L.gates.followAgeTitle}</label>
          <input type="number" min="1" max="3650" bind:value={followAgeDays} oninput={emit} aria-label="{L.gates.followAgeTitle} {L.fields.days}" disabled={!followAge} />
          <span>{L.fields.days}</span>
        </div>
      {/if}
      <span class="hint">{S.wizard.ageHint}</span>
    </fieldset>
  {/if}
  {#if has('presence')}
    <fieldset class="gate">
      <legend class="lbl">{L.gates.presenceTitle}</legend>
      <div class="row">
        <label class="row"><input type="checkbox" bind:checked={presence} onchange={emit} /> {L.gates.presenceTitle}</label>
        <input type="number" min="1" max={channels.length} bind:value={presenceMin} oninput={emit} aria-label="{L.gates.presenceTitle} {L.fields.minChannels}" disabled={!presence} />
        <span>{L.gates.channelsSuffix}</span>
      </div>
      <span class="hint">{S.wizard.presenceHint}</span>
    </fieldset>
  {/if}
  {#if error}<span class="error" role="alert">{error}</span>{/if}
</div>

<style>
  .gates {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .gate {
    border: 1px solid var(--border);
    padding: 14px 18px;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  legend {
    padding: 0 6px;
    color: var(--accent-2);
  }
  .indent {
    padding-left: 28px;
  }
  input[type='number'] {
    width: 5em;
  }
</style>
