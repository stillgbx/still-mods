# still-mods

Personal Claude Code mods, in one plugin. Each feature can be switched on or off on its own.

| Feature | Option | What it draws |
| --- | --- | --- |
| Plan progress | `planProgress` | Progress bars for multi-step tasks (stages, steps, subagent strips, sounds), above the prompt, on top |
| Agents pane | `agentsPane` | A pane listing the session's subagents and what each one does, with the team's journal |
| Usage meters | `usageMeters` | Context, session (5-hour) and weekly limits, always at the bottom: one column each, the share used and the reset time on one line, the bar under it |

Other options:

- `planEnforcement` (default `soft`): how hard Claude is held to its bars.
  - `strict`: a 4th change without a bar is refused once, a stale bar gets a reminder, and a turn that ends with an open bar is sent back.
  - `soft`: reminders only, nothing is refused or sent back.
  - `off`: no reminders; Claude uses the bars when it finds them useful.
- `sounds` (`soft`, `classic`, `off`; default `soft`): the sounds when a bar waits for a decision,
  fails or finishes. `soft` is still-mods' own (made by `tools/make-sounds.py`), `classic` plan-progress'.
- `agentsPane` (`auto`, `manual`, `off`; default `auto`): `auto` opens the Agents pane when a subagent
  starts, `manual` only with `/still-mods-agents`.
- `agentsSessionsDir` (default `_generated-ai-doc/sessions`): the folder, from the project root, that
  holds the team's session folders; the pane shows the newest one's `journal.md`.
- `timeZone` (default `Europe/Paris`), the zone of the 5-hour reset time.
- `language` (`auto`, `en`, `fr`; default `auto`): the labels' language. `auto` follows Claude Code's `language` setting, then the system locale.

Change them with the `/still-mods` command, which works in the desktop Code tab too (it has no `/config` menu):

```
/still-mods                     show the options
/still-mods usageMeters off     switch a feature off
/still-mods timeZone Asia/Tokyo set a text option
```

They are also rows in the terminal's `/config` menu. A plugin loaded from a folder has no such rows in
the desktop app, so `/still-mods` then writes the option in `~/.claude/settings.json` itself and touches
`.reload-stamp` (ignored by git) to reload the mod. The options are stored there:

```json
"pluginConfigs": { "still-mods": { "options": { "usageMeters": false } } }
```

## Plan bars

Claude creates a bar for a multi-step task through the `plan_progress` tool (2 to 10 stages) and moves
it as it works. Up to 5 bars show at once; past that, finished ones go first.

- The fill is the share of finished steps; the pixel texture in it is decoration.
- Full-height lines mark stage boundaries, short ticks the steps.
- The knob names the stage at work, or the step at work for a one-stage todo list, with its count.
- The colour is the state: running, waiting for a decision, error, done (each with a sound, see `sounds`).

## Agents pane

`/still-mods-agents` opens or closes it (in `auto`, it opens by itself when a subagent starts).

- **Agents**, from the engine's events in this session: each subagent's role (`subagentType`), state
  (running, waiting for an approval, done, failed, stopped), time, the tool it runs now and on what
  (a file, a command, a pattern), and how many tools it called. Running ones first, then the latest
  finished.
- **Session folder**: the newest folder under `agentsSessionsDir`, and which role files it holds
  (`brief.md`, `contrat.md`, `test.md`, `revue-ui.md`).
- **Journal**: the newest entries of its `journal.md`, read every 4 seconds, one per line as
  `HH:MM · role · type · #tag text`; `bloque`, `decision` and `resultat` are coloured.

Agents started in another session are not listed (the journal, read from disk, shows them). The
messages between the main thread and a subagent are not shown, only its tool calls.

## Usage meters

One column each for the context, the session (5-hour) limit and the weekly limit: the title and the
share used, the reset time dimmed at the right (`↻ 32 min · 15:00`), and the bar under them. The
context shows its tokens instead (`210k / 1M`).

On a narrow screen (a phone) the meters stack one under the other.

The blue line is the time gone in the window. A fill short of it means the limit lasts until the
reset; a fill past it means usage runs ahead of time. The colour says the same: green at least 10
points behind the line (or under 10 % used), orange close to it or a little past, red more than 15
points past it, or at 90 % used whatever the time.

The engine reports only the 5-hour and weekly windows (and a gateway's spend limit): the per-model
weekly limit and the usage credits the desktop panel shows are not available to mods.

## Layout

- `hooks/register.tsx`: reads the options and registers the features that are on.
- `features/<feature>.tsx`: one feature, registering its own hooks.
- `features/settings.ts`: the `/still-mods` command, always on.
- `features/band.ts`: stacks the parts of the band above the prompt.
- `features/agents.tsx`: the Agents pane.
- `features/i18n.ts`: the labels in English and French.
- `sounds/<theme>/`: the sound themes; `tools/make-sounds.py` synthesizes `sounds/soft/`.

The engine follows `$` only into functions of the same file, so a feature keeps its hooks and the
functions they hand `$` to in its own file. An event hooked without a matcher can be hooked only once
in the whole plugin, so each feature hooks `session.start` with the matcher `{ isInteractive: [true, false] }`,
which takes every session.

Adding a feature: a file in `features/`, a `userConfig` field in `.claude-plugin/plugin.json`, a line
in `hooks/register.tsx`.

## Installing

The repository is a marketplace holding this one plugin (`.claude-plugin/marketplace.json`):

```
/plugin marketplace add stillgbx/still-mods
/plugin install still-mods@still-mods
```

The bars and meters draw on every surface: terminal, desktop, VS Code and the Claude mobile app
(when it follows a session, the mod runs where the session runs). Mobile draws no input fields, which
the mod does not use.

## Loading for development

Do not install it from the marketplace on the machine that loads the folder below, or it loads twice.


`CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` points to this folder.
`CLAUDE_CODE_PLUGIN_DIR_WATCH=1` there too makes the desktop app watch it: saving a file reloads the
mod (without it, only a terminal session watches, and the desktop loads the mod at session start).

Check it with the engine's own CLI (the `claude` on PATH may be older):

```
claude plugin validate .claude-plugin/plugin.json   # the plugin and its hooks
claude plugin validate .                              # the marketplace
```

## Commands

- `/still-mods`: show or change the options.
- `/still-mods-agents`: open or close the Agents pane.
- `/still-mods-progress`: show or hide the bars.
- `/still-mods-progress-demo`: add a sample bar, one of 5 at random.
- `/still-mods-progress-clear`: remove every bar.
- `/still-mods-progress-sounds`: play the decision, error and done sounds of the current theme.

## Credits

still-mods started from the ideas and the work of two mods, combined here and extended:

- **[plan-progress](https://github.com/zycck/claude-mods)** by Kirill Serditov (MIT): the plan
  progress bars, their drawing, the `plan_progress` tool, the agent strips, the sounds and the rules
  that keep the bars up to date.
- **[usage-meter](https://github.com/HolyGrail/claude-mods)** by HolyGrail: the context and limit
  meters, the readings shared between sessions, the pace colours and the time marker.

Their notices are in [NOTICE](NOTICE). still-mods itself is under the MIT License ([LICENSE](LICENSE)).
