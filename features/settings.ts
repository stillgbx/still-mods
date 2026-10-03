// The /still-mods command: lists every option of the plugin with its value, and changes one, for
// surfaces with no /config menu (the desktop Code tab). A change goes through $.config.set when the
// option is a row of the config menu; a plugin loaded from a folder has no row there in the desktop
// app, so the command then writes pluginConfigs in ~/.claude/settings.json itself and touches a file
// of the plugin, which makes the watched folder reload it with the new options.
import type { EngineInterface, Register } from 'claude-code'

import { type Locale, resolveLocale, systemLocale } from './i18n'
import { PALETTE_NAMES } from './palettes'

const COMMAND = 'still-mods'
const PLUGIN = 'still-mods'
// written after a change so the watched folder reloads the plugin; ignored by git
const RELOAD_STAMP = '.reload-stamp'

type Field = { name: string; kind: 'boolean' | 'choice' | 'text' | 'number'; choices?: string[]; fallback: string | boolean | number; label: Record<Locale, string> }

// the manifest's userConfig, in the order the list shows it
const FIELDS: Field[] = [
  { name: 'planProgress', kind: 'boolean', fallback: true, label: { en: 'Plan progress bars', fr: 'Barres de progression des plans' } },
  {
    name: 'planEnforcement',
    kind: 'choice',
    choices: ['strict', 'soft', 'off'],
    fallback: 'soft',
    label: { en: 'How hard Claude is held to its bars', fr: 'Exigence envers Claude sur les barres' },
  },
  {
    name: 'sounds',
    kind: 'choice',
    choices: ['soft', 'classic', 'off'],
    fallback: 'soft',
    label: { en: 'Sounds for decision, error, done', fr: 'Sons de décision, erreur, fin' },
  },
  { name: 'turnNotify', kind: 'boolean', fallback: true, label: { en: 'Sound and toast when a long turn ends', fr: 'Son et notification à la fin d’un long tour' } },
  { name: 'turnNotifySeconds', kind: 'number', fallback: 60, label: { en: 'Seconds a turn must last to notify', fr: 'Durée minimale du tour pour notifier (s)' } },
  { name: 'gitStatus', kind: 'boolean', fallback: true, label: { en: 'Git status line (branch, changes, ahead/behind)', fr: 'Ligne d’état git (branche, modifs, avance/retard)' } },
  { name: 'cacheMeter', kind: 'boolean', fallback: true, label: { en: 'Prompt cache column (hit rate, time left)', fr: 'Colonne cache (taux, temps restant)' } },
  { name: 'cacheTtl', kind: 'choice', choices: ['1h', '5m'], fallback: '1h', label: { en: 'Prompt cache lifetime', fr: 'Durée de vie du cache' } },
  { name: 'usageMeters', kind: 'boolean', fallback: true, label: { en: 'Context and limit meters', fr: 'Compteurs de contexte et de limites' } },
  {
    name: 'agentsPane',
    kind: 'choice',
    choices: ['auto', 'manual', 'off'],
    fallback: 'auto',
    label: { en: 'Agents pane (auto opens when an agent starts)', fr: 'Panneau Agents (auto : s’ouvre au lancement d’un agent)' },
  },
  {
    name: 'agentsSessionsDir',
    kind: 'text',
    fallback: '_generated-ai-doc/sessions',
    label: { en: 'Team session folders, from the project', fr: 'Dossiers de session de l’équipe, depuis le projet' },
  },
  {
    name: 'palette',
    kind: 'choice',
    choices: PALETTE_NAMES,
    fallback: 'default',
    label: { en: 'Colours of the bars and meters', fr: 'Couleurs des barres et compteurs' },
  },
  { name: 'language', kind: 'choice', choices: ['auto', 'en', 'fr'], fallback: 'auto', label: { en: 'Labels language', fr: 'Langue des libellés' } },
  { name: 'timeZone', kind: 'text', fallback: 'Europe/Paris', label: { en: 'Reset time zone (IANA)', fr: 'Fuseau des heures de reset (IANA)' } },
]

const TEXT = {
  en: {
    title: 'still-mods options',
    change: `Change one: /${COMMAND} <option> <value>, e.g. /${COMMAND} usageMeters off`,
    commands: `Commands: /${COMMAND}-agents (the Agents pane), /${COMMAND}-progress (show or hide the bars), /${COMMAND}-progress-demo, /${COMMAND}-progress-clear, /${COMMAND}-progress-sounds`,
    unknown: (f: string) => `Unknown option "${f}".`,
    needs: (f: string, v: string) => `"${f}" takes ${v}.`,
    notChanged: (f: string, why: string) => `${f} not changed: ${why}`,
    changed: (f: string, v: string) => `${f} = ${v}. The plugin reloads with it.`,
    written: (f: string, v: string, path: string) => `${f} = ${v}, saved in ${path}. The plugin reloads with it.`,
    noWrite: (f: string, v: string, why: string) =>
      `${f} could not be saved (${why}). Set it in ~/.claude/settings.json:\n"pluginConfigs": { "${PLUGIN}": { "options": { "${f}": ${v} } } }`,
    anyText: 'any text',
  },
  fr: {
    title: 'Options de still-mods',
    change: `Pour changer : /${COMMAND} <option> <valeur>, ex. /${COMMAND} usageMeters off`,
    commands: `Commandes : /${COMMAND}-agents (panneau Agents), /${COMMAND}-progress (afficher ou masquer les barres), /${COMMAND}-progress-demo, /${COMMAND}-progress-clear, /${COMMAND}-progress-sounds`,
    unknown: (f: string) => `Option inconnue « ${f} ».`,
    needs: (f: string, v: string) => `« ${f} » accepte ${v}.`,
    notChanged: (f: string, why: string) => `${f} inchangé : ${why}`,
    changed: (f: string, v: string) => `${f} = ${v}. Le mod se recharge avec cette valeur.`,
    written: (f: string, v: string, path: string) => `${f} = ${v}, enregistré dans ${path}. Le mod se recharge avec cette valeur.`,
    noWrite: (f: string, v: string, why: string) =>
      `${f} n'a pas pu être enregistré (${why}). Règle-le dans ~/.claude/settings.json :\n"pluginConfigs": { "${PLUGIN}": { "options": { "${f}": ${v} } } }`,
    anyText: 'un texte',
  },
}

