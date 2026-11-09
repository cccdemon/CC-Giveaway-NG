<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons.js';

  interface Props extends HTMLButtonAttributes {
    kind?: 'primary' | 'default' | 'ghost' | 'danger';
    busy?: boolean;
    icon?: IconName;
    children?: Snippet;
  }

  let { kind = 'default', busy = false, disabled = false, type = 'button', icon, children, ...rest }: Props = $props();
</script>

<button class="btn btn-{kind}" {type} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
  {#if icon}<Icon name={icon} />{/if}
  {@render children?.()}
</button>
