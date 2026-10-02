import type { EngineInterface, Register } from 'claude-code'

import { stack } from './band'
import { type Locale, resolveLocale, strings, systemLocale } from './i18n'

// Usage meters: context, 5-hour and weekly limit usage, adapted from usage-meter by HolyGrail
// (https://github.com/HolyGrail/claude-mods): see NOTICE.

let context: any = null
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
const WINDOWS: Record<string, { title: string; ms?: number; showsDay?: boolean }> = {
  five_hour: { title: 'fiveHour', ms: 5 * HOUR_MS },
  seven_day: { title: 'sevenDay', ms: 7 * 24 * HOUR_MS, showsDay: true },
  spend_limit: { title: '$' },
}
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
const SVG_COLORS: Record<string, string> = { success: '#4caf50', warning: '#e0a526', error: '#e5534b', track: 'rgba(128,128,128,0.3)', marker: '#5b9bff' }
const MARKER_COLOR = 'cyan'

type Meter = { key: string; label: string; used: number | undefined; elapsed: number | null; detail: string }

// session.start fires again on a reload: the store stays, these variables start over
async function startUsageMeters($: EngineInterface) {
  const settings = await $.settings.read()
  locale = resolveLocale(language, settings.language, systemLocale())
  ticker?.cancel()
  rateLimits = []
  measuredAt = 0
  ownKey = KEY_PREFIX + (await $.session.id())
  const usage: any = await $.session.usage()
  context = usage.context
  if (usage.rateLimits.length > 0) await publishSnapshot($, usage.rateLimits)
  await refresh($)
  ticker = $.clock.every(TICK_MS, async () => {
    await refresh($)
    $.ui.invalidate('ui.render')
  })
  $.ui.invalidate('ui.render')
}

export function registerUsageMeters(on: Parameters<Register>[0], options: { timeZone?: string; language?: string }) {
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
    return stack($.ui.resolve(e).Box, [rest, meters]) ?? rest
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
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    context = e.context
    if (e.changed.includes('rateLimits')) await remember($, e.rateLimits as any[])
    $.ui.invalidate('ui.render')
    return next(e)
  })
}

async function usageMeters($: EngineInterface, e: any): Promise<any> {
  const elements: any = $.ui.resolve(e)
  const now = await $.clock.now()
  const L = strings(locale)
  const meters: Meter[] = [{ key: 'ctx', label: L.ctx, used: context?.percent, elapsed: null, detail: contextDetail() }]
  for (const limit of rateLimits) meters.push(readLimit(limit, now))
  // the windows arrive with the first API response; until then they show as unknown
  for (const kind of ALWAYS_SHOWN) {
    if (!rateLimits.some(l => l.kind === kind)) meters.push({ key: kind, label: titleOf(kind), used: undefined, elapsed: null, detail: L.waiting })
  }
  const columns = e.props.bodyColumns ?? 0
  const room = columns - BAND_RESERVED_COLUMNS
  // side by side when every column gets its minimum, else one under the other (a phone)
  const isRow = room - METER_GAP * (meters.length - 1) >= MIN_BAR_CELLS * meters.length
  const cells = isRow ? Math.floor((room - METER_GAP * (meters.length - 1)) / meters.length) : Math.max(MIN_BAR_CELLS, room)
  const gauge = 'Svg' in elements ? 'svg' : 'text'
  // equal columns from edge to edge, each two lines: the figures, then the bar
  return elements.Box({
    key: 'usage-meters',
    flexDirection: isRow ? 'row' : 'column',
    columnGap: METER_GAP,
    rowGap: 1,
    children: meters.map(m => meter(elements, gauge, cells, m)),
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
  if (resetsAtMs != null && resetsAtMs <= now) return { key: limit.kind, label, used: 0, elapsed: window?.ms ? 0 : null, detail: '' }
  const elapsed = window?.ms && resetsAtMs != null ? clamp(100 - ((resetsAtMs - now) / window.ms) * 100) : null
  const detail = resetsAtMs == null ? '' : strings(locale).resetsIn(untilReset(resetsAtMs - now)) + ' · ' + resetClock(resetsAtMs, window?.showsDay === true)
  return { key: limit.kind, label, used: limit.percentUsed, elapsed, detail }
}

function titleOf(kind: string) {
  const title = WINDOWS[kind]?.title ?? kind
  const L = strings(locale) as Record<string, unknown>
  return typeof L[title] === 'string' ? (L[title] as string) : title
}

// tokens in the window and its size, as 210k / 1M
function contextDetail() {
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

// two lines in one column: the title and the share used, the reset dimmed at the right; then the bar
function meter({ Box, Text, Svg }: any, gauge: string, cells: number, { key, label, used, elapsed, detail }: Meter) {
  const known = typeof used === 'number'
  const status = known ? statusOf(used, elapsed) : null
  const percent = known ? Math.round(used) + '%' : '—'
  const head = Box({
    flexDirection: 'row',
    justifyContent: 'space-between',
    columnGap: 1,
    children: [
      Box({
        flexDirection: 'row',
        columnGap: 1,
        flexShrink: 0,
        children: [Text({ bold: true, children: [label] }), Text({ bold: true, ...(known ? { color: status } : { dimColor: true }), children: [percent] })],
      }),
      Text({ dimColor: true, wrap: 'truncate', children: [detail] }),
    ],
  })
  const bar =
    gauge === 'svg'
      ? Svg({
          source: svgBar(cells * PX_PER_COLUMN, known ? used : 0, elapsed, status),
          alt: `${label} ${percent}${detail ? ', ' + detail : ''}${elapsed == null ? '' : ', ' + Math.round(elapsed) + '%'}`,
          width: cells * PX_PER_COLUMN,
          height: SVG_BAR_HEIGHT,
        })
      : textBar(Text, cells, known ? used : 0, elapsed, status)
  return Box({ key: 'meter-' + key, flexDirection: 'column', width: cells, flexShrink: 0, children: [head, bar] })
}

// used cells in the status color, the rest dim, and the time marker
function textBar(Text: any, cells: number, used: number, elapsed: number | null, status: string | null) {
  const filled = Math.round((clamp(used) / 100) * cells)
  const marker = elapsed == null ? -1 : Math.min(cells - 1, Math.floor((elapsed / 100) * cells))
  const markerStyle = { color: MARKER_COLOR, bold: true }
  const usedStyle = status ? { color: status } : { dimColor: true }
  const restStyle = { dimColor: true }
  const runs: { text: string; style: object }[] = []
  for (let i = 0; i < cells; i++) {
    const cell = i === marker ? { char: '┃', style: markerStyle } : i < filled ? { char: '█', style: usedStyle } : { char: '░', style: restStyle }
    const last = runs.at(-1)
    if (last && last.style === cell.style) last.text += cell.char
    else runs.push({ text: cell.char, style: cell.style })
  }
  return Text({ children: runs.map(run => Text({ ...run.style, children: [run.text] })) })
}

// a rounded track with the used share and, for a timed window, a marker at the time gone
function svgBar(width: number, used: number, elapsed: number | null, status: string | null) {
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
  parts.push('</g>')
  if (elapsed != null) {
    const x = Math.min(width - 2, Math.max(0, Math.round((elapsed / 100) * width) - 1))
    parts.push(`<rect x="${x}" width="2" height="${height}" rx="1" fill="${SVG_COLORS.marker}"/>`)
  }
  parts.push('</svg>')
  return parts.join('')
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
