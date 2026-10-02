import type { EngineInterface, Register } from 'claude-code'

import { stack } from './band'
import { palette, type PaletteName } from './palettes'
import { formatUsd, type Locale, resolveLocale, strings, systemLocale } from './i18n'

// Usage meters: context, 5-hour and weekly limit usage, adapted from usage-meter by HolyGrail
// (https://github.com/HolyGrail/claude-mods): see NOTICE.

let context: any = null
// what the session has cost so far, in US dollars; null where the host keeps no ledger
let costUsd: number | null = null
let rateLimits: any[] = []
// when rateLimits was last measured, in $.clock.now() milliseconds
let measuredAt = 0
let ticker: { cancel(): void } | null = null
// this session's own key in the store
let ownKey: string | null = null

// rate limits are per account, so sessions share readings through $.store and each shows the newest;
// each session writes only its own key, so no write can overwrite another session's reading
const KEY_PREFIX = 'reading:'
const HOUR_MS = 3_600_000
// readings older than the longest window say nothing current
const STALE_MS = 8 * 24 * HOUR_MS
// the session.end reasons after which the meters stop; /clear, /resume and logout keep them running
const FINAL_REASONS = ['prompt_input_exit', 'other']
const TICK_MS = 60_000
// reset times are shown in this zone, the timeZone option
let timeZone = 'Europe/Paris'
// the labels' language: the language option, else read at session.start
let language = 'auto'
let locale: Locale = 'en'

// title: a key of the labels, or the label itself; showsDay adds the weekday to the reset time
// divisions: the bar is cut in that many equal parts, one per hour or per day of the window
const WINDOWS: Record<string, { title: string; ms?: number; showsDay?: boolean; divisions?: number }> = {
  five_hour: { title: 'fiveHour', ms: 5 * HOUR_MS, divisions: 5 },
  seven_day: { title: 'sevenDay', ms: 7 * 24 * HOUR_MS, showsDay: true, divisions: 7 },
  spend_limit: { title: '$' },
}
// the context bar's cuts: every tenth from half full, where the window starts to matter
const CONTEXT_TICKS = [0.5, 0.6, 0.7, 0.8, 0.9]
// shown even before any reading, so the band keeps its shape from the first frame
const ALWAYS_SHOWN = ['five_hour', 'seven_day']

// pace thresholds: margin is the elapsed share of the window minus the used share
const GREEN_MIN_MARGIN = 10
const RED_BELOW_MARGIN = -15
const GREEN_MAX_USED = 10
const RED_MIN_USED = 90

// the narrowest a meter's column gets, in terminal cells
const MIN_BAR_CELLS = 12
// the desktop draws about this many CSS pixels per column
const PX_PER_COLUMN = 8
const METER_GAP = 3
const BAND_RESERVED_COLUMNS = 2
const SVG_BAR_HEIGHT = 12
// set from the palette option when the module registers
let usesPalette = false
const SVG_COLORS: Record<string, string> = { success: '#4caf50', warning: '#e0a526', error: '#e5534b', track: 'rgba(128,128,128,0.3)', marker: '#5b9bff', tick: 'rgba(0,0,0,0.38)' }
const MARKER_COLOR = 'cyan'

type Meter = {
  key: string
  label: string
  used: number | undefined
  elapsed: number | null
  detail: string
  ticks?: number[]
  // a figure and a colour of their own, where the bar measures something else (the cache)
  percent?: string
  status?: string | null
  barStatus?: string
}

// the main thread's prompt cache: the share of the last response's input it served, and when that
// response came, from which the cache's time to live runs; kept per session in the store
let cacheTtlMs = HOUR_MS
// the cacheMeter option
let cacheShown = true
let cacheRate: number | null = null
let lastResponseAt: number | null = null
let cacheKey: string | null = null
const CACHE_PREFIX = 'cache:'
// the cache counts as nearly gone in the last part of its life
const CACHE_LOW_SHARE = 0.15

// session.start fires again on a reload: the store stays, these variables start over
async function startUsageMeters($: EngineInterface) {
  const settings = await $.settings.read()
  locale = resolveLocale(language, settings.language, systemLocale())
  ticker?.cancel()
  rateLimits = []
  measuredAt = 0
  ownKey = KEY_PREFIX + (await $.session.id())
  await loadCache($)
  const usage: any = await $.session.usage()
  context = usage.context
  costUsd = typeof usage.cost?.usd === 'number' ? usage.cost.usd : null
  if (usage.rateLimits.length > 0) await publishSnapshot($, usage.rateLimits)
  await refresh($)
  ticker = $.clock.every(TICK_MS, async () => {
    await refresh($)
    $.ui.invalidate('ui.render')
  })
  $.ui.invalidate('ui.render')
}

