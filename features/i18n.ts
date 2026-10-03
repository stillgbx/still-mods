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
    cache: 'Cache',
    warm: (d: string) => `warm · ${d}`,
    cold: 'cold, the next message re-caches',
    cardCacheRate: (rate: string) => `Prompt cache · ${rate} of the last response's input came from the cache`,
    cardCacheWarm: (at: string, until: string, left: string) => `Last response at ${at} · expires at ${until} (in ${left}) if nothing is sent`,
    cardCacheCold: (at: string) => `Last response at ${at} · the cache has expired`,
    cardCacheNext: (tokens: string) => `Then the next message writes ${tokens} of context to the cache again`,
    cardCacheNone: 'Prompt cache · no response yet in this session',
    cardCtx: (tokens: string, window: string, pct: string) => `Context · ${tokens} of ${window} tokens (${pct})`,
    cardCtxNone: 'Context · no response yet in this session',
    cardCost: (cost: string) => `Session cost so far: ${cost}, at API prices`,
    cardCtxTicks: 'A cut every 10 % from 50 %, where the window starts to fill',
    cardFiveHour: 'Session limit · a 5-hour window',
    cardSevenDay: 'Weekly limit · a 7-day window',
    cardUsed: (used: string, gone: string) => `${used} used · ${gone} of the window gone`,
    cardPace: { under: 'below the average pace: it lasts until the reset', near: 'close to the average pace', over: 'above the average pace: it may run out before the reset' } as Record<string, string>,
    cardReset: (at: string, left: string) => `Resets ${at} (in ${left})`,
    cardTicksHours: 'A cut per hour · blue line: the time gone',
    cardTicksDays: 'A cut per day · blue line: the time gone',
    cardWaiting: 'No reading yet: the windows come with the first response',
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
    cache: 'Cache',
    warm: (d: string) => `chaud · ${d}`,
    cold: 'froid, le prochain message recache',
    cardCacheRate: (rate: string) => `Cache du prompt · ${rate} de l’entrée de la dernière réponse venaient du cache`,
    cardCacheWarm: (at: string, until: string, left: string) => `Dernière réponse à ${at} · expire à ${until} (dans ${left}) si rien n’est envoyé`,
    cardCacheCold: (at: string) => `Dernière réponse à ${at} · le cache a expiré`,
    cardCacheNext: (tokens: string) => `Le prochain message réécrira alors ${tokens} de contexte en cache`,
    cardCacheNone: 'Cache du prompt · pas encore de réponse dans cette session',
    cardCtx: (tokens: string, window: string, pct: string) => `Contexte · ${tokens} tokens sur ${window} (${pct})`,
    cardCtxNone: 'Contexte · pas encore de réponse dans cette session',
    cardCost: (cost: string) => `Coût de la session : ${cost}, au tarif de l’API`,
    cardCtxTicks: 'Un repère tous les 10 % à partir de 50 %, là où la fenêtre se remplit',
    cardFiveHour: 'Limite de session · une fenêtre de 5 h',
    cardSevenDay: 'Limite hebdomadaire · une fenêtre de 7 jours',
    cardUsed: (used: string, gone: string) => `${used} utilisés · ${gone} de la fenêtre écoulée`,
    cardPace: { under: 'sous le rythme moyen : elle tiendra jusqu’au reset', near: 'proche du rythme moyen', over: 'au-dessus du rythme moyen : elle risque d’être atteinte avant le reset' } as Record<string, string>,
    cardReset: (at: string, left: string) => `Réinitialisation ${at} (dans ${left})`,
    cardTicksHours: 'Un repère par heure · trait bleu : le temps écoulé',
    cardTicksDays: 'Un repère par jour · trait bleu : le temps écoulé',
    cardWaiting: 'Pas encore de relevé : les fenêtres arrivent avec la première réponse',
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

// a cost in US dollars, as the locale writes it: 3,42 $ or $3.42
export function formatUsd(locale: Locale, usd: number) {
  const digits = usd < 10 ? 2 : usd < 100 ? 1 : 0
  return locale === 'fr' ? `${usd.toFixed(digits).replace('.', ',')} $` : `$${usd.toFixed(digits)}`
}

// the locale the environment's Intl reports, often the system's
export function systemLocale(): string | undefined {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return undefined
  }
}
