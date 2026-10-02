---
name: plan-progress
description: Reference for the plan_progress bars (tool ops, /still-mods-progress commands). The working rules are already in the system prompt; load only when the user asks about the bars or a call was refused.
---

# plan_progress

Create once with the whole plan, then move it with short ops. Never resend `stages` except to restructure.

Create: `{id, title, stages:[{name, steps:[{title}]}]}`; `kind:"todo"` for one flat list. 2-10 stages, titles of at most 4 words, in the user's language, one `id` per task.

Ops:
- `{id, next:true}` — active step done, next one active
- `{id, done:["A"], active:"B"}` — mark done, pick current
- `{id, failed:"B", note}` — error
- `{id, state:"needs_input", note}` — before asking the user
- `{id, state:"done"}` — finish

The result already says `done/total, state, active step`; no need to check the bar.

User commands: `/still-mods-progress` toggle, `/still-mods-progress-demo`, `/still-mods-progress-sounds`, `/still-mods-progress-clear`. The **Progress** button in the footer is always shown while the mod is loaded.
