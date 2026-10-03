// The Agents pane: the main thread and the subagents of this session, what each one runs on and does,
// what they say to each other, and, when the project keeps one, the journal of the team's session
// folder (`<sessions dir>/<newest session>/journal.md`, one line per entry,
// `HH:MM · role · type · #tag text`). A project without that folder, or with the option empty, gets
// no session header and no team journal: the rest works for any subagent.
// Agents come from the engine's own events; the journal is read from disk every few seconds, so it
// shows entries written by any session. Surfaces that draw `Svg` (the desktop Code tab) get a graph
// of the agents; the terminal gets one row per agent.
import type { EngineInterface, Register } from 'claude-code'

import { type Locale, resolveLocale, systemLocale } from './i18n'
import { type Palette, type PaletteName, palette } from './palettes'

const PANE = 'still-mods-agents'
const COMMAND = 'still-mods-agents'
// how often the session folder is read again, and the shortest time between two redraws
const POLL_MS = 4000
const REDRAW_MS = 500
// the session folders looked at for the newest journal, newest names first
const SESSIONS_LOOKED_AT = 6
const JOURNAL_KEPT = 200
// finished agents kept in the list, past the running ones
const FINISHED_KEPT = 12
// the exchanges and events kept for the session log
const LOG_KEPT = 200
// what is kept of a prompt and an answer
const PROMPT_KEPT = 4000
// desktop reports ~8 CSS px per column
const PX_PER_COLUMN = 8

export type AgentsMode = 'auto' | 'manual' | 'off'

type AgentState = 'running' | 'waiting' | 'done' | 'error' | 'stopped'
type Agent = {
  id: string
  role: string
  description: string
  prompt: string
  answer: string
  model: string
  effort: string
  state: AgentState
  tool: string
  detail: string
  tools: number
  startedAt: number
  endedAt: number | null
  parentId: string | null
}
type Main = { state: 'idle' | 'running' | 'waiting'; model: string; effort: string; tool: string; detail: string; tools: number; startedAt: number }
type LogKind = 'spawn' | 'send' | 'answer' | 'tool' | 'wait' | 'fail'
type LogEntry = { at: number; from: string; to: string; kind: LogKind; text: string }
type JournalLine = { time: string; role: string; type: string; text: string }
type Session = { name: string; files: string[]; journal: JournalLine[] } | null
type Exchange = { text: string; isTool: boolean }
// an agent type the session can dispatch: offered to the model, or defined in an agents folder
type Declared = { name: string; description: string; model: string; source: string }

// module state: a reload starts the list over, the journal is read again from disk
let mode: AgentsMode = 'auto'
let sessionsDir = '_generated-ai-doc/sessions'
let locale: Locale = 'en'
let language = 'auto'
let timeZone = 'Europe/Paris'
let colors: Palette = palette('default')
// what the hooks see happen
const liveAgents = new Map<string, Agent>()
const liveMain: Main = { state: 'idle', model: '', effort: '', tool: '', detail: '', tools: 0, startedAt: 0 }
const liveDeclared = new Map<string, Declared>() // agent type -> what it is for and runs on
const liveLog: LogEntry[] = []
// what the pane shows: the live state, or the demo's while it plays
let agents = liveAgents
let main = liveMain
let declared = liveDeclared
let log = liveLog
let demo: { timer: { cancel: () => void }; step: number } | null = null
const toolUses = new Map<string, string>() // tool_use_id -> agentId ('main' for the main thread), for a permission wait
let selected: string | null = null // whose exchanges are shown: an agent id or 'main'
let exchanges: { id: string; stamp: string; list: Exchange[] } | null = null
let session: Session = null
let demoSession: Session = null
let journalStamp = ''
let hasAutoOpened = false

const MAIN = 'main'
const ROLE_FILES = ['brief.md', 'contrat.md', 'test.md', 'revue-ui.md']

const TEXT = {
  en: {
    title: 'Agents',
    command: 'Show or hide the Agents pane',
    opened: 'Agents pane opened.',
    closed: 'Agents pane closed.',
    noAgents: 'No agent started in this session yet.',
    journal: 'Team journal',
    emptyJournal: 'Journal empty.',
    states: { running: 'running', waiting: 'waiting', done: 'done', error: 'failed', stopped: 'stopped' } as Record<AgentState, string>,
    mainStates: { idle: 'idle', running: 'working', waiting: 'needs approval' } as Record<Main['state'], string>,
    tools: (n: number) => `${n} tool${n === 1 ? '' : 's'}`,
    starting: 'starting',
    approval: 'needs approval',
    main: 'main',
    mainThread: 'main thread',
    inherits: 'inherits',
    idle: 'never run',
    since: (t: string) => `since ${t}`,
    runs: (n: number) => `run ${n} time${n === 1 ? '' : 's'} this session`,
    sources: { project: 'project', user: 'user', 'built-in': 'built-in', plugin: 'plugin' } as Record<string, string>,
    more: (n: number) => `+${n} more`,
    exchanges: 'Exchanges',
    demoStart: 'Demo',
    demoStop: 'Stop the demo',
    demoBanner: 'Demo · a made-up session; what really happens is still recorded and comes back when it stops',
    asked: 'Asked',
    answered: 'Answer',
    noAnswer: 'No answer yet.',
    noExchanges: 'Nothing said yet.',
    sessionLog: 'Session log',
    emptyLog: 'Nothing yet.',
    graphAlt: (main: string, list: string) => `Main thread: ${main}. Agents: ${list || 'none'}.`,
  },
  fr: {
    title: 'Agents',
    command: 'Afficher ou masquer le panneau Agents',
    opened: 'Panneau Agents ouvert.',
    closed: 'Panneau Agents fermé.',
    noAgents: 'Aucun agent lancé dans cette session pour l’instant.',
    journal: 'Journal de l’équipe',
    emptyJournal: 'Journal vide.',
    states: { running: 'en cours', waiting: 'en attente', done: 'terminé', error: 'échec', stopped: 'arrêté' } as Record<AgentState, string>,
    mainStates: { idle: 'au repos', running: 'au travail', waiting: 'approbation requise' } as Record<Main['state'], string>,
    tools: (n: number) => `${n} outil${n === 1 ? '' : 's'}`,
    starting: 'démarrage',
    approval: 'approbation requise',
    main: 'principal',
    mainThread: 'fil principal',
    inherits: 'hérite',
    idle: 'jamais lancé',
    since: (t: string) => `depuis ${t}`,
    runs: (n: number) => `lancé ${n} fois dans cette session`,
    sources: { project: 'projet', user: 'utilisateur', 'built-in': 'intégré', plugin: 'plugin' } as Record<string, string>,
    more: (n: number) => `+${n} autre${n === 1 ? '' : 's'}`,
    exchanges: 'Échanges',
    demoStart: 'Démo',
    demoStop: 'Arrêter la démo',
    demoBanner: 'Démo · une session inventée ; ce qui se passe vraiment est toujours enregistré et revient à l’arrêt',
    asked: 'Demande',
    answered: 'Réponse',
    noAnswer: 'Pas encore de réponse.',
    noExchanges: 'Rien d’échangé pour l’instant.',
    sessionLog: 'Journal de session',
    emptyLog: 'Rien pour l’instant.',
    graphAlt: (main: string, list: string) => `Fil principal : ${main}. Agents : ${list || 'aucun'}.`,
  },
}
const T = () => TEXT[locale]

