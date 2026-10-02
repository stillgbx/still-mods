// Colour palettes for what still-mods draws (the plan bars, the meters), from popular editor themes.
// Only the mod's own drawings change: the app's text and background stay as the app draws them, and
// a mod cannot tell whether the app is light or dark, so each palette names its variant.
//
// Every value is taken from the theme's own repository:
// - Catppuccin: https://github.com/catppuccin/palette (palette.json, Mocha and Latte)
// - Dracula and Alucard: https://draculatheme.com/spec
// - Night Owl: https://github.com/sdras/night-owl-vscode-theme (Night Owl-color-theme.json)
// - SynthWave '84: https://github.com/robb0wen/synthwave-vscode (synthwave-color-theme.json)
// - Tokyo Night Storm: https://github.com/folke/tokyonight.nvim (lua/tokyonight/colors/storm.lua)

export type PaletteName = 'default' | 'catppuccin-mocha' | 'catppuccin-latte' | 'dracula' | 'alucard' | 'night-owl' | 'synthwave-84' | 'tokyo-night'

export type Palette = {
  // plan bar states
  running: string
  waiting: string
  error: string
  done: string
  // meter fills, by pace
  success: string
  warning: string
  danger: string
  // the meter's empty track and its time marker
  track: string
  marker: string
}

export const PALETTE_NAMES: PaletteName[] = ['default', 'catppuccin-mocha', 'catppuccin-latte', 'dracula', 'alucard', 'night-owl', 'synthwave-84', 'tokyo-night']

const PALETTES: Record<PaletteName, Palette> = {
  // still-mods' own colours
  default: {
    running: '#8B7CF6', waiting: '#E09A1E', error: '#E5484D', done: '#30A46C',
    success: '#4caf50', warning: '#e0a526', danger: '#e5534b', track: 'rgba(128,128,128,0.3)', marker: '#5b9bff',
  },
  // mauve, peach, red, green; yellow; surface1; blue
  'catppuccin-mocha': {
    running: '#cba6f7', waiting: '#fab387', error: '#f38ba8', done: '#a6e3a1',
    success: '#a6e3a1', warning: '#f9e2af', danger: '#f38ba8', track: '#45475a', marker: '#89b4fa',
  },
  'catppuccin-latte': {
    running: '#8839ef', waiting: '#fe640b', error: '#d20f39', done: '#40a02b',
    success: '#40a02b', warning: '#df8e1d', danger: '#d20f39', track: '#bcc0cc', marker: '#1e66f5',
  },
  // purple, orange, red, green; yellow; selection; cyan
  dracula: {
    running: '#bd93f9', waiting: '#ffb86c', error: '#ff5555', done: '#50fa7b',
    success: '#50fa7b', warning: '#f1fa8c', danger: '#ff5555', track: '#44475a', marker: '#8be9fd',
  },
  alucard: {
    running: '#644ac9', waiting: '#a34d14', error: '#cb3a2a', done: '#14710a',
    success: '#14710a', warning: '#846e15', danger: '#cb3a2a', track: '#cfcfde', marker: '#036a96',
  },
  // ansi magenta, the escape orange, ansi red, ansi green; bright yellow; selection; ansi blue
  'night-owl': {
    running: '#c792ea', waiting: '#f78c6c', error: '#ef5350', done: '#22da6e',
    success: '#22da6e', warning: '#ffeb95', danger: '#ef5350', track: '#1d3b53', marker: '#82aaff',
  },
  // pink, orange, red, green; yellow; a light veil over the dark background; cyan
  'synthwave-84': {
    running: '#ff7edb', waiting: '#ff8b39', error: '#fe4450', done: '#72f1b8',
    success: '#72f1b8', warning: '#f3e70f', danger: '#fe4450', track: 'rgba(255,255,255,0.14)', marker: '#36f9f6',
  },
  // magenta, orange, red, green; yellow; fg_gutter; cyan
  'tokyo-night': {
    running: '#bb9af7', waiting: '#ff9e64', error: '#f7768e', done: '#9ece6a',
    success: '#9ece6a', warning: '#e0af68', danger: '#f7768e', track: '#3b4261', marker: '#7dcfff',
  },
}

export function palette(name: unknown): Palette {
  return PALETTES[(PALETTE_NAMES as string[]).includes(name as string) ? (name as PaletteName) : 'default']
}
