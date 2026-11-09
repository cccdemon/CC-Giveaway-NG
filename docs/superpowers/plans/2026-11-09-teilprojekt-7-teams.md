# Teilprojekt 7: Teams – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mehrere Streamer bilden ein Team und steuern gemeinsam Giveaways: Team anlegen, per Einladungslink beitreten, verlassen, umbenennen, deaktivieren, team-weit sperren. Die Kanalliste eines Giveaways ist eine Teilmenge der Team-Kanäle. Ein Streamer darf in mehreren Teams sein. Das Solo-Team bleibt implizit.

**Architecture:** Neuer Strom `team:<uuid>` mit eigenem Reducer (`framework/team/`), Ereignissen, Befehlen, Umkehrung und Lesetabellen `teams`, `team_members`, `team_invites`, `team_bans`. Die Rechteprüfung der Giveaway-Befehle (`accountAuthorizer.controls`) lässt zusätzlich jedes Mitglied eines aktiven Teams zu. Der Rahmen bekommt zwei kleine Lese-Schnittstellen mit Null-Defaults: `TeamDirectory` (Kanäle und Aktivität eines Teams, für `create_giveaway`/`change_settings`) und `BanDirectory` (Sperren, für Anmeldung, `apply_signals` und Ziehung). HTTP-Routen `/teams/*` und `/me/teams`. Kein neues Prozess, kein Zeitgeber.

**Tech Stack:** TypeScript, Node 24, pg, zod, Fastify, Vitest, Testcontainers. Keine neuen Abhängigkeiten.

**Spec:** `NEW_DESIGN.md` Abschnitte 2 (Team, Kanal), 3.3, 3.4, 5.1 (Strom `team:<id>`), 5.3, 6.4, 7.1 (Kanal raus ↔ rein), 7.2, 9.1–9.3, 11.1 (nur die Befehle, keine Oberfläche), 12.2, 14 (Punkt 7), 15.3 (Bann team-weit, Mehrpersonen-Team), 15.9 (Befehl für `system:migration`).

## Global Constraints

- Jede Zustandsänderung läuft durch `CommandBus.execute`. Lesetabellen der Teams schreiben nur Projektoren in der Befehls-Transaktion.
- `events` ist append-only. Ein Strom je Befehl: Team-Befehle schreiben nur `team:<id>`, Giveaway-Befehle nur `giveaway:<id>`.
- Payloads enthalten nur `pid` und UUIDs, nie Twitch-Name oder Twitch-ID. Der Teamname ist freier Text (kein Twitch-Feld), höchstens 60 Zeichen.
- Neue Tabellen nur über `packages/server/migrations/007_teams.sql`.
- Umkehrarten je Ereignistyp deklarieren (`compensate`, `void`, `none` mit Grund), jede Umkehrung mit Grund (Spec 5.1, 5.3).
- Spec 9.3: Solo-Team automatisch, echtes Team per Einladungslink, alle Mitglieder gleichberechtigt, einladen/verlassen/umbenennen/deaktivieren, Deaktivieren löscht keine Nachweise, ein Streamer in mehreren Teams, Kanalliste ⊆ Team-Kanäle, eigenen Kanal aus laufendem Giveaway nehmen und wieder hinzufügen.
- Spec 15.9: Akteur `system:migration` darf ein Team mit vorgegebenen Mitgliedern ohne Einladung anlegen.
- UI- und Fehlertexte deutsch, aktiv, höchstens 20 Wörter, Glossar: Team, Kanal, Teilnehmer, Giveaway.
- Tests nur gegen Testcontainers. Kein Netz in Tests.
- Je Task erst den Code fertig schreiben, dann einmal `npm run typecheck`, `npm run lint`, `npm test`.

## Entscheidungen, die die Spec offen lässt (meine Festlegungen)

