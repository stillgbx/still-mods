// Stacks the parts of the band above the prompt into one column, leaving out the empty ones.
// Each feature draws its own part and places it against what the hooks beneath drew (`next(e)`):
// the plan bars above it, the usage meters below it, so the order holds whichever runs first.
//
// Every part sits in a box of its own, keyed by its name and kept even when it is alone, so the tree
// keeps one shape: a part showing or going leaves the others where they are, not drawn anew.
export function stack(Box: (props: any) => any, parts: [key: string, part: unknown][]): any {
  const shown = parts.filter(([, part]) => Boolean(part))
  if (shown.length === 0) return undefined
  return Box({
    flexDirection: 'column',
    gap: 1,
    children: shown.map(([key, part]) => Box({ key, flexDirection: 'column', children: [part] })),
  })
}
