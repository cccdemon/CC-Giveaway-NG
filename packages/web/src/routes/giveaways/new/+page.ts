import { apiOf, loadOrRedirect } from '#lib/api/client.js';
import type { AnnouncementCatalog, KernelInfo, TeamDetail, TeamList } from '#lib/api/types.js';
import { requireStreamer } from '#lib/guard.js';
import type { PageLoad } from './$types';

/** Start-Assistent (NEW_DESIGN.md 11.1): Kernkatalog, Teams und ihre Mitglieder als Kanäle. */
export const load: PageLoad = async ({ parent, fetch, url }) => {
  const { me } = await parent();
  const m = requireStreamer(me, url);
  const api = apiOf(fetch);
  const [kernels, teams, announcements] = await loadOrRedirect(
    Promise.all([api.get<KernelInfo[]>('/api/kernels'), api.get<TeamList>('/api/me/teams'), api.get<AnnouncementCatalog>('/api/announcements')]),
    url,
  );
  const details = await loadOrRedirect(Promise.all(teams.teams.filter((t) => t.active).map((t) => api.get<TeamDetail>(`/api/teams/${t.teamId}`))), url);
  const members: Record<string, { pid: string; displayName: string }[]> = { [m.soloTeamId]: [{ pid: m.pid, displayName: m.displayName }] };
  for (const d of details) members[d.teamId] = d.members;
  return { me: m, kernels, teams, members, announcementKinds: announcements.kinds };
};
