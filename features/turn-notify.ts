// The end-of-turn notice: when a turn of the main thread ran longer than a threshold, a sound and a
// toast with its time and cost; when a tool call waits on the person's approval, the decision sound.
// A mod cannot tell whether the app is in front, so the threshold keeps short answers silent.
import type { EngineInterface, Register } from 'claude-code'

import { formatUsd, type Locale, resolveLocale, systemLocale } from './i18n'

type Theme = 'soft' | 'classic' | 'off'

let thresholdMs = 60_000
let theme: Theme = 'soft'
let language = 'auto'
let locale: Locale = 'en'
// when each turn of the main thread began, the session's cost then, and the time its model requests took
const turns = new Map<string, { startedAt: number; usd: number | null; modelMs: number }>()
// tool calls that were asked about, so a quick settle by the mode stays silent
const asked = new Set<string>()

const TEXT = {
  en: {
    done: (time: string, cost: string) => `Claude finished in ${time}${cost ? ' · ' + cost : ''}`,
    split: (model: string, tools: string) => `model ${model}, tools ${tools}`,
    speed: (n: number) => `${n} tok/s`,
    failed: (time: string) => `Claude stopped on an error after ${time}`,
    refused: (time: string) => `Claude declined to go on after ${time}`,
  },
  fr: {
    done: (time: string, cost: string) => `Claude a terminé en ${time}${cost ? ' · ' + cost : ''}`,
    split: (model: string, tools: string) => `modèle ${model}, outils ${tools}`,
    speed: (n: number) => `${n} tok/s`,
    failed: (time: string) => `Claude s'est arrêté sur une erreur après ${time}`,
    refused: (time: string) => `Claude a refusé de continuer après ${time}`,
  },
}

export function registerTurnNotify(on: Parameters<Register>[0], options: { seconds?: number; sounds?: Theme; language?: string }) {
  thresholdMs = Math.max(0, options.seconds ?? 60) * 1000
  theme = options.sounds ?? 'soft'
  language = options.language ?? 'auto'

  // a matcher, so other features may hook session.start too
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const settings = await $.settings.read()
    locale = resolveLocale(language, settings.language, systemLocale())
    return next(e)
  })

  // matchers that take every value, so the plan bars may hook these events too
  on('turn.start', { turnId: /^/ }, async ($, e, next) => {
    turns.set(e.turnId, { startedAt: await $.clock.now(), usd: await sessionUsd($), modelMs: 0 })
    return next(e)
  })

  // each model request of a main-thread turn, timed from its ask to its last chunk
  on('turn.step', { index: /^/ }, async function* ($, e, next) {
    const turn = e.agentId ? undefined : turns.get(e.turnId)
    const started = await $.clock.now()
    const result = yield* next(e)
    if (turn) turn.modelMs += (await $.clock.now()) - started
    return result
  })

  on('turn.complete', { reason: /^/ }, async ($, e, next) => {
    const result = await next(e)
    const start = turns.get(e.turnId)
    turns.delete(e.turnId)
    // a subagent's turn, a turn stopped by the person, or one too short to call for attention
    if (e.agentId || !start || e.reason === 'aborted') return result
    const took = (await $.clock.now()) - start.startedAt
    if (took < thresholdMs) return result
    const T = TEXT[locale]
    const time = formatDuration(took)
    if (e.reason === 'answer') {
      const usd = await sessionUsd($)
      const cost = usd != null && start.usd != null && usd - start.usd >= 0.005 ? formatUsd(locale, usd - start.usd) : ''
      play($, 'done')
      // the rest of the turn is the tools and whatever waited between requests
      const toolsMs = Math.max(0, took - start.modelMs)
      const output = e.usage?.output_tokens ?? 0
      const speed = start.modelMs > 0 && output > 0 ? Math.round(output / (start.modelMs / 1000)) : 0
      const extra = [start.modelMs > 0 ? T.split(formatDuration(start.modelMs), formatDuration(toolsMs)) : '', speed > 0 ? T.speed(speed) : '']
      const detail = extra.filter(Boolean).join(' · ')
      $.ui.toast(T.done(time, cost) + (detail ? `\n${detail}` : ''), { timeoutMs: 8000 })
    } else {
      play($, 'error')
      $.ui.toast(e.reason === 'refusal' ? T.refused(time) : T.failed(time))
    }
    return result
  })

  // a call still held after a moment waits on the person: the mode often settles an ask in a blink
  on('tool.check', { tool: /^/ }, async ($, e, next) => {
    const verdict = await next(e)
    const useId = e.tool_use_id
    if (useId && verdict.decision === 'ask') {
      asked.add(useId)
      $.clock.after(700, () => {
        if (asked.delete(useId)) play($, 'decision')
      })
    }
    return verdict
  })

  // the call went on (approved or denied): no sound left to play for it
  on('tool.call', { tool: /^/ }, async ($, e, next) => {
    const ran = await next(e)
    if (e.tool_use_id) asked.delete(e.tool_use_id)
    return ran
  })
}

async function sessionUsd($: EngineInterface) {
  const usage = await $.session.usage()
  return typeof usage.cost?.usd === 'number' ? usage.cost.usd : null
}

// the theme's sound: the engine's player, else PowerShell where it cannot play
function play($: EngineInterface, name: 'decision' | 'error' | 'done') {
  if (theme === 'off') return
  const file = `${$.plugin.root}/sounds/${theme}/${name}.wav`.replace(/\//g, '\\')
  void $.audio.play({ asset: `sounds/${theme}/${name}.wav` }).catch(() =>
    $.process
      .run(['powershell', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `(New-Object Media.SoundPlayer '${file}').PlaySync()`], { timeoutMs: 5000 })
      .catch(() => undefined),
  )
}

function formatDuration(ms: number) {
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  if (m === 0) return `${s} s`
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}