1. **Solo-Team bleibt implizit.** Es gibt keinen Strom für `accounts.solo_team_id`. `controls(actor, teamId)` gilt, wenn `teamId` das Solo-Team des Kontos ist oder eine Zeile in `team_members` für ein aktives Team existiert. Kein Nachziehen bestehender Konten, keine Migration. Die Oberfläche (Teilprojekt 8) zeigt das Wort „Team“ nur für echte Teams.
2. **Zustand des Team-Stroms:** `{ exists, name, active, members: Record<pid, { since, eventId }>, invites: Record<inviteId, { expiresAt, revoked }>, banned: Record<pid, { since, eventId }> }`. Reducer `team`, Version 1.
3. **Ereignisse und Umkehrarten:** `team_created { name, members }` (`none`: „Ein Team bleibt im Nachweis. Deaktiviere es.“), `team_renamed { before, after }` (`compensate`, nur wenn `after` noch gilt), `invite_created { inviteId, expiresAt }` (`compensate` → `invite_revoked`), `invite_revoked { inviteId }` (`none`: „Erzeuge eine neue Einladung.“), `member_joined { pid, inviteId | null }` (`compensate` → `member_left`, nur wenn noch Mitglied und nicht das letzte), `member_left { pid }` (`none`: „Zum Wiedereintritt braucht es eine neue Einladung.“), `team_deactivated {}` ↔ `team_reactivated {}` (`compensate`, nur wenn der Zustand noch passt), `participant_banned { pid }` ↔ `participant_unbanned { pid }` (`compensate`, nur wenn der Zustand noch passt).
4. **Einladungslink:** `inviteId` ist eine zufällige UUID (v4) und steht offen im Ereignis; der Link ist `PUBLIC_URL/teams/join/<inviteId>`. Gültig 7 Tage (`INVITE_TTL_DAYS`), mehrfach nutzbar bis Widerruf oder Ablauf. Beitritt prüft: Einladung bekannt, nicht widerrufen, nicht abgelaufen, Team aktiv, nicht schon Mitglied, Person ist nicht gesperrt. Kein Geheimnis-Hash: wer den Link hat, soll beitreten können, das ist der Zweck.
5. **Mitgliedschaft verlassen:** das letzte Mitglied kann nicht gehen (`last_member`, „Du bist das letzte Mitglied. Deaktiviere das Team.“). Verlassen entfernt keine Kanäle aus laufenden Giveaways (Nachweis), der Kanal ist danach kein Team-Kanal mehr und `change_settings` lehnt ihn ab. Der Spec-Punkt „Kanal-Markierung inaktiv“ (15.9) ist damit für Teilprojekt 9 beantwortet: ein Kanal in `giveaways.channels` ohne Mitglied = inaktiv, keine eigene Markierung.
6. **Deaktivieren:** `active = false`. Danach kein `create_giveaway` (`team_inactive`, „Dieses Team ist deaktiviert. Aktiviere es oder nutze ein anderes.“), kein Beitritt, keine Einladung. Laufende Giveaways bleiben steuerbar (pausieren, schließen, ziehen, abschließen), Nachweise bleiben. `reactivate_team` hebt es auf.
7. **Kanal raus ↔ rein** (Spec 9.3 letzter Punkt, 5.3): über den vorhandenen Befehl `change_settings` mit `channels`. Er ist in Entwurf, Offen, Pausiert erlaubt und umkehrbar (`giveaway_settings_changed`). Kein eigener Befehl. Neu: `channels` muss ⊆ Team-Kanäle sein (`channel_not_in_team`, „Dieser Kanal gehört nicht zum Team.“). Team-Kanäle = Mitglieder-pids, beim Solo-Team genau die eigene pid. Die Prüfung läuft in `prepare` über `TeamDirectory`; Default `anyChannels` (kein Verzeichnis) prüft nichts, damit bestehende Tests und Systemakteure weiterlaufen.
8. **Sperre (Spec 15.3, 5.3):** team-weit, Befehle `ban_participant`/`unban_participant` durch Mitglieder. Wirkung in jedem Giveaway des Teams: `register` lehnt ab (`banned`, „Du bist in diesem Team gesperrt.“), `planSignals` überspringt Gesperrte vollständig (keine Anmeldung, keine Gutschrift, keine Identität), die Ziehung schließt sie mit Grund `banned` aus (vor Twitch-Aufrufen, wie `not_registered`). Schon gesammelte Zeit bleibt im Journal. Fakten liefert `BanDirectory.bannedOf(db, teamId)`, Default `noBans`.
9. **Rechte der Team-Befehle:** `create_team` braucht ein vollständiges Konto (Konto, Nutzungsbedingungen, verbundener Kanal) wie Giveaway-Befehle; alle anderen Team-Befehle brauchen Mitgliedschaft in genau diesem Team (`not_member`, „Du bist kein Mitglied dieses Teams.“), `join_team` braucht ein vollständiges Konto und ist nur für die eigene pid. `system:migration` darf `create_team` mit `members` (15.9), kein anderer Akteur darf `members` übergeben. Die Umsetzung liegt in `identity/account/authorizer.ts` als `TeamAuthorizer { canFound(c, actor), isMember(c, actor, teamId) }`, Tests nutzen `allowAllTeams`.
10. **Gelöschtes Konto:** die Zeile in `team_members` bleibt (pid ist pseudonym), die Rechteprüfung verlangt ein nicht gelöschtes Konto, darum greift sie nicht mehr. Kein Team-Ereignis beim Löschen (ein Befehl schreibt einen Strom).
11. **Lesetabellen:** `teams (id, name, active, member_count, last_seq, created_at, updated_at)`, `team_members (team_id, pid, since)`, `team_invites (invite_id, team_id, expires_at, revoked)`, `team_bans (team_id, pid, since)`. Ein `StateProjector` auf Reducer `team` schreibt alle vier aus dem Zustand (Löschen und Neuschreiben je Strom wie `giveaway_participants`).
12. **Verdrahtung:** `createRuntime` registriert Team-Ereignisse, -Projektoren und -Handler (`rt.teams.*`), weil Teams Rahmen-Sache sind (Spec 3.4: `framework` = Befehle, Lebenszyklus). Neue optionale Abhängigkeiten `teamAuth` (Default `allowAllTeams`), `teamDirectory` (Default `anyChannels`), `bans` (Default `noBans`). App verdrahtet `accountTeamAuthorizer()`, `pgTeamDirectory()`, `pgBanDirectory()` aus `identity/team-directory.ts`; Scheduler und Ingest `pgBanDirectory()` und `pgTeamDirectory()` (Signale und Zeitgeber müssen Sperren kennen), `teamAuth: denyUsersTeams`.
13. **API:** `GET /me/teams` (Solo-Team plus Mitgliedschaften), `POST /teams { name }` → 201 `{ teamId }`, `GET /teams/:id` (Name, aktiv, Mitglieder als `{ pid, displayName }`, offene Einladungen, Sperren als pid), `PUT /teams/:id/name`, `POST /teams/:id/invites` → 201 `{ inviteId, url, expiresAt }`, `DELETE /teams/:id/invites/:inviteId`, `GET /teams/join/:inviteId` (Team-Name und Gültigkeit, ohne Sitzung), `POST /teams/join/:inviteId`, `POST /teams/:id/leave`, `POST /teams/:id/deactivate`, `POST /teams/:id/reactivate`, `POST /teams/:id/bans { pid }`, `DELETE /teams/:id/bans/:pid`. Ablehnungen über `rejectionToHttp`; `not_member` → 403, `team_not_found`/`invite_not_found` → 404.
14. **Nicht hier:** Oberflächen (Teilprojekt 8), Übernahme-Befehl mit Legacy-Mitgliedern jenseits `create_team { members }` (Teilprojekt 9), Plattform-Sperren und Verwarnungen (11.4, Strom `platform`, später).

