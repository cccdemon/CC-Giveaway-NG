// Kern-Befehle über kernel.decide (NEW_DESIGN.md 4, 7.1). Der Rahmen prüft Rechte und Zustand, der Kern entscheidet.
import type pg from 'pg';
import type { KernelCommand } from '../../kernel-api/index.js';
import type { NewEvent } from '../../journal/types.js';
import { isRejection, reject, type Rejection } from '../../shared/rejection.js';
import type { CommandContext, CommandHandler } from '../command-bus.js';
import { GIVEAWAY_NOT_FOUND, authorizeSelf, loadGiveawayRow } from './authorize.js';
import type { GiveawayDeps } from './lifecycle.js';
import { giveawayStream, type GiveawayState } from './state.js';

export interface KernelCommandCmd {
  giveawayId: string;
  command: KernelCommand;
}

const UNKNOWN_COMMAND = (label: string): Rejection => reject('unknown_command', `Diesen Befehl kennt der Kern ${label} nicht.`);

export function kernelCommandHandler(d: GiveawayDeps): CommandHandler<KernelCommandCmd, GiveawayState> {
  async function authorize(cmd: KernelCommandCmd, ctx: CommandContext, c: pg.PoolClient): Promise<Rejection | null> {
    const row = await loadGiveawayRow(c, cmd.giveawayId);
    if (!row) return GIVEAWAY_NOT_FOUND();
    const kernel = d.kernels.get(row.kernel);
    const spec = kernel.commands.find((s) => s.type === cmd.command?.type);
    if (!spec) return UNKNOWN_COMMAND(kernel.label);
    switch (spec.issuer) {
      case 'participant':
        return authorizeSelf(cmd.command.pid, ctx.actor, 'Du kannst diesen Befehl nur für dich selbst ausführen.');
      case 'streamer':
        return d.auth.controls(c, ctx.actor, row.teamId);
      case 'scheduler':
        return ctx.actor === 'system:scheduler' ? null : d.auth.controls(c, ctx.actor, row.teamId);
    }
  }

  return {
    type: 'kernel_command',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize,
    decide(state, cmd, ctx) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (state.status !== 'open') return reject('not_open', 'Kern-Befehle gehen nur, solange das Giveaway offen ist.');
      const kernel = d.kernels.get(state.kernelId);
      if (!kernel.decide) return UNKNOWN_COMMAND(kernel.label);
      const out = kernel.decide(state.kernelState, cmd.command, state.settings.config, ctx.now.toISOString());
      if (isRejection(out)) return out;
      return out.map((e): NewEvent => {
        if (!e.type.startsWith(`${kernel.id}_`)) {
          throw new Error(`Der Kern ${kernel.id} hat ein fremdes Ereignis erzeugt: ${e.type}`);
        }
        return { type: e.type, payload: e.payload };
      });
    },
  };
}
