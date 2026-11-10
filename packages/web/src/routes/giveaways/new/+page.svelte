<script lang="ts">
  import { goto } from '$app/navigation';
  import { Action } from '#lib/action.svelte.js';
  import { ApiError } from '#lib/api/client.js';
  import type { CommandResult, KernelInfo, LegalTexts } from '#lib/api/types.js';
  import AnnouncementsForm from '#lib/components/AnnouncementsForm.svelte';
  import Button from '#lib/components/Button.svelte';
  import ChannelsForm from '#lib/components/ChannelsForm.svelte';
  import ConfigForm from '#lib/components/ConfigForm.svelte';
  import Field from '#lib/components/Field.svelte';
  import GatesForm from '#lib/components/GatesForm.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import LegalForm from '#lib/components/LegalForm.svelte';
  import Summary from '#lib/components/Summary.svelte';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import { STEPS, emptyDraft, legalComplete, legalMissing, stepOfRejection, toSettings, validateStep, withKernel, type Step, type WizardDraft } from '#lib/wizard.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const id = $props.id();
  let step = $state<Step>(1);
  // Startwerte aus den geladenen Daten, danach gehört der Entwurf der Person.
  // svelte-ignore state_referenced_locally
  let draft = $state<WizardDraft>({ ...emptyDraft(), teamId: data.me.soloTeamId, channels: [data.me.pid] });
  let errors = $state<Record<string, string>>({});
  let serverError = $state<string | null>(null);
  let legalApplied = $state(false);
  /** Entwurf angelegt, aber das Öffnen abgelehnt: die Meldung bleibt, der Entwurf ist verlinkt. */
  let draftId = $state<string | null>(null);
  const action = new Action();

  const kernel = $derived(data.kernels.find((k) => k.id === draft.kernelId) ?? null);
  const teamChannels = $derived((data.members[draft.teamId ?? ''] ?? []).map((m) => m.pid));
  const channelOptions = $derived((data.members[draft.teamId ?? ''] ?? []).filter((m) => draft.channels.includes(m.pid)));
  const channelNames = $derived(Object.fromEntries(Object.values(data.members).flat().map((m) => [m.pid, m.displayName])));
  const teamName = $derived(draft.teamId === data.me.soloTeamId ? L.solo : (data.teams.teams.find((t) => t.teamId === draft.teamId)?.name ?? '–'));
  const profileOk = $derived(legalComplete(data.me.legal));
  const done = $derived(STEPS.filter((s) => s < step && Object.keys(validateStep(s, draft, kernel, teamChannels, data.me.legal, data.announcementKinds)).length === 0));
  const announcementErrors = $derived(Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith('announcements.')).map(([k, v]) => [k.slice('announcements.'.length), v])));

  function chooseKernel(k: KernelInfo) {
    draft = withKernel(draft, k);
    errors = {};
  }
  function next() {
    errors = validateStep(step, draft, kernel, teamChannels, data.me.legal, data.announcementKinds);
    if (Object.keys(errors).length > 0) return;
    serverError = null;
    if (step < 6) step = (step + 1) as Step;
  }
  function back() {
    errors = {};
    serverError = null;
    if (step > 1) step = (step - 1) as Step;
  }
  function setTeam(teamId: string) {
    draft = { ...draft, teamId, channels: [], gates: draft.gates.filter((g) => g.id !== 'follow' || g.mode !== 'channel') };
  }
  function applyLegal(legal: LegalTexts) {
    draft = { ...draft, legal };
    legalApplied = true;
    errors = {};
  }
  function chooseProfile() {
    draft = { ...draft, legal: 'profile' };
    legalApplied = false;
  }

  async function submit(openNow: boolean) {
    for (const s of STEPS) {
      if (s === 6) break;
      const e = validateStep(s, draft, kernel, teamChannels, data.me.legal, data.announcementKinds);
      if (Object.keys(e).length > 0) {
        step = s;
        errors = e;
        return;
      }
    }
    serverError = null;
    action.error = null;
    try {
      const created = await action.api.post<CommandResult & { giveawayId: string }>('/api/giveaways', { teamId: draft.teamId, kernelId: draft.kernelId, settings: toSettings(draft) });
      if (openNow) {
        try {
          await action.api.post(`/api/giveaways/${created.giveawayId}/open`);
        } catch (e) {
          // Der Entwurf steht, das Öffnen nicht: Meldung hier zeigen, Entwurf verlinken. Kein Fehler bleibt still (12.1).
          if (e instanceof ApiError) {
            draftId = created.giveawayId;
            serverError = `${e.message} ${S.wizard.draftSaved}`;
            return;
          }
          throw e;
        }
      }
      await goto(`/giveaways/${created.giveawayId}`);
    } catch (e) {
      if (e instanceof ApiError) {
        step = stepOfRejection(e.code);
        serverError = e.message;
        return;
      }
      serverError = S.serverError;
    }
  }
</script>

<svelte:head><title>{L.wizard.title} · {L.brand}</title></svelte:head>

