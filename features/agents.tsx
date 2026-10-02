// The Agents pane: the subagents of this session with what each one does, and the journal of the
// team's session folder (`<sessions dir>/<newest session>/journal.md`, one line per entry,
// `HH:MM · role · type · #tag text`). Agents come from the engine's own events; the journal is read
// from disk every few seconds, so it shows entries written by any session.
import type { EngineInterface, Register } from 'claude-code'

import { type Locale, resolveLocale, systemLocale } from './i18n'

const PANE = 'still-mods-agents'
const COMMAND = 'still-mods-agents'
// how often the session folder is read again, and the elapsed times redrawn
const POLL_MS = 4000
const TICK_MS = 1000
// the session folders looked at for the newest journal, newest names first
const SESSIONS_LOOKED_AT = 6
const JOURNAL_KEPT = 200
// finished agents kept in the list, past the running ones
const FINISHED_KEPT = 12

export type AgentsMode = 'auto' | 'manual' | 'off'

type AgentState = 'running' | 'waiting' | 'done' | 'error' | 'stopped'
type Agent = {
  id: string
  role: string
  description: string
  state: AgentState
  tool: string
  detail: string
  tools: number
  startedAt: number
  endedAt: number | null
  depth: number
}
type JournalLine = { time: string; role: string; type: string; text: string }
type Session = { name: string; files: string[]; journal: JournalLine[] } | null

// module state: a reload starts the list over, the journal is read again from disk
let mode: AgentsMode = 'auto'
let sessionsDir = '_generated-ai-doc/sessions'
let locale: Locale = 'en'
let language = 'auto'
const agents = new Map<string, Agent>()
const toolUses = new Map<string, string>() // tool_use_id -> agentId, for a permission wait
let session: Session = null
let journalStamp = ''
let hasAutoOpened = false

const ROLE_FILES = ['brief.md', 'contrat.md', 'test.md', 'revue-ui.md']

const TEXT = {
  en: {
    title: 'Agents',
    command: 'Show or hide the Agents pane',
    opened: 'Agents pane opened.',
    closed: 'Agents pane closed.',
    noAgents: 'No agent started in this session yet.',
    noSession: (dir: string) => `No session folder in ${dir}.`,
    journal: 'Journal',
    emptyJournal: 'Journal empty.',
    states: { running: 'running', waiting: 'waiting', done: 'done', error: 'failed', stopped: 'stopped' } as Record<AgentState, string>,
    tools: (n: number) => `${n} tool${n === 1 ? '' : 's'}`,
    starting: 'starting',
    approval: 'needs approval',
  },
  fr: {
    title: 'Agents',
    command: 'Afficher ou masquer le panneau Agents',
    opened: 'Panneau Agents ouvert.',
    closed: 'Panneau Agents fermé.',
    noAgents: 'Aucun agent lancé dans cette session pour l’instant.',
    noSession: (dir: string) => `Aucun dossier de session dans ${dir}.`,
    journal: 'Journal',
    emptyJournal: 'Journal vide.',
    states: { running: 'en cours', waiting: 'en attente', done: 'terminé', error: 'échec', stopped: 'arrêté' } as Record<AgentState, string>,
    tools: (n: number) => `${n} outil${n === 1 ? '' : 's'}`,
    starting: 'démarrage',
    approval: 'approbation requise',
  },
}
const T = () => TEXT[locale]

const STATE_STYLE: Record<AgentState, { glyph: string; color: string }> = {
  running: { glyph: '●', color: '#8B7CF6' },
  waiting: { glyph: '?', color: '#E09A1E' },
  done: { glyph: '✓', color: '#30A46C' },
  error: { glyph: '!', color: '#E5484D' },
  stopped: { glyph: '■', color: '#8A8984' },
}
const TYPE_COLOR: Record<string, string> = { bloque: '#E5484D', decision: '#E09A1E', resultat: '#30A46C' }

