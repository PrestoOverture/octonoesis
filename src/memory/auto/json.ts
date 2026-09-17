/**
 * Extracts and parses a JSON payload from sub-agent fork text, stripping optional markdown code fences.
 *
 * @param text - Raw output string potentially containing a JSON markdown block.
 * @returns Parsed JSON value.
 * @throws SyntaxError If the extracted text cannot be parsed as valid JSON.
 */
export function parseForkJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return JSON.parse((fenced?.[1] ?? trimmed).trim())
}
