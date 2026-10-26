import { afterEach, describe, expect, it } from 'vitest';
import { logRead } from '../src/audit/access-log.js';
import { runMaintenance } from '../src/scheduler/maintenance.js';
import { AT, freshDb } from './helpers/db.js';
import { ACTOR } from './helpers/fixtures.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

describe('runMaintenance', () => {
  it('creates upcoming partitions and purges old IPs', async () => {
    const db = await freshDb();
    close = db.close;
    await logRead(db.pool, { actor: ACTOR, action: 'a', target: 't', ip: '10.0.0.1', at: AT });
    const later = new Date(AT.getTime() + 40 * 86_400_000);
    const res = await runMaintenance(db.pool, later);
    expect(res).toEqual({ partitions: ['events_y2026m11', 'events_y2026m12', 'events_y2027m01'], ipsPurged: 1 });
  });
});
