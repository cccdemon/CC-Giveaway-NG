<script lang="ts">
  // Rechtstexte des Streamers je Giveaway (NEW_DESIGN.md 11.3): Links, Text aufklappbar.
  import type { FrozenLegal, LegalTexts } from '../api/types.js';
  import { legalView } from '../legal-view.js';
  import { L } from '../texts/labels.js';
  import { S } from '../texts/sentences.js';

  let { legal }: { legal: FrozenLegal | LegalTexts | null } = $props();
  const v = $derived(legalView(legal));
</script>

<div class="legal">
  <div class="row">
    {#if v.impressumUrl}<a href={v.impressumUrl} target="_blank" rel="noopener">{L.legal.impressum}</a>{/if}
    {#if v.termsUrl}<a href={v.termsUrl} target="_blank" rel="noopener">{L.legal.terms}</a>{/if}
    {#if v.privacyUrl}<a href={v.privacyUrl} target="_blank" rel="noopener">{L.legal.privacy}</a>{/if}
  </div>
  {#if v.termsText}
    <details>
      <summary>{S.portal.termsCollapsed}</summary>
      <p class="terms">{v.termsText}</p>
    </details>
  {/if}
</div>

<style>
  .legal {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.875rem;
  }
  .terms {
    white-space: pre-wrap;
    margin-top: 8px;
    font-size: 0.875rem;
  }
  summary {
    cursor: pointer;
  }
</style>
