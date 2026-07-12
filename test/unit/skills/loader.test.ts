import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clearSkillCacheForTesting, loadSkills } from '../../../src/skills/loader'

const roots: string[] = []

async function fixture(): Promise<{ repo: string; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'skills-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  const home = path.join(root, 'home')
  await Promise.all([mkdir(repo), mkdir(home)])
  return { repo, home }
}

async function skill(dir: string, name: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${name}.md`), content)
}

afterEach(async () => {
  clearSkillCacheForTesting()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('loadSkills', () => {
  test('loads frontmatter, defaults inline, and applies project precedence', async () => {
    const { repo, home } = await fixture()
    await skill(
      path.join(home, '.octonoesis/skills'),
      'review',
      '---\ndescription: global review\ncontext: fork\nallowed-tools: [Read, Bash]\nmodel: child-model\n---\nglobal body',
    )
    await skill(
      path.join(repo, '.octonoesis/skills'),
      'review',
      '---\ndescription: project review\n---\nproject body',
    )
    await skill(
      path.join(home, '.octonoesis/skills'),
      'global-only',
      '---\ndescription: global only\n---\nglobal content',
    )

    expect(await loadSkills(repo, { homeDir: home })).toEqual([
      {
        name: 'global-only',
        description: 'global only',
        context: 'inline',
        content: 'global content',
        source: 'user',
        path: path.join(home, '.octonoesis/skills/global-only.md'),
      },
      {
        name: 'review',
        description: 'project review',
        context: 'inline',
        content: 'project body',
        source: 'project',
        path: path.join(repo, '.octonoesis/skills/review.md'),
      },
    ])
  })

  test('retains fork-only settings and skips malformed files and invalid slugs', async () => {
    const { repo, home } = await fixture()
    const dir = path.join(repo, '.octonoesis/skills')
    await skill(
      dir,
      'inspect',
      '---\ndescription: Inspect files\ncontext: fork\nallowed-tools: [Read, Grep]\nmodel: tiny\nignored: yes\n---\nDo the work.',
    )
    await skill(dir, 'Bad_Name', '---\ndescription: invalid slug\n---\nbody')
    await skill(dir, '.', '---\ndescription: traversal shaped\n---\nbody')
    await skill(dir, 'missing', '---\ncontext: inline\n---\nbody')
    await skill(dir, 'bad-context', '---\ndescription: nope\ncontext: remote\n---\nbody')
    await skill(dir, 'broken', '---\ndescription: unclosed\nbody')

    expect(await loadSkills(repo, { homeDir: home })).toEqual([
      {
        name: 'inspect',
        description: 'Inspect files',
        context: 'fork',
        allowedTools: ['Read', 'Grep'],
        model: 'tiny',
        content: 'Do the work.',
        source: 'project',
        path: path.join(dir, 'inspect.md'),
      },
    ])
  })

  test('caches one scan per repository root', async () => {
    const { repo, home } = await fixture()
    const dir = path.join(repo, '.octonoesis/skills')
    await skill(dir, 'first', '---\ndescription: first\n---\nbody')
    const first = await loadSkills(repo, { homeDir: home })
    await skill(dir, 'second', '---\ndescription: second\n---\nbody')

    expect(await loadSkills(repo, { homeDir: home })).toBe(first)
    expect(first.map((entry) => entry.name)).toEqual(['first'])
  })

  test('returns an empty catalog when both skill directories are absent', async () => {
    const { repo, home } = await fixture()
    expect(await loadSkills(repo, { homeDir: home })).toEqual([])
  })
})
