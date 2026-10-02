# usage-progress

A Claude Code mod that draws, above the prompt:

- **plan progress bars** for multi-step tasks (stages, steps, subagent strips, sounds), on top;
- **usage meters**, always at the bottom: context, 5-hour limit (with the reset time in Europe/Paris) and weekly limit.

The other mods' bands are kept between the two (this mod calls `next(e)`).

## Loading

It is loaded by `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`, which points to this folder. The folder is watched: saving a file reloads the mod.

Check it with the engine's own CLI (the `claude` on PATH may be older):

```
claude plugin validate .
```

## Commands

`/progress` (show or hide the bars), `/progress-demo`, `/progress-clear`, `/progress-sounds`.

## Credits

- Plan bars: based on [plan-progress](https://github.com/zycck/claude-mods) 0.3.0 by Kirill Serditov (MIT).
- Usage meters: based on [usage-meter](https://github.com/HolyGrail/claude-mods) 0.1.0 by HolyGrail.