export function registerUsageMeters(on: Parameters<Register>[0], options: { timeZone?: string; language?: string; palette?: PaletteName; cacheTtl?: '5m' | '1h'; cacheMeter?: boolean }) {
  cacheTtlMs = options.cacheTtl === '5m' ? 5 * 60_000 : HOUR_MS
  cacheShown = options.cacheMeter !== false
  const p = palette(options.palette)
  usesPalette = (options.palette ?? 'default') !== 'default'
  Object.assign(SVG_COLORS, { success: p.success, warning: p.warning, error: p.danger, track: p.track, marker: p.marker })
  if (options.timeZone) timeZone = options.timeZone
  language = options.language ?? 'auto'

  // the meters sit below whatever the hooks beneath draw, next to the prompt
  // a matcher, so other features may hook session.start too
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    await startUsageMeters($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const meters = await usageMeters($, e)
    return stack($.ui.resolve(e).Box, [['above-meters', rest], ['usage-meters', meters]]) ?? rest
  })
  on('session.end', async ($, e, next) => {
    if (!FINAL_REASONS.includes(e.reason) || !ownKey) return next(e)
    ticker?.cancel()
    await releaseKey($)
    return next(e)
  })

  // /clear, /resume, /branch and compaction change the context; all but compaction switch session id
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork', 'compact'] }, async ($, e, next) => {
    const key = KEY_PREFIX + (await $.session.id())
    if (ownKey && key !== ownKey) {
      await releaseKey($)
      ownKey = key
    }
    context = ((await $.session.usage()) as any).context
    const since = (e as unknown as { seconds_since_last_response?: number }).seconds_since_last_response
    if (typeof since === 'number') await saveCache($, cacheRate, (await $.clock.now()) - since * 1000)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // each response of the main thread: how much of its input the cache served, and the time it came
  on('turn.step', { turnId: /^/ }, async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (!e.agentId && usage) {
      const input = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
      await saveCache($, input > 0 ? (usage.cache_read_input_tokens / input) * 100 : cacheRate, await $.clock.now())
      $.ui.invalidate('ui.render')
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    context = e.context
    if (typeof e.cost?.usd === 'number') costUsd = e.cost.usd
    if (e.changed.includes('rateLimits')) await remember($, e.rateLimits as any[])
    $.ui.invalidate('ui.render')
    return next(e)
  })
}

async function usageMeters($: EngineInterface, e: any): Promise<any> {
  const elements: any = $.ui.resolve(e)
  const now = await $.clock.now()
  const L = strings(locale)
  const meters: Meter[] = [{ key: 'ctx', label: L.ctx, used: context?.percent, elapsed: null, detail: contextDetail(), ticks: CONTEXT_TICKS }]
  if (cacheShown) meters.push(cacheMeter(now))
  for (const limit of rateLimits) meters.push(readLimit(limit, now))
  // the windows arrive with the first API response; until then they show as unknown
  for (const kind of ALWAYS_SHOWN) {
    if (!rateLimits.some(l => l.kind === kind)) meters.push({ key: kind, label: titleOf(kind), used: undefined, elapsed: null, detail: L.waiting })
  }
  const columns = e.props.bodyColumns ?? 0
  const room = columns - BAND_RESERVED_COLUMNS
  // as many meters on a row as fit whole, their title, figure and detail untruncated; the rows
  // balanced (4 meters as 2 + 2, not 3 + 1), down to one per row on a phone
  const need = Math.max(MIN_BAR_CELLS, ...meters.map(widthOf))
  const fit = Math.max(1, Math.min(meters.length, Math.floor((room + METER_GAP) / (need + METER_GAP))))
  const rowCount = Math.ceil(meters.length / fit)
  const perRow = Math.ceil(meters.length / rowCount)
  const cells = Math.max(MIN_BAR_CELLS, Math.floor((room - METER_GAP * (perRow - 1)) / perRow))
  const gauge = 'Svg' in elements ? 'svg' : 'text'
  const rows = Array.from({ length: rowCount }, (_, r) => meters.slice(r * perRow, (r + 1) * perRow))
  // equal columns from edge to edge, each two lines: the figures, then the bar
  return elements.Box({
    key: 'usage-meters',
    flexDirection: 'column',
    rowGap: 1,
    children: rows.map((row, r) =>
      elements.Box({ key: `meters-row-${r}`, flexDirection: 'row', columnGap: METER_GAP, children: row.map(m => meter(elements, gauge, cells, m)) }),
    ),
  })
}

