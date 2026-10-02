// Labels in the person's language. The `language` option picks it; `auto` follows Claude Code's own
// `language` setting, then the system locale. Pure functions: each feature reads the settings itself
// and hands the result to resolveLocale, since `$` never crosses a file.

export type Locale = 'en' | 'fr'

const STRINGS = {
  en: {
    done: 'Done',
    tasks: 'Tasks',
    agents: 'Agents',
    progress: 'Progress',
    needsApproval: 'Needs approval',
    stopped: 'Stopped',
    failed: 'Failed',
    moreAgents: (n: number) => `+${n} more agent${n === 1 ? '' : 's'}`,
    nDone: (n: number) => `${n} done`,
    pluginOn: 'still-mods is on. A bar appears when Claude starts a task with several steps.',
    resetsIn: (d: string) => `↻ ${d}`,
    waiting: 'waiting for a response',
    ctx: 'Context',
    fiveHour: 'Session',
    sevenDay: 'Week',
  },
  fr: {
    done: 'Terminé',
    tasks: 'Tâches',
    agents: 'Agents',
    progress: 'Progression',
    needsApproval: 'Approbation requise',
    stopped: 'Arrêté',
    failed: 'Échec',
    moreAgents: (n: number) => `+${n} autre${n === 1 ? '' : 's'} agent${n === 1 ? '' : 's'}`,
    nDone: (n: number) => `${n} terminé${n === 1 ? '' : 's'}`,
    pluginOn: 'still-mods est actif. Une barre apparaît quand Claude lance une tâche en plusieurs étapes.',
    resetsIn: (d: string) => `↻ ${d}`,
    waiting: 'en attente d’une réponse',
    ctx: 'Contexte',
    fiveHour: 'Session',
    sevenDay: 'Semaine',
  },
} as const

export type Strings = (typeof STRINGS)['en']

export function strings(locale: Locale): Strings {
  return STRINGS[locale] as Strings
}

// the first candidate that names a known language: an option, a setting ("french", "fr-FR"), a locale
export function resolveLocale(...candidates: unknown[]): Locale {
  for (const c of candidates) {
    if (typeof c !== 'string' || !c || c === 'auto') continue
    const word = c.trim().toLowerCase()
    if (word.startsWith('fr') || word === 'français' || word === 'francais') return 'fr'
    if (word.startsWith('en') || word === 'english') return 'en'
  }
  return 'en'
}

// the locale the environment's Intl reports, often the system's
export function systemLocale(): string | undefined {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return undefined
  }
}
