<script lang="ts">
  // Einstellungen ändern (NEW_DESIGN.md 7.1: in Entwurf, Offen, Pausiert): Rahmen-Felder, Kern-Regeln, Bedingungen, Kanäle.
  import { cleanAnnouncements, validateAnnouncements } from '../announcements.js';
  import type { AnnouncementKind, GiveawaySettings, KernelInfo } from '../api/types.js';
  import { L } from '../texts/labels.js';
  import { S } from '../texts/sentences.js';
  import AnnouncementsForm from './AnnouncementsForm.svelte';
  import Button from './Button.svelte';
  import ConfigForm from './ConfigForm.svelte';
  import Field from './Field.svelte';
  import GatesForm from './GatesForm.svelte';

  interface Props {
    settings: GiveawaySettings;
    kernel: KernelInfo;
    channelOptions: { pid: string; displayName: string }[];
    /** Katalog der Chat-Ansagen; leer, solange er lädt. */
    announcementKinds?: AnnouncementKind[];
    busy: boolean;
    error: string | null;
    onsave: (partial: Partial<GiveawaySettings>) => void;
    oncancel: () => void;
  }

  let { settings, kernel, channelOptions, announcementKinds = [], busy, error, onsave, oncancel }: Props = $props();
  const id = $props.id();
  // svelte-ignore state_referenced_locally
  const start = settings;
  let prize = $state(start.prize);
  let sponsor = $state(start.sponsor ?? '');
  let keyword = $state(start.keyword ?? '');
  let contact = $state(start.contact ?? '');
  let winnersCount = $state(start.winnersCount);
  let claimDays = $state(start.claimDays);
  let counting = $state(start.counting);
  let purgeDays = $state(start.purgeDays);
  let chatEnabled = $state(start.chatBonus.enabled);
  let chatSec = $state(start.chatBonus.sec);
  let chatMinWords = $state(start.chatBonus.minWords);
  let chatCooldown = $state(start.chatBonus.cooldownSec);
  let channels = $state<string[]>([...start.channels]);
  let config = $state<Record<string, unknown>>({ ...start.config });
  let gates = $state([...start.gates]);
  let announcements = $state({ ...start.announcements, texts: { ...start.announcements.texts } });
  let announcementErrors = $state<Record<string, string>>({});
  const chosen = $derived(channelOptions.filter((c) => channels.includes(c.pid)));

  const clean = (s: string): string | null => (s.trim() === '' ? null : s.trim());

  function submit(e: SubmitEvent) {
    e.preventDefault();
    announcementErrors = validateAnnouncements(announcements, announcementKinds, kernel.id);
    if (Object.keys(announcementErrors).length > 0) return;
    onsave({
      prize: prize.trim(),
      sponsor: clean(sponsor),
      keyword: clean(keyword),
      contact: clean(contact),
      winnersCount: Math.round(winnersCount),
      claimDays: Math.round(claimDays),
      counting,
      purgeDays: Math.round(purgeDays),
      chatBonus: { enabled: chatEnabled, sec: Math.round(chatSec), minWords: Math.round(chatMinWords), cooldownSec: Math.round(chatCooldown) },
      channels,
      config,
      gates,
      announcements: cleanAnnouncements(announcements),
    });
  }
</script>

<form class="panel" onsubmit={submit}>
  <div class="panel-body stack">
    <span class="lbl">{L.actions.settings}</span>
    <span class="hint">{S.detail.settingsHint}</span>
    <div class="grid">
      <Field label={L.fields.prize} for="{id}-prize"><input id="{id}-prize" type="text" bind:value={prize} maxlength="200" required /></Field>
      <Field label={L.fields.sponsor} for="{id}-sponsor"><input id="{id}-sponsor" type="text" bind:value={sponsor} maxlength="200" /></Field>
      <Field label={L.fields.keyword} for="{id}-keyword"><input id="{id}-keyword" type="text" bind:value={keyword} maxlength="32" placeholder="!keyword" /></Field>
      <Field label={L.fields.contact} for="{id}-contact"><input id="{id}-contact" type="text" bind:value={contact} maxlength="200" /></Field>
      <Field label={L.fields.winnersCount} for="{id}-winners"><input id="{id}-winners" type="number" min="1" max="100" bind:value={winnersCount} required /></Field>
      <Field label={L.fields.claimDays} for="{id}-claim"><input id="{id}-claim" type="number" min="1" max="90" bind:value={claimDays} required /></Field>
    </div>
    <fieldset class="group">
      <legend class="lbl">{L.fields.counting}</legend>
      <label class="row"><input type="radio" name="{id}-counting" value="registered" bind:group={counting} /> {L.fields.countingRegistered}</label>
      <label class="row"><input type="radio" name="{id}-counting" value="first_seen" bind:group={counting} /> {L.fields.countingFirstSeen}</label>
      {#if counting === 'first_seen'}
        <Field label={L.fields.purgeDays} for="{id}-purge"><input id="{id}-purge" type="number" min="1" max="90" bind:value={purgeDays} /></Field>
      {/if}
    </fieldset>
    <fieldset class="group">
      <legend class="lbl">{L.fields.chatBonus}</legend>
      <label class="row"><input type="checkbox" bind:checked={chatEnabled} /> {L.fields.chatBonusEnabled}</label>
      {#if chatEnabled}
        <div class="row">
          <Field label={L.fields.chatBonusSec} for="{id}-csec"><input id="{id}-csec" type="number" min="1" max="60" bind:value={chatSec} /></Field>
          <Field label={L.fields.chatMinWords} for="{id}-cwords"><input id="{id}-cwords" type="number" min="1" max="20" bind:value={chatMinWords} /></Field>
          <Field label={L.fields.chatCooldown} for="{id}-ccool"><input id="{id}-ccool" type="number" min="1" max="600" bind:value={chatCooldown} /></Field>
        </div>
      {/if}
    </fieldset>
    <fieldset class="group">
      <legend class="lbl">{L.fields.config}</legend>
      <ConfigForm schema={kernel.configSchema} value={config} onchange={(c) => (config = c)} />
    </fieldset>
    <details class="group" open={Object.keys(announcementErrors).length > 0}>
      <summary class="lbl">{L.announcements.title}</summary>
      <AnnouncementsForm kinds={announcementKinds} kernelId={kernel.id} value={announcements} onchange={(a) => (announcements = a)} errors={announcementErrors} />
    </details>
    <fieldset class="group">
      <legend class="lbl">{L.fields.gates}</legend>
      {#key channels.join(',')}
        <GatesForm supported={kernel.supportedGates} channels={chosen} value={gates} onchange={(g) => (gates = g)} />
      {/key}
    </fieldset>
    <fieldset class="group">
      <legend class="lbl">{L.fields.channels}</legend>
      {#each channelOptions as c (c.pid)}
        <label class="row"><input type="checkbox" value={c.pid} bind:group={channels} /> {c.displayName}</label>
      {/each}
    </fieldset>
    <div class="row">
      <Button type="submit" {busy}>{L.actions.save}</Button>
      <Button kind="ghost" onclick={oncancel}>{L.actions.abort}</Button>
      {#if error}<span class="error" role="alert">{error}</span>{/if}
    </div>
  </div>
</form>

<style>
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
    gap: 8px;
  }
  legend {
    padding: 0 6px;
    color: var(--accent-2);
  }
  summary {
    cursor: pointer;
    color: var(--accent-2);
  }
</style>