async function remember($: EngineInterface, limits: any[]) {
  // take the time first, so a refresh meanwhile cannot pair old limits with it
  const now = await $.clock.now()
  rateLimits = limits
  measuredAt = now
  if (ownKey) await $.store.set(ownKey, { at: now, limits })
}

// takes the newest reading any session saved, unless this session's own is newer still
async function refresh($: EngineInterface) {
  const { entries, newest } = await scan($)
  if (newest && newest.reading.at >= measuredAt) {
    rateLimits = newest.reading.limits
    measuredAt = newest.reading.at
  } else if (!newest && measuredAt < (await $.clock.now()) - STALE_MS) {
    rateLimits = []
    measuredAt = 0
  }
  await prune($, entries, newest?.key)
}

// keeps this session's reading marked ended if it is the newest, removes it otherwise
async function releaseKey($: EngineInterface) {
  if (!ownKey) return
  const { entries, newest } = await scan($)
  if (newest?.key === ownKey) await $.store.set(ownKey, { ...newest.reading, ended: true })
  else await $.store.delete(ownKey)
  await prune($, entries, newest?.key)
}

async function prune($: EngineInterface, entries: { key: string; reading: any }[], newestKey: string | undefined) {
  const cutoff = (await $.clock.now()) - STALE_MS
  for (const { key, reading } of entries) {
    if (key === ownKey || key === newestKey) continue
    if (!isReading(reading) || reading.ended === true || reading.at < cutoff) await $.store.delete(key)
  }
}

// a shared reading always wins over the startup snapshot of usage(), which may be older
async function publishSnapshot($: EngineInterface, snapshot: any[]) {
  const { newest } = await scan($)
  if (newest) {
    rateLimits = newest.reading.limits
    measuredAt = newest.reading.at
    return
  }
  await remember($, snapshot)
}

async function scan($: EngineInterface) {
  const entries: { key: string; reading: any }[] = []
  let newest: { key: string; reading: any } | null = null
  const cutoff = (await $.clock.now()) - STALE_MS
  for (const key of await $.store.keys()) {
    if (!key.startsWith(KEY_PREFIX)) continue
    const reading: any = await $.store.get(key)
    entries.push({ key, reading })
    if (!isReading(reading) || reading.at < cutoff) continue
    if (!newest || reading.at > newest.reading.at || (reading.at === newest.reading.at && key > newest.key)) newest = { key, reading }
  }
  return { entries, newest }
}

function isReading(value: any) {
  return value != null && typeof value.at === 'number' && Array.isArray(value.limits)
}

function readLimit(limit: any, now: number): Meter {
  const window = WINDOWS[limit.kind]
  const label = titleOf(limit.kind)
  const resetsAtMs = limit.resetsAt == null ? null : Date.parse(limit.resetsAt)
  // a window that has reset since the last reading starts again from zero
  if (resetsAtMs != null && resetsAtMs <= now) return { key: limit.kind, label, used: 0, elapsed: window?.ms ? 0 : null, detail: '', ticks: divisionPoints(window?.divisions) }
  const elapsed = window?.ms && resetsAtMs != null ? clamp(100 - ((resetsAtMs - now) / window.ms) * 100) : null
  const detail = resetsAtMs == null ? '' : strings(locale).resetsIn(untilReset(resetsAtMs - now)) + ' · ' + resetClock(resetsAtMs, window?.showsDay === true)
  return { key: limit.kind, label, used: limit.percentUsed, elapsed, detail, ticks: divisionPoints(window?.divisions) }
}

// the cache column: its hit rate as the figure, the time it has left as the bar, which drains
function cacheMeter(now: number): Meter {
  const L = strings(locale)
  const rate = cacheRate == null ? '—' : Math.round(cacheRate) + '%'
  const rateStatus = cacheRate == null ? null : cacheRate >= 80 ? 'success' : cacheRate >= 50 ? 'warning' : 'error'
  if (lastResponseAt == null) return { key: 'cache', label: L.cache, used: undefined, elapsed: null, detail: L.waiting, percent: rate, status: rateStatus }
  const left = lastResponseAt + cacheTtlMs - now
  if (left <= 0) return { key: 'cache', label: L.cache, used: 0, elapsed: null, detail: L.cold, percent: rate, status: rateStatus }
  const share = (left / cacheTtlMs) * 100
  return {
    key: 'cache',
    label: L.cache,
    used: share,
    elapsed: null,
    detail: L.warm(untilReset(left)),
    percent: rate,
    status: rateStatus,
    // the bar's own colour: green while it has time, orange near the end
    barStatus: share / 100 <= CACHE_LOW_SHARE ? 'warning' : 'success',
  }
}