export function registerAgents(on: Parameters<Register>[0], options: { mode?: AgentsMode; sessionsDir?: string; language?: string }) {
  mode = options.mode ?? 'auto'
  if (options.sessionsDir) sessionsDir = options.sessionsDir.replace(/\\/g, '/').replace(/\/+$/, '')
  language = options.language ?? 'auto'

  // a matcher, so other features may hook session.start too
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    await startAgents($)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const isShown = (await $.ui.panes()).some(p => p.id === PANE)
    if (isShown) {
      await $.ui.close({ id: PANE })
      return { text: T().closed }
    }
    await readSession($)
    await $.ui.open({ id: PANE, title: T().title })
    return { text: T().opened }
  })

  // matchers that take every value, so the plan bars may hook these events too
  on('agent.spawn', { subagentType: /^/ }, async ($, e, next) => {
    const started = await next(e)
    if (!('agentId' in started) || !started.agentId) return started
    const now = await $.clock.now()
    agents.set(started.agentId, {
      id: started.agentId,
      role: e.subagentType || 'agent',
      description: (e.description ?? '').slice(0, 80),
      state: 'running',
      tool: T().starting,
      detail: '',
      tools: 0,
      startedAt: now,
      endedAt: null,
      depth: e.parentAgentId && agents.has(e.parentAgentId) ? 1 : 0,
    })
    trim()
    $.ui.invalidate('ui.render')
    if (mode === 'auto' && !hasAutoOpened) {
      hasAutoOpened = true
      void $.ui.open({ id: PANE, title: T().title })
    }
    return started
  })

  on('tool.call', { tool: /^/ }, async ($, e, next) => {
    const agent = e.agentId ? agents.get(e.agentId) : undefined
    if (!agent) return next(e)
    agents.set(agent.id, { ...agent, state: 'running', tool: e.tool, detail: detailOf(e as unknown as Record<string, unknown>), tools: agent.tools + 1 })
    if (e.tool_use_id) toolUses.set(e.tool_use_id, agent.id)
    $.ui.invalidate('ui.render')
    const ran = await next(e)
    if (e.tool_use_id) toolUses.delete(e.tool_use_id)
    const after = agents.get(agent.id)
    if (after?.state === 'waiting') agents.set(agent.id, { ...after, state: 'running' })
    return ran
  })

  // a call still held after a moment waits on the person
  on('tool.check', { tool: /^/ }, async ($, e, next) => {
    const verdict = await next(e)
    const useId = e.tool_use_id
    const agentId = useId ? toolUses.get(useId) : undefined
    if (agentId && useId && verdict.decision === 'ask') {
      $.clock.after(600, () => {
        const agent = agents.get(agentId)
        if (toolUses.get(useId) !== agentId || !agent) return
        agents.set(agentId, { ...agent, state: 'waiting', detail: T().approval })
        $.ui.invalidate('ui.render')
      })
    }
    return verdict
  })

  on('turn.complete', { reason: /^/ }, async ($, e, next) => {
    const agent = e.agentId ? agents.get(e.agentId) : undefined
    if (agent) {
      const state: AgentState = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'error'
      agents.set(agent.id, { ...agent, state, tool: '', detail: '', endedAt: await $.clock.now() })
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const rows = e.viewport?.rows ?? 30
    const list = ordered()
    const roleWidth = Math.max(6, ...list.map(a => [...a.role].length))

    const header = session ? (
      <Box key="head" flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Text bold wrap="truncate">{session.name}</Text>
        <Text dimColor>{ROLE_FILES.map(f => `${f.replace(/\.md$/, '')} ${session?.files.includes(f) ? '✓' : '·'}`).join('  ')}</Text>
      </Box>
    ) : (
      <Text key="head" dimColor>{T().noSession(sessionsDir)}</Text>
    )

    const agentRows =
      list.length === 0
        ? [<Text key="none" dimColor>{T().noAgents}</Text>]
        : list.map(a => {
            const style = STATE_STYLE[a.state]
            const elapsed = formatElapsed((a.endedAt ?? now) - a.startedAt)
            const doing = a.state === 'running' || a.state === 'waiting' ? `${a.tool}${a.detail ? '  ' + a.detail : ''}` : a.description
            return (
              <Box key={`agent-${a.id}`} flexDirection="row" columnGap={1}>
                <Text color={style.color}>{(a.depth > 0 ? '  ' : '') + style.glyph}</Text>
                <Text bold>{a.role.padEnd(roleWidth)}</Text>
                <Text color={style.color}>{T().states[a.state].padEnd(10)}</Text>
                <Text dimColor>{elapsed.padStart(6)}</Text>
                <Box flexGrow={1}>
                  <Text wrap="truncate" dimColor={a.state !== 'running' && a.state !== 'waiting'}>{doing}</Text>
                </Box>
                <Text dimColor>{T().tools(a.tools)}</Text>
              </Box>
            )
          })

    // the newest entries first, as many as the pane has rows left
    const room = Math.max(3, rows - agentRows.length - 6)
    const journal = session?.journal ?? []
    const journalRows =
      journal.length === 0
        ? [<Text key="nojournal" dimColor>{T().emptyJournal}</Text>]
        : journal
            .slice(-room)
            .reverse()
            .map((line, i) => (
              <Box key={`j-${i}`} flexDirection="row" columnGap={1}>
                <Text dimColor>{line.time}</Text>
                <Text bold>{line.role.padEnd(roleWidth)}</Text>
                <Text color={TYPE_COLOR[line.type]} dimColor={!TYPE_COLOR[line.type]}>{line.type.padEnd(9)}</Text>
                <Box flexGrow={1}>
                  <Text wrap="truncate">{line.text}</Text>
                </Box>
              </Box>
            ))

    return (
      <Box flexDirection="column" rowGap={1}>
        {header}
        <Box key="agents" flexDirection="column">
          {agentRows}
        </Box>
        <Box key="journal" flexDirection="column">
          <Text bold>{T().journal}</Text>
          {journalRows}
        </Box>
      </Box>
    )
  })
}

