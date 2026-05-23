import { readFile as fsReadFile } from 'node:fs/promises'

export async function readFile(input: { path: string }): Promise<string> {
  const content = await fsReadFile(input.path, 'utf-8')
  return content
}