const STATE_GLYPH: Record<AgentState, string> = { running: '●', waiting: '?', done: '✓', error: '!', stopped: '■' }
const stateColor = (s: AgentState | Main['state']) =>
  s === 'running' ? colors.running : s === 'waiting' ? colors.waiting : s === 'done' ? colors.done : s === 'error' ? colors.error : REST
const typeColor = (type: string) => ({ bloque: colors.error, decision: colors.waiting, resultat: colors.done } as Record<string, string | undefined>)[type]
// one colour per model family, from the palette: Opus warm, Sonnet blue, Haiku green, Fable violet
const familyColors = (): Record<string, string> => ({ opus: colors.waiting, sonnet: colors.marker, haiku: colors.success, fable: colors.running })
// what is at rest: no agent of it runs
const REST = '#8A8984'
const EFFORT_CELLS: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 }
const logColor = (kind: LogKind) => ({ spawn: colors.marker, send: colors.running, answer: colors.done, tool: undefined, wait: colors.waiting, fail: colors.error })[kind]

export function registerAgents(
  on: Parameters<Register>[0],
  options: { mode?: AgentsMode; sessionsDir?: string; language?: string; palette?: PaletteName; timeZone?: string },
) {
  mode = options.mode ?? 'auto'
  if (options.sessionsDir !== undefined) sessionsDir = options.sessionsDir.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  language = options.language ?? 'auto'
  colors = palette(options.palette)
  if (options.timeZone) timeZone = options.timeZone

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

  // the agent types the model is offered (built-in, plugins', files'), drawn idle until one runs
  on('agent.offer', { agent: /^/ }, async ($, e, next) => {
    const offer = await next(e)
    const known = liveDeclared.get(e.agent)
    if (offer.isOffered && (!known || !known.description)) {
      liveDeclared.set(e.agent, { name: e.agent, description: e.description, model: known?.model ?? '', source: known?.source ?? e.source })
      redraw($)
    }
    return offer
  })

  on('turn.start', { turnId: /^/ }, async ($, e, next) => {
    Object.assign(liveMain, { state: 'running', tool: '', detail: '', tools: 0, startedAt: await $.clock.now() })
    if (!liveMain.model) liveMain.model = await $.session.model()
    void readAgentFiles($)
    void readPluginAgents($)
    redraw($)
    return next(e)
  })

  // each request names its model and effort, the main thread's and each subagent's
  on('turn.step', { turnId: /^/ }, async function* ($, e, next) {
    const effort = e.effort == null ? '' : String(e.effort)
    const agent = e.agentId ? liveAgents.get(e.agentId) : undefined
    if (agent && (agent.model !== e.model || agent.effort !== effort)) {
      liveAgents.set(agent.id, { ...agent, model: e.model, effort })
      redraw($)
    } else if (!e.agentId && (liveMain.model !== e.model || liveMain.effort !== effort)) {
      Object.assign(liveMain, { model: e.model, effort })
      redraw($)
    }
    return yield* next(e)
  })

  // matchers that take every value, so the plan bars may hook these events too
  on('agent.spawn', { subagentType: /^/ }, async ($, e, next) => {
    const started = await next(e)
    if (!('agentId' in started) || !started.agentId) return started
    const now = await $.clock.now()
    const parentId = e.parentAgentId && liveAgents.has(e.parentAgentId) ? e.parentAgentId : null
    const role = e.subagentType || 'agent'
    // a type started before any offer named it (a fork, a plugin's own spawn) gets its block too
    if (!liveDeclared.has(role)) liveDeclared.set(role, { name: role, description: '', model: '', source: e.provider.plugin === 'engine' ? 'built-in' : 'plugin' })
    liveAgents.set(started.agentId, {
      id: started.agentId,
      role,
      description: (e.description ?? '').slice(0, 80),
      prompt: (e.prompt ?? '').slice(0, PROMPT_KEPT),
      answer: '',
      model: started.model || e.model || e.parentModel,
      effort: '',
      state: 'running',
      tool: T().starting,
      detail: '',
      tools: 0,
      startedAt: now,
      endedAt: null,
      parentId,
    })
    addLog({ at: now, from: parentId ? nameOf(parentId) : T().main, to: role, kind: 'spawn', text: e.description || oneLine(e.prompt) })
    trim()
    redraw($)
    if (mode === 'auto' && !hasAutoOpened) {
      hasAutoOpened = true
      void $.ui.open({ id: PANE, title: T().title })
    }
    return started
  })

  on('tool.call', { tool: /^/ }, async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const agent = e.agentId ? liveAgents.get(e.agentId) : undefined
    if (!e.agentId) {
      Object.assign(liveMain, { state: 'running', tool: e.tool, detail: detailOf(input), tools: liveMain.tools + 1 })
      if (e.tool_use_id) toolUses.set(e.tool_use_id, MAIN)
      if (e.tool === 'SendMessage') logSend(await $.clock.now(), T().main, input)
      redraw($)
    } else if (agent) {
      const detail = detailOf(input)
      liveAgents.set(agent.id, { ...agent, state: 'running', tool: e.tool, detail, tools: agent.tools + 1 })
      if (e.tool_use_id) toolUses.set(e.tool_use_id, agent.id)
      const now = await $.clock.now()
      if (e.tool === 'SendMessage') logSend(now, agent.role, input)
      else addLog({ at: now, from: agent.role, to: '', kind: 'tool', text: `${e.tool}${detail ? ' → ' + detail : ''}` })
      redraw($)
    } else return next(e)
    const ran = await next(e)
    if (e.tool_use_id) toolUses.delete(e.tool_use_id)
    if (!e.agentId) {
      if (liveMain.state === 'waiting') liveMain.state = 'running'
    } else {
      const after = liveAgents.get(e.agentId)
      if (after?.state === 'waiting') liveAgents.set(after.id, { ...after, state: 'running' })
    }
    return ran
  })

  // a call still held after a moment waits on the person
  on('tool.check', { tool: /^/ }, async ($, e, next) => {
    const verdict = await next(e)
    const useId = e.tool_use_id
    const who = useId ? toolUses.get(useId) : undefined
    if (who && useId && verdict.decision === 'ask') {
      $.clock.after(600, async () => {
        if (toolUses.get(useId) !== who) return
        if (who === MAIN) {
          liveMain.state = 'waiting'
        } else {
          const agent = liveAgents.get(who)
          if (!agent) return
          liveAgents.set(who, { ...agent, state: 'waiting', detail: T().approval })
          addLog({ at: await $.clock.now(), from: agent.role, to: '', kind: 'wait', text: `${agent.tool} · ${T().approval}` })
        }
        redraw($)
      })
    }
    return verdict
  })

  on('turn.complete', { reason: /^/ }, async ($, e, next) => {
    if (!e.agentId) {
      Object.assign(liveMain, { state: 'idle', tool: '', detail: '' })
      redraw($)
      return next(e)
    }
    const agent = liveAgents.get(e.agentId)
    if (agent) {
      const now = await $.clock.now()
      const state: AgentState = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'error'
      liveAgents.set(agent.id, { ...agent, state, tool: '', detail: '', answer: e.answer.slice(0, PROMPT_KEPT), endedAt: now })
      const to = agent.parentId ? nameOf(agent.parentId) : T().main
      if (state === 'done') addLog({ at: now, from: agent.role, to, kind: 'answer', text: oneLine(e.answer) || T().states.done })
      else addLog({ at: now, from: agent.role, to, kind: 'fail', text: T().states[state] })
      redraw($)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const Svg = 'Svg' in t ? t.Svg : null
    const now = await $.clock.now()
    const rows = e.viewport?.rows ?? 30
    const list = ordered()
    const groups = typeGroups()
    const roleWidth = Math.max(9, ...list.map(a => [...a.role].length), ...groups.flatMap(g => g.blocks.map(b => [...b.short].length)))

    // the team's session folder, when the project keeps one (or the demo's)
    const team = demo ? demoSession : session
    const header = team ? (
      <Box key="head" flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Text bold wrap="truncate">{team.name}</Text>
        <Text dimColor>{ROLE_FILES.map(f => `${f.replace(/\.md$/, '')} ${team.files.includes(f) ? '✓' : '·'}`).join('  ')}</Text>
      </Box>
    ) : null

    // the graph where the surface draws vectors, one row per agent elsewhere
    let agentsView
    let graphRows = 0
    if (Svg) {
      const width = Math.max(320, Math.min(1200, (e.viewport?.columns ?? 80) * PX_PER_COLUMN - 16))
      const graph = graphSvg(groups, width, now)
      graphRows = Math.ceil(graph.height / 18)
      const alt = T().graphAlt(`${modelLabel(main.model)} ${T().mainStates[main.state]}`, list.map(a => `${a.role} ${T().states[a.state]}`).join(', '))
      agentsView = <Svg key="graph" source={graph.source} alt={alt} width={width} height={graph.height} />
    } else {
      agentsView = (
        <Box key="agents" flexDirection="column">
          <Box key="agent-main" flexDirection="row" columnGap={1}>
            <Text color={stateColor(main.state)}>{main.state === 'idle' ? '○' : '●'}</Text>
            <Text bold color={familyColor(main.model)}>{T().main.padEnd(roleWidth)}</Text>
            <Text color={familyColor(main.model)}>{modelLabel(main.model).padEnd(10)}</Text>
            <Text dimColor>{(main.effort || '').padEnd(10)}</Text>
            <Box flexGrow={1}>
              <Text wrap="truncate" dimColor>{main.state === 'idle' ? T().mainStates.idle : `${main.tool}${main.detail ? '  ' + main.detail : ''}`}</Text>
            </Box>
          </Box>
          {groups.length === 0 ? <Text key="none" dimColor>{T().noAgents}</Text> : null}
          {groups.flatMap(g => [
            <Text key={`g-${g.key}`} bold dimColor={!g.blocks.some(b => b.live.length > 0)}>{`${g.title} · ${g.blocks.length}`}</Text>,
            ...g.blocks.map(b => {
              const view = blockView(b, now)
              const isLive = b.live.length > 0
              return (
                <Box key={`type-${b.type.name}`} flexDirection="row" columnGap={1}>
                  <Text color={isLive ? view.stateColor : undefined} dimColor={!isLive}>{`  ${view.glyph}`}</Text>
                  <Text bold={isLive} dimColor={!isLive}>{b.short.padEnd(roleWidth)}</Text>
                  <Text color={isLive ? familyColor(view.model) : undefined} dimColor={!isLive}>{view.modelText.padEnd(10)}</Text>
                  <Text color={isLive ? view.stateColor : undefined} dimColor={!isLive}>{view.status.padEnd(24)}</Text>
                  <Box flexGrow={1}>
                    <Text wrap="truncate" dimColor={!isLive}>{view.activity}</Text>
                  </Box>
                </Box>
              )
            }),
          ])}
        </Box>
      )
    }

    // whose exchanges to read: the main thread or one agent, pressed again to hide
    const pick = (id: string) => () => {
      selected = selected === id ? null : id
      exchanges = null
      redraw($)
    }
    const picker = (
      <Box key="picker" flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text bold>{T().exchanges}</Text>
        <Button key="x-main" label={T().main} variant={selected === MAIN ? 'primary' : undefined} dimColor={selected !== MAIN} onPress={pick(MAIN)} />
        {list.map(a => (
          <Button key={`x-${a.id}`} label={a.role} variant={selected === a.id ? 'primary' : undefined} dimColor={selected !== a.id} onPress={pick(a.id)} />
        ))}
      </Box>
    )

    const shown = selected === MAIN || (selected && agents.has(selected)) ? selected : null
    const exchangeView = shown ? await exchangeBox($, { Box, Text }, shown, roleWidth) : null

    // the newest entries first, the session log and the journal (when there is one) sharing the rows left
    const used = (Svg ? graphRows : groups.reduce((n, g) => n + g.blocks.length + 1, 2)) + (exchangeView ? 14 : 0) + 8
    const room = Math.max(3, Math.floor((rows - used) / (team ? 2 : 1)))
    const logRows =
      log.length === 0
        ? [<Text key="nolog" dimColor>{T().emptyLog}</Text>]
        : log
            .slice(-room)
            .reverse()
            .map((entry, i) => (
              <Box key={`l-${i}`} flexDirection="row" columnGap={1}>
                <Text dimColor>{clockTime(entry.at)}</Text>
                <Text bold color={entry.from === T().main ? familyColor(main.model) : undefined}>{entry.from.padEnd(roleWidth)}</Text>
                <Text color={logColor(entry.kind)}>{(entry.to ? `→ ${entry.to}` : '').padEnd(roleWidth + 2)}</Text>
                <Box flexGrow={1}>
                  <Text wrap="truncate" dimColor={entry.kind === 'tool'} color={entry.kind === 'tool' ? undefined : logColor(entry.kind)}>{entry.text}</Text>
                </Box>
              </Box>
            ))

    const journal = team?.journal ?? []
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
                <Text color={typeColor(line.type)} dimColor={!typeColor(line.type)}>{line.type.padEnd(9)}</Text>
                <Box flexGrow={1}>
                  <Text wrap="truncate">{line.text}</Text>
                </Box>
              </Box>
            ))

    return (
      <Box flexDirection="column" rowGap={1}>
        {/* the Demo button pinned to the top right, whatever the rows under it hold */}
        <Box key="top" flexDirection="row" alignItems="flex-start" columnGap={2}>
          <Box flexGrow={1} flexShrink={1} flexDirection="column">
            {demo ? <Text key="demo-banner" bold color={colors.waiting}>{T().demoBanner}</Text> : null}
            {header}
          </Box>
          <Box flexShrink={0}>
            <Button key="demo" label={demo ? T().demoStop : T().demoStart} variant={demo ? 'primary' : undefined} dimColor={!demo} onPress={() => toggleDemo($)} />
          </Box>
        </Box>
        {agentsView}
        {picker}
        {exchangeView}
        <Box key="log" flexDirection="column">
          <Text bold>{T().sessionLog}</Text>
          {logRows}
        </Box>
        {team ? (
          <Box key="journal" flexDirection="column">
            <Text bold>{T().journal}</Text>
            {journalRows}
          </Box>
        ) : null}
      </Box>
    )
  })
}

