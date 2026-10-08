/** Pure display projections; never change the canonical tool result. */
function fields(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}
function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
export type RepoRoots = string | readonly string[]

export function primaryArg(name: string, input: unknown, repoRoot?: RepoRoots): string {
  const args = fields(input)
  let value: string
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      value = string(args.path)
      break
    case 'Grep':
      value = string(args.pattern) + (args.path ? ` ${string(args.path)}` : '')
      break
    case 'Glob':
      value = string(args.pattern)
      break
    case 'Bash':
      value = string(args.command)
      break
    case 'TodoWrite':
      value = ''
      break
    case 'Agent':
      value = string(args.description)
      break
    case 'Skill':
      value = string(args.skill)
      break
    case 'SendMessage':
      value = string(args.agentId)
      break
    default:
      value = string(Object.values(args).find((value) => typeof value === 'string'))
  }
  value = value.split(/\r?\n/)[0] ?? ''
  const roots = (typeof repoRoot === 'string' ? [repoRoot] : (repoRoot ?? []))
    .map((root) => root.replace(/\/+$/, '') || '/')
    .sort((a, b) => b.length - a.length)
  for (const root of roots) {
    if (name === 'Bash') {
      for (const directory of [root, `'${root}'`, `"${root}"`]) {
        for (const separator of [' && ', '; ', ';']) {
          const prefix = `cd ${directory}${separator}`
          if (value.startsWith(prefix)) value = value.slice(prefix.length)
        }
      }
    }
    // Match path boundaries, not lookalikes such as /repo-other or /outside/repo.
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    value = value.replace(
      new RegExp(`(^|[\\s"'=:(])${escaped}(/|(?=$|[\\s"';)]))`, 'g'),
      (_match, boundary: string, slash: string) => `${boundary}${slash ? '' : '.'}`,
    )
  }
  return value
}
function parse(content: string): unknown {
  try {
    return JSON.parse(content.split('\n\n<octo-memory>')[0] ?? content)
  } catch {
    return undefined
  }
}
function lines(value: unknown): number {
  const text = string(value)
  return text ? text.split(/\r?\n/).length : 0
}
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
export function summarizeToolResult(
  name: string,
  input: unknown,
  result: { ok: boolean; content: string },
): { summary?: string; failed: boolean } {
  const value = parse(result.content)
  const data = fields(value)
  if (!result.ok) {
    const error = string(data.error) || result.content
    return {
      failed: true,
      summary:
        error === 'Tool execution cancelled by user.'
          ? 'cancelled'
          : error.includes(':')
            ? error.slice(0, error.indexOf(':'))
            : error.slice(0, 40),
    }
  }
  const args = fields(input)
  let summary: string | undefined
  switch (name) {
    case 'Read':
      summary = count(lines(result.content), 'line')
      break
    case 'Grep': {
      const matches = result.content.match(/^ {2}\d+: /gm)?.length ?? 0
      const files = result.content.match(/^\S.*:\r?$/gm)?.length ?? 0
      const truncated = result.content.includes(
        '... [Output truncated to stay under 30000 character limit]',
      )
      summary = matches
        ? `${matches}${truncated ? '+' : ''} ${matches === 1 && !truncated ? 'match' : 'matches'} in ${count(files, 'file')}`
        : 'no matches'
      break
    }
    case 'Glob':
      if (Array.isArray(value)) summary = count(value.length, 'file')
      break
    case 'Bash':
      if (data.status === 'running') summary = `started ${data.task_id}`
      else if (typeof data.code === 'number')
        return { summary: `exit ${data.code}`, failed: data.code !== 0 }
      break
    case 'Edit':
      summary = `+${lines(args.new_string)} −${lines(args.old_string)} lines`
      break
    case 'Write':
      summary = count(lines(args.content), 'line')
      break
    case 'TodoWrite': {
      const todos = Array.isArray(args.todos) ? args.todos : []
      summary = `${count(todos.length, 'todo')}, ${todos.filter((todo) => fields(todo).status === 'completed').length} done`
      break
    }
    case 'Agent':
      summary = data.status === 'running' ? 'running in background' : 'done'
      break
  }
  return { summary, failed: false }
}