// the values this load runs with, from register(on, options)
let current: Record<string, unknown> = {}
let locale: Locale = 'en'

export function registerSettings(on: Parameters<Register>[0], options: Record<string, unknown>) {
  current = options

  // a matcher, so other features may hook session.start too
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const settings = await $.settings.read()
    locale = resolveLocale(current.language, settings.language, systemLocale())
    await $.command.register({
      name: COMMAND,
      description: locale === 'fr' ? 'Afficher ou changer les options de still-mods' : 'Show or change the still-mods options',
      argumentHint: '[' + FIELDS.map(f => f.name).join('|') + '] [value]',
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [name, ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    if (!name) return { text: await describe($) }
    return { text: await change($, name, rest.join(' ')) }
  })
}

// this plugin's rows of the config menu, keyed `<plugin>.<field>` (`<plugin>@inline.<field>` loaded from a folder)
async function ownRows($: EngineInterface) {
  const rows = await $.config.list()
  return rows
    .filter(row => row.key.startsWith(PLUGIN + '.') || row.key.startsWith(PLUGIN + '@'))
    .map(row => ({ ...row, field: row.key.slice(row.key.lastIndexOf('.') + 1) }))
}

function accepted(field: Field) {
  if (field.kind === 'boolean') return 'on | off'
  if (field.kind === 'choice') return (field.choices ?? []).join(' | ')
  if (field.kind === 'number') return locale === 'fr' ? 'un nombre' : 'a number'
  return TEXT[locale].anyText
}

async function describe($: EngineInterface) {
  const rows = await ownRows($)
  const width = Math.max(...FIELDS.map(f => f.name.length))
  const lines = FIELDS.map(field => {
    const row = rows.find(r => r.field === field.name)
    const value = row ? row.value : (current[field.name] ?? field.fallback)
    return `  ${field.name.padEnd(width)}  ${formatValue(value).padEnd(12)}  ${field.label[locale]}  (${accepted(field)})`
  })
  const T = TEXT[locale]
  return [T.title, ...lines, '', T.change, T.commands].join('\n')
}

async function change($: EngineInterface, name: string, raw: string) {
  const T = TEXT[locale]
  const field = FIELDS.find(f => f.name.toLowerCase() === name.toLowerCase())
  if (!field) return `${T.unknown(name)}\n\n${await describe($)}`
  const value = parseValue(field, raw)
  if (value === undefined) return T.needs(field.name, accepted(field))
  const row = (await ownRows($)).find(r => r.field === field.name)
  if (!row) {
    try {
      const path = await saveOption($, field.name, value)
      current = { ...current, [field.name]: value }
      return T.written(field.name, formatValue(value), path)
    } catch (error) {
      return T.noWrite(field.name, JSON.stringify(value), error instanceof Error ? error.message : String(error))
    }
  }
  const result = await $.config.set({ key: row.key, value })
  if (result.deny) return T.notChanged(field.name, result.deny)
  return T.changed(field.name, formatValue(result.value))
}

// writes pluginConfigs.<plugin>.options.<name> in the user settings, keeping every other key, then
// touches the reload stamp so the watched plugin folder loads again with the new options
async function saveOption($: EngineInterface, name: string, value: string | boolean | number) {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) throw new Error('no home directory')
  const path = home.replace(/\\/g, '/') + '/.claude/settings.json'
  const text = (await $.fs.exists(path)) ? await $.fs.read(path) : '{}'
  const settings = JSON.parse(text) as Record<string, any>
  const configs = (settings.pluginConfigs ??= {})
  const own = (configs[PLUGIN] ??= {})
  own.options = { ...(own.options ?? {}), [name]: value }
  await $.fs.write(path, JSON.stringify(settings, null, 2) + '\n')
  await $.fs.write(`${$.plugin.root}/${RELOAD_STAMP}`, new Date().toISOString() + '\n')
  return path
}

function parseValue(field: Field, raw: string): string | boolean | number | undefined {
  const word = raw.trim()
  if (field.kind === 'number') {
    const n = Number(word.replace(',', '.'))
    return word && Number.isFinite(n) && n >= 0 ? n : undefined
  }
  if (field.kind === 'boolean') {
    const w = word.toLowerCase()
    if (['on', 'true', 'yes', 'oui', '1'].includes(w)) return true
    if (['off', 'false', 'no', 'non', '0'].includes(w)) return false
    return undefined
  }
  if (field.kind === 'choice') return field.choices?.find(c => c === word.toLowerCase())
  return word || undefined
}

function formatValue(value: unknown) {
  if (value === true) return 'on'
  if (value === false) return 'off'
  return String(value)
}
