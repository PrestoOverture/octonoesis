import fs from 'node:fs/promises'
import path from 'node:path'
import { getMemoryDir } from '../../utils/path'
import type { Episode } from './types'

/**
 * Reads all persisted episodes from disk, deduplicating by ID (later lines overwrite earlier ones).
 */
export async function readEpisodes(): Promise<Episode[]> {
  const memoryDir = getMemoryDir()
  const episodesPath = path.join(memoryDir, 'episodes.jsonl')

  try {
    const data = await fs.readFile(episodesPath, 'utf8')
    const lines = data
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
    const episodesMap = new Map<string, Episode>()
    for (const line of lines) {
      const ep = JSON.parse(line) as Episode
      if (ep?.id) {
        episodesMap.set(ep.id, ep)
      }
    }
    return Array.from(episodesMap.values())
  } catch (err) {
    // If file does not exist, return empty array
    return []
  }
}

/**
 * Determines the next episode index (1-based) by reading the last stored ID.
 */
export async function getNextEpisodeIndex(): Promise<number> {
  const episodes = await readEpisodes()
  if (episodes.length === 0) {
    return 1
  }

  const lastEpisode = episodes[episodes.length - 1]
  if (!lastEpisode || !lastEpisode.id) {
    return episodes.length + 1
  }

  // Parse ep_NNNN
  const match = lastEpisode.id.match(/^ep_(\d+)$/)
  if (match?.[1]) {
    return Number.parseInt(match[1], 10) + 1
  }

  return episodes.length + 1
}

/**
 * Appends a list of episodes to the persisted log.
 */
export async function appendEpisodes(episodes: Episode[]): Promise<void> {
  if (episodes.length === 0) return

  const memoryDir = getMemoryDir()
  await fs.mkdir(memoryDir, { recursive: true })
  const episodesPath = path.join(memoryDir, 'episodes.jsonl')

  const lines = episodes.map((ep) => `${JSON.stringify(ep)}\n`).join('')
  await fs.appendFile(episodesPath, lines, 'utf8')
}