<div class="wizard">
  <nav aria-label={L.wizard.stepsLabel} class="steps">
    <ol>
      {#each STEPS as s (s)}
        <li class:current={s === step} class:done={done.includes(s)} aria-current={s === step ? 'step' : undefined}>
          <span class="mark" aria-hidden="true">
            {#if done.includes(s)}<Icon name="check" size={14} stroke={2.5} />{:else if s === step}<Icon name="dot" size={14} />{:else}<Icon name="circle" size={14} />{/if}
          </span>
          <span>{s} · {L.wizard.steps[s - 1]}</span>
        </li>
      {/each}
    </ol>
    <a href="/giveaways" class="hint">{L.actions.abort}</a>
  </nav>

  <main class="body stack">
    <div class="stack tight">
      <span class="lbl">{L.wizard.stepOf(step, STEPS.length)}{#if kernel} · {kernel.label}{/if}</span>
      <h1>{L.wizard.titles[step - 1]}</h1>
    </div>
    {#if serverError}<p class="error" role="alert">{serverError}</p>{/if}
    {#if draftId}<a class="btn" href="/giveaways/{draftId}">{L.actions.toDetail}</a>{/if}

    {#if step === 1}
      <p class="hint">{S.wizard.kernelHint}</p>
      <div class="kernels" role="radiogroup" aria-label={L.wizard.chooseKernel}>
        {#each data.kernels as k (k.id)}
          <button type="button" class="kernel" class:chosen={draft.kernelId === k.id} role="radio" aria-checked={draft.kernelId === k.id} onclick={() => chooseKernel(k)}>
            <span class="row between">
              <span class="lbl">{k.id}{#if k.display.beta} · {L.beta}{/if}</span>
              <span class="lbl">{L.wizard.drawMode[k.drawMode]}</span>
            </span>
            <strong>{k.label}</strong>
            <span class="hint">{k.usesServices.map((s) => L.wizard.services[s]).join(' · ')}</span>
          </button>
        {/each}
      </div>
      {#if errors.kernelId}<p class="error" role="alert">{errors.kernelId}</p>{/if}
    {:else if step === 2 && kernel}
      <div class="grid">
        <Field label={L.fields.prize} error={errors.prize ?? null} for="{id}-prize"><input id="{id}-prize" type="text" bind:value={draft.prize} maxlength="200" required /></Field>
        <Field label={L.fields.sponsor} error={errors.sponsor ?? null} for="{id}-sponsor"><input id="{id}-sponsor" type="text" bind:value={draft.sponsor} maxlength="200" /></Field>
        <Field label={L.fields.winnersCount} error={errors.winnersCount ?? null} for="{id}-winners"><input id="{id}-winners" type="number" min="1" max="100" bind:value={draft.winnersCount} /></Field>
        <Field label={L.fields.claimDays} error={errors.claimDays ?? null} for="{id}-claim"><input id="{id}-claim" type="number" min="1" max="90" bind:value={draft.claimDays} /></Field>
        <Field label={L.fields.contact} help={S.wizard.contactHelp} error={errors.contact ?? null} for="{id}-contact"><input id="{id}-contact" type="text" bind:value={draft.contact} maxlength="200" /></Field>
        <Field label={L.fields.keyword} help={S.wizard.keywordHelp} error={errors.keyword ?? null} for="{id}-keyword"><input id="{id}-keyword" type="text" bind:value={draft.keyword} maxlength="32" placeholder="!keyword" /></Field>
      </div>
      <fieldset class="group">
        <legend class="lbl">{L.fields.config}</legend>
        <ConfigForm schema={kernel.configSchema} value={draft.config} onchange={(c) => (draft = { ...draft, config: c })} errors={Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith('config.')).map(([k, v]) => [k.slice('config.'.length), v]))} />
      </fieldset>
      {#if kernel.usesServices.includes('watchtime')}
        <fieldset class="group">
          <legend class="lbl">{L.fields.counting}</legend>
          <label class="row"><input type="radio" name="{id}-counting" value="registered" bind:group={draft.counting} /> <span><strong>{L.fields.countingRegistered}.</strong> {S.wizard.countingRegistered}</span></label>
          <label class="row"><input type="radio" name="{id}-counting" value="first_seen" bind:group={draft.counting} /> <span><strong>{L.fields.countingFirstSeen}.</strong> {S.wizard.countingFirstSeen}</span></label>
          {#if draft.counting === 'first_seen'}
            <Field label={L.fields.purgeDays} error={errors.purgeDays ?? null} for="{id}-purge"><input id="{id}-purge" type="number" min="1" max="90" bind:value={draft.purgeDays} /></Field>
          {/if}
        </fieldset>
      {/if}
      {#if kernel.usesServices.includes('chatBonus')}
        <fieldset class="group">
          <legend class="lbl">{L.fields.chatBonus}</legend>
          <label class="row"><input type="checkbox" bind:checked={draft.chatBonus.enabled} /> {L.fields.chatBonusEnabled}</label>
          {#if draft.chatBonus.enabled}
            <div class="row">
              <Field label={L.fields.chatBonusSec} error={errors['chatBonus.sec'] ?? null} for="{id}-csec"><input id="{id}-csec" type="number" min="1" max="60" bind:value={draft.chatBonus.sec} /></Field>
              <Field label={L.fields.chatMinWords} error={errors['chatBonus.minWords'] ?? null} for="{id}-cwords"><input id="{id}-cwords" type="number" min="1" max="20" bind:value={draft.chatBonus.minWords} /></Field>
              <Field label={L.fields.chatCooldown} error={errors['chatBonus.cooldownSec'] ?? null} for="{id}-ccool"><input id="{id}-ccool" type="number" min="1" max="600" bind:value={draft.chatBonus.cooldownSec} /></Field>
            </div>
          {/if}
        </fieldset>
      {/if}
      <details class="group" open={Object.keys(announcementErrors).length > 0}>
        <summary class="lbl">{L.announcements.title}</summary>
        <AnnouncementsForm kinds={data.announcementKinds} kernelId={draft.kernelId} value={draft.announcements} onchange={(a) => (draft = { ...draft, announcements: a })} errors={announcementErrors} />
      </details>
    {:else if step === 3}
      <ChannelsForm teams={data.teams} soloTeamId={data.me.soloTeamId} members={data.members} teamId={draft.teamId} channels={draft.channels} onteam={setTeam} onchannels={(c) => (draft = { ...draft, channels: c })} error={errors.channels ?? null} />
    {:else if step === 4 && kernel}
      {#key draft.channels.join(',')}
        <GatesForm supported={kernel.supportedGates} channels={channelOptions} value={draft.gates} onchange={(g) => (draft = { ...draft, gates: g })} error={errors.gates ?? null} />
      {/key}
    {:else if step === 5}
      <p class="hint">{S.wizard.legalIntro}</p>
      <fieldset class="group">
        <legend class="lbl">{L.fields.legal}</legend>
        <label class="row">
          <input type="radio" name="{id}-legal" value="profile" checked={draft.legal === 'profile'} onchange={chooseProfile} disabled={!profileOk} />
          <span>{L.wizard.legalProfile}{#if !profileOk} · {S.wizard.profileIncomplete(legalMissing(data.me.legal).join(', '))}{/if}</span>
        </label>
        <label class="row">
          <input type="radio" name="{id}-legal" value="own" checked={draft.legal !== 'profile'} onchange={() => (draft = { ...draft, legal: draft.legal === 'profile' ? { impressumUrl: null, terms: null, privacyUrl: null } : draft.legal })} />
          <span>{L.wizard.legalOwn}</span>
        </label>
      </fieldset>
      {#if draft.legal !== 'profile'}
        <LegalForm value={draft.legal} onsubmit={applyLegal} submitLabel={L.actions.apply} saved={legalApplied} primary={false} />
      {/if}
      {#if errors.legal}<p class="error" role="alert">{errors.legal}</p>{/if}
    {:else if step === 6}
      <p>{S.wizard.reviewIntro}</p>
      <p class="hint">{S.wizard.draftHint}</p>
      <div class="row">
        <Button busy={action.busy} disabled={draftId !== null} onclick={() => submit(false)}>{L.actions.saveDraft}</Button>
        <Button kind="primary" icon="play" busy={action.busy} disabled={draftId !== null} onclick={() => submit(true)}>{L.actions.openNow}</Button>
      </div>
    {/if}

    {#if step < 6}
      <div class="row between nav">
        <Button onclick={back} disabled={step === 1}>{L.actions.back}</Button>
        <Button kind="primary" onclick={next}>{L.actions.next}: {L.wizard.steps[step as 1 | 2 | 3 | 4 | 5]}</Button>
      </div>
    {:else}
      <div class="row nav"><Button onclick={back}>{L.actions.back}</Button></div>
    {/if}
  </main>

  <Summary {draft} {kernel} {channelNames} profileLegal={data.me.legal} {teamName} />
</div>

<style>
  .wizard {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 28px;
    align-items: start;
  }
  @media (min-width: 1100px) {
    .wizard {
      grid-template-columns: 240px minmax(0, 1fr) 340px;
    }
  }
  .steps ol {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .steps li {
    padding: 8px 12px;
    display: flex;
    gap: 10px;
    align-items: center;
    color: var(--muted);
    border-left: 2px solid transparent;
  }
  .steps li.done {
    color: var(--text);
  }
  .steps li.done .mark {
    color: var(--ok);
  }
  .steps li.current {
    color: var(--text);
    font-weight: 600;
    border-left-color: var(--accent-2);
  }
  .body {
    gap: 18px;
    min-width: 0;
  }
  .tight {
    gap: 6px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
    gap: 12px 18px;
  }
  .group {
    border: 1px solid var(--border);
    padding: 12px 16px;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  legend {
    padding: 0 6px;
    color: var(--accent-2);
  }
  summary {
    cursor: pointer;
    color: var(--accent-2);
  }
  .kernels {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
    gap: 14px;
  }
  .kernel {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    text-align: left;
    cursor: pointer;
    font: inherit;
  }
  .kernel.chosen {
    border-color: var(--accent-2);
  }
  .between {
    justify-content: space-between;
  }
  .nav {
    padding-top: 8px;
  }
</style>