## Review Focus

1. Beitritt mit abgelaufener oder widerrufener Einladung, oder in ein deaktiviertes Team: Ablehnung mit Grund, kein Ereignis. Test in Task 1.
2. Letztes Mitglied verlässt das Team: `last_member`, auch über Rückgängig von `member_joined`. Test in Task 1.
3. Giveaway mit Kanal eines Nicht-Mitglieds, Solo-Team mit fremdem Kanal, `change_settings` nach Austritt des Kanalinhabers: `channel_not_in_team`. Test in Task 3.
4. Gesperrte Person: `register` abgelehnt, Keyword im Chat wirkungslos ohne Identität, Ziehung schließt mit `banned` aus, nach `unban` geht alles wieder. Test in Task 3.
5. Deaktiviertes Team: `create_giveaway` abgelehnt, laufendes Giveaway lässt sich pausieren und ziehen, Rechteprüfung eines Mitglieds greift weiter. Test in Task 2 und 3.

---

## Dateistruktur

```
packages/server/migrations/007_teams.sql                     teams, team_members, team_invites, team_bans
packages/server/src/framework/team/state.ts                  TeamState, TEAM_EVENTS, teamStream, teamReducer
packages/server/src/framework/team/events.ts                 registerTeamEvents (Schemas, Umkehrung)
packages/server/src/framework/team/commands.ts               Befehle, TeamAuthorizer-Schnittstelle, allowAllTeams, denyUsersTeams, teamRevertHandler
packages/server/src/framework/team/projectors.ts             teamsProjector (StateProjector)
packages/server/src/framework/team/directory.ts              TeamDirectory, BanDirectory, anyChannels, noBans
packages/server/src/framework/runtime.ts                     + teamAuth, teamDirectory, bans, rt.teams
packages/server/src/framework/giveaway/lifecycle.ts          create/change_settings: prepare prüft Kanäle und Aktivität
packages/server/src/framework/giveaway/registration.ts       register: prepare prüft Sperre
packages/server/src/framework/giveaway/signals.ts            prepare liest Sperren, planSignals überspringt Gesperrte
packages/server/src/framework/giveaway/draw.ts               checkGates: Gesperrte mit Grund banned
packages/server/src/identity/account/authorizer.ts           controls mit team_members, accountTeamAuthorizer
packages/server/src/identity/team-directory.ts               pgTeamDirectory, pgBanDirectory
packages/server/src/api/teams.ts                             Routen /teams/*, /me/teams
packages/server/src/api/http.ts                              403/404-Codes ergänzen
packages/server/src/app/build-app.ts, app/main.ts, scheduler/main.ts, ingest/main.ts   Verdrahtung
packages/server/test/team.test.ts, team-integration.test.ts, api-teams.test.ts, account-authorizer.test.ts (Ergänzung)
README.md, CLAUDE.md                                         Stand Teilprojekt 7
```