async function loadCache($: EngineInterface) {
  cacheKey = CACHE_PREFIX + (await $.session.id())
  const saved: any = await $.store.get(cacheKey)
  cacheRate = typeof saved?.rate === 'number' ? saved.rate : null
  lastResponseAt = typeof saved?.at === 'number' ? saved.at : null
  // other sessions' readings past any cache's life say nothing; their keys go
  const cutoff = (await $.clock.now()) - 2 * HOUR_MS
  for (const key of await $.store.keys()) {
    if (!key.startsWith(CACHE_PREFIX) || key === cacheKey) continue
    const other: any = await $.store.get(key)
    if (typeof other?.at !== 'number' || other.at < cutoff) await $.store.delete(key)
  }
}

async function saveCache($: EngineInterface, rate: number | null, at: number) {
  cacheRate = rate
  lastResponseAt = at
  if (cacheKey) await $.store.set(cacheKey, { rate, at })
}

function titleOf(kind: string) {
  const title = WINDOWS[kind]?.title ?? kind
  const L = strings(locale) as Record<string, unknown>
  return typeof L[title] === 'string' ? (L[title] as string) : title
}

// the session's cost, then the tokens in the window and its size: 3,42 $ · 210k / 1M
function contextDetail() {
  const cost = costUsd == null ? '' : formatUsd(locale, costUsd)
  const tokens = contextTokens()
  return cost && tokens ? `${cost} · ${tokens}` : cost || tokens
}

function contextTokens() {
  if (!context?.window) return ''
  const used = typeof context.tokens === 'number' ? context.tokens : typeof context.percent === 'number' ? (context.percent / 100) * context.window : null
  return used == null ? formatTokens(context.window) : formatTokens(used) + ' / ' + formatTokens(context.window)
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return String(Math.round(n / 100_000) / 10) + 'M'
  if (n >= 1000) return Math.round(n / 1000) + 'k'
  return String(Math.round(n))
}

function statusOf(used: number, elapsed: number | null) {
  if (used >= RED_MIN_USED) return 'error'
  if (elapsed == null) return used >= 80 ? 'error' : used >= 50 ? 'warning' : 'success'
  const margin = elapsed - used
  if (margin < RED_BELOW_MARGIN) return 'error'
  if (margin < GREEN_MIN_MARGIN && used >= GREEN_MAX_USED) return 'warning'
  return 'success'
}

// the cells a meter's first line takes whole: title, figure, two spaces, detail
function widthOf(m: Meter) {
  const percent = m.percent ?? (typeof m.used === 'number' ? Math.round(m.used) + '%' : '—')
  return [...m.label].length + 1 + [...percent].length + 2 + [...m.detail].length
}

// two lines in one column: the title and the share used, the reset dimmed at the right; then the bar
function meter({ Box, Text, Svg }: any, gauge: string, cells: number, m: Meter) {
  const { key, label, used, elapsed, detail, ticks } = m
  const known = typeof used === 'number'
  const barStatus = m.barStatus ?? (known ? statusOf(used, elapsed) : null)
  const status = m.status !== undefined ? m.status : barStatus
  const percent = m.percent ?? (known ? Math.round(used) + '%' : '—')
  const hasFigure = m.percent !== undefined ? m.percent !== '—' : known
  const head = Box({
    flexDirection: 'row',
    justifyContent: 'space-between',
    columnGap: 1,
    children: [
      Box({
        flexDirection: 'row',
        columnGap: 1,
        flexShrink: 0,
        children: [Text({ bold: true, children: [label] }), Text({ bold: true, ...(hasFigure ? { color: textColor(status) } : { dimColor: true }), children: [percent] })],
      }),
      Text({ dimColor: true, wrap: 'truncate', children: [detail] }),
    ],
  })
  const bar =
    gauge === 'svg'
      ? Svg({
          source: svgBar(cells * PX_PER_COLUMN, known ? used : 0, elapsed, barStatus, ticks),
          alt: `${label} ${percent}${detail ? ', ' + detail : ''}${elapsed == null ? '' : ', ' + Math.round(elapsed) + '%'}`,
          width: cells * PX_PER_COLUMN,
          height: SVG_BAR_HEIGHT,
        })
      : textBar(Text, cells, known ? used : 0, elapsed, barStatus, ticks)
  return Box({ key: 'meter-' + key, flexDirection: 'column', width: cells, flexShrink: 0, children: [head, bar] })
}