async function startAgents($: EngineInterface) {
  const settings = await $.settings.read()
  locale = resolveLocale(language, settings.language, systemLocale())
  await $.command.register({ name: COMMAND, description: TEXT[locale].command })
  liveMain.model = await $.session.model()
  await readAgentFiles($)
  await readPluginAgents($)
  await readSession($)
  $.clock.every(POLL_MS, async () => {
    if (await readSession($)) redraw($)
  })
}

// redraws at most once per REDRAW_MS: each redraw of the graph swaps its picture, so a burst of
// tool calls becomes one swap
let isRedrawPending = false
function redraw($: EngineInterface) {
  if (isRedrawPending) return
  isRedrawPending = true
  $.clock.after(REDRAW_MS, () => {
    isRedrawPending = false
    $.ui.invalidate('ui.render')
  })
}

// the agents of the enabled plugins, read from where they are installed
// (`~/.claude/plugins/installed_plugins.json`): each plugin's `agents/*.md`, and the paths its
// manifest names under `agents`; typed `<plugin>:<name>`, as the Agent tool names them
async function readPluginAgents($: EngineInterface) {
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
  if (!home) return
  let changed = false
  try {
    const installed = JSON.parse(await $.fs.read(`${home}/.claude/plugins/installed_plugins.json`)) as {
      plugins?: Record<string, { installPath?: string }[]>
    }
    const enabled = ((await $.settings.read()) as { enabledPlugins?: Record<string, boolean> }).enabledPlugins
    for (const [key, installs] of Object.entries(installed.plugins ?? {})) {
      // a plugin the settings switch off offers no agent; no list at all means none is switched off
      if (enabled && enabled[key] !== true) continue
      const root = installs.at(-1)?.installPath?.replace(/\\/g, '/')
      if (!root) continue
      const plugin = key.split('@')[0]!
      const paths = ['agents']
      try {
        const manifest = JSON.parse(await $.fs.read(`${root}/.claude-plugin/plugin.json`)) as { agents?: string | string[] }
        for (const p of [manifest.agents ?? []].flat()) paths.push(p.replace(/^\.\//, ''))
      } catch {
        // no manifest: the default folder alone
      }
      const files = new Set<string>()
      for (const p of paths) {
        const at = `${root}/${p}`.replace(/\/+$/, '')
        if (at.endsWith('.md')) {
          if (await $.fs.exists(at)) files.add(at)
          continue
        }
        if (!(await $.fs.exists(at))) continue
        for (const f of await $.fs.list(at)) if (f.kind === 'file' && f.name.endsWith('.md')) files.add(`${at}/${f.name}`)
      }
      for (const file of files) {
        const meta = frontMatter(await $.fs.read(file))
        const name = `${plugin}:${meta.name || file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/, '')}`
        const known = liveDeclared.get(name)
        const next = { name, description: known?.description || meta.description || '', model: meta.model || known?.model || '', source: 'plugin' }
        if (!known || known.description !== next.description || known.model !== next.model) {
          liveDeclared.set(name, next)
          changed = true
        }
      }
    }
  } catch {
    // no plugins installed, or a file that does not parse: what was read stays
  }
  if (changed) redraw($)
}

// the agent files of the project and of the user (`.claude/agents/*.md`): name, description and
// model from the front matter; a file's model wins over what the offer said
async function readAgentFiles($: EngineInterface) {
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
  const root = (await $.session.root()).replace(/\\/g, '/')
  let changed = false
  for (const [dir, source] of [[`${root}/.claude/agents`, 'project'], [`${home}/.claude/agents`, 'user']] as const) {
    if (source === 'user' && !home) continue
    try {
      if (!(await $.fs.exists(dir))) continue
      for (const f of await $.fs.list(dir)) {
        if (f.kind !== 'file' || !f.name.endsWith('.md')) continue
        const meta = frontMatter(await $.fs.read(`${dir}/${f.name}`))
        const name = meta.name || f.name.replace(/\.md$/, '')
        const known = liveDeclared.get(name)
        // the project's file shadows the user's of the same name
        if (known && known.source === 'project' && source === 'user') continue
        const next = { name, description: meta.description || known?.description || '', model: meta.model || '', source }
        if (!known || known.description !== next.description || known.model !== next.model || known.source !== source) {
          liveDeclared.set(name, next)
          changed = true
        }
      }
    } catch {
      // an unreadable folder or file shows nothing
    }
  }
  if (changed) redraw($)
}

// `key: value` lines between the leading `---` fences; quotes taken off
function frontMatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const out: Record<string, string> = {}
  if (!m) return out
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
    if (kv) out[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, '')
  }
  return out
}

