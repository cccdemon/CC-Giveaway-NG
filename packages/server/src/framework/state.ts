import type { Queryable } from '../db/pool.js';
import type { EventTypeRegistry } from '../journal/event-types.js';
import { readStream } from '../journal/journal.js';
import { loadSnapshot } from '../journal/snapshots.js';
import type { StreamId } from '../journal/types.js';
import type { StreamReducer } from './command-bus.js';

/** Zustand eines Stroms: neuester passender Snapshot, danach die restlichen Ereignisse. */
export async function loadStreamState<S>(c: Queryable, registry: EventTypeRegistry, stream: StreamId, reducer: StreamReducer<S>): Promise<S> {
  const snap = await loadSnapshot<S>(c, stream, reducer);
  let state = snap ? snap.state : reducer.initial();
  for (const e of await readStream(c, registry, stream, snap?.seq ?? 0)) state = reducer.apply(state, e);
  return state;
}