// used cells in the status color, the rest dim, and the time marker
function textBar(Text: any, cells: number, used: number, elapsed: number | null, status: string | null, ticks: number[] = []) {
  const filled = Math.round((clamp(used) / 100) * cells)
  // the cells of the cuts, shown on the unused part only
  const tickCells = new Set(ticks.map(f => Math.round(f * cells)))
  const marker = elapsed == null ? -1 : Math.min(cells - 1, Math.floor((elapsed / 100) * cells))
  const markerStyle = { color: MARKER_COLOR, bold: true }
  const usedStyle = status ? { color: textColor(status) } : { dimColor: true }
  const restStyle = { dimColor: true }
  const runs: { text: string; style: object }[] = []
  for (let i = 0; i < cells; i++) {
    const cell =
      i === marker
        ? { char: '┃', style: markerStyle }
        : i < filled
          ? { char: '█', style: usedStyle }
          : { char: tickCells.has(i) ? '┊' : '░', style: restStyle }
    const last = runs.at(-1)
    if (last && last.style === cell.style) last.text += cell.char
    else runs.push({ text: cell.char, style: cell.style })
  }
  return Text({ children: runs.map(run => Text({ ...run.style, children: [run.text] })) })
}

// a rounded track with the used share, thin cuts (each hour or day, or the context's upper tenths),
// and for a timed window a marker at the time gone
function svgBar(width: number, used: number, elapsed: number | null, status: string | null, ticks: number[] = []) {
  const height = SVG_BAR_HEIGHT
  const barH = 6
  const y = (height - barH) / 2
  const r = barH / 2
  const fill = Math.round((clamp(used) / 100) * width)
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<clipPath id="c"><rect y="${y}" width="${width}" height="${barH}" rx="${r}"/></clipPath>`,
    `<g clip-path="url(#c)">`,
    `<rect y="${y}" width="${width}" height="${barH}" fill="${SVG_COLORS.track}"/>`,
  ]
  if (fill > 0) parts.push(`<rect y="${y}" width="${fill}" height="${barH}" fill="${SVG_COLORS[status ?? 'success']}"/>`)
  for (const f of ticks) parts.push(`<rect x="${(f * width - 0.5).toFixed(1)}" y="${y}" width="1" height="${barH}" fill="${SVG_COLORS.tick}"/>`)
  parts.push('</g>')
  if (elapsed != null) {
    const x = Math.min(width - 2, Math.max(0, Math.round((elapsed / 100) * width) - 1))
    parts.push(`<rect x="${x}" width="2" height="${height}" rx="1" fill="${SVG_COLORS.marker}"/>`)
  }
  parts.push('</svg>')
  return parts.join('')
}

// where the window's hours or days begin, as shares of the bar, the ends left out
function divisionPoints(divisions?: number) {
  if (!divisions || divisions < 2) return []
  return Array.from({ length: divisions - 1 }, (_, i) => (i + 1) / divisions)
}

// a palette's own hex, else the surface's theme colour of that name (success, warning, error)
function textColor(status: string | null) {
  if (!status) return undefined
  return usesPalette ? SVG_COLORS[status] : status
}

function clamp(percent: number) {
  return Math.min(Math.max(percent, 0), 100)
}

// the reset as HH:MM in timeZone, with the short weekday for the long windows ("mar. 09:00")
function resetClock(ms: number, showsDay: boolean) {
  const tag = locale === 'fr' ? 'fr-FR' : 'en-GB'
  try {
    const time = new Intl.DateTimeFormat(tag, { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
    if (!showsDay) return time
    return new Intl.DateTimeFormat(tag, { timeZone, weekday: 'short' }).format(new Date(ms)) + ' ' + time
  } catch {
    const d = new Date(ms)
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }
}

function untilReset(ms: number) {
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const dayUnit = locale === 'fr' ? 'j' : 'd'
  if (days > 0) return days + dayUnit + ' ' + hours + 'h'
  if (hours > 0) return hours + 'h' + String(minutes % 60).padStart(2, '0')
  return (minutes % 60) + ' min'
}