type Block = { type: Declared; short: string; live: Agent[]; latest: Agent | null; runs: number }
type Group = { key: string; title: string; blocks: Block[] }

// every declared type, one block each whether it runs or not, grouped by where it comes from:
// the project's, the user's, the built-in ones, then one group per plugin (`plugin:name`)
function typeGroups(): Group[] {
  const byKey = new Map<string, Group & { rank: number }>()
  for (const d of declared.values()) {
    const colon = d.name.indexOf(':')
    const plugin = colon > 0 ? d.name.slice(0, colon) : ''
    const kind = plugin ? 'plugin' : sourceKey(d.source)
    const key = plugin ? `plugin:${plugin}` : kind
    const rank = plugin ? 3 : kind === 'project' ? 0 : kind === 'user' ? 1 : 2
    const title = plugin ? `${T().sources.plugin} · ${plugin}` : (T().sources[kind] ?? kind)
    const group = byKey.get(key) ?? { key, title, rank, blocks: [] }
    const runs = [...agents.values()].filter(a => a.role === d.name).sort((a, b) => b.startedAt - a.startedAt)
    group.blocks.push({
      type: d,
      short: plugin ? d.name.slice(colon + 1) : d.name,
      live: runs.filter(a => a.state === 'running' || a.state === 'waiting'),
      latest: runs[0] ?? null,
      runs: runs.length,
    })
    byKey.set(key, group)
  }
  const groups = [...byKey.values()].sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title))
  for (const g of groups) g.blocks.sort((a, b) => a.short.localeCompare(b.short))
  return groups
}