---

### Task 1: Team-Strom – Zustand, Ereignisse, Befehle, Lesetabellen

**Files:**
- Create: `migrations/007_teams.sql`, `src/framework/team/state.ts`, `src/framework/team/events.ts`, `src/framework/team/commands.ts`, `src/framework/team/projectors.ts`, `src/framework/team/directory.ts`
- Modify: `src/framework/runtime.ts`, `src/journal/types.ts` (nichts: `team:<uuid>` ist schon erlaubt)
- Test: `test/team.test.ts`

**Interfaces:**
- Produces (`team/state.ts`):
  - `interface TeamState { exists: boolean; name: string; active: boolean; members: Record<Pid, { since: string; eventId: string }>; invites: Record<string, { expiresAt: string; revoked: boolean }>; banned: Record<Pid, { since: string; eventId: string }> }`
  - `TEAM_EVENTS = { created: 'team_created', renamed: 'team_renamed', inviteCreated: 'invite_created', inviteRevoked: 'invite_revoked', memberJoined: 'member_joined', memberLeft: 'member_left', deactivated: 'team_deactivated', reactivated: 'team_reactivated', banned: 'participant_banned', unbanned: 'participant_unbanned' } as const`
  - `teamStream(id): StreamId` = `team:<id>`, `teamIdOfStream(stream): string | null`, `teamReducer: StreamReducer<TeamState>` (`name: 'team'`, `version: 1`), `TEAM_NAME_MAX = 60`, `INVITE_TTL_DAYS = 7`.
