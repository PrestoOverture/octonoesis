import type { Item } from './transcript'

export type ToolItem = Extract<Item, { kind: 'tool' }>
export type Block =
  | { kind: 'item'; item: Exclude<Item, ToolItem>; index: number }
  | { kind: 'tool'; tool: ToolItem; index: number }
  | { kind: 'group'; tools: ToolItem[]; index: number; live: boolean }

const READS = new Set(['Read'])
const SEARCHES = new Set(['Grep', 'Glob'])
const EDITS = new Set(['Edit', 'Write'])

/**
 * Consecutive tool calls collapse into one activity group. Failed calls never collapse:
 * they end the run and stand alone, as does a run of one.
 */
export function activityBlocks(items: Item[]): Block[] {
  const blocks: Block[] = []
  let run: { tools: ToolItem[]; index: number } | undefined
  const flush = () => {
    if (!run) return
    const [first] = run.tools
    if (run.tools.length === 1 && first)
      blocks.push({ kind: 'tool', tool: first, index: run.index })
    else
      blocks.push({
        kind: 'group',
        tools: run.tools,
        index: run.index,
        live: run.tools.some((tool) => tool.status === 'running'),
      })
    run = undefined
  }
  items.forEach((item, index) => {
    if (item.kind === 'tool' && item.status !== 'error') {
      run ??= { tools: [], index }
      run.tools.push(item)
      return
    }
    flush()
    blocks.push(
      item.kind === 'tool' ? { kind: 'tool', tool: item, index } : { kind: 'item', item, index },
    )
  })
  flush()
  return blocks
}

/** Added/removed line counts for a finished Edit ("+a −r lines") or Write ("N lines"). */
export function lineDelta(tool: ToolItem): { added: number; removed: number } | undefined {
  if (tool.status !== 'done' || !tool.summary) return
  if (tool.name === 'Edit') {
    const match = tool.summary.match(/^\+(\d+) −(\d+)/)
    if (match) return { added: Number(match[1]), removed: Number(match[2]) }
  }
  if (tool.name === 'Write') {
    const match = tool.summary.match(/^(\d+) lines?$/)
    if (match) return { added: Number(match[1]), removed: 0 }
  }
}

const count = (value: number, singular: string, plural = `${singular}s`) =>
  `${value} ${value === 1 ? singular : plural}`

export type GroupSummary = {
  title: 'Edited' | 'Ran' | 'Explored'
  file?: string
  added: number
  removed: number
  details: string[]
  running?: ToolItem
}

export function summarizeGroup(tools: ToolItem[]): GroupSummary {
  const files = new Set<string>()
  let added = 0
  let removed = 0
  let reads = 0
  let searches = 0
  let commands = 0
  let todos = 0
  let others = 0
  for (const tool of tools) {
    if (EDITS.has(tool.name)) {
      files.add(tool.argument)
      const delta = lineDelta(tool)
      added += delta?.added ?? 0
      removed += delta?.removed ?? 0
    } else if (READS.has(tool.name)) reads++
    else if (SEARCHES.has(tool.name)) searches++
    else if (tool.name === 'Bash') commands++
    else if (tool.name === 'TodoWrite') todos++
    else others++
  }
  const details = [
    ...(files.size > 1 ? [`edited ${count(files.size, 'file')}`] : []),
    ...(reads ? [`read ${count(reads, 'file')}`] : []),
    ...(searches ? [`searched ${count(searches, 'pattern')}`] : []),
    ...(commands ? [`ran ${count(commands, 'command')}`] : []),
    ...(todos ? ['updated tasks'] : []),
    ...(others ? [`used ${count(others, 'other tool')}`] : []),
  ]
  return {
    title: files.size ? 'Edited' : commands ? 'Ran' : 'Explored',
    ...(files.size === 1 ? { file: [...files][0] } : {}),
    added,
    removed,
    details,
    running: [...tools].reverse().find((tool) => tool.status === 'running'),
  }
}