// what a block says: its newest running agent's work, or its last run, or what it is for
function blockView(b: Block, now: number) {
  const a = b.live[0] ?? b.latest
  const isLive = b.live.length > 0
  const model = a?.model || b.type.model
  const modelText = model ? modelLabel(model) : T().inherits
  if (isLive && a) {
    const count = b.live.length > 1 ? ` ×${b.live.length}` : ''
    return {
      glyph: STATE_GLYPH[a.state],
      stateColor: stateColor(a.state),
      model,
      modelText,
      effort: a.effort,
      status: `${T().states[a.state]}${count} · ${T().since(clockTime(a.startedAt).slice(0, 5))} · ${T().tools(a.tools)}`,
      activity: `${a.tool}${a.detail ? ' · ' + a.detail : ''}`,
    }
  }
  if (a) {
    const took = formatElapsed((a.endedAt ?? now) - a.startedAt)
    return {
      glyph: STATE_GLYPH[a.state],
      stateColor: stateColor(a.state),
      model,
      modelText,
      effort: '',
      status: `${T().states[a.state]} · ${clockTime(a.endedAt ?? now).slice(0, 5)} · ${took}${b.runs > 1 ? ` · ×${b.runs}` : ''}`,
      activity: a.description || oneLine(b.type.description),
    }
  }
  return { glyph: '○', stateColor: REST, model, modelText, effort: '', status: T().idle, activity: oneLine(b.type.description) }
}

// what the selected one was asked and said: an agent's prompt, its messages and its answer, or the
// main thread's side of the session log
async function exchangeBox($: EngineInterface, { Box, Text }: any, id: string, roleWidth: number) {
  if (id === MAIN) {
    const mine = log.filter(l => l.kind !== 'tool' && (l.from === T().main || l.to === T().main)).slice(-12)
    return (
      <Box key="exchange" flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold color={familyColor(main.model)}>{`${T().mainThread} · ${modelLabel(main.model)}${main.effort ? ' · ' + main.effort : ''}`}</Text>
        {mine.length === 0 ? (
          <Text dimColor>{T().noExchanges}</Text>
        ) : (
          mine.map((l, i) => (
            <Box key={`xm-${i}`} flexDirection="row" columnGap={1}>
              <Text dimColor>{clockTime(l.at)}</Text>
              <Text color={logColor(l.kind)}>{`${l.from} → ${l.to}`.padEnd(roleWidth * 2 + 3)}</Text>
              <Box flexGrow={1}>
                <Text wrap="truncate">{l.text}</Text>
              </Box>
            </Box>
          ))
        )}
      </Box>
    )
  }
  const agent = agents.get(id)!
  const stamp = `${agent.tools}:${agent.state}`
  if (!exchanges || exchanges.id !== id || exchanges.stamp !== stamp) {
    // a demo agent has no transcript: its calls come from the demo's log
    const found = demo ? [] : await $.session.messages({ agentId: id })
    const list: Exchange[] = demo ? log.filter(l => l.from === agent.role && l.kind === 'tool').map(l => ({ text: l.text, isTool: true })) : []
    if (Array.isArray(found)) {
      for (const m of found) {
        if (m.role !== 'assistant') continue
        if (m.text.trim()) list.push({ text: oneLine(m.text), isTool: false })
        for (const u of m.toolUses) {
          const detail = detailOf(u.input)
          list.push({ text: `${u.tool}${detail ? ' → ' + detail : ''}`, isTool: true })
        }
      }
    }
    exchanges = { id, stamp, list }
  }
  const parent = agent.parentId ? nameOf(agent.parentId) : T().main
  return (
    <Box key="exchange" flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        <Text color={familyColor(agent.model)}>{agent.role}</Text>
        <Text dimColor>{` · ${modelLabel(agent.model)}${agent.effort ? ' · ' + agent.effort : ''} · ${T().states[agent.state]}`}</Text>
      </Text>
      <Text color={logColor('spawn')}>{`${T().asked} (${parent} → ${agent.role})`}</Text>
      <Text>{clip(agent.prompt, 600)}</Text>
      {exchanges.list.slice(-8).map((x, i) => (
        <Text key={`xa-${i}`} wrap="truncate" dimColor={x.isTool}>{`${x.isTool ? '  ' : '» '}${x.text}`}</Text>
      ))}
      <Text color={logColor('answer')}>{`${T().answered} (${agent.role} → ${parent})`}</Text>
      <Text dimColor={!agent.answer}>{agent.answer ? clip(agent.answer, 800) : T().noAnswer}</Text>
    </Box>
  )
}

// the graph: the main thread on top, then a frame per group holding a block per agent type,
// the running ones lit, the others drawn faint
function graphSvg(groups: Group[], W: number, now: number): { source: string; height: number } {
  const pad = 8
  const charW = 6.6
  const mainW = Math.min(420, W - pad * 2)
  const mainX = (W - mainW) / 2
  const mainH = 66
  let y = pad
  const parts: string[] = []

  // main thread
  const mainColor = familyColor(main.model)
  const mainDoing = main.state === 'idle' ? T().mainStates.idle : `${main.tool}${main.detail ? ' · ' + main.detail : ''}`
  parts.push(
    `<g><title>${esc(`${modelLabel(main.model)} · ${T().mainStates[main.state]}${main.effort ? ' · ' + main.effort : ''} · ${T().tools(main.tools)}`)}</title>`,
    `<rect x="${mainX}" y="${y}" width="${mainW}" height="${mainH}" rx="6" class="card" stroke="${mainColor}" stroke-width="1.5"/>`,
    `<text x="${W / 2}" y="${y + 19}" text-anchor="middle" class="b" fill="${mainColor}">${esc(`${modelLabel(main.model)} · ${T().mainThread}`)}</text>`,
    `<text x="${W / 2}" y="${y + 37}" text-anchor="middle" class="${main.state === 'idle' ? 'dim' : 'fg'}">${esc(fit(mainDoing, (mainW - 36) / charW))}</text>`,
    effortSvg(W / 2, y + 56, main.effort, mainColor, true),
    main.state !== 'idle' ? spinnerSvg(mainX + 14, y + 15, stateColor(main.state), main.state === 'running') : '',
    `</g>`,
  )
  y += mainH

  if (groups.length === 0) {
    y += 26
    parts.push(`<text x="${W / 2}" y="${y}" text-anchor="middle" class="dim">${esc(T().noAgents)}</text>`)
    y += pad
  } else {
    parts.push(`<line x1="${W / 2}" y1="${y}" x2="${W / 2}" y2="${y + 14}" class="wire"/>`)
    y += 14
    const gap = 8
    const cardH = 64
    const innerW = W - pad * 2 - 16
    const cols = Math.max(1, Math.floor((innerW + gap) / (180 + gap)))
    const cardW = (innerW - gap * (cols - 1)) / cols
    for (const g of groups) {
      const isLive = g.blocks.some(b => b.live.length > 0)
      const rowsOf = Math.ceil(g.blocks.length / cols)
      const frameH = 24 + rowsOf * (cardH + gap) - gap + 8
      parts.push(
        `<rect x="${pad}" y="${y}" width="${W - pad * 2}" height="${frameH}" rx="7" fill="none" class="frame${isLive ? ' lit' : ''}"/>`,
        `<text x="${pad + 8}" y="${y + 16}" class="small b ${isLive ? 'fg' : 'dim'}">${esc(`${g.title} · ${g.blocks.length}`)}</text>`,
      )
      g.blocks.forEach((b, i) => {
        parts.push(blockSvg(b, pad + 8 + (i % cols) * (cardW + gap), y + 24 + Math.floor(i / cols) * (cardH + gap), cardW, cardH, now))
      })
      y += frameH + 10
    }
    y += pad - 10
  }

  const height = Math.ceil(y)
  const style = [
    'text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}',
    '.b{font-weight:700}.small{font-size:10.5px}',
    '.fg{fill:#2b2b2b}.dim{fill:#7a7a7a}.card{fill:rgba(128,128,128,.07)}.off{fill:rgba(128,128,128,.03)}',
    `.frame{stroke:${colors.track}}.lit{stroke:${colors.marker};stroke-opacity:.6}`,
    `.wire{stroke:${colors.track};stroke-width:1.2;fill:none;stroke-dasharray:3 3}`,
    '@media (prefers-color-scheme:dark){.fg{fill:#e6e6e6}.dim{fill:#8f8f8f}}',
  ].join('')
  return {
    height,
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}"><style>${style}</style>${parts.join('')}</svg>`,
  }
}

