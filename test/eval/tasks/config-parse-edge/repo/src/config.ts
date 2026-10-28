export function parse(input: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of input.split('\n')) {
    const content = line.split('#')[0]?.trim() ?? ''
    if (!content) continue
    const equal = content.indexOf('=')
    if (equal < 1) throw new Error('invalid assignment')
    const key = content.slice(0, equal).trim()
    const value = content.slice(equal + 1).trim()
    result[key] = value.startsWith('"') ? JSON.parse(value) : value
  }
  return result
}
