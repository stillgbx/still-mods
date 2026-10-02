// still-mods: each feature lives in ../features, registers its own hooks and is switched on or off
// by its userConfig option. Adding one: a file in ../features, a field in plugin.json, a line here.
import type { Register } from 'claude-code'

import { registerPlanProgress, type Enforcement, type SoundTheme } from '../features/plan-progress'
import { registerSettings } from '../features/settings'
import { registerUsageMeters } from '../features/usage-meters'

export const register: Register = (on, options) => {
  const opts = options as { planProgress?: boolean; planEnforcement?: Enforcement; sounds?: SoundTheme; usageMeters?: boolean; timeZone?: string; language?: string }
  // always there: the /still-mods command that changes the options below
  registerSettings(on, options as Record<string, unknown>)
  // a missing value means on, the manifest's default
  if (opts.planProgress !== false) registerPlanProgress(on, { enforcement: opts.planEnforcement, language: opts.language, sounds: opts.sounds })
  if (opts.usageMeters !== false) registerUsageMeters(on, { timeZone: opts.timeZone, language: opts.language })
}