- Produces (`team/events.ts`): `registerTeamEvents(registry)` mit Schemas: `team_created { name: string 1–60, members: uuid[] min 1 }`, `team_renamed { before, after }`, `invite_created { inviteId: uuid, expiresAt: iso }`, `invite_revoked { inviteId }`, `member_joined { pid, inviteId: uuid | null }`, `member_left { pid }`, `team_deactivated {}`, `team_reactivated {}`, `participant_banned { pid }`, `participant_unbanned { pid }`; Umkehrarten nach Festlegung 3. Inverse-Ablehnungen: `not_latest` („Nimm zuerst die späteren Änderungen zurück.“), `last_member`, `not_member`.
- Produces (`team/commands.ts`):
  - `interface TeamAuthorizer { canFound(c, actor): Promise<Rejection | null>; isMember(c, actor, teamId): Promise<Rejection | null> }`, `allowAllTeams`, `denyUsersTeams` (System-Akteure ja, Nutzer `no_accounts`).
  - Befehle (alle mit `teamId`, UUID-Prüfung → `invalid_id`): `createTeamHandler(auth)`: `CreateTeamCmd { teamId; name; members?: Pid[] }`, Akteur `user:<pid>` → `canFound`, `members` nur für `system:migration` (`members_reserved`, „Mitglieder vorgeben darf nur die Übernahme.“), sonst Gründer = Akteur-pid; `already_exists`; `team_name_invalid` („Der Teamname hat 1 bis 60 Zeichen.“). `renameTeamHandler`, `createInviteHandler` (`CreateInviteCmd { teamId; inviteId }`, `expiresAt = now + 7 d`, `team_inactive`), `revokeInviteHandler` (`invite_not_found`, „Diese Einladung gibt es nicht.“; schon widerrufen → `[]`), `joinTeamHandler` (`JoinTeamCmd { teamId; inviteId; pid }`, `authorize`: `authorizeSelf` + `canFound`; `decide`: `invite_not_found`, `invite_expired` („Diese Einladung ist abgelaufen. Bitte um eine neue.“), `invite_revoked`, `team_inactive`, `banned` („Du bist in diesem Team gesperrt.“), schon Mitglied → `[]`), `leaveTeamHandler` (`LeaveTeamCmd { teamId; pid }`, selbst; `not_member`, `last_member`), `deactivateTeamHandler` (schon inaktiv → `[]`), `reactivateTeamHandler`, `banParticipantHandler` (`BanCmd { teamId; pid }`; schon gesperrt → `[]`), `unbanParticipantHandler` (`not_banned`, „Diese Person ist nicht gesperrt.“), `teamRevertHandler(registry, auth)` (Mitglied des Stroms, `team_not_found` für fremde Ströme).
  - Alle Nicht-Gründungs-Befehle: `authorize` → `isMember`, `decide` zuerst `team_not_found` („Dieses Team gibt es nicht.“).
- Produces (`team/projectors.ts`): `teamsProjector(): StateProjector<TeamState>` (`name: 'teams'`, `reducer: 'team'`): `teams` upsert, dann `team_members`, `team_invites`, `team_bans` je Strom löschen und aus dem Zustand neu schreiben; `reset` ohne Strom löscht alle vier.
- Produces (`team/directory.ts`): `interface TeamDirectory { channelsOf(db, teamId): Promise<{ channels: Set<Pid>; active: boolean } | null> }` (null = unbekanntes Team, kein Solo-Team), `anyChannels` (immer null), `interface BanDirectory { bannedOf(db, teamId): Promise<Set<Pid>> }`, `noBans`.
- Produces (`runtime.ts`): `RuntimeOptions.teamAuth?`, `teamDirectory?`, `bans?`; `Runtime.teams: { create, rename, createInvite, revokeInvite, join, leave, deactivate, reactivate, ban, unban, revert }`; `Runtime.teamReducer`. `createRuntime` registriert Team-Ereignisse und `teamsProjector` nach den Giveaway-Projektoren.
- Produces (`007_teams.sql`): vier Tabellen nach Festlegung 11, `team_members (team_id, pid)` PK, Index `team_members_pid`, `team_invites` PK `invite_id`, Index `team_invites_team`, `team_bans (team_id, pid)` PK.

- [ ] **Step 1: Tests schreiben** (`setupGiveaway()` genügt: Teams hängen an der Runtime; feste IDs `TEAM`, `P1`–`P3`, `STREAMER` = Gründer-Akteur)

