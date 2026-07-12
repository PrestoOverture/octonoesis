import { describe, expect, it } from 'bun:test'
import type { ResolvedSandboxConfig } from '../../../src/sandbox/types'
import { buildProfile, wrapWithSandbox } from '../../../src/sandbox/wrapper'

function resolvedConfig(overrides: Partial<ResolvedSandboxConfig> = {}): ResolvedSandboxConfig {
  return {
    enabled: true,
    repoRoot: '/work/repo',
    protectedWrite: '/work/repo/.octonoesis',
    filesystem: {
      allowWrite: ['/work/repo', '/private/tmp', '/dev/null'],
      denyRead: ['/Users/test/.ssh'],
    },
    network: { allowedDomains: [] },
    ...overrides,
  }
}

describe('buildProfile', () => {
  it('emits the binding targeted-deny baseline and hardened filesystem policy', () => {
    const profile = buildProfile(resolvedConfig())

    expect(profile).toContain('(version 1)')
    expect(profile).toContain('(allow default)')
    expect(profile).toContain('(deny file-write*)')
    expect(profile).toContain('(subpath "/work/repo")')
    expect(profile).toContain('(literal "/dev/null")')
    expect(profile).toContain('(deny file-write*\n  (literal "/work/repo/.octonoesis")')
    expect(profile).toContain('(deny file-read*\n  (literal "/Users/test/.ssh")')
    expect(profile).toContain('(deny network*)')
  })

  it('switches from network denial to explicit network allowance for the wildcard policy', () => {
    const profile = buildProfile(resolvedConfig({ network: { allowedDomains: ['*'] } }))

    expect(profile).toContain('(allow network*)')
    expect(profile).not.toContain('(deny network*)')
  })

  it('escapes quotes and backslashes and rejects control-character profile injection', () => {
    const profile = buildProfile(
      resolvedConfig({
        filesystem: {
          allowWrite: ['/work/repo/quote" and \\ slash'],
          denyRead: ['/Users/test/.ssh'],
        },
      }),
    )

    expect(profile).toContain('/work/repo/quote\\" and \\\\ slash')
    expect(() =>
      buildProfile(
        resolvedConfig({
          filesystem: { allowWrite: ['/work/repo\n(allow network*)'], denyRead: [] },
        }),
      ),
    ).toThrow('may not contain NUL or newline')
  })
})

describe('wrapWithSandbox', () => {
  it('returns the exact argv boundary without an extra shell layer', () => {
    const config = resolvedConfig()
    const command = 'printf "%s" "$HOME" && false'
    const argv = wrapWithSandbox(command, config)

    expect(argv).toEqual(['sandbox-exec', '-p', buildProfile(config), 'bash', '-c', command])
  })
})