// one agent type: lit in its model's colour while an agent of it runs, faint and dashed otherwise
function blockSvg(b: Block, x: number, y: number, w: number, h: number, now: number) {
  const v = blockView(b, now)
  const isLive = b.live.length > 0
  const color = v.model ? familyColor(v.model) : REST
  const chars = (w - 16) / 6.4
  const modelChars = Math.min(14, v.modelText.length)
  const prompt = b.live[0]?.prompt ?? b.latest?.prompt ?? ''
  const tip = [
    `${b.type.name} · ${v.modelText} · ${sourceLabel(b.type.source)}`,
    oneLine(b.type.description),
    b.runs ? T().runs(b.runs) : '',
    prompt ? clip(prompt, 400) : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  return [
    `<g opacity="${isLive ? 1 : 0.5}">`,
    `<title>${esc(tip)}</title>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" class="${isLive ? 'card' : 'off'}" stroke="${isLive ? color : colors.track}" stroke-width="${isLive ? 1.6 : 1.2}"${isLive ? '' : ' stroke-dasharray="4 3"'}/>`,
    `<text x="${x + 8}" y="${y + 16}" class="b ${isLive ? 'fg' : 'dim'}">${esc(fit(b.short, chars - modelChars - 2))}</text>`,
    `<text x="${x + w - 8}" y="${y + 16}" text-anchor="end" class="small" fill="${isLive ? color : REST}">${esc(fit(v.modelText, 14))}</text>`,
    `<text x="${x + 8}" y="${y + 34}" class="small ${isLive ? 'fg' : 'dim'}">${esc(fit(v.activity, chars))}</text>`,
    isLive
      ? spinnerSvg(x + 13, y + 50, v.stateColor, b.live[0]?.state === 'running')
      : `<text x="${x + 13}" y="${y + 54}" text-anchor="middle" class="small" fill="${b.latest ? v.stateColor : REST}">${esc(v.glyph)}</text>`,
    `<text x="${x + 22}" y="${y + 54}" class="small" fill="${isLive ? v.stateColor : REST}">${esc(fit(v.status, chars - (v.effort ? 9 : 0) - 3))}</text>`,
    isLive && v.effort ? effortCells(x + w - 8, y + 54, v.effort, color) : '',
    `</g>`,
  ].join('')
}

// the effort as four small cells, right-aligned at x
function effortCells(right: number, y: number, effort: string, color: string) {
  const n = EFFORT_CELLS[effort] ?? 0
  const cell = 6
  const gap = 2
  let x = right - (4 * cell + 3 * gap)
  const out: string[] = [`<title>${esc(effort)}</title>`]
  for (let i = 0; i < 4; i++) {
    out.push(`<rect x="${x}" y="${y - cell}" width="${cell}" height="${cell}" rx="1" fill="${color}" fill-opacity="${i < n ? 1 : 0.22}"/>`)
    x += cell + gap
  }
  return `<g>${out.join('')}</g>`
}

// four cells, filled as hard as the request asks the model to think, the level named after them
function effortSvg(cx: number, y: number, effort: string, color: string, big: boolean) {
  if (!effort) return ''
  const n = EFFORT_CELLS[effort] ?? 0
  const cell = big ? 9 : 7
  const gap = 2
  const total = 4 * cell + 3 * gap + 6 + effort.length * 6.4
  let x = cx - total / 2
  const out: string[] = []
  for (let i = 0; i < 4; i++) {
    out.push(`<rect x="${x}" y="${y - cell + 1}" width="${cell}" height="${cell}" rx="1.5" fill="${color}" fill-opacity="${i < n ? 1 : 0.22}"/>`)
    x += cell + gap
  }
  out.push(`<text x="${x + 4}" y="${y}" class="small" fill="${color}">${esc(effort)}</text>`)
  return out.join('')
}

// a turning arc while running, a still dot while waiting
function spinnerSvg(x: number, y: number, color: string, turning: boolean) {
  if (!turning) return `<circle cx="${x}" cy="${y}" r="4" fill="${color}"/>`
  return `<g transform="translate(${x} ${y})"><circle r="4.5" fill="none" stroke="${color}" stroke-opacity=".25" stroke-width="2"/><path d="M0 -4.5 A4.5 4.5 0 0 1 4.5 0" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="0.9s" repeatCount="indefinite"/></path></g>`
}

// `claude-opus-5-5` as `Opus 5.5`, an alias as its family
function modelLabel(id: string) {
  if (!id) return '—'
  const m = /(opus|sonnet|haiku|fable)(?:[-_ ]?(\d{1,2})(?:[-.](\d{1,2})(?!\d))?)?/i.exec(id)
  if (!m) return id.replace(/^claude-/, '')
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase()
  return m[2] ? `${family} ${m[2]}${m[3] ? '.' + m[3] : ''}` : family
}

function familyColor(id: string) {
  const m = /(opus|sonnet|haiku|fable)/i.exec(id)
  return (m && familyColors()[m[1]!.toLowerCase()]) || REST
}

// where a type comes from; settings sources (`userSettings`, ...) as user or project
function sourceKey(source: string) {
  return /project|local/i.test(source) ? 'project' : /user/i.test(source) ? 'user' : /plugin/i.test(source) ? 'plugin' : 'built-in'
}

function sourceLabel(source: string) {
  return T().sources[sourceKey(source)] ?? source
}

function nameOf(agentId: string) {
  return (agents.get(agentId) ?? liveAgents.get(agentId))?.role ?? 'agent'
}

function logSend(at: number, from: string, input: Record<string, unknown>) {
  const to = [input.to, input.recipient, input.name].find(v => typeof v === 'string') as string | undefined
  const text = [input.message, input.content, input.text].find(v => typeof v === 'string') as string | undefined
  addLog({ at, from, to: to ?? '?', kind: 'send', text: oneLine(text) })
}

function addLog(entry: LogEntry) {
  liveLog.push(entry)
  if (liveLog.length > LOG_KEPT) liveLog.splice(0, liveLog.length - LOG_KEPT)
}

function clockTime(at: number) {
  try {
    return new Intl.DateTimeFormat('fr-FR', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(at))
  } catch {
    const d = new Date(at)
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
  }
}

const oneLine = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text)
const fit = (text: string, chars: number) => clip(text, Math.max(4, Math.floor(chars)))
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// reads the newest session folder; true when what the pane shows changed
async function readSession($: EngineInterface): Promise<boolean> {
  if (!sessionsDir) return replaceSession(null, '')
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
  const ended = [...liveAgents.values()].filter(a => a.endedAt != null).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  for (const a of ended.slice(FINISHED_KEPT)) liveAgents.delete(a.id)
}