async function startAgents($: EngineInterface) {
  const settings = await $.settings.read()
  locale = resolveLocale(language, settings.language, systemLocale())
  await $.command.register({ name: COMMAND, description: TEXT[locale].command })
  await readSession($)
  $.clock.every(POLL_MS, async () => {
    if (await readSession($)) $.ui.invalidate('ui.render')
  })
  $.clock.every(TICK_MS, () => {
    if ([...agents.values()].some(a => a.state === 'running' || a.state === 'waiting')) $.ui.invalidate('ui.render')
  })
}

// reads the newest session folder; true when what the pane shows changed
async function readSession($: EngineInterface): Promise<boolean> {
  const root = `${await $.session.cwd()}/${sessionsDir}`.replace(/\\/g, '/')
  try {
    if (!(await $.fs.exists(root))) return replaceSession(null, '')
    const dirs = (await $.fs.list(root)).filter(d => d.kind === 'dir').map(d => d.name)
    dirs.sort((a, b) => b.localeCompare(a))
    let best: { name: string; entries: { name: string; mtimeMs: number }[]; newest: number } | null = null
    for (const name of dirs.slice(0, SESSIONS_LOOKED_AT)) {
      const entries = (await $.fs.list(`${root}/${name}`)).filter(f => f.kind === 'file')
      const newest = Math.max(0, ...entries.map(f => f.mtimeMs))
      if (!best || newest > best.newest) best = { name, entries, newest }
    }
    if (!best) return replaceSession(null, '')
    const journalFile = best.entries.find(f => f.name === 'journal.md')
    const stamp = `${best.name}:${best.entries.map(f => f.name + f.mtimeMs).join(',')}`
    if (stamp === journalStamp) return false
    const text = journalFile ? await $.fs.read(`${root}/${best.name}/journal.md`) : ''
    return replaceSession({ name: best.name, files: best.entries.map(f => f.name), journal: parseJournal(text) }, stamp)
  } catch {
    return false
  }
}

function replaceSession(next: Session, stamp: string) {
  if (stamp === journalStamp && (next === null) === (session === null)) return false
  session = next
  journalStamp = stamp
  return true
}

// `HH:MM · role · type · text`; a line that does not parse is kept whole as info
function parseJournal(text: string): JournalLine[] {
  const lines: JournalLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split(' · ')
    if (parts.length >= 4) lines.push({ time: parts[0]!, role: parts[1]!, type: parts[2]!, text: parts.slice(3).join(' · ') })
    else lines.push({ time: '', role: '', type: 'info', text: line })
  }
  return lines.slice(-JOURNAL_KEPT)
}

// what a call works on, in a few words: a file, a command, a pattern
function detailOf(input: Record<string, unknown>) {
  const pick = ['file_path', 'notebook_path', 'command', 'pattern', 'path', 'url', 'query', 'description', 'prompt']
  for (const key of pick) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').trim().slice(0, 120)
  }
  return ''
}

// running and waiting first, by start; then the latest finished
function ordered() {
  const all = [...agents.values()]
  const live = all.filter(a => a.state === 'running' || a.state === 'waiting').sort((a, b) => a.startedAt - b.startedAt)
  const ended = all.filter(a => a.endedAt != null).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  return [...live, ...ended]
}

function trim() {
  const ended = [...agents.values()].filter(a => a.endedAt != null).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  for (const a of ended.slice(FINISHED_KEPT)) agents.delete(a.id)
}

function formatElapsed(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}
