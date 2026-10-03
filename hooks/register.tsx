// still-mods: each feature lives in ../features, registers its own hooks and is switched on or off
// by its userConfig option. Adding one: a file in ../features, a field in plugin.json, a line here.
import type { Register } from 'claude-code'

import { type AgentsMode, registerAgents } from '../features/agents'
import { registerGitStatus } from '../features/git-status'
import { registerTurnNotify } from '../features/turn-notify'
import type { PaletteName } from '../features/palettes'
import { registerPlanProgress, type Enforcement, type SoundTheme } from '../features/plan-progress'
import { registerSettings } from '../features/settings'
import { registerUsageMeters } from '../features/usage-meters'

export const register: Register = (on, options) => {
  const opts = options as { planProgress?: boolean; planEnforcement?: Enforcement; sounds?: SoundTheme; usageMeters?: boolean; gitStatus?: boolean; cacheMeter?: boolean; cacheTtl?: '5m' | '1h'; turnNotify?: boolean; turnNotifySeconds?: number; timeZone?: string; language?: string; palette?: PaletteName; agentsPane?: AgentsMode; agentsSessionsDir?: string }
  // always there: the /still-mods command that changes the options below
  registerSettings(on, options as Record<string, unknown>)
  // a missing value means on, the manifest's default
  if (opts.planProgress !== false) registerPlanProgress(on, { enforcement: opts.planEnforcement, language: opts.language, sounds: opts.sounds, palette: opts.palette })
  if (opts.agentsPane !== 'off') registerAgents(on, { mode: opts.agentsPane, sessionsDir: opts.agentsSessionsDir, language: opts.language, palette: opts.palette, timeZone: opts.timeZone })
  if (opts.turnNotify !== false) registerTurnNotify(on, { seconds: opts.turnNotifySeconds, sounds: opts.sounds, language: opts.language })
  if (opts.gitStatus !== false) registerGitStatus(on, { language: opts.language })
  if (opts.usageMeters !== false) registerUsageMeters(on, { timeZone: opts.timeZone, language: opts.language, palette: opts.palette, cacheMeter: opts.cacheMeter, cacheTtl: opts.cacheTtl })
}
