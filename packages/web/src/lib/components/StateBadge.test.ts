import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { GiveawayStatus } from '../api/types.js';
import { L } from '../texts/labels.js';
import StateBadge from './StateBadge.svelte';

const STATUSES: GiveawayStatus[] = ['draft', 'open', 'paused', 'closed', 'drawn', 'completed', 'cancelled'];

describe('StateBadge', () => {
  it('renders the German word and an icon for every status', () => {
    for (const status of STATUSES) {
      const { unmount, container } = render(StateBadge, { props: { status } });
      expect(screen.getByText(L.status[status])).toBeInTheDocument();
      expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      unmount();
    }
  });
});