function formatElapsed(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

// The demo: a made-up session played in the pane, every kind of block and state in turn, while the
// live state goes on being recorded underneath. The Demo button starts and stops it.
const DEMO_MS = 1500
const DEMO_LOG_KEPT = 80
let demoCount = 0
type DemoType = Declared & { effort: string; script: [string, string][]; task: [string, string] }

const demoTypes = (): DemoType[] => {
  const fr = locale === 'fr'
  const type = (name: string, source: string, model: string, effort: string, description: string, task: string, script: [string, string][]): DemoType => ({
    name,
    source,
    model,
    effort,
    description,
    task: [task, `${task}. ${fr ? 'Rends un résumé court avec les fichiers en cause.' : 'Report back briefly with the files involved.'}`],
    script,
  })
  return [
    type('Explore', 'built-in', 'claude-haiku-4-5', 'medium', fr ? 'Explore le code en lecture seule' : 'Read-only codebase search', fr ? 'Trouver où les factures sont arrondies' : 'Find where invoices are rounded', [
      ['Grep', 'roundAmount'], ['Read', 'src/billing/invoice.ts'], ['Glob', 'src/billing/**/*.test.ts'], ['Read', 'src/billing/tax.ts'],
    ]),
    type('Plan', 'built-in', '', '', fr ? 'Conçoit un plan d’implémentation' : 'Designs an implementation plan', fr ? 'Planifier le passage aux centimes entiers' : 'Plan the move to integer cents', [
      ['Read', 'docs/architecture.md'], ['Grep', 'Money'], ['Read', 'src/shared/money.ts'],
    ]),
    type('general-purpose', 'built-in', '', '', fr ? 'Tâches en plusieurs étapes' : 'Multi-step tasks', fr ? 'Corriger l’arrondi et lancer les tests' : 'Fix the rounding and run the tests', [
      ['Read', 'src/billing/invoice.ts'], ['Edit', 'src/billing/invoice.ts'], ['Bash', 'npm test -- billing'], ['Edit', 'src/billing/invoice.test.ts'], ['Bash', 'npm test -- billing'],
    ]),
    type('reviewer', 'project', 'claude-sonnet-5-5', 'medium', fr ? 'Relit un diff avant commit' : 'Reviews a diff before commit', fr ? 'Relire le correctif d’arrondi' : 'Review the rounding fix', [
      ['Bash', 'git diff --stat'], ['Read', 'src/billing/invoice.ts'], ['Grep', 'Math.round'],
    ]),
    type('researcher', 'user', 'claude-haiku-4-5', 'low', fr ? 'Cherche dans la documentation' : 'Looks things up in the docs', fr ? 'Vérifier les règles d’arrondi ISO 4217' : 'Check the ISO 4217 rounding rules', [
      ['WebSearch', 'ISO 4217 minor units rounding'], ['WebFetch', 'https://www.iso.org/iso-4217-currency-codes.html'],
    ]),
    type('feature-dev:code-explorer', 'plugin', 'claude-sonnet-5-5', 'medium', fr ? 'Trace un flux d’exécution' : 'Traces an execution path', fr ? 'Tracer le calcul du total d’une commande' : 'Trace how an order total is computed', [
      ['Grep', 'computeTotal'], ['Read', 'src/orders/total.ts'], ['Read', 'src/billing/invoice.ts'],
    ]),
    type('feature-dev:code-architect', 'plugin', 'claude-opus-5-5', 'high', fr ? 'Propose une architecture' : 'Designs an architecture', fr ? 'Concevoir un type Money partagé' : 'Design a shared Money type', [
      ['Read', 'src/shared/money.ts'], ['Grep', 'number // cents'], ['Read', 'src/payments/stripe.ts'], ['Read', 'src/orders/total.ts'],
    ]),
    type('feature-dev:code-reviewer', 'plugin', 'claude-sonnet-5-5', 'high', fr ? 'Cherche les bugs d’un changement' : 'Looks for bugs in a change', fr ? 'Chercher les régressions du correctif' : 'Look for regressions in the fix', [
      ['Bash', 'git diff main'], ['Read', 'src/billing/invoice.test.ts'],
    ]),
    type('understand-anything:file-analyzer', 'plugin', 'claude-haiku-4-5', 'low', fr ? 'Analyse un lot de fichiers' : 'Analyzes a batch of files', fr ? 'Analyser le dossier billing' : 'Analyze the billing folder', [
      ['Glob', 'src/billing/*.ts'], ['Read', 'src/billing/index.ts'], ['Read', 'src/billing/tax.ts'],
    ]),
    type('understand-anything:graph-reviewer', 'plugin', 'claude-sonnet-5-5', 'medium', fr ? 'Valide un graphe de connaissances' : 'Validates a knowledge graph', '', []),
  ]
}

function toggleDemo($: EngineInterface) {
  if (demo) {
    demo.timer.cancel()
    demo = null
    demoSession = null
    agents = liveAgents
    main = liveMain
    declared = liveDeclared
    log = liveLog
  } else {
    void startDemo($)
  }
  selected = null
  exchanges = null
  $.ui.invalidate('ui.render')
}

async function startDemo($: EngineInterface) {
  const now = await $.clock.now()
  const types = demoTypes()
  demoSession = demoTeam(now)
  agents = new Map()
  declared = new Map(types.map(t => [t.name, { name: t.name, description: t.description, model: t.model, source: t.source }]))
  log = []
  main = { state: 'running', model: 'claude-opus-5-5', effort: 'high', tool: 'Agent', detail: types[0]!.task[0], tools: 6, startedAt: now - 95_000 }
  // what already happened: one answered, one failed, one stopped
  demoRun(types.find(t => t.name === 'reviewer')!, now - 240_000, { state: 'done', at: now - 170_000 })
  demoRun(types.find(t => t.name === 'researcher')!, now - 200_000, { state: 'error', at: now - 150_000 })
  demoRun(types.find(t => t.name === 'Plan')!, now - 130_000, { state: 'stopped', at: now - 100_000 })
  // what runs now
  demoRun(types.find(t => t.name === 'Explore')!, now - 40_000)
  demoRun(types.find(t => t.name === 'feature-dev:code-architect')!, now - 25_000)
  demo = { timer: $.clock.every(DEMO_MS, () => void demoTick($)), step: 0 }
  $.ui.invalidate('ui.render')
}

// starts an agent of a demo type; with `end`, it already finished that way
function demoRun(t: DemoType, at: number, end?: { state: AgentState; at: number }) {
  const id = `demo-${++demoCount}`
  const fr = locale === 'fr'
  const first = t.script[0] ?? ['Read', 'README.md']
  agents.set(id, {
    id,
    role: t.name,
    description: t.task[0],
    prompt: t.task[1],
    answer: end?.state === 'done' ? (fr ? 'Deux appels à Math.round sur des montants flottants, dans invoice.ts:42 et tax.ts:17. Le reste passe par money.ts.' : 'Two Math.round calls on float amounts, in invoice.ts:42 and tax.ts:17. Everything else goes through money.ts.') : '',
    model: t.model || main.model,
    effort: t.effort || main.effort,
    state: end?.state ?? 'running',
    tool: end ? '' : first[0],
    detail: end ? '' : first[1],
    tools: end ? t.script.length : 1,
    startedAt: at,
    endedAt: end?.at ?? null,
    parentId: null,
  })
  demoLog({ at, from: T().main, to: t.name, kind: 'spawn', text: t.task[0] })
  if (!end) {
    demoLog({ at, from: t.name, to: '', kind: 'tool', text: `${first[0]} → ${first[1]}` })
    return
  }
  for (const [tool, detail] of t.script) demoLog({ at: at + 5000, from: t.name, to: '', kind: 'tool', text: `${tool} → ${detail}` })
  const to = T().main
  if (end.state === 'done') demoLog({ at: end.at, from: t.name, to, kind: 'answer', text: oneLine(agents.get(id)!.answer) })
  else demoLog({ at: end.at, from: t.name, to, kind: 'fail', text: T().states[end.state] })
}

// one beat: each running agent calls its next tool or answers, one asks for an approval now and
// then, and a new one starts when fewer than two run
async function demoTick($: EngineInterface) {
  if (!demo) return
  const now = await $.clock.now()
  const step = ++demo.step
  const types = demoTypes()
  const byName = new Map(types.map(t => [t.name, t]))
  const running = [...agents.values()].filter(a => a.state === 'running' || a.state === 'waiting')
  running.forEach((a, i) => {
    const t = byName.get(a.role)
    if (a.state === 'waiting') {
      agents.set(a.id, { ...a, state: 'running', detail: t?.script[Math.min(a.tools, t.script.length) - 1]?.[1] ?? '' })
      return
    }
    if (step % 7 === 3 && i === 0) {
      agents.set(a.id, { ...a, state: 'waiting', detail: T().approval })
      demoLog({ at: now, from: a.role, to: '', kind: 'wait', text: `${a.tool} · ${T().approval}` })
      return
    }
    const next = t?.script[a.tools]
    if (next) {
      agents.set(a.id, { ...a, tool: next[0], detail: next[1], tools: a.tools + 1 })
      demoLog({ at: now, from: a.role, to: '', kind: 'tool', text: `${next[0]} → ${next[1]}` })
      return
    }
    // a run in four ends in a failure, the others answer
    const isFailed = step % 4 === 0
    const answer = locale === 'fr' ? `Fait : ${a.description.toLowerCase()}. ${a.tools} appels, rien de bloquant.` : `Done: ${a.description.toLowerCase()}. ${a.tools} calls, nothing blocking.`
    agents.set(a.id, { ...a, state: isFailed ? 'error' : 'done', tool: '', detail: '', answer: isFailed ? '' : answer, endedAt: now })
    demoLog(isFailed ? { at: now, from: a.role, to: T().main, kind: 'fail', text: T().states.error } : { at: now, from: a.role, to: T().main, kind: 'answer', text: answer })
  })

  const stillRunning = [...agents.values()].filter(a => a.state === 'running' || a.state === 'waiting')
  if (stillRunning.length < 2) {
    const busy = new Set(stillRunning.map(a => a.role))
    const candidates = types.filter(t => t.script.length > 0 && !busy.has(t.name))
    const t = candidates[step % candidates.length]!
    demoRun(t, now)
    Object.assign(main, { state: 'running', tool: 'Agent', detail: t.task[0], tools: main.tools + 1 })
  } else if (step % 9 === 0) {
    Object.assign(main, { state: 'idle', tool: '', detail: '' })
  } else {
    const [tool, detail] = ([['Read', 'src/billing/invoice.ts'], ['TodoWrite', ''], ['Grep', 'roundAmount']] as const)[step % 3]!
    Object.assign(main, { state: 'running', tool, detail, tools: main.tools + 1 })
  }
  // finished agents past the newest few leave, as live ones do
  const ended = [...agents.values()].filter(a => a.endedAt != null).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  for (const a of ended.slice(FINISHED_KEPT)) agents.delete(a.id)
  redraw($)
}

function demoLog(entry: LogEntry) {
  log.push(entry)
  if (log.length > DEMO_LOG_KEPT) log.splice(0, log.length - DEMO_LOG_KEPT)
}

// the demo's session folder: its role files and a journal as a team would write it
function demoTeam(now: number): Session {
  const fr = locale === 'fr'
  const at = (minutesAgo: number) => clockTime(now - minutesAgo * 60_000).slice(0, 5)
  const lines: [number, string, string, string][] = fr
    ? [
        [42, 'lead', 'decision', '#arrondi on passe les montants en centimes entiers'],
        [35, 'architect', 'info', '#money type Money partagé proposé dans contrat.md'],
        [21, 'tester', 'bloque', '#tests invoice.test.ts dépend de l’arrondi flottant'],
        [12, 'dev', 'info', '#arrondi invoice.ts et tax.ts passent par Money'],
        [4, 'tester', 'resultat', '#tests 128 tests passent, 0 en échec'],
      ]
    : [
        [42, 'lead', 'decision', '#rounding amounts move to integer cents'],
        [35, 'architect', 'info', '#money a shared Money type, proposed in contrat.md'],
        [21, 'tester', 'bloque', '#tests invoice.test.ts relies on float rounding'],
        [12, 'dev', 'info', '#rounding invoice.ts and tax.ts go through Money'],
        [4, 'tester', 'resultat', '#tests 128 tests pass, 0 failing'],
      ]
  return {
    name: fr ? '2026-10-03-arrondi-factures' : '2026-10-03-invoice-rounding',
    files: ['brief.md', 'contrat.md', 'test.md', 'journal.md'],
    journal: lines.map(([m, role, type, text]) => ({ time: at(m), role, type, text })),
  }
}