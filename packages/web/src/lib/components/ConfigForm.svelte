<script lang="ts">
  // Formular aus configSchema (NEW_DESIGN.md 4): int mit Bereich (Sekunden als Minuten), bool als Schalter, text mit Höchstlänge.
  import type { ConfigField } from '../api/types.js';
  import { L } from '../texts/labels.js';
  import Field from './Field.svelte';

  interface Props {
    schema: Record<string, ConfigField>;
    value: Record<string, unknown>;
    onchange: (value: Record<string, unknown>) => void;
    errors?: Record<string, string>;
  }

  let { schema, value, onchange, errors = {} }: Props = $props();
  const id = $props.id();

  const set = (key: string, v: unknown) => onchange({ ...value, [key]: v });
  const numOf = (e: Event): number => Number((e.currentTarget as HTMLInputElement).value);
  const intValue = (key: string): number => (typeof value[key] === 'number' ? (value[key] as number) : 0);
</script>

<div class="config">
  {#each Object.entries(schema) as [key, f] (key)}
    {#if f.kind === 'int'}
      {#if f.unit === 'sec'}
        <Field label={f.label} help={`${f.help} ${L.wizard.inMinutes}`} error={errors[key] ?? null} for="{id}-{key}">
          <input id="{id}-{key}" type="number" min={Math.ceil(f.min / 60)} max={Math.floor(f.max / 60)} step="1" value={Math.round(intValue(key) / 60)} oninput={(e) => set(key, Math.round(numOf(e)) * 60)} />
        </Field>
      {:else}
        <Field label={f.label} help={f.unit === 'coins' ? `${f.help} ${L.wizard.inCoins}` : f.help} error={errors[key] ?? null} for="{id}-{key}">
          <input id="{id}-{key}" type="number" min={f.min} max={f.max} step="1" value={intValue(key)} oninput={(e) => set(key, Math.round(numOf(e)))} />
        </Field>
      {/if}
    {:else if f.kind === 'bool'}
      <div class="field">
        <label class="row">
          <input type="checkbox" checked={value[key] === true} onchange={(e) => set(key, (e.currentTarget as HTMLInputElement).checked)} />
          <span>{f.label}</span>
        </label>
        <span class="hint">{f.help}</span>
        {#if errors[key]}<span class="error" role="alert">{errors[key]}</span>{/if}
      </div>
    {:else}
      <Field label={f.label} help={f.help} error={errors[key] ?? null} for="{id}-{key}">
        <input id="{id}-{key}" type="text" maxlength={f.maxLength} value={typeof value[key] === 'string' ? (value[key] as string) : ''} oninput={(e) => set(key, (e.currentTarget as HTMLInputElement).value)} />
      </Field>
    {/if}
  {/each}
</div>

<style>
  .config {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
    gap: 12px 18px;
  }
</style>
