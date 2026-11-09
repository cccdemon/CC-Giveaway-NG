<script lang="ts">
  // Teilnehmer-Name, im Streamermodus maskiert (NEW_DESIGN.md 11.1). Für Kanalnamen nicht nutzen.
  import { maskName, streamerMode } from '../mask.js';

  let { pid, displayName }: { pid: string; displayName: string } = $props();
</script>

<span class="name">{$streamerMode ? maskName(pid) : displayName}</span>