```ts
// team.test.ts
it('create_team writes team_created with the founder as only member and projects teams + team_members', ...);
it('create_team rejects a second create, an invalid name (empty, 61 chars) and members from a user; system:migration may pass members', ...);
it('rename writes before/after, revert restores the old name, revert of an older rename is not_latest', ...);
it('invite → join adds the member with inviteId, second join is a no-op, projection lists both members and the invite', ...);
it('join rejects: unknown invite, revoked invite, expired invite (now ≥ expiresAt), inactive team, banned pid; nothing is written', ...);   // Review Focus 1
it('leave removes a member; the last member gets last_member; revert of member_joined for the last member is last_member too', ...);   // Review Focus 2
it('deactivate/reactivate toggle active, repeated calls write nothing, revert of deactivated reactivates; invites and joins fail while inactive', ...);
it('ban/unban toggle team_bans, revert of participant_banned unbans, unban of a non-banned pid is not_banned', ...);
it('payloads of the whole team stream contain no login or twitch id', ...);
it('team commands by a non-member are rejected through the authorizer (denyUsersTeams: no_accounts)', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen** (`npm run typecheck`, `npm run lint`, `npm test`)
- [ ] **Step 5: Commit** `feat(team): Strom team mit Einladung, Mitgliedern, Deaktivierung und Sperren`

---

### Task 2: Rechte – Mitglieder steuern Team-Giveaways

**Files:**
- Modify: `src/identity/account/authorizer.ts`
- Test: `test/account-authorizer.test.ts`

**Interfaces:**
- Consumes: Tabellen `team_members`, `teams` (Task 1), `rt.teams.create`/`join` zum Aufbau.
- Produces (`authorizer.ts`):
  - `accountAuthorizer().controls`: nach den Konto-Prüfungen (Konto, nicht gelöscht, Nutzungsbedingungen, Kanal) gilt `teamId === solo_team_id` oder `EXISTS team_members JOIN teams WHERE team_id = $teamId AND pid = $pid` (auch bei `teams.active = false`, Festlegung 6). Sonst `not_your_team` wie bisher. Reihenfolge: erst Konto-Prüfungen, dann Team, damit die Texte „Akzeptiere zuerst…“ unverändert bleiben.
  - `accountTeamAuthorizer(): TeamAuthorizer`: `canFound` = dieselben Konto-Prüfungen (Konto, Nutzungsbedingungen, Kanal); `isMember` = Konto nicht gelöscht und Zeile in `team_members`, sonst `not_member`.

- [ ] **Step 1: Tests schreiben**

```ts
// account-authorizer.test.ts: ergänzen (zwei Konten ALICE/BOB, Team über rt.teams mit teamAuth: allowAllTeams)
it('a member of a real team controls its giveaways, a non-member gets not_your_team, a member of a deactivated team still controls', ...);   // Review Focus 5
it('accountTeamAuthorizer: canFound needs account, terms and channel; isMember needs a team_members row; a deleted account loses both', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(identity): Mitglieder echter Teams steuern Team-Giveaways`

---

### Task 3: Giveaway-Anbindung – Kanäle des Teams, Sperren

**Files:**
- Create: `src/identity/team-directory.ts`
- Modify: `src/framework/giveaway/lifecycle.ts`, `src/framework/giveaway/registration.ts`, `src/framework/giveaway/signals.ts`, `src/framework/giveaway/draw.ts`, `src/framework/runtime.ts`
- Test: `test/team-integration.test.ts`

**Interfaces:**
- Consumes: `TeamDirectory`, `BanDirectory` (Task 1), `GiveawayDeps`.
- Produces (`identity/team-directory.ts`): `pgTeamDirectory(): TeamDirectory` – Solo-Team: `SELECT pid FROM accounts WHERE solo_team_id = $1 AND NOT deleted` → `{ channels: {pid}, active: true }`; echtes Team: `teams.active` und `team_members.pid`; sonst null. `pgBanDirectory(): BanDirectory` – `SELECT pid FROM team_bans WHERE team_id = $1`.
- Produces (`lifecycle.ts`): `GiveawayDeps.teams: TeamDirectory` (Runtime setzt den Default `anyChannels`). `createGiveawayHandler` und `changeSettingsHandler` bekommen `prepare(c, cmd, ctx, _pre, state)`: lädt `teams.channelsOf(c, teamId)`; `decide` (mit `prepared`): Verzeichnis liefert null → keine Prüfung; `active === false` bei `create` → `team_inactive`; ein Kanal außerhalb `channels` → `channel_not_in_team`. Bei `change_settings` ohne `channels` im Befehl keine Prüfung (Kanäle eines ausgetretenen Mitglieds bleiben, Festlegung 5).
- Produces (`registration.ts`): `GiveawayDeps.bans: BanDirectory`; `registerHandler` mit `prepare` → `bans.bannedOf(c, state.teamId)`; `decide`: gesperrt → `banned`. `withdraw` unverändert.
- Produces (`signals.ts`): `ResolvedSignals.banned: Pid[]`; `prepare` liest `bans.bannedOf`; `planSignals(…, banned: ReadonlySet<Pid>)` filtert Gesperrte aus Chat und Anwesenheit vor allen Schritten (dadurch plant `prepare` für sie keine Identität).
- Produces (`draw.ts`): `checkGates` liest `d.bans.bannedOf(db, state.teamId)` und setzt Gesperrte wie Unangemeldete auf `{ ok: false, reasons: ['banned'] }` ohne Twitch-Aufruf; `withRegistration` lässt `banned` vor `not_registered`.
- Produces (`runtime.ts`): `teamDirectory`, `bans` in `GiveawayDeps`; `app/main.ts` verdrahtet `pgTeamDirectory()`, `pgBanDirectory()`, `accountTeamAuthorizer()`; `scheduler/main.ts`, `ingest/main.ts` verdrahten `pgTeamDirectory()`, `pgBanDirectory()`, `teamAuth: denyUsersTeams`.

- [ ] **Step 1: Tests schreiben** (`setupGiveaway({ teamDirectory: pgTeamDirectory(), bans: pgBanDirectory() })` plus `attachAccounts` für Konten; Team über `rt.teams`)

```ts
// team-integration.test.ts
it('create_giveaway accepts channels of members, rejects a non-member channel with channel_not_in_team; solo team accepts only the own pid', ...);   // Review Focus 3
it('after a member leaves, change_settings with their channel is channel_not_in_team, without channels it still works', ...);
it('create_giveaway in a deactivated team is team_inactive; pause, close and draw of the running giveaway still work', ...);   // Review Focus 5
it('banned pid: register → banned, keyword in chat writes nothing and creates no identity, presence credits nothing; after unban all three work', ...);   // Review Focus 4
it('draw excludes a banned pid with reason banned before not_registered and without a gate check', ...);
it('without directories (anyChannels, noBans) nothing changes: foreign channels and unknown teams pass as before', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(giveaway): Kanäle nur aus dem Team, team-weite Sperre in Anmeldung, Signalen und Ziehung`

---

### Task 4: HTTP-Routen für Teams

**Files:**
- Create: `src/api/teams.ts`
- Modify: `src/api/http.ts`, `src/app/build-app.ts`
- Test: `test/api-teams.test.ts`

**Interfaces:**
- Consumes: `rt.teams.*`, `requireSession`, `rejectionToHttp`, `findIdentity`/`displayNameOf`, Lesetabellen.
- Produces (`api/teams.ts`): `registerTeamRoutes(app, deps, pool)` mit den Routen aus Festlegung 13. `GET /me/teams` → `{ solo: { teamId }, teams: [{ teamId, name, active, memberCount }] }`. `GET /teams/:id` nur für Mitglieder (sonst 403 `not_member`) → `{ teamId, name, active, members: [{ pid, displayName }], invites: [{ inviteId, expiresAt }] (nur offene), banned: [pid] }`. `POST /teams` erzeugt `teamId = randomUUID()`. `POST /teams/:id/invites` erzeugt `inviteId = randomUUID()`, Antwort `{ inviteId, url: \`${publicUrl}/teams/join/${inviteId}\`, expiresAt }`. `GET /teams/join/:inviteId` ohne Sitzung → `{ teamId, name, valid: boolean }` oder 404 `invite_not_found`. `POST /teams/join/:inviteId` löst `teamId` über `team_invites` auf und führt `join` als `user:<pid>` aus → 204.
- Produces (`http.ts`): `FORBIDDEN` + `not_member`, `members_reserved`; `_not_found` deckt `team_not_found`, `invite_not_found` schon ab.
- Produces (`build-app.ts`): `registerTeamRoutes` nach `registerMeRoutes`.

- [ ] **Step 1: Tests schreiben** (`setupApi()`, `login(s, ALICE)`, `login(s, BOB)`, Konten über `/me/terms` und `connect`)

```ts
// api-teams.test.ts
it('POST /teams creates a team, GET /me/teams lists solo and the team, GET /teams/:id shows members with display names', ...);
it('invite link: POST invites returns url and expiresAt, GET join shows name and valid, BOB joins via POST and appears as member', ...);
it('a non-member gets 403 not_member on GET /teams/:id and on rename; unknown team is 404', ...);
it('leave, deactivate, reactivate, ban and unban run through the bus and show in GET /teams/:id', ...);
it('without terms or channel POST /teams is rejected with the account texts (400)', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(api): Team-Routen, Einladungslink, Sperren`

---

### Task 5: Doku und Gesamtprüfung

**Files:**
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- README „Begriffe“: `Team` (Solo-Team implizit, echtes Team per Link, alle gleichberechtigt), `Einladung` (Link mit `inviteId`, 7 Tage, mehrfach, Widerruf), `Sperre` (team-weit, Wirkung in Anmeldung, Signalen, Ziehung), `Teilprojekt`: 1 bis 7 fertig. README „Prozesse“ → app: Routen `/teams/*`, `/me/teams`.
- CLAUDE.md: Pflichtlektüre: 1–7 fertig, als Nächstes 8 (Oberflächen). Architektur: Abschnitt **Teams** (`framework/team/`, Strom, Lesetabellen, `TeamDirectory`/`BanDirectory`, Rechte über `team_members`, Festlegungen 1, 5, 7, 8).

- [ ] **Step 1: Doku schreiben**
- [ ] **Step 2: Alles prüfen** (`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`; App gegen den Dev-Stack starten, `/healthz`, über die Runtime ein Team anlegen, zweites Konto per Einladung beitreten lassen, Giveaway mit beiden Kanälen anlegen, `team_members` und `giveaways.channels` in der Datenbank sehen)
- [ ] **Step 3: Commit** `docs: Teams, Stand Teilprojekt 7`

---

## Selbstprüfung gegen die Spec

- 2 Glossar Team, Kanal → Task 1, README in Task 5.
- 5.1 Strom `team:<id>` (Mitglieder, Kanäle, Einstellungen) → Task 1. Kanäle = Mitglieder-pids (Festlegung 7).
- 5.3 Umkehrbarkeit je Typ, Grund Pflicht → Task 1. Bann ↔ Entbannung `compensate` → Task 1.
- 6.4 Anmeldung: Sperre blockt → Task 3.
- 7.1 Kanal raus ↔ rein über `change_settings` → Task 3 (Festlegung 7).
- 7.2 Ziehung filtert Gesperrte mit Grund → Task 3.
- 9.1–9.2 unverändert, `create_team` verlangt das Onboarding → Task 2.
- 9.3 Solo-Team automatisch (bestehend), Einladungslink, gleichberechtigt, einladen/verlassen/umbenennen/deaktivieren, kein Löschen von Nachweisen, mehrere Teams je Streamer, Kanalliste ⊆ Team, eigener Kanal raus/rein → Task 1, 2, 3, 4.
- 11.1 Team-Ansicht: Daten über `/teams/:id`, Oberfläche Teilprojekt 8.
- 12.2 Tests: Strom-Tests, Rechte, Integration über den Bus, API → Task 1–4.
- 15.3 Bann team-weit, Mehrpersonen-Team → Task 1. 15.9 `system:migration` legt Team mit Mitgliedern an → Task 1; Kanal-Markierung „inaktiv“ = Kanal ohne Mitglied (Festlegung 5).
- Offen für Teilprojekt 8: Streamermodus-Maskierung der Mitgliedsnamen, Einladungsseite. Offen für Teilprojekt 9: Kanal „ohne Verbindung“ ergibt sich aus `accounts.channel_connected`.
