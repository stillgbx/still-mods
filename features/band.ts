// Stacks the parts of the band above the prompt into one column, leaving out the empty ones.
// Each feature draws its own part and places it against what the hooks beneath drew (`next(e)`):
// the plan bars above it, the usage meters below it, so the order holds whichever runs first.
export function stack(Box: (props: any) => any, parts: unknown[]): any {
  const shown = parts.filter(Boolean)
  if (shown.length === 0) return undefined
  if (shown.length === 1) return shown[0]
  return Box({
    flexDirection: 'column',
    gap: 1,
    children: shown.map((part, i) => Box({ key: `part-${i}`, flexDirection: 'column', children: [part] })),
  })
}
