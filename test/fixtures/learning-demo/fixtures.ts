import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

export interface ExtractorMock {
  tool: string
  error_class: string
  file: string
  expression: string
}

export interface FixtureDef {
  id: string
  scenarioType: string
  errorClass: string
  file: string
  expression: string
  sourceContent: string
  stderrOutput: string
  extractorResponse: ExtractorMock
  fix: {
    old: string
    new: string
  }
  passingOutput: string
  /** Repo-relative path the fix actually targets, when different from `file`. */
  fixFile?: string
  /** Additional repo-relative files to materialize alongside `file`. A `package.json` key
   *  replaces the harness's default-generated package.json entirely. */
  extraFiles?: Record<string, string>
  /** Overrides the harness's generated test file content (buildTestFile()'s generators do not
   *  cover RepoQuirk fixtures, which always supply this explicitly). */
  testContent?: string
}

export const SCENARIO_TYPES = [
  'NullAccess',
  'UndefinedRef',
  'ParseError',
  'OutOfBounds',
  'ModuleNotFound',
  'MissingExport',
  'ExpectMismatch',
  'SnapshotDrift',
  'TypeMismatch',
  'PromiseReject',
  'JSONMalformed',
  'InvalidRegex',
  'MissingEnvVar',
  'ConfigInvalid',
  'DeprecatedAPI',
  'RepoQuirk',
] as const

export const ERROR_CLASSES = [
  'TypeError',
  'SyntaxError',
  'ImportError',
  'AssertionError',
  'ConfigError',
  'ReferenceError',
  'RangeError',
] as const

export const COARSE_GROUPS: Record<(typeof ERROR_CLASSES)[number], string[]> = {
  TypeError: ['NullAccess', 'TypeMismatch', 'PromiseReject', 'DeprecatedAPI'],
  SyntaxError: ['ParseError', 'JSONMalformed', 'InvalidRegex'],
  ImportError: ['ModuleNotFound', 'MissingExport'],
  AssertionError: ['ExpectMismatch', 'SnapshotDrift'],
  ConfigError: ['MissingEnvVar', 'ConfigInvalid'],
  ReferenceError: ['UndefinedRef'],
  RangeError: ['OutOfBounds'],
}

export const FIXTURE_SCHEMA = z
  .object({
    id: z.string().min(1),
    scenarioType: z.enum(SCENARIO_TYPES),
    errorClass: z.enum(ERROR_CLASSES),
    file: z
      .string()
      .min(1)
      .refine((value) => !value.startsWith('/'), 'file must be repo-relative')
      .refine((value) => !value.includes('\\'), 'file must use forward slashes'),
    expression: z.string().min(1),
    sourceContent: z.string().min(1),
    stderrOutput: z.string().min(1),
    extractorResponse: z.object({
      tool: z.literal('bun-test'),
      error_class: z.string().min(1),
      file: z.string().min(1),
      expression: z.string().min(1),
    }),
    fix: z.object({
      old: z.string().min(1),
      new: z.string().min(1),
    }),
    passingOutput: z.string().min(1),
    fixFile: z.string().optional(),
    extraFiles: z.record(z.string(), z.string()).optional(),
    testContent: z.string().optional(),
  })
  .superRefine((fixture, ctx) => {
    if (fixture.extractorResponse.error_class !== fixture.errorClass) {
      ctx.addIssue({
        code: 'custom',
        path: ['extractorResponse', 'error_class'],
        message: 'extractorResponse.error_class must equal errorClass',
      })
    }

    if (fixture.extractorResponse.file !== fixture.file) {
      ctx.addIssue({
        code: 'custom',
        path: ['extractorResponse', 'file'],
        message: 'extractorResponse.file must equal file',
      })
    }

    if (fixture.fixFile && fixture.fixFile !== fixture.file) {
      const fixFileContent = fixture.extraFiles?.[fixture.fixFile]
      if (fixFileContent === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['extraFiles', fixture.fixFile],
          message: 'extraFiles must contain the content of fixFile when fixFile differs from file',
        })
      } else if (!fixFileContent.includes(fixture.fix.old)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fix', 'old'],
          message: 'fix.old must be present in extraFiles[fixFile]',
        })
      }
    } else if (!fixture.sourceContent.includes(fixture.fix.old)) {
      ctx.addIssue({
        code: 'custom',
        path: ['fix', 'old'],
        message: 'fix.old must be present in sourceContent',
      })
    }

    if (fixture.fix.old === fixture.fix.new) {
      ctx.addIssue({
        code: 'custom',
        path: ['fix', 'new'],
        message: 'fix.new must differ from fix.old',
      })
    }
  })

export const ALL_FIXTURES: FixtureDef[] = [
  {
    id: 'NullAccess_A1',
    scenarioType: 'NullAccess',
    errorClass: 'TypeError',
    file: 'src/user.ts',
    expression: "evaluating 'user.name'",
    sourceContent:
      "export type User = {\n  id: string\n  name: string\n  email?: string\n} | null\n\nexport function displayUser(user: User): string {\n  const normalized = user.name.trim()\n  const label = normalized.length > 0 ? normalized : 'Anonymous'\n  return `User: ${label}`\n}\n\nexport function displayTeam(users: User[]): string[] {\n  return users.map((user) => displayUser(user))\n}\n",
    stderrOutput:
      "src/user.test.ts:\n6 |   const normalized = user.name.trim()\n                              ^\nTypeError: Cannot read properties of null (reading 'name')\n    at displayUser (/tmp/octonoesis-demo/src/user.ts:6:27)\n    at <anonymous> (/tmp/octonoesis-demo/src/user.test.ts:4:12)\n(fail) displayUser > handles missing user [0.18ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/user.ts',
      expression: "evaluating 'user.name'",
    },
    fix: {
      old: 'const normalized = user.name.trim()',
      new: "const normalized = user?.name?.trim() ?? 'Anonymous'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/user.test.ts:\n(pass) displayUser > handles missing user [0.11ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ModuleNotFound_A1',
    scenarioType: 'ModuleNotFound',
    errorClass: 'ImportError',
    file: 'src/loader.ts',
    expression: "import './config-loader'",
    sourceContent:
      "import { readFile } from 'node:fs/promises'\nimport { loadConfig } from './config-loader'\n\nexport type LoadedConfig = {\n  path: string\n  value: string\n}\n\nexport async function loadFromDisk(path: string): Promise<LoadedConfig> {\n  const raw = await readFile(path, 'utf8')\n  const value = loadConfig(raw)\n  return { path, value }\n}\n",
    stderrOutput:
      'src/loader.test.ts:\nImportError: Could not resolve: "./config-loader"\n    at /tmp/octonoesis-demo/src/loader.ts:2:28\n    at /tmp/octonoesis-demo/src/loader.test.ts:1:1\n(fail) loadFromDisk > loads config from disk [0.09ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/loader.ts',
      expression: "import './config-loader'",
    },
    fix: {
      old: "import { loadConfig } from './config-loader'",
      new: "import { loadConfig } from './config'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/loader.test.ts:\n(pass) loadFromDisk > loads config from disk [0.12ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ParseError_A1',
    scenarioType: 'ParseError',
    errorClass: 'SyntaxError',
    file: 'src/parser.ts',
    expression: 'missing closing brace in parsePayload',
    sourceContent:
      'export type ParseResult =\n  | { ok: true; value: unknown }\n  | { ok: false; error: unknown }\n\nexport function parsePayload(raw: string): ParseResult {\n  try {\n    const value = JSON.parse(raw)\n    return { ok: true, value }\n  } catch (error) {\n    return { ok: false, error }\n',
    stderrOutput:
      'src/parser.test.ts:\n10 |     return { ok: false, error }\n                                  ^\nSyntaxError: Expected "}" but found end of file\n    at /tmp/octonoesis-demo/src/parser.ts:10:34\n    at /tmp/octonoesis-demo/src/parser.test.ts:1:1\n(fail) parsePayload > rejects malformed JSON [0.07ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/parser.ts',
      expression: 'missing closing brace in parsePayload',
    },
    fix: {
      old: '  } catch (error) {\n    return { ok: false, error }\n',
      new: '  } catch (error) {\n    return { ok: false, error }\n  }\n}\n',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/parser.test.ts:\n(pass) parsePayload > rejects malformed JSON [0.10ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'NullAccess_A2',
    scenarioType: 'NullAccess',
    errorClass: 'TypeError',
    file: 'src/user.ts',
    expression: "evaluating 'user.email'",
    sourceContent:
      'type MaybeRecord = Record<string, any> | null\n\nexport function handleUser2(user: MaybeRecord): string {\n  const value = user.email.trim()\n  return value || "Unknown email"\n}\n\nexport function renderhandleUser2(input: MaybeRecord): string {\n  return handleUser2(input).toUpperCase()\n}\n',
    stderrOutput:
      "src/user.test.ts:\n7 |   const value = user.email.trim()\n                              ^\nTypeError: Cannot read properties of null (reading 'email')\n    at handleUser2 (/tmp/octonoesis-demo/src/user.ts:7:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/user.test.ts:4:12)\n(fail) NullAccess > NullAccess_A2 reproduces fixture failure [0.11ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/user.ts',
      expression: "evaluating 'user.email'",
    },
    fix: {
      old: 'const value = user.email.trim()',
      new: 'const value = user?.email?.trim() ?? "Unknown email"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/user.test.ts:\n(pass) NullAccess > NullAccess_A2 passes after fixture fix [0.12ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'NullAccess_A3',
    scenarioType: 'NullAccess',
    errorClass: 'TypeError',
    file: 'src/user.ts',
    expression: "evaluating 'user.avatarUrl'",
    sourceContent:
      'type MaybeRecord = Record<string, any> | null\n\nexport function handleUser3(user: MaybeRecord): string {\n  const value = user.avatarUrl.trim()\n  return value || "default-avatar"\n}\n\nexport function renderhandleUser3(input: MaybeRecord): string {\n  return handleUser3(input).toUpperCase()\n}\n',
    stderrOutput:
      "src/user.test.ts:\n8 |   const value = user.avatarUrl.trim()\n                              ^\nTypeError: Cannot read properties of null (reading 'avatarUrl')\n    at handleUser3 (/tmp/octonoesis-demo/src/user.ts:8:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/user.test.ts:4:12)\n(fail) NullAccess > NullAccess_A3 reproduces fixture failure [0.12ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/user.ts',
      expression: "evaluating 'user.avatarUrl'",
    },
    fix: {
      old: 'const value = user.avatarUrl.trim()',
      new: 'const value = user?.avatarUrl?.trim() ?? "default-avatar"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/user.test.ts:\n(pass) NullAccess > NullAccess_A3 passes after fixture fix [0.13ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'NullAccess_B1',
    scenarioType: 'NullAccess',
    errorClass: 'TypeError',
    file: 'src/account.ts',
    expression: "evaluating 'account.planName'",
    sourceContent:
      'type MaybeRecord = Record<string, any> | null\n\nexport function handleAccount4(account: MaybeRecord): string {\n  const value = account.planName.trim()\n  return value || "free"\n}\n\nexport function renderhandleAccount4(input: MaybeRecord): string {\n  return handleAccount4(input).toUpperCase()\n}\n',
    stderrOutput:
      "src/account.test.ts:\n9 |   const value = account.planName.trim()\n                              ^\nTypeError: Cannot read properties of null (reading 'planName')\n    at handleAccount4 (/tmp/octonoesis-demo/src/account.ts:9:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/account.test.ts:4:12)\n(fail) NullAccess > NullAccess_B1 reproduces fixture failure [0.13ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/account.ts',
      expression: "evaluating 'account.planName'",
    },
    fix: {
      old: 'const value = account.planName.trim()',
      new: 'const value = account?.planName?.trim() ?? "free"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/account.test.ts:\n(pass) NullAccess > NullAccess_B1 passes after fixture fix [0.14ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'NullAccess_B2',
    scenarioType: 'NullAccess',
    errorClass: 'TypeError',
    file: 'src/account.ts',
    expression: "evaluating 'account.status'",
    sourceContent:
      'type MaybeRecord = Record<string, any> | null\n\nexport function handleAccount5(account: MaybeRecord): string {\n  const value = account.status.trim()\n  return value || "inactive"\n}\n\nexport function renderhandleAccount5(input: MaybeRecord): string {\n  return handleAccount5(input).toUpperCase()\n}\n',
    stderrOutput:
      "src/account.test.ts:\n10 |   const value = account.status.trim()\n                              ^\nTypeError: Cannot read properties of null (reading 'status')\n    at handleAccount5 (/tmp/octonoesis-demo/src/account.ts:10:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/account.test.ts:4:12)\n(fail) NullAccess > NullAccess_B2 reproduces fixture failure [0.14ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/account.ts',
      expression: "evaluating 'account.status'",
    },
    fix: {
      old: 'const value = account.status.trim()',
      new: 'const value = account?.status?.trim() ?? "inactive"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/account.test.ts:\n(pass) NullAccess > NullAccess_B2 passes after fixture fix [0.15ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'NullAccess_B3',
    scenarioType: 'NullAccess',
    errorClass: 'TypeError',
    file: 'src/account.ts',
    expression: "evaluating 'account.ownerName'",
    sourceContent:
      'type MaybeRecord = Record<string, any> | null\n\nexport function handleAccount6(account: MaybeRecord): string {\n  const value = account.ownerName.trim()\n  return value || "unowned"\n}\n\nexport function renderhandleAccount6(input: MaybeRecord): string {\n  return handleAccount6(input).toUpperCase()\n}\n',
    stderrOutput:
      "src/account.test.ts:\n11 |   const value = account.ownerName.trim()\n                              ^\nTypeError: Cannot read properties of null (reading 'ownerName')\n    at handleAccount6 (/tmp/octonoesis-demo/src/account.ts:11:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/account.test.ts:4:12)\n(fail) NullAccess > NullAccess_B3 reproduces fixture failure [0.15ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/account.ts',
      expression: "evaluating 'account.ownerName'",
    },
    fix: {
      old: 'const value = account.ownerName.trim()',
      new: 'const value = account?.ownerName?.trim() ?? "unowned"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/account.test.ts:\n(pass) NullAccess > NullAccess_B3 passes after fixture fix [0.16ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'NullAccess_C1',
    scenarioType: 'NullAccess',
    errorClass: 'TypeError',
    file: 'src/profile.ts',
    expression: "evaluating 'profile.bio'",
    sourceContent:
      'type MaybeRecord = Record<string, any> | null\n\nexport function handleProfile7(profile: MaybeRecord): string {\n  const value = profile.bio.trim()\n  return value || "No bio"\n}\n\nexport function renderhandleProfile7(input: MaybeRecord): string {\n  return handleProfile7(input).toUpperCase()\n}\n',
    stderrOutput:
      "src/profile.test.ts:\n12 |   const value = profile.bio.trim()\n                              ^\nTypeError: Cannot read properties of null (reading 'bio')\n    at handleProfile7 (/tmp/octonoesis-demo/src/profile.ts:12:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/profile.test.ts:4:12)\n(fail) NullAccess > NullAccess_C1 reproduces fixture failure [0.16ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/profile.ts',
      expression: "evaluating 'profile.bio'",
    },
    fix: {
      old: 'const value = profile.bio.trim()',
      new: 'const value = profile?.bio?.trim() ?? "No bio"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/profile.test.ts:\n(pass) NullAccess > NullAccess_C1 passes after fixture fix [0.17ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'NullAccess_C2',
    scenarioType: 'NullAccess',
    errorClass: 'TypeError',
    file: 'src/profile.ts',
    expression: "evaluating 'profile.displayName'",
    sourceContent:
      'type MaybeRecord = Record<string, any> | null\n\nexport function handleProfile8(profile: MaybeRecord): string {\n  const value = profile.displayName.trim()\n  return value || "Guest"\n}\n\nexport function renderhandleProfile8(input: MaybeRecord): string {\n  return handleProfile8(input).toUpperCase()\n}\n',
    stderrOutput:
      "src/profile.test.ts:\n13 |   const value = profile.displayName.trim()\n                              ^\nTypeError: Cannot read properties of null (reading 'displayName')\n    at handleProfile8 (/tmp/octonoesis-demo/src/profile.ts:13:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/profile.test.ts:4:12)\n(fail) NullAccess > NullAccess_C2 reproduces fixture failure [0.17ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/profile.ts',
      expression: "evaluating 'profile.displayName'",
    },
    fix: {
      old: 'const value = profile.displayName.trim()',
      new: 'const value = profile?.displayName?.trim() ?? "Guest"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/profile.test.ts:\n(pass) NullAccess > NullAccess_C2 passes after fixture fix [0.18ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'NullAccess_D1',
    scenarioType: 'NullAccess',
    errorClass: 'TypeError',
    file: 'src/session.ts',
    expression: "evaluating 'session.token'",
    sourceContent:
      'type MaybeRecord = Record<string, any> | null\n\nexport function handleSession9(session: MaybeRecord): string {\n  const value = session.token.trim()\n  return value || "missing-token"\n}\n\nexport function renderhandleSession9(input: MaybeRecord): string {\n  return handleSession9(input).toUpperCase()\n}\n',
    stderrOutput:
      "src/session.test.ts:\n14 |   const value = session.token.trim()\n                              ^\nTypeError: Cannot read properties of null (reading 'token')\n    at handleSession9 (/tmp/octonoesis-demo/src/session.ts:14:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/session.test.ts:4:12)\n(fail) NullAccess > NullAccess_D1 reproduces fixture failure [0.18ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/session.ts',
      expression: "evaluating 'session.token'",
    },
    fix: {
      old: 'const value = session.token.trim()',
      new: 'const value = session?.token?.trim() ?? "missing-token"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/session.test.ts:\n(pass) NullAccess > NullAccess_D1 passes after fixture fix [0.19ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'NullAccess_E1',
    scenarioType: 'NullAccess',
    errorClass: 'TypeError',
    file: 'src/auth.ts',
    expression: "evaluating 'authState.provider'",
    sourceContent:
      'type MaybeRecord = Record<string, any> | null\n\nexport function handleAuth10(authState: MaybeRecord): string {\n  const value = authState.provider.trim()\n  return value || "anonymous"\n}\n\nexport function renderhandleAuth10(input: MaybeRecord): string {\n  return handleAuth10(input).toUpperCase()\n}\n',
    stderrOutput:
      "src/auth.test.ts:\n15 |   const value = authState.provider.trim()\n                              ^\nTypeError: Cannot read properties of null (reading 'provider')\n    at handleAuth10 (/tmp/octonoesis-demo/src/auth.ts:15:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/auth.test.ts:4:12)\n(fail) NullAccess > NullAccess_E1 reproduces fixture failure [0.19ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/auth.ts',
      expression: "evaluating 'authState.provider'",
    },
    fix: {
      old: 'const value = authState.provider.trim()',
      new: 'const value = authState?.provider?.trim() ?? "anonymous"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/auth.test.ts:\n(pass) NullAccess > NullAccess_E1 passes after fixture fix [0.20ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'TypeMismatch_A1',
    scenarioType: 'TypeMismatch',
    errorClass: 'TypeError',
    file: 'src/validator.ts',
    expression: 'calling trim on validatorInput',
    sourceContent:
      'export function handleValidator1(validatorInput: any): unknown {\n  const normalized = validatorInput.trim()\n  return normalized\n}\n\nexport function asserthandleValidator1(input: unknown): boolean {\n  return handleValidator1(input) !== undefined\n}\n// Fixture TypeMismatch_A1 keeps the Phase 19 source file at realistic size.\n// Scenario TypeMismatch is expected to surface TypeError.\n',
    stderrOutput:
      'src/validator.test.ts:\n6 |   const normalized = validatorInput.trim()\n                              ^\nTypeError: trim is not a function\n    at handleValidator1 (/tmp/octonoesis-demo/src/validator.ts:6:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/validator.test.ts:4:12)\n(fail) TypeMismatch > TypeMismatch_A1 reproduces fixture failure [0.10ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/validator.ts',
      expression: 'calling trim on validatorInput',
    },
    fix: {
      old: 'const normalized = validatorInput.trim()',
      new: 'const normalized = String(validatorInput)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/validator.test.ts:\n(pass) TypeMismatch > TypeMismatch_A1 passes after fixture fix [0.11ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'TypeMismatch_A2',
    scenarioType: 'TypeMismatch',
    errorClass: 'TypeError',
    file: 'src/validator.ts',
    expression: 'calling toFixed on validatorAge',
    sourceContent:
      'export function handleValidator2(validatorAge: any): unknown {\n  const normalized = validatorAge.toFixed()\n  return normalized\n}\n\nexport function asserthandleValidator2(input: unknown): boolean {\n  return handleValidator2(input) !== undefined\n}\n// Fixture TypeMismatch_A2 keeps the Phase 19 source file at realistic size.\n// Scenario TypeMismatch is expected to surface TypeError.\n',
    stderrOutput:
      'src/validator.test.ts:\n7 |   const normalized = validatorAge.toFixed()\n                              ^\nTypeError: toFixed is not a function\n    at handleValidator2 (/tmp/octonoesis-demo/src/validator.ts:7:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/validator.test.ts:4:12)\n(fail) TypeMismatch > TypeMismatch_A2 reproduces fixture failure [0.11ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/validator.ts',
      expression: 'calling toFixed on validatorAge',
    },
    fix: {
      old: 'const normalized = validatorAge.toFixed()',
      new: 'const normalized = String(validatorAge)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/validator.test.ts:\n(pass) TypeMismatch > TypeMismatch_A2 passes after fixture fix [0.12ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'TypeMismatch_A3',
    scenarioType: 'TypeMismatch',
    errorClass: 'TypeError',
    file: 'src/validator.ts',
    expression: 'calling toLowerCase on schemaValue',
    sourceContent:
      'export function handleValidator3(schemaValue: any): unknown {\n  const normalized = schemaValue.toLowerCase()\n  return normalized\n}\n\nexport function asserthandleValidator3(input: unknown): boolean {\n  return handleValidator3(input) !== undefined\n}\n// Fixture TypeMismatch_A3 keeps the Phase 19 source file at realistic size.\n// Scenario TypeMismatch is expected to surface TypeError.\n',
    stderrOutput:
      'src/validator.test.ts:\n8 |   const normalized = schemaValue.toLowerCase()\n                              ^\nTypeError: toLowerCase is not a function\n    at handleValidator3 (/tmp/octonoesis-demo/src/validator.ts:8:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/validator.test.ts:4:12)\n(fail) TypeMismatch > TypeMismatch_A3 reproduces fixture failure [0.12ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/validator.ts',
      expression: 'calling toLowerCase on schemaValue',
    },
    fix: {
      old: 'const normalized = schemaValue.toLowerCase()',
      new: 'const normalized = String(schemaValue)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/validator.test.ts:\n(pass) TypeMismatch > TypeMismatch_A3 passes after fixture fix [0.13ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'TypeMismatch_B1',
    scenarioType: 'TypeMismatch',
    errorClass: 'TypeError',
    file: 'src/schema.ts',
    expression: 'calling toPrecision on schemaCount',
    sourceContent:
      'export function handleSchema4(schemaCount: any): unknown {\n  const normalized = schemaCount.toPrecision()\n  return normalized\n}\n\nexport function asserthandleSchema4(input: unknown): boolean {\n  return handleSchema4(input) !== undefined\n}\n// Fixture TypeMismatch_B1 keeps the Phase 19 source file at realistic size.\n// Scenario TypeMismatch is expected to surface TypeError.\n',
    stderrOutput:
      'src/schema.test.ts:\n9 |   const normalized = schemaCount.toPrecision()\n                              ^\nTypeError: toPrecision is not a function\n    at handleSchema4 (/tmp/octonoesis-demo/src/schema.ts:9:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/schema.test.ts:4:12)\n(fail) TypeMismatch > TypeMismatch_B1 reproduces fixture failure [0.13ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/schema.ts',
      expression: 'calling toPrecision on schemaCount',
    },
    fix: {
      old: 'const normalized = schemaCount.toPrecision()',
      new: 'const normalized = String(schemaCount)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/schema.test.ts:\n(pass) TypeMismatch > TypeMismatch_B1 passes after fixture fix [0.14ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'TypeMismatch_B2',
    scenarioType: 'TypeMismatch',
    errorClass: 'TypeError',
    file: 'src/schema.ts',
    expression: 'calling valueOf on schemaFlag',
    sourceContent:
      'export function handleSchema5(schemaFlag: any): unknown {\n  const normalized = schemaFlag.valueOf()\n  return normalized\n}\n\nexport function asserthandleSchema5(input: unknown): boolean {\n  return handleSchema5(input) !== undefined\n}\n// Fixture TypeMismatch_B2 keeps the Phase 19 source file at realistic size.\n// Scenario TypeMismatch is expected to surface TypeError.\n',
    stderrOutput:
      'src/schema.test.ts:\n10 |   const normalized = schemaFlag.valueOf()\n                              ^\nTypeError: valueOf is not a function\n    at handleSchema5 (/tmp/octonoesis-demo/src/schema.ts:10:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/schema.test.ts:4:12)\n(fail) TypeMismatch > TypeMismatch_B2 reproduces fixture failure [0.14ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/schema.ts',
      expression: 'calling valueOf on schemaFlag',
    },
    fix: {
      old: 'const normalized = schemaFlag.valueOf()',
      new: 'const normalized = Boolean(schemaFlag).valueOf()',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/schema.test.ts:\n(pass) TypeMismatch > TypeMismatch_B2 passes after fixture fix [0.15ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'TypeMismatch_B3',
    scenarioType: 'TypeMismatch',
    errorClass: 'TypeError',
    file: 'src/schema.ts',
    expression: 'calling map on transformPayload',
    sourceContent:
      'export function handleSchema6(transformPayload: any): unknown {\n  const normalized = transformPayload.map()\n  return normalized\n}\n\nexport function asserthandleSchema6(input: unknown): boolean {\n  return handleSchema6(input) !== undefined\n}\n// Fixture TypeMismatch_B3 keeps the Phase 19 source file at realistic size.\n// Scenario TypeMismatch is expected to surface TypeError.\n',
    stderrOutput:
      'src/schema.test.ts:\n11 |   const normalized = transformPayload.map()\n                              ^\nTypeError: map is not a function\n    at handleSchema6 (/tmp/octonoesis-demo/src/schema.ts:11:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/schema.test.ts:4:12)\n(fail) TypeMismatch > TypeMismatch_B3 reproduces fixture failure [0.15ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/schema.ts',
      expression: 'calling map on transformPayload',
    },
    fix: {
      old: 'const normalized = transformPayload.map()',
      new: 'const normalized = Array.isArray(transformPayload) ? transformPayload.map(String) : []',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/schema.test.ts:\n(pass) TypeMismatch > TypeMismatch_B3 passes after fixture fix [0.16ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'TypeMismatch_C1',
    scenarioType: 'TypeMismatch',
    errorClass: 'TypeError',
    file: 'src/transform.ts',
    expression: 'calling trim on transformName',
    sourceContent:
      'export function handleTransform7(transformName: any): unknown {\n  const normalized = transformName.trim()\n  return normalized\n}\n\nexport function asserthandleTransform7(input: unknown): boolean {\n  return handleTransform7(input) !== undefined\n}\n// Fixture TypeMismatch_C1 keeps the Phase 19 source file at realistic size.\n// Scenario TypeMismatch is expected to surface TypeError.\n',
    stderrOutput:
      'src/transform.test.ts:\n12 |   const normalized = transformName.trim()\n                              ^\nTypeError: trim is not a function\n    at handleTransform7 (/tmp/octonoesis-demo/src/transform.ts:12:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/transform.test.ts:4:12)\n(fail) TypeMismatch > TypeMismatch_C1 reproduces fixture failure [0.16ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/transform.ts',
      expression: 'calling trim on transformName',
    },
    fix: {
      old: 'const normalized = transformName.trim()',
      new: 'const normalized = String(transformName)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/transform.test.ts:\n(pass) TypeMismatch > TypeMismatch_C1 passes after fixture fix [0.17ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'TypeMismatch_C2',
    scenarioType: 'TypeMismatch',
    errorClass: 'TypeError',
    file: 'src/transform.ts',
    expression: 'calling toUpperCase on mapperEntry',
    sourceContent:
      'export function handleTransform8(mapperEntry: any): unknown {\n  const normalized = mapperEntry.toUpperCase()\n  return normalized\n}\n\nexport function asserthandleTransform8(input: unknown): boolean {\n  return handleTransform8(input) !== undefined\n}\n// Fixture TypeMismatch_C2 keeps the Phase 19 source file at realistic size.\n// Scenario TypeMismatch is expected to surface TypeError.\n',
    stderrOutput:
      'src/transform.test.ts:\n13 |   const normalized = mapperEntry.toUpperCase()\n                              ^\nTypeError: toUpperCase is not a function\n    at handleTransform8 (/tmp/octonoesis-demo/src/transform.ts:13:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/transform.test.ts:4:12)\n(fail) TypeMismatch > TypeMismatch_C2 reproduces fixture failure [0.17ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/transform.ts',
      expression: 'calling toUpperCase on mapperEntry',
    },
    fix: {
      old: 'const normalized = mapperEntry.toUpperCase()',
      new: 'const normalized = String(mapperEntry).toUpperCase()',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/transform.test.ts:\n(pass) TypeMismatch > TypeMismatch_C2 passes after fixture fix [0.18ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'TypeMismatch_D1',
    scenarioType: 'TypeMismatch',
    errorClass: 'TypeError',
    file: 'src/mapper.ts',
    expression: 'calling toISOString on castValue',
    sourceContent:
      'export function handleMapper9(castValue: any): unknown {\n  const normalized = castValue.toISOString()\n  return normalized\n}\n\nexport function asserthandleMapper9(input: unknown): boolean {\n  return handleMapper9(input) !== undefined\n}\n// Fixture TypeMismatch_D1 keeps the Phase 19 source file at realistic size.\n// Scenario TypeMismatch is expected to surface TypeError.\n',
    stderrOutput:
      'src/mapper.test.ts:\n14 |   const normalized = castValue.toISOString()\n                              ^\nTypeError: toISOString is not a function\n    at handleMapper9 (/tmp/octonoesis-demo/src/mapper.ts:14:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/mapper.test.ts:4:12)\n(fail) TypeMismatch > TypeMismatch_D1 reproduces fixture failure [0.18ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/mapper.ts',
      expression: 'calling toISOString on castValue',
    },
    fix: {
      old: 'const normalized = castValue.toISOString()',
      new: 'const normalized = new Date(String(castValue)).toISOString()',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/mapper.test.ts:\n(pass) TypeMismatch > TypeMismatch_D1 passes after fixture fix [0.19ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'TypeMismatch_E1',
    scenarioType: 'TypeMismatch',
    errorClass: 'TypeError',
    file: 'src/cast.ts',
    expression: 'calling join on castList',
    sourceContent:
      'export function handleCast10(castList: any): unknown {\n  const normalized = castList.join()\n  return normalized\n}\n\nexport function asserthandleCast10(input: unknown): boolean {\n  return handleCast10(input) !== undefined\n}\n// Fixture TypeMismatch_E1 keeps the Phase 19 source file at realistic size.\n// Scenario TypeMismatch is expected to surface TypeError.\n',
    stderrOutput:
      'src/cast.test.ts:\n15 |   const normalized = castList.join()\n                              ^\nTypeError: join is not a function\n    at handleCast10 (/tmp/octonoesis-demo/src/cast.ts:15:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/cast.test.ts:4:12)\n(fail) TypeMismatch > TypeMismatch_E1 reproduces fixture failure [0.19ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/cast.ts',
      expression: 'calling join on castList',
    },
    fix: {
      old: 'const normalized = castList.join()',
      new: 'const normalized = Array.isArray(castList) ? castList.join(",") : String(castList)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/cast.test.ts:\n(pass) TypeMismatch > TypeMismatch_E1 passes after fixture fix [0.20ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'PromiseReject_A1',
    scenarioType: 'PromiseReject',
    errorClass: 'TypeError',
    file: 'src/fetcher.ts',
    expression: 'awaiting fetchResponse.items.map',
    sourceContent:
      'type ApiShape = { [key: string]: any } | undefined\n\nexport async function handleFetcher1(fetchResponse: ApiShape): Promise<string[]> {\n  const values = fetchResponse.items.map((item: unknown) => String(item))\n  return values\n}\n\nexport async function runhandleFetcher1(input: ApiShape): Promise<number> {\n  return (await handleFetcher1(input)).length\n}\n',
    stderrOutput:
      'src/fetcher.test.ts:\n6 |   const values = fetchResponse.items.map((item: unknown) => String(item))\n                              ^\nTypeError: items is not a function\n    at handleFetcher1 (/tmp/octonoesis-demo/src/fetcher.ts:6:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/fetcher.test.ts:4:12)\n(fail) PromiseReject > PromiseReject_A1 reproduces fixture failure [0.10ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/fetcher.ts',
      expression: 'awaiting fetchResponse.items.map',
    },
    fix: {
      old: 'const values = fetchResponse.items.map((item: unknown) => String(item))',
      new: 'const values = fetchResponse?.items?.map((item: unknown) => String(item)) ?? []',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/fetcher.test.ts:\n(pass) PromiseReject > PromiseReject_A1 passes after fixture fix [0.11ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'PromiseReject_A2',
    scenarioType: 'PromiseReject',
    errorClass: 'TypeError',
    file: 'src/fetcher.ts',
    expression: 'awaiting fetchJson.data.map',
    sourceContent:
      'type ApiShape = { [key: string]: any } | undefined\n\nexport async function handleFetcher2(fetchJson: ApiShape): Promise<string[]> {\n  const values = fetchJson.data.map((item: unknown) => String(item))\n  return values\n}\n\nexport async function runhandleFetcher2(input: ApiShape): Promise<number> {\n  return (await handleFetcher2(input)).length\n}\n',
    stderrOutput:
      'src/fetcher.test.ts:\n7 |   const values = fetchJson.data.map((item: unknown) => String(item))\n                              ^\nTypeError: data is not a function\n    at handleFetcher2 (/tmp/octonoesis-demo/src/fetcher.ts:7:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/fetcher.test.ts:4:12)\n(fail) PromiseReject > PromiseReject_A2 reproduces fixture failure [0.11ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/fetcher.ts',
      expression: 'awaiting fetchJson.data.map',
    },
    fix: {
      old: 'const values = fetchJson.data.map((item: unknown) => String(item))',
      new: 'const values = fetchJson?.data?.map((item: unknown) => String(item)) ?? []',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/fetcher.test.ts:\n(pass) PromiseReject > PromiseReject_A2 passes after fixture fix [0.12ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'PromiseReject_A3',
    scenarioType: 'PromiseReject',
    errorClass: 'TypeError',
    file: 'src/fetcher.ts',
    expression: 'awaiting clientResult.rows.map',
    sourceContent:
      'type ApiShape = { [key: string]: any } | undefined\n\nexport async function handleFetcher3(clientResult: ApiShape): Promise<string[]> {\n  const values = clientResult.rows.map((item: unknown) => String(item))\n  return values\n}\n\nexport async function runhandleFetcher3(input: ApiShape): Promise<number> {\n  return (await handleFetcher3(input)).length\n}\n',
    stderrOutput:
      'src/fetcher.test.ts:\n8 |   const values = clientResult.rows.map((item: unknown) => String(item))\n                              ^\nTypeError: rows is not a function\n    at handleFetcher3 (/tmp/octonoesis-demo/src/fetcher.ts:8:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/fetcher.test.ts:4:12)\n(fail) PromiseReject > PromiseReject_A3 reproduces fixture failure [0.12ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/fetcher.ts',
      expression: 'awaiting clientResult.rows.map',
    },
    fix: {
      old: 'const values = clientResult.rows.map((item: unknown) => String(item))',
      new: 'const values = clientResult?.rows?.map((item: unknown) => String(item)) ?? []',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/fetcher.test.ts:\n(pass) PromiseReject > PromiseReject_A3 passes after fixture fix [0.13ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'PromiseReject_B1',
    scenarioType: 'PromiseReject',
    errorClass: 'TypeError',
    file: 'src/api-client.ts',
    expression: 'awaiting clientUser.roles.map',
    sourceContent:
      'type ApiShape = { [key: string]: any } | undefined\n\nexport async function handleApiClient4(clientUser: ApiShape): Promise<string[]> {\n  const values = clientUser.roles.map((item: unknown) => String(item))\n  return values\n}\n\nexport async function runhandleApiClient4(input: ApiShape): Promise<number> {\n  return (await handleApiClient4(input)).length\n}\n',
    stderrOutput:
      'src/api-client.test.ts:\n9 |   const values = clientUser.roles.map((item: unknown) => String(item))\n                              ^\nTypeError: roles is not a function\n    at handleApiClient4 (/tmp/octonoesis-demo/src/api-client.ts:9:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/api-client.test.ts:4:12)\n(fail) PromiseReject > PromiseReject_B1 reproduces fixture failure [0.13ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/api-client.ts',
      expression: 'awaiting clientUser.roles.map',
    },
    fix: {
      old: 'const values = clientUser.roles.map((item: unknown) => String(item))',
      new: 'const values = clientUser?.roles?.map((item: unknown) => String(item)) ?? []',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/api-client.test.ts:\n(pass) PromiseReject > PromiseReject_B1 passes after fixture fix [0.14ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'PromiseReject_B2',
    scenarioType: 'PromiseReject',
    errorClass: 'TypeError',
    file: 'src/api-client.ts',
    expression: 'awaiting clientPage.entries.map',
    sourceContent:
      'type ApiShape = { [key: string]: any } | undefined\n\nexport async function handleApiClient5(clientPage: ApiShape): Promise<string[]> {\n  const values = clientPage.entries.map((item: unknown) => String(item))\n  return values\n}\n\nexport async function runhandleApiClient5(input: ApiShape): Promise<number> {\n  return (await handleApiClient5(input)).length\n}\n',
    stderrOutput:
      'src/api-client.test.ts:\n10 |   const values = clientPage.entries.map((item: unknown) => String(item))\n                              ^\nTypeError: entries is not a function\n    at handleApiClient5 (/tmp/octonoesis-demo/src/api-client.ts:10:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/api-client.test.ts:4:12)\n(fail) PromiseReject > PromiseReject_B2 reproduces fixture failure [0.14ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/api-client.ts',
      expression: 'awaiting clientPage.entries.map',
    },
    fix: {
      old: 'const values = clientPage.entries.map((item: unknown) => String(item))',
      new: 'const values = clientPage?.entries?.map((item: unknown) => String(item)) ?? []',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/api-client.test.ts:\n(pass) PromiseReject > PromiseReject_B2 passes after fixture fix [0.15ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'PromiseReject_B3',
    scenarioType: 'PromiseReject',
    errorClass: 'TypeError',
    file: 'src/api-client.ts',
    expression: 'awaiting queueJob.steps.map',
    sourceContent:
      'type ApiShape = { [key: string]: any } | undefined\n\nexport async function handleApiClient6(queueJob: ApiShape): Promise<string[]> {\n  const values = queueJob.steps.map((item: unknown) => String(item))\n  return values\n}\n\nexport async function runhandleApiClient6(input: ApiShape): Promise<number> {\n  return (await handleApiClient6(input)).length\n}\n',
    stderrOutput:
      'src/api-client.test.ts:\n11 |   const values = queueJob.steps.map((item: unknown) => String(item))\n                              ^\nTypeError: steps is not a function\n    at handleApiClient6 (/tmp/octonoesis-demo/src/api-client.ts:11:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/api-client.test.ts:4:12)\n(fail) PromiseReject > PromiseReject_B3 reproduces fixture failure [0.15ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/api-client.ts',
      expression: 'awaiting queueJob.steps.map',
    },
    fix: {
      old: 'const values = queueJob.steps.map((item: unknown) => String(item))',
      new: 'const values = queueJob?.steps?.map((item: unknown) => String(item)) ?? []',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/api-client.test.ts:\n(pass) PromiseReject > PromiseReject_B3 passes after fixture fix [0.16ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'PromiseReject_C1',
    scenarioType: 'PromiseReject',
    errorClass: 'TypeError',
    file: 'src/queue.ts',
    expression: 'awaiting queueBatch.tasks.map',
    sourceContent:
      'type ApiShape = { [key: string]: any } | undefined\n\nexport async function handleQueue7(queueBatch: ApiShape): Promise<string[]> {\n  const values = queueBatch.tasks.map((item: unknown) => String(item))\n  return values\n}\n\nexport async function runhandleQueue7(input: ApiShape): Promise<number> {\n  return (await handleQueue7(input)).length\n}\n',
    stderrOutput:
      'src/queue.test.ts:\n12 |   const values = queueBatch.tasks.map((item: unknown) => String(item))\n                              ^\nTypeError: tasks is not a function\n    at handleQueue7 (/tmp/octonoesis-demo/src/queue.ts:12:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/queue.test.ts:4:12)\n(fail) PromiseReject > PromiseReject_C1 reproduces fixture failure [0.16ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/queue.ts',
      expression: 'awaiting queueBatch.tasks.map',
    },
    fix: {
      old: 'const values = queueBatch.tasks.map((item: unknown) => String(item))',
      new: 'const values = queueBatch?.tasks?.map((item: unknown) => String(item)) ?? []',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/queue.test.ts:\n(pass) PromiseReject > PromiseReject_C1 passes after fixture fix [0.17ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'PromiseReject_C2',
    scenarioType: 'PromiseReject',
    errorClass: 'TypeError',
    file: 'src/queue.ts',
    expression: 'awaiting workerPayload.messages.map',
    sourceContent:
      'type ApiShape = { [key: string]: any } | undefined\n\nexport async function handleQueue8(workerPayload: ApiShape): Promise<string[]> {\n  const values = workerPayload.messages.map((item: unknown) => String(item))\n  return values\n}\n\nexport async function runhandleQueue8(input: ApiShape): Promise<number> {\n  return (await handleQueue8(input)).length\n}\n',
    stderrOutput:
      'src/queue.test.ts:\n13 |   const values = workerPayload.messages.map((item: unknown) => String(item))\n                              ^\nTypeError: messages is not a function\n    at handleQueue8 (/tmp/octonoesis-demo/src/queue.ts:13:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/queue.test.ts:4:12)\n(fail) PromiseReject > PromiseReject_C2 reproduces fixture failure [0.17ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/queue.ts',
      expression: 'awaiting workerPayload.messages.map',
    },
    fix: {
      old: 'const values = workerPayload.messages.map((item: unknown) => String(item))',
      new: 'const values = workerPayload?.messages?.map((item: unknown) => String(item)) ?? []',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/queue.test.ts:\n(pass) PromiseReject > PromiseReject_C2 passes after fixture fix [0.18ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'PromiseReject_D1',
    scenarioType: 'PromiseReject',
    errorClass: 'TypeError',
    file: 'src/worker.ts',
    expression: 'awaiting pollResult.events.map',
    sourceContent:
      'type ApiShape = { [key: string]: any } | undefined\n\nexport async function handleWorker9(pollResult: ApiShape): Promise<string[]> {\n  const values = pollResult.events.map((item: unknown) => String(item))\n  return values\n}\n\nexport async function runhandleWorker9(input: ApiShape): Promise<number> {\n  return (await handleWorker9(input)).length\n}\n',
    stderrOutput:
      'src/worker.test.ts:\n14 |   const values = pollResult.events.map((item: unknown) => String(item))\n                              ^\nTypeError: events is not a function\n    at handleWorker9 (/tmp/octonoesis-demo/src/worker.ts:14:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/worker.test.ts:4:12)\n(fail) PromiseReject > PromiseReject_D1 reproduces fixture failure [0.18ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/worker.ts',
      expression: 'awaiting pollResult.events.map',
    },
    fix: {
      old: 'const values = pollResult.events.map((item: unknown) => String(item))',
      new: 'const values = pollResult?.events?.map((item: unknown) => String(item)) ?? []',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/worker.test.ts:\n(pass) PromiseReject > PromiseReject_D1 passes after fixture fix [0.19ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'PromiseReject_E1',
    scenarioType: 'PromiseReject',
    errorClass: 'TypeError',
    file: 'src/poller.ts',
    expression: 'awaiting pollSnapshot.changes.map',
    sourceContent:
      'type ApiShape = { [key: string]: any } | undefined\n\nexport async function handlePoller10(pollSnapshot: ApiShape): Promise<string[]> {\n  const values = pollSnapshot.changes.map((item: unknown) => String(item))\n  return values\n}\n\nexport async function runhandlePoller10(input: ApiShape): Promise<number> {\n  return (await handlePoller10(input)).length\n}\n',
    stderrOutput:
      'src/poller.test.ts:\n15 |   const values = pollSnapshot.changes.map((item: unknown) => String(item))\n                              ^\nTypeError: changes is not a function\n    at handlePoller10 (/tmp/octonoesis-demo/src/poller.ts:15:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/poller.test.ts:4:12)\n(fail) PromiseReject > PromiseReject_E1 reproduces fixture failure [0.19ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/poller.ts',
      expression: 'awaiting pollSnapshot.changes.map',
    },
    fix: {
      old: 'const values = pollSnapshot.changes.map((item: unknown) => String(item))',
      new: 'const values = pollSnapshot?.changes?.map((item: unknown) => String(item)) ?? []',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/poller.test.ts:\n(pass) PromiseReject > PromiseReject_E1 passes after fixture fix [0.20ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'DeprecatedAPI_A1',
    scenarioType: 'DeprecatedAPI',
    errorClass: 'TypeError',
    file: 'src/router.ts',
    expression: "calling removed API 'router.push'",
    sourceContent:
      "type LegacyTarget = Record<string, any>\n\nexport function handleRouter1(router: LegacyTarget): void {\n  router.push('/dashboard')\n}\n\nexport function safehandleRouter1(router: LegacyTarget): boolean {\n  handleRouter1(router)\n  return true\n}\n",
    stderrOutput:
      "src/router.test.ts:\n6 |   router.push('/dashboard')\n                              ^\nTypeError: push is not a function\n    at handleRouter1 (/tmp/octonoesis-demo/src/router.ts:6:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/router.test.ts:4:12)\n(fail) DeprecatedAPI > DeprecatedAPI_A1 reproduces fixture failure [0.10ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/router.ts',
      expression: "calling removed API 'router.push'",
    },
    fix: {
      old: "router.push('/dashboard')",
      new: "router.navigate('/dashboard')",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/router.test.ts:\n(pass) DeprecatedAPI > DeprecatedAPI_A1 passes after fixture fix [0.11ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'DeprecatedAPI_A2',
    scenarioType: 'DeprecatedAPI',
    errorClass: 'TypeError',
    file: 'src/router.ts',
    expression: "calling removed API 'routerHistory.replaceRoute'",
    sourceContent:
      "type LegacyTarget = Record<string, any>\n\nexport function handleRouter2(routerHistory: LegacyTarget): void {\n  routerHistory.replaceRoute('/dashboard')\n}\n\nexport function safehandleRouter2(routerHistory: LegacyTarget): boolean {\n  handleRouter2(routerHistory)\n  return true\n}\n",
    stderrOutput:
      "src/router.test.ts:\n7 |   routerHistory.replaceRoute('/dashboard')\n                              ^\nTypeError: replaceRoute is not a function\n    at handleRouter2 (/tmp/octonoesis-demo/src/router.ts:7:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/router.test.ts:4:12)\n(fail) DeprecatedAPI > DeprecatedAPI_A2 reproduces fixture failure [0.11ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/router.ts',
      expression: "calling removed API 'routerHistory.replaceRoute'",
    },
    fix: {
      old: "routerHistory.replaceRoute('/dashboard')",
      new: "routerHistory.replace('/dashboard')",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/router.test.ts:\n(pass) DeprecatedAPI > DeprecatedAPI_A2 passes after fixture fix [0.12ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'DeprecatedAPI_A3',
    scenarioType: 'DeprecatedAPI',
    errorClass: 'TypeError',
    file: 'src/router.ts',
    expression: "calling removed API 'middlewareContext.nextTick'",
    sourceContent:
      "type LegacyTarget = Record<string, any>\n\nexport function handleRouter3(middlewareContext: LegacyTarget): void {\n  middlewareContext.nextTick('/dashboard')\n}\n\nexport function safehandleRouter3(middlewareContext: LegacyTarget): boolean {\n  handleRouter3(middlewareContext)\n  return true\n}\n",
    stderrOutput:
      "src/router.test.ts:\n8 |   middlewareContext.nextTick('/dashboard')\n                              ^\nTypeError: nextTick is not a function\n    at handleRouter3 (/tmp/octonoesis-demo/src/router.ts:8:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/router.test.ts:4:12)\n(fail) DeprecatedAPI > DeprecatedAPI_A3 reproduces fixture failure [0.12ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/router.ts',
      expression: "calling removed API 'middlewareContext.nextTick'",
    },
    fix: {
      old: "middlewareContext.nextTick('/dashboard')",
      new: "middlewareContext.next('/dashboard')",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/router.test.ts:\n(pass) DeprecatedAPI > DeprecatedAPI_A3 passes after fixture fix [0.13ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'DeprecatedAPI_B1',
    scenarioType: 'DeprecatedAPI',
    errorClass: 'TypeError',
    file: 'src/middleware.ts',
    expression: "calling removed API 'middlewareSession.setHeader'",
    sourceContent:
      "type LegacyTarget = Record<string, any>\n\nexport function handleMiddleware4(middlewareSession: LegacyTarget): void {\n  middlewareSession.setHeader('/dashboard')\n}\n\nexport function safehandleMiddleware4(middlewareSession: LegacyTarget): boolean {\n  handleMiddleware4(middlewareSession)\n  return true\n}\n",
    stderrOutput:
      "src/middleware.test.ts:\n9 |   middlewareSession.setHeader('/dashboard')\n                              ^\nTypeError: setHeader is not a function\n    at handleMiddleware4 (/tmp/octonoesis-demo/src/middleware.ts:9:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/middleware.test.ts:4:12)\n(fail) DeprecatedAPI > DeprecatedAPI_B1 reproduces fixture failure [0.13ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/middleware.ts',
      expression: "calling removed API 'middlewareSession.setHeader'",
    },
    fix: {
      old: "middlewareSession.setHeader('/dashboard')",
      new: "middlewareSession.headers.set('/dashboard')",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/middleware.test.ts:\n(pass) DeprecatedAPI > DeprecatedAPI_B1 passes after fixture fix [0.14ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'DeprecatedAPI_B2',
    scenarioType: 'DeprecatedAPI',
    errorClass: 'TypeError',
    file: 'src/middleware.ts',
    expression: "calling removed API 'middlewareLogger.warnOnce'",
    sourceContent:
      "type LegacyTarget = Record<string, any>\n\nexport function handleMiddleware5(middlewareLogger: LegacyTarget): void {\n  middlewareLogger.warnOnce('/dashboard')\n}\n\nexport function safehandleMiddleware5(middlewareLogger: LegacyTarget): boolean {\n  handleMiddleware5(middlewareLogger)\n  return true\n}\n",
    stderrOutput:
      "src/middleware.test.ts:\n10 |   middlewareLogger.warnOnce('/dashboard')\n                              ^\nTypeError: warnOnce is not a function\n    at handleMiddleware5 (/tmp/octonoesis-demo/src/middleware.ts:10:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/middleware.test.ts:4:12)\n(fail) DeprecatedAPI > DeprecatedAPI_B2 reproduces fixture failure [0.14ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/middleware.ts',
      expression: "calling removed API 'middlewareLogger.warnOnce'",
    },
    fix: {
      old: "middlewareLogger.warnOnce('/dashboard')",
      new: "middlewareLogger.warn('/dashboard')",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/middleware.test.ts:\n(pass) DeprecatedAPI > DeprecatedAPI_B2 passes after fixture fix [0.15ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'DeprecatedAPI_B3',
    scenarioType: 'DeprecatedAPI',
    errorClass: 'TypeError',
    file: 'src/middleware.ts',
    expression: "calling removed API 'legacyStore.getStateSync'",
    sourceContent:
      "type LegacyTarget = Record<string, any>\n\nexport function handleMiddleware6(legacyStore: LegacyTarget): void {\n  legacyStore.getStateSync('/dashboard')\n}\n\nexport function safehandleMiddleware6(legacyStore: LegacyTarget): boolean {\n  handleMiddleware6(legacyStore)\n  return true\n}\n",
    stderrOutput:
      "src/middleware.test.ts:\n11 |   legacyStore.getStateSync('/dashboard')\n                              ^\nTypeError: getStateSync is not a function\n    at handleMiddleware6 (/tmp/octonoesis-demo/src/middleware.ts:11:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/middleware.test.ts:4:12)\n(fail) DeprecatedAPI > DeprecatedAPI_B3 reproduces fixture failure [0.15ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/middleware.ts',
      expression: "calling removed API 'legacyStore.getStateSync'",
    },
    fix: {
      old: "legacyStore.getStateSync('/dashboard')",
      new: "legacyStore.getState('/dashboard')",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/middleware.test.ts:\n(pass) DeprecatedAPI > DeprecatedAPI_B3 passes after fixture fix [0.16ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'DeprecatedAPI_C1',
    scenarioType: 'DeprecatedAPI',
    errorClass: 'TypeError',
    file: 'src/legacy.ts',
    expression: "calling removed API 'legacyClient.sendAsync'",
    sourceContent:
      "type LegacyTarget = Record<string, any>\n\nexport function handleLegacy7(legacyClient: LegacyTarget): void {\n  legacyClient.sendAsync('/dashboard')\n}\n\nexport function safehandleLegacy7(legacyClient: LegacyTarget): boolean {\n  handleLegacy7(legacyClient)\n  return true\n}\n",
    stderrOutput:
      "src/legacy.test.ts:\n12 |   legacyClient.sendAsync('/dashboard')\n                              ^\nTypeError: sendAsync is not a function\n    at handleLegacy7 (/tmp/octonoesis-demo/src/legacy.ts:12:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/legacy.test.ts:4:12)\n(fail) DeprecatedAPI > DeprecatedAPI_C1 reproduces fixture failure [0.16ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/legacy.ts',
      expression: "calling removed API 'legacyClient.sendAsync'",
    },
    fix: {
      old: "legacyClient.sendAsync('/dashboard')",
      new: "legacyClient.send('/dashboard')",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/legacy.test.ts:\n(pass) DeprecatedAPI > DeprecatedAPI_C1 passes after fixture fix [0.17ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'DeprecatedAPI_C2',
    scenarioType: 'DeprecatedAPI',
    errorClass: 'TypeError',
    file: 'src/legacy.ts',
    expression: "calling removed API 'compatLayer.mountComponent'",
    sourceContent:
      "type LegacyTarget = Record<string, any>\n\nexport function handleLegacy8(compatLayer: LegacyTarget): void {\n  compatLayer.mountComponent('/dashboard')\n}\n\nexport function safehandleLegacy8(compatLayer: LegacyTarget): boolean {\n  handleLegacy8(compatLayer)\n  return true\n}\n",
    stderrOutput:
      "src/legacy.test.ts:\n13 |   compatLayer.mountComponent('/dashboard')\n                              ^\nTypeError: mountComponent is not a function\n    at handleLegacy8 (/tmp/octonoesis-demo/src/legacy.ts:13:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/legacy.test.ts:4:12)\n(fail) DeprecatedAPI > DeprecatedAPI_C2 reproduces fixture failure [0.17ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/legacy.ts',
      expression: "calling removed API 'compatLayer.mountComponent'",
    },
    fix: {
      old: "compatLayer.mountComponent('/dashboard')",
      new: "compatLayer.mount('/dashboard')",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/legacy.test.ts:\n(pass) DeprecatedAPI > DeprecatedAPI_C2 passes after fixture fix [0.18ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'DeprecatedAPI_D1',
    scenarioType: 'DeprecatedAPI',
    errorClass: 'TypeError',
    file: 'src/compat.ts',
    expression: "calling removed API 'adapterBridge.callLegacy'",
    sourceContent:
      "type LegacyTarget = Record<string, any>\n\nexport function handleCompat9(adapterBridge: LegacyTarget): void {\n  adapterBridge.callLegacy('/dashboard')\n}\n\nexport function safehandleCompat9(adapterBridge: LegacyTarget): boolean {\n  handleCompat9(adapterBridge)\n  return true\n}\n",
    stderrOutput:
      "src/compat.test.ts:\n14 |   adapterBridge.callLegacy('/dashboard')\n                              ^\nTypeError: callLegacy is not a function\n    at handleCompat9 (/tmp/octonoesis-demo/src/compat.ts:14:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/compat.test.ts:4:12)\n(fail) DeprecatedAPI > DeprecatedAPI_D1 reproduces fixture failure [0.18ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/compat.ts',
      expression: "calling removed API 'adapterBridge.callLegacy'",
    },
    fix: {
      old: "adapterBridge.callLegacy('/dashboard')",
      new: "adapterBridge.call('/dashboard')",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/compat.test.ts:\n(pass) DeprecatedAPI > DeprecatedAPI_D1 passes after fixture fix [0.19ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'DeprecatedAPI_E1',
    scenarioType: 'DeprecatedAPI',
    errorClass: 'TypeError',
    file: 'src/adapter.ts',
    expression: "calling removed API 'adapterRouter.goTo'",
    sourceContent:
      "type LegacyTarget = Record<string, any>\n\nexport function handleAdapter10(adapterRouter: LegacyTarget): void {\n  adapterRouter.goTo('/dashboard')\n}\n\nexport function safehandleAdapter10(adapterRouter: LegacyTarget): boolean {\n  handleAdapter10(adapterRouter)\n  return true\n}\n",
    stderrOutput:
      "src/adapter.test.ts:\n15 |   adapterRouter.goTo('/dashboard')\n                              ^\nTypeError: goTo is not a function\n    at handleAdapter10 (/tmp/octonoesis-demo/src/adapter.ts:15:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/adapter.test.ts:4:12)\n(fail) DeprecatedAPI > DeprecatedAPI_E1 reproduces fixture failure [0.19ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'TypeError',
      file: 'src/adapter.ts',
      expression: "calling removed API 'adapterRouter.goTo'",
    },
    fix: {
      old: "adapterRouter.goTo('/dashboard')",
      new: "adapterRouter.navigate('/dashboard')",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/adapter.test.ts:\n(pass) DeprecatedAPI > DeprecatedAPI_E1 passes after fixture fix [0.20ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ParseError_A2',
    scenarioType: 'ParseError',
    errorClass: 'SyntaxError',
    file: 'src/parser.ts',
    expression: 'missing closing paren in parseHeader',
    sourceContent:
      'export function parseHeader(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n// Fixture ParseError_A2 keeps the Phase 19 source file at realistic size.\n// Scenario ParseError is expected to surface SyntaxError.\n// The buggy line above remains the exact Edit target for this fixture.\n// File src/parser.ts participates in the medium-fingerprint group.\n// Additional context prevents tiny artificial source snippets.\n// Tests use this content when materializing temporary repositories.\n// The fix payload intentionally changes only the targeted line.\n',
    stderrOutput:
      'src/parser.test.ts:\n7 |   return raw.trim()\n                       ^\nSyntaxError: Expected "}" but found end of file\n    at handleParser2 (/tmp/octonoesis-demo/src/parser.ts:7:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/parser.test.ts:4:12)\n(fail) ParseError > ParseError_A2 reproduces fixture failure [0.11ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/parser.ts',
      expression: 'missing closing paren in parseHeader',
    },
    fix: {
      old: 'export function parseHeader(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n',
      new: "export function parseHeader(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n  }\n  return ''\n}\n",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/parser.test.ts:\n(pass) ParseError > ParseError_A2 passes after fixture fix [0.12ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ParseError_A3',
    scenarioType: 'ParseError',
    errorClass: 'SyntaxError',
    file: 'src/parser.ts',
    expression: 'missing object brace in parseToken',
    sourceContent:
      'export function parseToken(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n// Fixture ParseError_A3 keeps the Phase 19 source file at realistic size.\n// Scenario ParseError is expected to surface SyntaxError.\n// The buggy line above remains the exact Edit target for this fixture.\n// File src/parser.ts participates in the medium-fingerprint group.\n// Additional context prevents tiny artificial source snippets.\n// Tests use this content when materializing temporary repositories.\n// The fix payload intentionally changes only the targeted line.\n',
    stderrOutput:
      'src/parser.test.ts:\n8 |   return raw.trim()\n                       ^\nSyntaxError: Expected "}" but found end of file\n    at handleParser3 (/tmp/octonoesis-demo/src/parser.ts:8:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/parser.test.ts:4:12)\n(fail) ParseError > ParseError_A3 reproduces fixture failure [0.12ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/parser.ts',
      expression: 'missing object brace in parseToken',
    },
    fix: {
      old: 'export function parseToken(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n',
      new: "export function parseToken(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n  }\n  return ''\n}\n",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/parser.test.ts:\n(pass) ParseError > ParseError_A3 passes after fixture fix [0.13ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ParseError_B1',
    scenarioType: 'ParseError',
    errorClass: 'SyntaxError',
    file: 'src/tokenizer.ts',
    expression: 'missing array bracket in tokenizeLine',
    sourceContent:
      'export function tokenizeLine(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n// Fixture ParseError_B1 keeps the Phase 19 source file at realistic size.\n// Scenario ParseError is expected to surface SyntaxError.\n// The buggy line above remains the exact Edit target for this fixture.\n// File src/tokenizer.ts participates in the medium-fingerprint group.\n// Additional context prevents tiny artificial source snippets.\n// Tests use this content when materializing temporary repositories.\n// The fix payload intentionally changes only the targeted line.\n',
    stderrOutput:
      'src/tokenizer.test.ts:\n9 |   return raw.trim()\n                       ^\nSyntaxError: Expected "}" but found end of file\n    at handleTokenizer4 (/tmp/octonoesis-demo/src/tokenizer.ts:9:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/tokenizer.test.ts:4:12)\n(fail) ParseError > ParseError_B1 reproduces fixture failure [0.13ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/tokenizer.ts',
      expression: 'missing array bracket in tokenizeLine',
    },
    fix: {
      old: 'export function tokenizeLine(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n',
      new: "export function tokenizeLine(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n  }\n  return ''\n}\n",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/tokenizer.test.ts:\n(pass) ParseError > ParseError_B1 passes after fixture fix [0.14ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ParseError_B2',
    scenarioType: 'ParseError',
    errorClass: 'SyntaxError',
    file: 'src/tokenizer.ts',
    expression: 'missing template brace in tokenizeBlock',
    sourceContent:
      'export function tokenizeBlock(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n// Fixture ParseError_B2 keeps the Phase 19 source file at realistic size.\n// Scenario ParseError is expected to surface SyntaxError.\n// The buggy line above remains the exact Edit target for this fixture.\n// File src/tokenizer.ts participates in the medium-fingerprint group.\n// Additional context prevents tiny artificial source snippets.\n// Tests use this content when materializing temporary repositories.\n// The fix payload intentionally changes only the targeted line.\n',
    stderrOutput:
      'src/tokenizer.test.ts:\n10 |   return raw.trim()\n                       ^\nSyntaxError: Expected "}" but found end of file\n    at handleTokenizer5 (/tmp/octonoesis-demo/src/tokenizer.ts:10:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/tokenizer.test.ts:4:12)\n(fail) ParseError > ParseError_B2 reproduces fixture failure [0.14ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/tokenizer.ts',
      expression: 'missing template brace in tokenizeBlock',
    },
    fix: {
      old: 'export function tokenizeBlock(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n',
      new: "export function tokenizeBlock(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n  }\n  return ''\n}\n",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/tokenizer.test.ts:\n(pass) ParseError > ParseError_B2 passes after fixture fix [0.15ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ParseError_B3',
    scenarioType: 'ParseError',
    errorClass: 'SyntaxError',
    file: 'src/tokenizer.ts',
    expression: 'missing switch brace in compileNode',
    sourceContent:
      'export function compileNode(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n// Fixture ParseError_B3 keeps the Phase 19 source file at realistic size.\n// Scenario ParseError is expected to surface SyntaxError.\n// The buggy line above remains the exact Edit target for this fixture.\n// File src/tokenizer.ts participates in the medium-fingerprint group.\n// Additional context prevents tiny artificial source snippets.\n// Tests use this content when materializing temporary repositories.\n// The fix payload intentionally changes only the targeted line.\n',
    stderrOutput:
      'src/tokenizer.test.ts:\n11 |   return raw.trim()\n                       ^\nSyntaxError: Expected "}" but found end of file\n    at handleTokenizer6 (/tmp/octonoesis-demo/src/tokenizer.ts:11:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/tokenizer.test.ts:4:12)\n(fail) ParseError > ParseError_B3 reproduces fixture failure [0.15ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/tokenizer.ts',
      expression: 'missing switch brace in compileNode',
    },
    fix: {
      old: 'export function compileNode(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n',
      new: "export function compileNode(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n  }\n  return ''\n}\n",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/tokenizer.test.ts:\n(pass) ParseError > ParseError_B3 passes after fixture fix [0.16ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ParseError_C1',
    scenarioType: 'ParseError',
    errorClass: 'SyntaxError',
    file: 'src/compiler.ts',
    expression: 'missing function brace in compileGraph',
    sourceContent:
      'export function compileGraph(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n// Fixture ParseError_C1 keeps the Phase 19 source file at realistic size.\n// Scenario ParseError is expected to surface SyntaxError.\n// The buggy line above remains the exact Edit target for this fixture.\n// File src/compiler.ts participates in the medium-fingerprint group.\n// Additional context prevents tiny artificial source snippets.\n// Tests use this content when materializing temporary repositories.\n// The fix payload intentionally changes only the targeted line.\n',
    stderrOutput:
      'src/compiler.test.ts:\n12 |   return raw.trim()\n                       ^\nSyntaxError: Expected "}" but found end of file\n    at handleCompiler7 (/tmp/octonoesis-demo/src/compiler.ts:12:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/compiler.test.ts:4:12)\n(fail) ParseError > ParseError_C1 reproduces fixture failure [0.16ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/compiler.ts',
      expression: 'missing function brace in compileGraph',
    },
    fix: {
      old: 'export function compileGraph(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n',
      new: "export function compileGraph(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n  }\n  return ''\n}\n",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/compiler.test.ts:\n(pass) ParseError > ParseError_C1 passes after fixture fix [0.17ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ParseError_C2',
    scenarioType: 'ParseError',
    errorClass: 'SyntaxError',
    file: 'src/compiler.ts',
    expression: 'missing template literal in renderTemplate',
    sourceContent:
      'export function renderTemplate(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n// Fixture ParseError_C2 keeps the Phase 19 source file at realistic size.\n// Scenario ParseError is expected to surface SyntaxError.\n// The buggy line above remains the exact Edit target for this fixture.\n// File src/compiler.ts participates in the medium-fingerprint group.\n// Additional context prevents tiny artificial source snippets.\n// Tests use this content when materializing temporary repositories.\n// The fix payload intentionally changes only the targeted line.\n',
    stderrOutput:
      'src/compiler.test.ts:\n13 |   return raw.trim()\n                       ^\nSyntaxError: Expected "}" but found end of file\n    at handleCompiler8 (/tmp/octonoesis-demo/src/compiler.ts:13:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/compiler.test.ts:4:12)\n(fail) ParseError > ParseError_C2 reproduces fixture failure [0.17ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/compiler.ts',
      expression: 'missing template literal in renderTemplate',
    },
    fix: {
      old: 'export function renderTemplate(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n',
      new: "export function renderTemplate(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n  }\n  return ''\n}\n",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/compiler.test.ts:\n(pass) ParseError > ParseError_C2 passes after fixture fix [0.18ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ParseError_D1',
    scenarioType: 'ParseError',
    errorClass: 'SyntaxError',
    file: 'src/template.ts',
    expression: 'missing try block in evaluateExpr',
    sourceContent:
      'export function evaluateExpr(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n// Fixture ParseError_D1 keeps the Phase 19 source file at realistic size.\n// Scenario ParseError is expected to surface SyntaxError.\n// The buggy line above remains the exact Edit target for this fixture.\n// File src/template.ts participates in the medium-fingerprint group.\n// Additional context prevents tiny artificial source snippets.\n// Tests use this content when materializing temporary repositories.\n// The fix payload intentionally changes only the targeted line.\n',
    stderrOutput:
      'src/template.test.ts:\n14 |   return raw.trim()\n                       ^\nSyntaxError: Expected "}" but found end of file\n    at handleTemplate9 (/tmp/octonoesis-demo/src/template.ts:14:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/template.test.ts:4:12)\n(fail) ParseError > ParseError_D1 reproduces fixture failure [0.18ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/template.ts',
      expression: 'missing try block in evaluateExpr',
    },
    fix: {
      old: 'export function evaluateExpr(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n',
      new: "export function evaluateExpr(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n  }\n  return ''\n}\n",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/template.test.ts:\n(pass) ParseError > ParseError_D1 passes after fixture fix [0.19ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ParseError_E1',
    scenarioType: 'ParseError',
    errorClass: 'SyntaxError',
    file: 'src/evaluator.ts',
    expression: 'missing if block in evaluateRule',
    sourceContent:
      'export function evaluateRule(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n// Fixture ParseError_E1 keeps the Phase 19 source file at realistic size.\n// Scenario ParseError is expected to surface SyntaxError.\n// The buggy line above remains the exact Edit target for this fixture.\n// File src/evaluator.ts participates in the medium-fingerprint group.\n// Additional context prevents tiny artificial source snippets.\n// Tests use this content when materializing temporary repositories.\n// The fix payload intentionally changes only the targeted line.\n',
    stderrOutput:
      'src/evaluator.test.ts:\n15 |   return raw.trim()\n                       ^\nSyntaxError: Expected "}" but found end of file\n    at handleEvaluator10 (/tmp/octonoesis-demo/src/evaluator.ts:15:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/evaluator.test.ts:4:12)\n(fail) ParseError > ParseError_E1 reproduces fixture failure [0.19ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/evaluator.ts',
      expression: 'missing if block in evaluateRule',
    },
    fix: {
      old: 'export function evaluateRule(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n',
      new: "export function evaluateRule(raw: string): string {\n  if (raw.length > 0) {\n    return raw.trim()\n  }\n  return ''\n}\n",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/evaluator.test.ts:\n(pass) ParseError > ParseError_E1 passes after fixture fix [0.20ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'JSONMalformed_A1',
    scenarioType: 'JSONMalformed',
    errorClass: 'SyntaxError',
    file: 'src/json-reader.ts',
    expression: 'JSON.parse(readerRaw)',
    sourceContent:
      "function safeParse(raw: string): unknown {\n  try { return JSON.parse(raw || '{}') } catch { return {} }\n}\n\nexport function handleJsonReader1(readerRaw: string): unknown {\n  const parsed = JSON.parse(readerRaw)\n  return parsed\n}\n// Fixture JSONMalformed_A1 keeps the Phase 19 source file at realistic size.\n// Scenario JSONMalformed is expected to surface SyntaxError.\n",
    stderrOutput:
      "src/json-reader.test.ts:\n6 |   const parsed = JSON.parse(readerRaw)\n                              ^\nSyntaxError: Unexpected token 'u' at position 0\n    at handleJsonReader1 (/tmp/octonoesis-demo/src/json-reader.ts:6:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/json-reader.test.ts:4:12)\n(fail) JSONMalformed > JSONMalformed_A1 reproduces fixture failure [0.10ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/json-reader.ts',
      expression: 'JSON.parse(readerRaw)',
    },
    fix: {
      old: 'const parsed = JSON.parse(readerRaw)',
      new: 'const parsed = safeParse(readerRaw)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/json-reader.test.ts:\n(pass) JSONMalformed > JSONMalformed_A1 passes after fixture fix [0.11ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'JSONMalformed_A2',
    scenarioType: 'JSONMalformed',
    errorClass: 'SyntaxError',
    file: 'src/json-reader.ts',
    expression: 'JSON.parse(readerBody)',
    sourceContent:
      "function safeParse(raw: string): unknown {\n  try { return JSON.parse(raw || '{}') } catch { return {} }\n}\n\nexport function handleJsonReader2(readerBody: string): unknown {\n  const parsed = JSON.parse(readerBody)\n  return parsed\n}\n// Fixture JSONMalformed_A2 keeps the Phase 19 source file at realistic size.\n// Scenario JSONMalformed is expected to surface SyntaxError.\n",
    stderrOutput:
      "src/json-reader.test.ts:\n7 |   const parsed = JSON.parse(readerBody)\n                              ^\nSyntaxError: Unexpected token 'u' at position 0\n    at handleJsonReader2 (/tmp/octonoesis-demo/src/json-reader.ts:7:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/json-reader.test.ts:4:12)\n(fail) JSONMalformed > JSONMalformed_A2 reproduces fixture failure [0.11ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/json-reader.ts',
      expression: 'JSON.parse(readerBody)',
    },
    fix: {
      old: 'const parsed = JSON.parse(readerBody)',
      new: 'const parsed = safeParse(readerBody)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/json-reader.test.ts:\n(pass) JSONMalformed > JSONMalformed_A2 passes after fixture fix [0.12ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'JSONMalformed_A3',
    scenarioType: 'JSONMalformed',
    errorClass: 'SyntaxError',
    file: 'src/json-reader.ts',
    expression: 'JSON.parse(payloadText)',
    sourceContent:
      "function safeParse(raw: string): unknown {\n  try { return JSON.parse(raw || '{}') } catch { return {} }\n}\n\nexport function handleJsonReader3(payloadText: string): unknown {\n  const parsed = JSON.parse(payloadText)\n  return parsed\n}\n// Fixture JSONMalformed_A3 keeps the Phase 19 source file at realistic size.\n// Scenario JSONMalformed is expected to surface SyntaxError.\n",
    stderrOutput:
      "src/json-reader.test.ts:\n8 |   const parsed = JSON.parse(payloadText)\n                              ^\nSyntaxError: Unexpected token 'u' at position 0\n    at handleJsonReader3 (/tmp/octonoesis-demo/src/json-reader.ts:8:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/json-reader.test.ts:4:12)\n(fail) JSONMalformed > JSONMalformed_A3 reproduces fixture failure [0.12ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/json-reader.ts',
      expression: 'JSON.parse(payloadText)',
    },
    fix: {
      old: 'const parsed = JSON.parse(payloadText)',
      new: 'const parsed = safeParse(payloadText)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/json-reader.test.ts:\n(pass) JSONMalformed > JSONMalformed_A3 passes after fixture fix [0.13ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'JSONMalformed_B1',
    scenarioType: 'JSONMalformed',
    errorClass: 'SyntaxError',
    file: 'src/payload.ts',
    expression: 'JSON.parse(payloadConfig)',
    sourceContent:
      "function safeParse(raw: string): unknown {\n  try { return JSON.parse(raw || '{}') } catch { return {} }\n}\n\nexport function handlePayload4(payloadConfig: string): unknown {\n  const parsed = JSON.parse(payloadConfig)\n  return parsed\n}\n// Fixture JSONMalformed_B1 keeps the Phase 19 source file at realistic size.\n// Scenario JSONMalformed is expected to surface SyntaxError.\n",
    stderrOutput:
      "src/payload.test.ts:\n9 |   const parsed = JSON.parse(payloadConfig)\n                              ^\nSyntaxError: Unexpected token 'u' at position 0\n    at handlePayload4 (/tmp/octonoesis-demo/src/payload.ts:9:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/payload.test.ts:4:12)\n(fail) JSONMalformed > JSONMalformed_B1 reproduces fixture failure [0.13ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/payload.ts',
      expression: 'JSON.parse(payloadConfig)',
    },
    fix: {
      old: 'const parsed = JSON.parse(payloadConfig)',
      new: 'const parsed = safeParse(payloadConfig)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/payload.test.ts:\n(pass) JSONMalformed > JSONMalformed_B1 passes after fixture fix [0.14ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'JSONMalformed_B2',
    scenarioType: 'JSONMalformed',
    errorClass: 'SyntaxError',
    file: 'src/payload.ts',
    expression: 'JSON.parse(payloadMeta)',
    sourceContent:
      "function safeParse(raw: string): unknown {\n  try { return JSON.parse(raw || '{}') } catch { return {} }\n}\n\nexport function handlePayload5(payloadMeta: string): unknown {\n  const parsed = JSON.parse(payloadMeta)\n  return parsed\n}\n// Fixture JSONMalformed_B2 keeps the Phase 19 source file at realistic size.\n// Scenario JSONMalformed is expected to surface SyntaxError.\n",
    stderrOutput:
      "src/payload.test.ts:\n10 |   const parsed = JSON.parse(payloadMeta)\n                              ^\nSyntaxError: Unexpected token 'u' at position 0\n    at handlePayload5 (/tmp/octonoesis-demo/src/payload.ts:10:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/payload.test.ts:4:12)\n(fail) JSONMalformed > JSONMalformed_B2 reproduces fixture failure [0.14ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/payload.ts',
      expression: 'JSON.parse(payloadMeta)',
    },
    fix: {
      old: 'const parsed = JSON.parse(payloadMeta)',
      new: 'const parsed = safeParse(payloadMeta)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/payload.test.ts:\n(pass) JSONMalformed > JSONMalformed_B2 passes after fixture fix [0.15ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'JSONMalformed_B3',
    scenarioType: 'JSONMalformed',
    errorClass: 'SyntaxError',
    file: 'src/payload.ts',
    expression: 'JSON.parse(serializerInput)',
    sourceContent:
      "function safeParse(raw: string): unknown {\n  try { return JSON.parse(raw || '{}') } catch { return {} }\n}\n\nexport function handlePayload6(serializerInput: string): unknown {\n  const parsed = JSON.parse(serializerInput)\n  return parsed\n}\n// Fixture JSONMalformed_B3 keeps the Phase 19 source file at realistic size.\n// Scenario JSONMalformed is expected to surface SyntaxError.\n",
    stderrOutput:
      "src/payload.test.ts:\n11 |   const parsed = JSON.parse(serializerInput)\n                              ^\nSyntaxError: Unexpected token 'u' at position 0\n    at handlePayload6 (/tmp/octonoesis-demo/src/payload.ts:11:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/payload.test.ts:4:12)\n(fail) JSONMalformed > JSONMalformed_B3 reproduces fixture failure [0.15ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/payload.ts',
      expression: 'JSON.parse(serializerInput)',
    },
    fix: {
      old: 'const parsed = JSON.parse(serializerInput)',
      new: 'const parsed = safeParse(serializerInput)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/payload.test.ts:\n(pass) JSONMalformed > JSONMalformed_B3 passes after fixture fix [0.16ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'JSONMalformed_C1',
    scenarioType: 'JSONMalformed',
    errorClass: 'SyntaxError',
    file: 'src/serializer.ts',
    expression: 'JSON.parse(serializerCache)',
    sourceContent:
      "function safeParse(raw: string): unknown {\n  try { return JSON.parse(raw || '{}') } catch { return {} }\n}\n\nexport function handleSerializer7(serializerCache: string): unknown {\n  const parsed = JSON.parse(serializerCache)\n  return parsed\n}\n// Fixture JSONMalformed_C1 keeps the Phase 19 source file at realistic size.\n// Scenario JSONMalformed is expected to surface SyntaxError.\n",
    stderrOutput:
      "src/serializer.test.ts:\n12 |   const parsed = JSON.parse(serializerCache)\n                              ^\nSyntaxError: Unexpected token 'u' at position 0\n    at handleSerializer7 (/tmp/octonoesis-demo/src/serializer.ts:12:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/serializer.test.ts:4:12)\n(fail) JSONMalformed > JSONMalformed_C1 reproduces fixture failure [0.16ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/serializer.ts',
      expression: 'JSON.parse(serializerCache)',
    },
    fix: {
      old: 'const parsed = JSON.parse(serializerCache)',
      new: 'const parsed = safeParse(serializerCache)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/serializer.test.ts:\n(pass) JSONMalformed > JSONMalformed_C1 passes after fixture fix [0.17ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'JSONMalformed_C2',
    scenarioType: 'JSONMalformed',
    errorClass: 'SyntaxError',
    file: 'src/serializer.ts',
    expression: 'JSON.parse(decoderBuffer)',
    sourceContent:
      "function safeParse(raw: string): unknown {\n  try { return JSON.parse(raw || '{}') } catch { return {} }\n}\n\nexport function handleSerializer8(decoderBuffer: string): unknown {\n  const parsed = JSON.parse(decoderBuffer)\n  return parsed\n}\n// Fixture JSONMalformed_C2 keeps the Phase 19 source file at realistic size.\n// Scenario JSONMalformed is expected to surface SyntaxError.\n",
    stderrOutput:
      "src/serializer.test.ts:\n13 |   const parsed = JSON.parse(decoderBuffer)\n                              ^\nSyntaxError: Unexpected token 'u' at position 0\n    at handleSerializer8 (/tmp/octonoesis-demo/src/serializer.ts:13:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/serializer.test.ts:4:12)\n(fail) JSONMalformed > JSONMalformed_C2 reproduces fixture failure [0.17ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/serializer.ts',
      expression: 'JSON.parse(decoderBuffer)',
    },
    fix: {
      old: 'const parsed = JSON.parse(decoderBuffer)',
      new: 'const parsed = safeParse(decoderBuffer)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/serializer.test.ts:\n(pass) JSONMalformed > JSONMalformed_C2 passes after fixture fix [0.18ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'JSONMalformed_D1',
    scenarioType: 'JSONMalformed',
    errorClass: 'SyntaxError',
    file: 'src/decoder.ts',
    expression: 'JSON.parse(importerText)',
    sourceContent:
      "function safeParse(raw: string): unknown {\n  try { return JSON.parse(raw || '{}') } catch { return {} }\n}\n\nexport function handleDecoder9(importerText: string): unknown {\n  const parsed = JSON.parse(importerText)\n  return parsed\n}\n// Fixture JSONMalformed_D1 keeps the Phase 19 source file at realistic size.\n// Scenario JSONMalformed is expected to surface SyntaxError.\n",
    stderrOutput:
      "src/decoder.test.ts:\n14 |   const parsed = JSON.parse(importerText)\n                              ^\nSyntaxError: Unexpected token 'u' at position 0\n    at handleDecoder9 (/tmp/octonoesis-demo/src/decoder.ts:14:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/decoder.test.ts:4:12)\n(fail) JSONMalformed > JSONMalformed_D1 reproduces fixture failure [0.18ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/decoder.ts',
      expression: 'JSON.parse(importerText)',
    },
    fix: {
      old: 'const parsed = JSON.parse(importerText)',
      new: 'const parsed = safeParse(importerText)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/decoder.test.ts:\n(pass) JSONMalformed > JSONMalformed_D1 passes after fixture fix [0.19ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'JSONMalformed_E1',
    scenarioType: 'JSONMalformed',
    errorClass: 'SyntaxError',
    file: 'src/importer.ts',
    expression: 'JSON.parse(importerBlob)',
    sourceContent:
      "function safeParse(raw: string): unknown {\n  try { return JSON.parse(raw || '{}') } catch { return {} }\n}\n\nexport function handleImporter10(importerBlob: string): unknown {\n  const parsed = JSON.parse(importerBlob)\n  return parsed\n}\n// Fixture JSONMalformed_E1 keeps the Phase 19 source file at realistic size.\n// Scenario JSONMalformed is expected to surface SyntaxError.\n",
    stderrOutput:
      "src/importer.test.ts:\n15 |   const parsed = JSON.parse(importerBlob)\n                              ^\nSyntaxError: Unexpected token 'u' at position 0\n    at handleImporter10 (/tmp/octonoesis-demo/src/importer.ts:15:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/importer.test.ts:4:12)\n(fail) JSONMalformed > JSONMalformed_E1 reproduces fixture failure [0.19ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/importer.ts',
      expression: 'JSON.parse(importerBlob)',
    },
    fix: {
      old: 'const parsed = JSON.parse(importerBlob)',
      new: 'const parsed = safeParse(importerBlob)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/importer.test.ts:\n(pass) JSONMalformed > JSONMalformed_E1 passes after fixture fix [0.20ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'InvalidRegex_A1',
    scenarioType: 'InvalidRegex',
    errorClass: 'SyntaxError',
    file: 'src/regex-engine.ts',
    expression: 'new RegExp(namePattern)',
    sourceContent:
      "function escapeRegex(value: string): string {\n  return value.split('').map((char) => '^.*+?()[]{}|'.includes(char) ? '\\\\' + char : char).join('')\n}\n\nexport function handleRegexEngine1(namePattern: string, input: string): boolean {\n  const matcher = new RegExp(namePattern)\n  return matcher.test(input)\n}\n// Fixture InvalidRegex_A1 keeps the Phase 19 source file at realistic size.\n// Scenario InvalidRegex is expected to surface SyntaxError.\n",
    stderrOutput:
      'src/regex-engine.test.ts:\n6 |   const matcher = new RegExp(namePattern)\n                              ^\nSyntaxError: Invalid regular expression: /[/: Unterminated character class\n    at handleRegexEngine1 (/tmp/octonoesis-demo/src/regex-engine.ts:6:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/regex-engine.test.ts:4:12)\n(fail) InvalidRegex > InvalidRegex_A1 reproduces fixture failure [0.10ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/regex-engine.ts',
      expression: 'new RegExp(namePattern)',
    },
    fix: {
      old: 'const matcher = new RegExp(namePattern)',
      new: 'const matcher = new RegExp(escapeRegex(namePattern))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/regex-engine.test.ts:\n(pass) InvalidRegex > InvalidRegex_A1 passes after fixture fix [0.11ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'InvalidRegex_A2',
    scenarioType: 'InvalidRegex',
    errorClass: 'SyntaxError',
    file: 'src/regex-engine.ts',
    expression: 'new RegExp(emailPattern)',
    sourceContent:
      "function escapeRegex(value: string): string {\n  return value.split('').map((char) => '^.*+?()[]{}|'.includes(char) ? '\\\\' + char : char).join('')\n}\n\nexport function handleRegexEngine2(emailPattern: string, input: string): boolean {\n  const matcher = new RegExp(emailPattern)\n  return matcher.test(input)\n}\n// Fixture InvalidRegex_A2 keeps the Phase 19 source file at realistic size.\n// Scenario InvalidRegex is expected to surface SyntaxError.\n",
    stderrOutput:
      'src/regex-engine.test.ts:\n7 |   const matcher = new RegExp(emailPattern)\n                              ^\nSyntaxError: Invalid regular expression: /[/: Unterminated character class\n    at handleRegexEngine2 (/tmp/octonoesis-demo/src/regex-engine.ts:7:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/regex-engine.test.ts:4:12)\n(fail) InvalidRegex > InvalidRegex_A2 reproduces fixture failure [0.11ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/regex-engine.ts',
      expression: 'new RegExp(emailPattern)',
    },
    fix: {
      old: 'const matcher = new RegExp(emailPattern)',
      new: 'const matcher = new RegExp(escapeRegex(emailPattern))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/regex-engine.test.ts:\n(pass) InvalidRegex > InvalidRegex_A2 passes after fixture fix [0.12ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'InvalidRegex_A3',
    scenarioType: 'InvalidRegex',
    errorClass: 'SyntaxError',
    file: 'src/regex-engine.ts',
    expression: 'new RegExp(pathPattern)',
    sourceContent:
      "function escapeRegex(value: string): string {\n  return value.split('').map((char) => '^.*+?()[]{}|'.includes(char) ? '\\\\' + char : char).join('')\n}\n\nexport function handleRegexEngine3(pathPattern: string, input: string): boolean {\n  const matcher = new RegExp(pathPattern)\n  return matcher.test(input)\n}\n// Fixture InvalidRegex_A3 keeps the Phase 19 source file at realistic size.\n// Scenario InvalidRegex is expected to surface SyntaxError.\n",
    stderrOutput:
      'src/regex-engine.test.ts:\n8 |   const matcher = new RegExp(pathPattern)\n                              ^\nSyntaxError: Invalid regular expression: /[/: Unterminated character class\n    at handleRegexEngine3 (/tmp/octonoesis-demo/src/regex-engine.ts:8:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/regex-engine.test.ts:4:12)\n(fail) InvalidRegex > InvalidRegex_A3 reproduces fixture failure [0.12ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/regex-engine.ts',
      expression: 'new RegExp(pathPattern)',
    },
    fix: {
      old: 'const matcher = new RegExp(pathPattern)',
      new: 'const matcher = new RegExp(escapeRegex(pathPattern))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/regex-engine.test.ts:\n(pass) InvalidRegex > InvalidRegex_A3 passes after fixture fix [0.13ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'InvalidRegex_B1',
    scenarioType: 'InvalidRegex',
    errorClass: 'SyntaxError',
    file: 'src/pattern.ts',
    expression: 'new RegExp(tokenPattern)',
    sourceContent:
      "function escapeRegex(value: string): string {\n  return value.split('').map((char) => '^.*+?()[]{}|'.includes(char) ? '\\\\' + char : char).join('')\n}\n\nexport function handlePattern4(tokenPattern: string, input: string): boolean {\n  const matcher = new RegExp(tokenPattern)\n  return matcher.test(input)\n}\n// Fixture InvalidRegex_B1 keeps the Phase 19 source file at realistic size.\n// Scenario InvalidRegex is expected to surface SyntaxError.\n",
    stderrOutput:
      'src/pattern.test.ts:\n9 |   const matcher = new RegExp(tokenPattern)\n                              ^\nSyntaxError: Invalid regular expression: /[/: Unterminated character class\n    at handlePattern4 (/tmp/octonoesis-demo/src/pattern.ts:9:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/pattern.test.ts:4:12)\n(fail) InvalidRegex > InvalidRegex_B1 reproduces fixture failure [0.13ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/pattern.ts',
      expression: 'new RegExp(tokenPattern)',
    },
    fix: {
      old: 'const matcher = new RegExp(tokenPattern)',
      new: 'const matcher = new RegExp(escapeRegex(tokenPattern))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/pattern.test.ts:\n(pass) InvalidRegex > InvalidRegex_B1 passes after fixture fix [0.14ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'InvalidRegex_B2',
    scenarioType: 'InvalidRegex',
    errorClass: 'SyntaxError',
    file: 'src/pattern.ts',
    expression: 'new RegExp(queryPattern)',
    sourceContent:
      "function escapeRegex(value: string): string {\n  return value.split('').map((char) => '^.*+?()[]{}|'.includes(char) ? '\\\\' + char : char).join('')\n}\n\nexport function handlePattern5(queryPattern: string, input: string): boolean {\n  const matcher = new RegExp(queryPattern)\n  return matcher.test(input)\n}\n// Fixture InvalidRegex_B2 keeps the Phase 19 source file at realistic size.\n// Scenario InvalidRegex is expected to surface SyntaxError.\n",
    stderrOutput:
      'src/pattern.test.ts:\n10 |   const matcher = new RegExp(queryPattern)\n                              ^\nSyntaxError: Invalid regular expression: /[/: Unterminated character class\n    at handlePattern5 (/tmp/octonoesis-demo/src/pattern.ts:10:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/pattern.test.ts:4:12)\n(fail) InvalidRegex > InvalidRegex_B2 reproduces fixture failure [0.14ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/pattern.ts',
      expression: 'new RegExp(queryPattern)',
    },
    fix: {
      old: 'const matcher = new RegExp(queryPattern)',
      new: 'const matcher = new RegExp(escapeRegex(queryPattern))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/pattern.test.ts:\n(pass) InvalidRegex > InvalidRegex_B2 passes after fixture fix [0.15ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'InvalidRegex_B3',
    scenarioType: 'InvalidRegex',
    errorClass: 'SyntaxError',
    file: 'src/pattern.ts',
    expression: 'new RegExp(searchPattern)',
    sourceContent:
      "function escapeRegex(value: string): string {\n  return value.split('').map((char) => '^.*+?()[]{}|'.includes(char) ? '\\\\' + char : char).join('')\n}\n\nexport function handlePattern6(searchPattern: string, input: string): boolean {\n  const matcher = new RegExp(searchPattern)\n  return matcher.test(input)\n}\n// Fixture InvalidRegex_B3 keeps the Phase 19 source file at realistic size.\n// Scenario InvalidRegex is expected to surface SyntaxError.\n",
    stderrOutput:
      'src/pattern.test.ts:\n11 |   const matcher = new RegExp(searchPattern)\n                              ^\nSyntaxError: Invalid regular expression: /[/: Unterminated character class\n    at handlePattern6 (/tmp/octonoesis-demo/src/pattern.ts:11:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/pattern.test.ts:4:12)\n(fail) InvalidRegex > InvalidRegex_B3 reproduces fixture failure [0.15ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/pattern.ts',
      expression: 'new RegExp(searchPattern)',
    },
    fix: {
      old: 'const matcher = new RegExp(searchPattern)',
      new: 'const matcher = new RegExp(escapeRegex(searchPattern))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/pattern.test.ts:\n(pass) InvalidRegex > InvalidRegex_B3 passes after fixture fix [0.16ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'InvalidRegex_C1',
    scenarioType: 'InvalidRegex',
    errorClass: 'SyntaxError',
    file: 'src/search.ts',
    expression: 'new RegExp(searchFilter)',
    sourceContent:
      "function escapeRegex(value: string): string {\n  return value.split('').map((char) => '^.*+?()[]{}|'.includes(char) ? '\\\\' + char : char).join('')\n}\n\nexport function handleSearch7(searchFilter: string, input: string): boolean {\n  const matcher = new RegExp(searchFilter)\n  return matcher.test(input)\n}\n// Fixture InvalidRegex_C1 keeps the Phase 19 source file at realistic size.\n// Scenario InvalidRegex is expected to surface SyntaxError.\n",
    stderrOutput:
      'src/search.test.ts:\n12 |   const matcher = new RegExp(searchFilter)\n                              ^\nSyntaxError: Invalid regular expression: /[/: Unterminated character class\n    at handleSearch7 (/tmp/octonoesis-demo/src/search.ts:12:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/search.test.ts:4:12)\n(fail) InvalidRegex > InvalidRegex_C1 reproduces fixture failure [0.16ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/search.ts',
      expression: 'new RegExp(searchFilter)',
    },
    fix: {
      old: 'const matcher = new RegExp(searchFilter)',
      new: 'const matcher = new RegExp(escapeRegex(searchFilter))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/search.test.ts:\n(pass) InvalidRegex > InvalidRegex_C1 passes after fixture fix [0.17ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'InvalidRegex_C2',
    scenarioType: 'InvalidRegex',
    errorClass: 'SyntaxError',
    file: 'src/search.ts',
    expression: 'new RegExp(filterPattern)',
    sourceContent:
      "function escapeRegex(value: string): string {\n  return value.split('').map((char) => '^.*+?()[]{}|'.includes(char) ? '\\\\' + char : char).join('')\n}\n\nexport function handleSearch8(filterPattern: string, input: string): boolean {\n  const matcher = new RegExp(filterPattern)\n  return matcher.test(input)\n}\n// Fixture InvalidRegex_C2 keeps the Phase 19 source file at realistic size.\n// Scenario InvalidRegex is expected to surface SyntaxError.\n",
    stderrOutput:
      'src/search.test.ts:\n13 |   const matcher = new RegExp(filterPattern)\n                              ^\nSyntaxError: Invalid regular expression: /[/: Unterminated character class\n    at handleSearch8 (/tmp/octonoesis-demo/src/search.ts:13:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/search.test.ts:4:12)\n(fail) InvalidRegex > InvalidRegex_C2 reproduces fixture failure [0.17ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/search.ts',
      expression: 'new RegExp(filterPattern)',
    },
    fix: {
      old: 'const matcher = new RegExp(filterPattern)',
      new: 'const matcher = new RegExp(escapeRegex(filterPattern))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/search.test.ts:\n(pass) InvalidRegex > InvalidRegex_C2 passes after fixture fix [0.18ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'InvalidRegex_D1',
    scenarioType: 'InvalidRegex',
    errorClass: 'SyntaxError',
    file: 'src/filter.ts',
    expression: 'new RegExp(matcherGlob)',
    sourceContent:
      "function escapeRegex(value: string): string {\n  return value.split('').map((char) => '^.*+?()[]{}|'.includes(char) ? '\\\\' + char : char).join('')\n}\n\nexport function handleFilter9(matcherGlob: string, input: string): boolean {\n  const matcher = new RegExp(matcherGlob)\n  return matcher.test(input)\n}\n// Fixture InvalidRegex_D1 keeps the Phase 19 source file at realistic size.\n// Scenario InvalidRegex is expected to surface SyntaxError.\n",
    stderrOutput:
      'src/filter.test.ts:\n14 |   const matcher = new RegExp(matcherGlob)\n                              ^\nSyntaxError: Invalid regular expression: /[/: Unterminated character class\n    at handleFilter9 (/tmp/octonoesis-demo/src/filter.ts:14:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/filter.test.ts:4:12)\n(fail) InvalidRegex > InvalidRegex_D1 reproduces fixture failure [0.18ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/filter.ts',
      expression: 'new RegExp(matcherGlob)',
    },
    fix: {
      old: 'const matcher = new RegExp(matcherGlob)',
      new: 'const matcher = new RegExp(escapeRegex(matcherGlob))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/filter.test.ts:\n(pass) InvalidRegex > InvalidRegex_D1 passes after fixture fix [0.19ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'InvalidRegex_E1',
    scenarioType: 'InvalidRegex',
    errorClass: 'SyntaxError',
    file: 'src/matcher.ts',
    expression: 'new RegExp(matcherToken)',
    sourceContent:
      "function escapeRegex(value: string): string {\n  return value.split('').map((char) => '^.*+?()[]{}|'.includes(char) ? '\\\\' + char : char).join('')\n}\n\nexport function handleMatcher10(matcherToken: string, input: string): boolean {\n  const matcher = new RegExp(matcherToken)\n  return matcher.test(input)\n}\n// Fixture InvalidRegex_E1 keeps the Phase 19 source file at realistic size.\n// Scenario InvalidRegex is expected to surface SyntaxError.\n",
    stderrOutput:
      'src/matcher.test.ts:\n15 |   const matcher = new RegExp(matcherToken)\n                              ^\nSyntaxError: Invalid regular expression: /[/: Unterminated character class\n    at handleMatcher10 (/tmp/octonoesis-demo/src/matcher.ts:15:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/matcher.test.ts:4:12)\n(fail) InvalidRegex > InvalidRegex_E1 reproduces fixture failure [0.19ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'SyntaxError',
      file: 'src/matcher.ts',
      expression: 'new RegExp(matcherToken)',
    },
    fix: {
      old: 'const matcher = new RegExp(matcherToken)',
      new: 'const matcher = new RegExp(escapeRegex(matcherToken))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/matcher.test.ts:\n(pass) InvalidRegex > InvalidRegex_E1 passes after fixture fix [0.20ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'UndefinedRef_A1',
    scenarioType: 'UndefinedRef',
    errorClass: 'ReferenceError',
    file: 'src/scope.ts',
    expression: "reading 'currentUserId'",
    sourceContent:
      "type Context = Record<string, string>\n\nexport function handleScope1(scopeValue: string, context: Context): string {\n  return currentUserId + ':' + scopeValue\n}\n\nexport function renderhandleScope1(value: string, context: Context): string {\n  return handleScope1(value, context).trim()\n}\n// Fixture UndefinedRef_A1 keeps the Phase 19 source file at realistic size.\n",
    stderrOutput:
      "src/scope.test.ts:\n6 |   return currentUserId + ':' + scopeValue\n                              ^\nReferenceError: currentUserId is not defined\n    at handleScope1 (/tmp/octonoesis-demo/src/scope.ts:6:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/scope.test.ts:4:12)\n(fail) UndefinedRef > UndefinedRef_A1 reproduces fixture failure [0.10ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ReferenceError',
      file: 'src/scope.ts',
      expression: "reading 'currentUserId'",
    },
    fix: {
      old: "return currentUserId + ':' + scopeValue",
      new: "return context.currentUserId + ':' + scopeValue",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/scope.test.ts:\n(pass) UndefinedRef > UndefinedRef_A1 passes after fixture fix [0.11ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'UndefinedRef_A2',
    scenarioType: 'UndefinedRef',
    errorClass: 'ReferenceError',
    file: 'src/scope.ts',
    expression: "reading 'activeScopeName'",
    sourceContent:
      "type Context = Record<string, string>\n\nexport function handleScope2(scopeLabel: string, context: Context): string {\n  return activeScopeName + ':' + scopeLabel\n}\n\nexport function renderhandleScope2(value: string, context: Context): string {\n  return handleScope2(value, context).trim()\n}\n// Fixture UndefinedRef_A2 keeps the Phase 19 source file at realistic size.\n",
    stderrOutput:
      "src/scope.test.ts:\n7 |   return activeScopeName + ':' + scopeLabel\n                              ^\nReferenceError: activeScopeName is not defined\n    at handleScope2 (/tmp/octonoesis-demo/src/scope.ts:7:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/scope.test.ts:4:12)\n(fail) UndefinedRef > UndefinedRef_A2 reproduces fixture failure [0.11ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ReferenceError',
      file: 'src/scope.ts',
      expression: "reading 'activeScopeName'",
    },
    fix: {
      old: "return activeScopeName + ':' + scopeLabel",
      new: "return context.activeScopeName + ':' + scopeLabel",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/scope.test.ts:\n(pass) UndefinedRef > UndefinedRef_A2 passes after fixture fix [0.12ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'UndefinedRef_A3',
    scenarioType: 'UndefinedRef',
    errorClass: 'ReferenceError',
    file: 'src/scope.ts',
    expression: "reading 'requestTraceId'",
    sourceContent:
      "type Context = Record<string, string>\n\nexport function handleScope3(contextValue: string, context: Context): string {\n  return requestTraceId + ':' + contextValue\n}\n\nexport function renderhandleScope3(value: string, context: Context): string {\n  return handleScope3(value, context).trim()\n}\n// Fixture UndefinedRef_A3 keeps the Phase 19 source file at realistic size.\n",
    stderrOutput:
      "src/scope.test.ts:\n8 |   return requestTraceId + ':' + contextValue\n                              ^\nReferenceError: requestTraceId is not defined\n    at handleScope3 (/tmp/octonoesis-demo/src/scope.ts:8:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/scope.test.ts:4:12)\n(fail) UndefinedRef > UndefinedRef_A3 reproduces fixture failure [0.12ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ReferenceError',
      file: 'src/scope.ts',
      expression: "reading 'requestTraceId'",
    },
    fix: {
      old: "return requestTraceId + ':' + contextValue",
      new: "return context.requestTraceId + ':' + contextValue",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/scope.test.ts:\n(pass) UndefinedRef > UndefinedRef_A3 passes after fixture fix [0.13ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'UndefinedRef_B1',
    scenarioType: 'UndefinedRef',
    errorClass: 'ReferenceError',
    file: 'src/context.ts',
    expression: "reading 'sessionRoleName'",
    sourceContent:
      "type Context = Record<string, string>\n\nexport function handleContext4(contextRole: string, context: Context): string {\n  return sessionRoleName + ':' + contextRole\n}\n\nexport function renderhandleContext4(value: string, context: Context): string {\n  return handleContext4(value, context).trim()\n}\n// Fixture UndefinedRef_B1 keeps the Phase 19 source file at realistic size.\n",
    stderrOutput:
      "src/context.test.ts:\n9 |   return sessionRoleName + ':' + contextRole\n                              ^\nReferenceError: sessionRoleName is not defined\n    at handleContext4 (/tmp/octonoesis-demo/src/context.ts:9:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/context.test.ts:4:12)\n(fail) UndefinedRef > UndefinedRef_B1 reproduces fixture failure [0.13ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ReferenceError',
      file: 'src/context.ts',
      expression: "reading 'sessionRoleName'",
    },
    fix: {
      old: "return sessionRoleName + ':' + contextRole",
      new: "return context.sessionRoleName + ':' + contextRole",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/context.test.ts:\n(pass) UndefinedRef > UndefinedRef_B1 passes after fixture fix [0.14ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'UndefinedRef_B2',
    scenarioType: 'UndefinedRef',
    errorClass: 'ReferenceError',
    file: 'src/context.ts',
    expression: "reading 'tenantRegion'",
    sourceContent:
      "type Context = Record<string, string>\n\nexport function handleContext5(contextTenant: string, context: Context): string {\n  return tenantRegion + ':' + contextTenant\n}\n\nexport function renderhandleContext5(value: string, context: Context): string {\n  return handleContext5(value, context).trim()\n}\n// Fixture UndefinedRef_B2 keeps the Phase 19 source file at realistic size.\n",
    stderrOutput:
      "src/context.test.ts:\n10 |   return tenantRegion + ':' + contextTenant\n                              ^\nReferenceError: tenantRegion is not defined\n    at handleContext5 (/tmp/octonoesis-demo/src/context.ts:10:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/context.test.ts:4:12)\n(fail) UndefinedRef > UndefinedRef_B2 reproduces fixture failure [0.14ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ReferenceError',
      file: 'src/context.ts',
      expression: "reading 'tenantRegion'",
    },
    fix: {
      old: "return tenantRegion + ':' + contextTenant",
      new: "return context.tenantRegion + ':' + contextTenant",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/context.test.ts:\n(pass) UndefinedRef > UndefinedRef_B2 passes after fixture fix [0.15ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'UndefinedRef_B3',
    scenarioType: 'UndefinedRef',
    errorClass: 'ReferenceError',
    file: 'src/context.ts',
    expression: "reading 'resolvedModuleName'",
    sourceContent:
      "type Context = Record<string, string>\n\nexport function handleContext6(resolverTarget: string, context: Context): string {\n  return resolvedModuleName + ':' + resolverTarget\n}\n\nexport function renderhandleContext6(value: string, context: Context): string {\n  return handleContext6(value, context).trim()\n}\n// Fixture UndefinedRef_B3 keeps the Phase 19 source file at realistic size.\n",
    stderrOutput:
      "src/context.test.ts:\n11 |   return resolvedModuleName + ':' + resolverTarget\n                              ^\nReferenceError: resolvedModuleName is not defined\n    at handleContext6 (/tmp/octonoesis-demo/src/context.ts:11:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/context.test.ts:4:12)\n(fail) UndefinedRef > UndefinedRef_B3 reproduces fixture failure [0.15ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ReferenceError',
      file: 'src/context.ts',
      expression: "reading 'resolvedModuleName'",
    },
    fix: {
      old: "return resolvedModuleName + ':' + resolverTarget",
      new: "return context.resolvedModuleName + ':' + resolverTarget",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/context.test.ts:\n(pass) UndefinedRef > UndefinedRef_B3 passes after fixture fix [0.16ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'UndefinedRef_C1',
    scenarioType: 'UndefinedRef',
    errorClass: 'ReferenceError',
    file: 'src/resolver.ts',
    expression: "reading 'entryAlias'",
    sourceContent:
      "type Context = Record<string, string>\n\nexport function handleResolver7(resolverEntry: string, context: Context): string {\n  return entryAlias + ':' + resolverEntry\n}\n\nexport function renderhandleResolver7(value: string, context: Context): string {\n  return handleResolver7(value, context).trim()\n}\n// Fixture UndefinedRef_C1 keeps the Phase 19 source file at realistic size.\n",
    stderrOutput:
      "src/resolver.test.ts:\n12 |   return entryAlias + ':' + resolverEntry\n                              ^\nReferenceError: entryAlias is not defined\n    at handleResolver7 (/tmp/octonoesis-demo/src/resolver.ts:12:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/resolver.test.ts:4:12)\n(fail) UndefinedRef > UndefinedRef_C1 reproduces fixture failure [0.16ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ReferenceError',
      file: 'src/resolver.ts',
      expression: "reading 'entryAlias'",
    },
    fix: {
      old: "return entryAlias + ':' + resolverEntry",
      new: "return context.entryAlias + ':' + resolverEntry",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/resolver.test.ts:\n(pass) UndefinedRef > UndefinedRef_C1 passes after fixture fix [0.17ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'UndefinedRef_C2',
    scenarioType: 'UndefinedRef',
    errorClass: 'ReferenceError',
    file: 'src/resolver.ts',
    expression: "reading 'boundServiceName'",
    sourceContent:
      "type Context = Record<string, string>\n\nexport function handleResolver8(bindingName: string, context: Context): string {\n  return boundServiceName + ':' + bindingName\n}\n\nexport function renderhandleResolver8(value: string, context: Context): string {\n  return handleResolver8(value, context).trim()\n}\n// Fixture UndefinedRef_C2 keeps the Phase 19 source file at realistic size.\n",
    stderrOutput:
      "src/resolver.test.ts:\n13 |   return boundServiceName + ':' + bindingName\n                              ^\nReferenceError: boundServiceName is not defined\n    at handleResolver8 (/tmp/octonoesis-demo/src/resolver.ts:13:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/resolver.test.ts:4:12)\n(fail) UndefinedRef > UndefinedRef_C2 reproduces fixture failure [0.17ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ReferenceError',
      file: 'src/resolver.ts',
      expression: "reading 'boundServiceName'",
    },
    fix: {
      old: "return boundServiceName + ':' + bindingName",
      new: "return context.boundServiceName + ':' + bindingName",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/resolver.test.ts:\n(pass) UndefinedRef > UndefinedRef_C2 passes after fixture fix [0.18ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'UndefinedRef_D1',
    scenarioType: 'UndefinedRef',
    errorClass: 'ReferenceError',
    file: 'src/binding.ts',
    expression: "reading 'injectedSecretToken'",
    sourceContent:
      "type Context = Record<string, string>\n\nexport function handleBinding9(injectorToken: string, context: Context): string {\n  return injectedSecretToken + ':' + injectorToken\n}\n\nexport function renderhandleBinding9(value: string, context: Context): string {\n  return handleBinding9(value, context).trim()\n}\n// Fixture UndefinedRef_D1 keeps the Phase 19 source file at realistic size.\n",
    stderrOutput:
      "src/binding.test.ts:\n14 |   return injectedSecretToken + ':' + injectorToken\n                              ^\nReferenceError: injectedSecretToken is not defined\n    at handleBinding9 (/tmp/octonoesis-demo/src/binding.ts:14:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/binding.test.ts:4:12)\n(fail) UndefinedRef > UndefinedRef_D1 reproduces fixture failure [0.18ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ReferenceError',
      file: 'src/binding.ts',
      expression: "reading 'injectedSecretToken'",
    },
    fix: {
      old: "return injectedSecretToken + ':' + injectorToken",
      new: "return context.injectedSecretToken + ':' + injectorToken",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/binding.test.ts:\n(pass) UndefinedRef > UndefinedRef_D1 passes after fixture fix [0.19ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'UndefinedRef_E1',
    scenarioType: 'UndefinedRef',
    errorClass: 'ReferenceError',
    file: 'src/injector.ts',
    expression: "reading 'dependencyPath'",
    sourceContent:
      "type Context = Record<string, string>\n\nexport function handleInjector10(injectorPath: string, context: Context): string {\n  return dependencyPath + ':' + injectorPath\n}\n\nexport function renderhandleInjector10(value: string, context: Context): string {\n  return handleInjector10(value, context).trim()\n}\n// Fixture UndefinedRef_E1 keeps the Phase 19 source file at realistic size.\n",
    stderrOutput:
      "src/injector.test.ts:\n15 |   return dependencyPath + ':' + injectorPath\n                              ^\nReferenceError: dependencyPath is not defined\n    at handleInjector10 (/tmp/octonoesis-demo/src/injector.ts:15:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/injector.test.ts:4:12)\n(fail) UndefinedRef > UndefinedRef_E1 reproduces fixture failure [0.19ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ReferenceError',
      file: 'src/injector.ts',
      expression: "reading 'dependencyPath'",
    },
    fix: {
      old: "return dependencyPath + ':' + injectorPath",
      new: "return context.dependencyPath + ':' + injectorPath",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/injector.test.ts:\n(pass) UndefinedRef > UndefinedRef_E1 passes after fixture fix [0.20ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'OutOfBounds_A1',
    scenarioType: 'OutOfBounds',
    errorClass: 'RangeError',
    file: 'src/buffer.ts',
    expression: 'allocating bufferSize - headerOffset',
    sourceContent:
      'export function handleBuffer1(bufferSize: number, headerOffset: number): unknown[] {\n  const window = new Array(bufferSize - headerOffset)\n  window.fill(null)\n  return window\n}\n\nexport function counthandleBuffer1(bufferSize: number, headerOffset: number): number {\n  return handleBuffer1(bufferSize, headerOffset).length\n}\n// Fixture OutOfBounds_A1 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/buffer.test.ts:\n6 |   const window = new Array(bufferSize - headerOffset)\n                              ^\nRangeError: Invalid array length\n    at handleBuffer1 (/tmp/octonoesis-demo/src/buffer.ts:6:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/buffer.test.ts:4:12)\n(fail) OutOfBounds > OutOfBounds_A1 reproduces fixture failure [0.10ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'RangeError',
      file: 'src/buffer.ts',
      expression: 'allocating bufferSize - headerOffset',
    },
    fix: {
      old: 'const window = new Array(bufferSize - headerOffset)',
      new: 'const window = new Array(Math.max(0, bufferSize - headerOffset))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/buffer.test.ts:\n(pass) OutOfBounds > OutOfBounds_A1 passes after fixture fix [0.11ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'OutOfBounds_A2',
    scenarioType: 'OutOfBounds',
    errorClass: 'RangeError',
    file: 'src/buffer.ts',
    expression: 'allocating bufferLimit - tailOffset',
    sourceContent:
      'export function handleBuffer2(bufferLimit: number, tailOffset: number): unknown[] {\n  const window = new Array(bufferLimit - tailOffset)\n  window.fill(null)\n  return window\n}\n\nexport function counthandleBuffer2(bufferLimit: number, tailOffset: number): number {\n  return handleBuffer2(bufferLimit, tailOffset).length\n}\n// Fixture OutOfBounds_A2 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/buffer.test.ts:\n7 |   const window = new Array(bufferLimit - tailOffset)\n                              ^\nRangeError: Invalid array length\n    at handleBuffer2 (/tmp/octonoesis-demo/src/buffer.ts:7:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/buffer.test.ts:4:12)\n(fail) OutOfBounds > OutOfBounds_A2 reproduces fixture failure [0.11ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'RangeError',
      file: 'src/buffer.ts',
      expression: 'allocating bufferLimit - tailOffset',
    },
    fix: {
      old: 'const window = new Array(bufferLimit - tailOffset)',
      new: 'const window = new Array(Math.max(0, bufferLimit - tailOffset))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/buffer.test.ts:\n(pass) OutOfBounds > OutOfBounds_A2 passes after fixture fix [0.12ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'OutOfBounds_A3',
    scenarioType: 'OutOfBounds',
    errorClass: 'RangeError',
    file: 'src/buffer.ts',
    expression: 'allocating pageSize - pageOffset',
    sourceContent:
      'export function handleBuffer3(pageSize: number, pageOffset: number): unknown[] {\n  const window = new Array(pageSize - pageOffset)\n  window.fill(null)\n  return window\n}\n\nexport function counthandleBuffer3(pageSize: number, pageOffset: number): number {\n  return handleBuffer3(pageSize, pageOffset).length\n}\n// Fixture OutOfBounds_A3 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/buffer.test.ts:\n8 |   const window = new Array(pageSize - pageOffset)\n                              ^\nRangeError: Invalid array length\n    at handleBuffer3 (/tmp/octonoesis-demo/src/buffer.ts:8:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/buffer.test.ts:4:12)\n(fail) OutOfBounds > OutOfBounds_A3 reproduces fixture failure [0.12ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'RangeError',
      file: 'src/buffer.ts',
      expression: 'allocating pageSize - pageOffset',
    },
    fix: {
      old: 'const window = new Array(pageSize - pageOffset)',
      new: 'const window = new Array(Math.max(0, pageSize - pageOffset))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/buffer.test.ts:\n(pass) OutOfBounds > OutOfBounds_A3 passes after fixture fix [0.13ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'OutOfBounds_B1',
    scenarioType: 'OutOfBounds',
    errorClass: 'RangeError',
    file: 'src/paginator.ts',
    expression: 'allocating pageEnd - pageStart',
    sourceContent:
      'export function handlePaginator4(pageEnd: number, pageStart: number): unknown[] {\n  const window = new Array(pageEnd - pageStart)\n  window.fill(null)\n  return window\n}\n\nexport function counthandlePaginator4(pageEnd: number, pageStart: number): number {\n  return handlePaginator4(pageEnd, pageStart).length\n}\n// Fixture OutOfBounds_B1 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/paginator.test.ts:\n9 |   const window = new Array(pageEnd - pageStart)\n                              ^\nRangeError: Invalid array length\n    at handlePaginator4 (/tmp/octonoesis-demo/src/paginator.ts:9:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/paginator.test.ts:4:12)\n(fail) OutOfBounds > OutOfBounds_B1 reproduces fixture failure [0.13ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'RangeError',
      file: 'src/paginator.ts',
      expression: 'allocating pageEnd - pageStart',
    },
    fix: {
      old: 'const window = new Array(pageEnd - pageStart)',
      new: 'const window = new Array(Math.max(0, pageEnd - pageStart))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/paginator.test.ts:\n(pass) OutOfBounds > OutOfBounds_B1 passes after fixture fix [0.14ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'OutOfBounds_B2',
    scenarioType: 'OutOfBounds',
    errorClass: 'RangeError',
    file: 'src/paginator.ts',
    expression: 'allocating pageWindow - cursorOffset',
    sourceContent:
      'export function handlePaginator5(pageWindow: number, cursorOffset: number): unknown[] {\n  const window = new Array(pageWindow - cursorOffset)\n  window.fill(null)\n  return window\n}\n\nexport function counthandlePaginator5(pageWindow: number, cursorOffset: number): number {\n  return handlePaginator5(pageWindow, cursorOffset).length\n}\n// Fixture OutOfBounds_B2 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/paginator.test.ts:\n10 |   const window = new Array(pageWindow - cursorOffset)\n                              ^\nRangeError: Invalid array length\n    at handlePaginator5 (/tmp/octonoesis-demo/src/paginator.ts:10:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/paginator.test.ts:4:12)\n(fail) OutOfBounds > OutOfBounds_B2 reproduces fixture failure [0.14ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'RangeError',
      file: 'src/paginator.ts',
      expression: 'allocating pageWindow - cursorOffset',
    },
    fix: {
      old: 'const window = new Array(pageWindow - cursorOffset)',
      new: 'const window = new Array(Math.max(0, pageWindow - cursorOffset))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/paginator.test.ts:\n(pass) OutOfBounds > OutOfBounds_B2 passes after fixture fix [0.15ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'OutOfBounds_B3',
    scenarioType: 'OutOfBounds',
    errorClass: 'RangeError',
    file: 'src/paginator.ts',
    expression: 'allocating sliceEnd - sliceStart',
    sourceContent:
      'export function handlePaginator6(sliceEnd: number, sliceStart: number): unknown[] {\n  const window = new Array(sliceEnd - sliceStart)\n  window.fill(null)\n  return window\n}\n\nexport function counthandlePaginator6(sliceEnd: number, sliceStart: number): number {\n  return handlePaginator6(sliceEnd, sliceStart).length\n}\n// Fixture OutOfBounds_B3 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/paginator.test.ts:\n11 |   const window = new Array(sliceEnd - sliceStart)\n                              ^\nRangeError: Invalid array length\n    at handlePaginator6 (/tmp/octonoesis-demo/src/paginator.ts:11:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/paginator.test.ts:4:12)\n(fail) OutOfBounds > OutOfBounds_B3 reproduces fixture failure [0.15ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'RangeError',
      file: 'src/paginator.ts',
      expression: 'allocating sliceEnd - sliceStart',
    },
    fix: {
      old: 'const window = new Array(sliceEnd - sliceStart)',
      new: 'const window = new Array(Math.max(0, sliceEnd - sliceStart))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/paginator.test.ts:\n(pass) OutOfBounds > OutOfBounds_B3 passes after fixture fix [0.16ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'OutOfBounds_C1',
    scenarioType: 'OutOfBounds',
    errorClass: 'RangeError',
    file: 'src/slicer.ts',
    expression: 'allocating sliceLimit - negativeOffset',
    sourceContent:
      'export function handleSlicer7(sliceLimit: number, negativeOffset: number): unknown[] {\n  const window = new Array(sliceLimit - negativeOffset)\n  window.fill(null)\n  return window\n}\n\nexport function counthandleSlicer7(sliceLimit: number, negativeOffset: number): number {\n  return handleSlicer7(sliceLimit, negativeOffset).length\n}\n// Fixture OutOfBounds_C1 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/slicer.test.ts:\n12 |   const window = new Array(sliceLimit - negativeOffset)\n                              ^\nRangeError: Invalid array length\n    at handleSlicer7 (/tmp/octonoesis-demo/src/slicer.ts:12:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/slicer.test.ts:4:12)\n(fail) OutOfBounds > OutOfBounds_C1 reproduces fixture failure [0.16ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'RangeError',
      file: 'src/slicer.ts',
      expression: 'allocating sliceLimit - negativeOffset',
    },
    fix: {
      old: 'const window = new Array(sliceLimit - negativeOffset)',
      new: 'const window = new Array(Math.max(0, sliceLimit - negativeOffset))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/slicer.test.ts:\n(pass) OutOfBounds > OutOfBounds_C1 passes after fixture fix [0.17ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'OutOfBounds_C2',
    scenarioType: 'OutOfBounds',
    errorClass: 'RangeError',
    file: 'src/slicer.ts',
    expression: 'allocating chunkSize - overlap',
    sourceContent:
      'export function handleSlicer8(chunkSize: number, overlap: number): unknown[] {\n  const window = new Array(chunkSize - overlap)\n  window.fill(null)\n  return window\n}\n\nexport function counthandleSlicer8(chunkSize: number, overlap: number): number {\n  return handleSlicer8(chunkSize, overlap).length\n}\n// Fixture OutOfBounds_C2 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/slicer.test.ts:\n13 |   const window = new Array(chunkSize - overlap)\n                              ^\nRangeError: Invalid array length\n    at handleSlicer8 (/tmp/octonoesis-demo/src/slicer.ts:13:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/slicer.test.ts:4:12)\n(fail) OutOfBounds > OutOfBounds_C2 reproduces fixture failure [0.17ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'RangeError',
      file: 'src/slicer.ts',
      expression: 'allocating chunkSize - overlap',
    },
    fix: {
      old: 'const window = new Array(chunkSize - overlap)',
      new: 'const window = new Array(Math.max(0, chunkSize - overlap))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/slicer.test.ts:\n(pass) OutOfBounds > OutOfBounds_C2 passes after fixture fix [0.18ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'OutOfBounds_D1',
    scenarioType: 'OutOfBounds',
    errorClass: 'RangeError',
    file: 'src/chunker.ts',
    expression: 'allocating windowEnd - windowStart',
    sourceContent:
      'export function handleChunker9(windowEnd: number, windowStart: number): unknown[] {\n  const window = new Array(windowEnd - windowStart)\n  window.fill(null)\n  return window\n}\n\nexport function counthandleChunker9(windowEnd: number, windowStart: number): number {\n  return handleChunker9(windowEnd, windowStart).length\n}\n// Fixture OutOfBounds_D1 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/chunker.test.ts:\n14 |   const window = new Array(windowEnd - windowStart)\n                              ^\nRangeError: Invalid array length\n    at handleChunker9 (/tmp/octonoesis-demo/src/chunker.ts:14:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/chunker.test.ts:4:12)\n(fail) OutOfBounds > OutOfBounds_D1 reproduces fixture failure [0.18ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'RangeError',
      file: 'src/chunker.ts',
      expression: 'allocating windowEnd - windowStart',
    },
    fix: {
      old: 'const window = new Array(windowEnd - windowStart)',
      new: 'const window = new Array(Math.max(0, windowEnd - windowStart))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/chunker.test.ts:\n(pass) OutOfBounds > OutOfBounds_D1 passes after fixture fix [0.19ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'OutOfBounds_E1',
    scenarioType: 'OutOfBounds',
    errorClass: 'RangeError',
    file: 'src/window.ts',
    expression: 'allocating windowSize - padding',
    sourceContent:
      'export function handleWindow10(windowSize: number, padding: number): unknown[] {\n  const window = new Array(windowSize - padding)\n  window.fill(null)\n  return window\n}\n\nexport function counthandleWindow10(windowSize: number, padding: number): number {\n  return handleWindow10(windowSize, padding).length\n}\n// Fixture OutOfBounds_E1 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/window.test.ts:\n15 |   const window = new Array(windowSize - padding)\n                              ^\nRangeError: Invalid array length\n    at handleWindow10 (/tmp/octonoesis-demo/src/window.ts:15:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/window.test.ts:4:12)\n(fail) OutOfBounds > OutOfBounds_E1 reproduces fixture failure [0.19ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'RangeError',
      file: 'src/window.ts',
      expression: 'allocating windowSize - padding',
    },
    fix: {
      old: 'const window = new Array(windowSize - padding)',
      new: 'const window = new Array(Math.max(0, windowSize - padding))',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/window.test.ts:\n(pass) OutOfBounds > OutOfBounds_E1 passes after fixture fix [0.20ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ModuleNotFound_A2',
    scenarioType: 'ModuleNotFound',
    errorClass: 'ImportError',
    file: 'src/loader.ts',
    expression: "import './file-reader'",
    sourceContent:
      'import { load2 } from \'./file-reader\'\n\nexport function handleLoader2(): string {\n  return load2()\n}\n\nexport function describehandleLoader2(): string {\n  return "src/loader.ts"\n}\n// Fixture ModuleNotFound_A2 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/loader.test.ts:\n7 |   import { load2 } from \'./file-reader\'\n                              ^\nImportError: Could not resolve: "./file-reader"\n    at handleLoader2 (/tmp/octonoesis-demo/src/loader.ts:7:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/loader.test.ts:4:12)\n(fail) ModuleNotFound > ModuleNotFound_A2 reproduces fixture failure [0.11ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/loader.ts',
      expression: "import './file-reader'",
    },
    fix: {
      old: "import { load2 } from './file-reader'",
      new: "import { load2 } from './reader'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/loader.test.ts:\n(pass) ModuleNotFound > ModuleNotFound_A2 passes after fixture fix [0.12ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ModuleNotFound_A3',
    scenarioType: 'ModuleNotFound',
    errorClass: 'ImportError',
    file: 'src/loader.ts',
    expression: "import './env-reader'",
    sourceContent:
      'import { load3 } from \'./env-reader\'\n\nexport function handleLoader3(): string {\n  return load3()\n}\n\nexport function describehandleLoader3(): string {\n  return "src/loader.ts"\n}\n// Fixture ModuleNotFound_A3 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/loader.test.ts:\n8 |   import { load3 } from \'./env-reader\'\n                              ^\nImportError: Could not resolve: "./env-reader"\n    at handleLoader3 (/tmp/octonoesis-demo/src/loader.ts:8:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/loader.test.ts:4:12)\n(fail) ModuleNotFound > ModuleNotFound_A3 reproduces fixture failure [0.12ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/loader.ts',
      expression: "import './env-reader'",
    },
    fix: {
      old: "import { load3 } from './env-reader'",
      new: "import { load3 } from './env'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/loader.test.ts:\n(pass) ModuleNotFound > ModuleNotFound_A3 passes after fixture fix [0.13ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ModuleNotFound_B1',
    scenarioType: 'ModuleNotFound',
    errorClass: 'ImportError',
    file: 'src/plugin.ts',
    expression: "import './plugin-regsitry'",
    sourceContent:
      'import { load4 } from \'./plugin-regsitry\'\n\nexport function handlePlugin4(): string {\n  return load4()\n}\n\nexport function describehandlePlugin4(): string {\n  return "src/plugin.ts"\n}\n// Fixture ModuleNotFound_B1 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/plugin.test.ts:\n9 |   import { load4 } from \'./plugin-regsitry\'\n                              ^\nImportError: Could not resolve: "./plugin-regsitry"\n    at handlePlugin4 (/tmp/octonoesis-demo/src/plugin.ts:9:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/plugin.test.ts:4:12)\n(fail) ModuleNotFound > ModuleNotFound_B1 reproduces fixture failure [0.13ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/plugin.ts',
      expression: "import './plugin-regsitry'",
    },
    fix: {
      old: "import { load4 } from './plugin-regsitry'",
      new: "import { load4 } from './plugin-registry'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/plugin.test.ts:\n(pass) ModuleNotFound > ModuleNotFound_B1 passes after fixture fix [0.14ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ModuleNotFound_B2',
    scenarioType: 'ModuleNotFound',
    errorClass: 'ImportError',
    file: 'src/plugin.ts',
    expression: "import './hook-loder'",
    sourceContent:
      'import { load5 } from \'./hook-loder\'\n\nexport function handlePlugin5(): string {\n  return load5()\n}\n\nexport function describehandlePlugin5(): string {\n  return "src/plugin.ts"\n}\n// Fixture ModuleNotFound_B2 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/plugin.test.ts:\n10 |   import { load5 } from \'./hook-loder\'\n                              ^\nImportError: Could not resolve: "./hook-loder"\n    at handlePlugin5 (/tmp/octonoesis-demo/src/plugin.ts:10:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/plugin.test.ts:4:12)\n(fail) ModuleNotFound > ModuleNotFound_B2 reproduces fixture failure [0.14ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/plugin.ts',
      expression: "import './hook-loder'",
    },
    fix: {
      old: "import { load5 } from './hook-loder'",
      new: "import { load5 } from './hook-loader'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/plugin.test.ts:\n(pass) ModuleNotFound > ModuleNotFound_B2 passes after fixture fix [0.15ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ModuleNotFound_B3',
    scenarioType: 'ModuleNotFound',
    errorClass: 'ImportError',
    file: 'src/plugin.ts',
    expression: "import './plugin-manfiest'",
    sourceContent:
      'import { load6 } from \'./plugin-manfiest\'\n\nexport function handlePlugin6(): string {\n  return load6()\n}\n\nexport function describehandlePlugin6(): string {\n  return "src/plugin.ts"\n}\n// Fixture ModuleNotFound_B3 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/plugin.test.ts:\n11 |   import { load6 } from \'./plugin-manfiest\'\n                              ^\nImportError: Could not resolve: "./plugin-manfiest"\n    at handlePlugin6 (/tmp/octonoesis-demo/src/plugin.ts:11:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/plugin.test.ts:4:12)\n(fail) ModuleNotFound > ModuleNotFound_B3 reproduces fixture failure [0.15ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/plugin.ts',
      expression: "import './plugin-manfiest'",
    },
    fix: {
      old: "import { load6 } from './plugin-manfiest'",
      new: "import { load6 } from './plugin-manifest'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/plugin.test.ts:\n(pass) ModuleNotFound > ModuleNotFound_B3 passes after fixture fix [0.16ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ModuleNotFound_C1',
    scenarioType: 'ModuleNotFound',
    errorClass: 'ImportError',
    file: 'src/registry.ts',
    expression: "import './regsitry-store'",
    sourceContent:
      'import { load7 } from \'./regsitry-store\'\n\nexport function handleRegistry7(): string {\n  return load7()\n}\n\nexport function describehandleRegistry7(): string {\n  return "src/registry.ts"\n}\n// Fixture ModuleNotFound_C1 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/registry.test.ts:\n12 |   import { load7 } from \'./regsitry-store\'\n                              ^\nImportError: Could not resolve: "./regsitry-store"\n    at handleRegistry7 (/tmp/octonoesis-demo/src/registry.ts:12:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/registry.test.ts:4:12)\n(fail) ModuleNotFound > ModuleNotFound_C1 reproduces fixture failure [0.16ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/registry.ts',
      expression: "import './regsitry-store'",
    },
    fix: {
      old: "import { load7 } from './regsitry-store'",
      new: "import { load7 } from './registry-store'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/registry.test.ts:\n(pass) ModuleNotFound > ModuleNotFound_C1 passes after fixture fix [0.17ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ModuleNotFound_C2',
    scenarioType: 'ModuleNotFound',
    errorClass: 'ImportError',
    file: 'src/registry.ts',
    expression: "import './registry-adpater'",
    sourceContent:
      'import { load8 } from \'./registry-adpater\'\n\nexport function handleRegistry8(): string {\n  return load8()\n}\n\nexport function describehandleRegistry8(): string {\n  return "src/registry.ts"\n}\n// Fixture ModuleNotFound_C2 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/registry.test.ts:\n13 |   import { load8 } from \'./registry-adpater\'\n                              ^\nImportError: Could not resolve: "./registry-adpater"\n    at handleRegistry8 (/tmp/octonoesis-demo/src/registry.ts:13:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/registry.test.ts:4:12)\n(fail) ModuleNotFound > ModuleNotFound_C2 reproduces fixture failure [0.17ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/registry.ts',
      expression: "import './registry-adpater'",
    },
    fix: {
      old: "import { load8 } from './registry-adpater'",
      new: "import { load8 } from './registry-adapter'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/registry.test.ts:\n(pass) ModuleNotFound > ModuleNotFound_C2 passes after fixture fix [0.18ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ModuleNotFound_D1',
    scenarioType: 'ModuleNotFound',
    errorClass: 'ImportError',
    file: 'src/bootstrap.ts',
    expression: "import './bootstarp-env'",
    sourceContent:
      'import { load9 } from \'./bootstarp-env\'\n\nexport function handleBootstrap9(): string {\n  return load9()\n}\n\nexport function describehandleBootstrap9(): string {\n  return "src/bootstrap.ts"\n}\n// Fixture ModuleNotFound_D1 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/bootstrap.test.ts:\n14 |   import { load9 } from \'./bootstarp-env\'\n                              ^\nImportError: Could not resolve: "./bootstarp-env"\n    at handleBootstrap9 (/tmp/octonoesis-demo/src/bootstrap.ts:14:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/bootstrap.test.ts:4:12)\n(fail) ModuleNotFound > ModuleNotFound_D1 reproduces fixture failure [0.18ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/bootstrap.ts',
      expression: "import './bootstarp-env'",
    },
    fix: {
      old: "import { load9 } from './bootstarp-env'",
      new: "import { load9 } from './bootstrap-env'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/bootstrap.test.ts:\n(pass) ModuleNotFound > ModuleNotFound_D1 passes after fixture fix [0.19ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ModuleNotFound_E1',
    scenarioType: 'ModuleNotFound',
    errorClass: 'ImportError',
    file: 'src/init.ts',
    expression: "import './inti-config'",
    sourceContent:
      'import { load10 } from \'./inti-config\'\n\nexport function handleInit10(): string {\n  return load10()\n}\n\nexport function describehandleInit10(): string {\n  return "src/init.ts"\n}\n// Fixture ModuleNotFound_E1 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/init.test.ts:\n15 |   import { load10 } from \'./inti-config\'\n                              ^\nImportError: Could not resolve: "./inti-config"\n    at handleInit10 (/tmp/octonoesis-demo/src/init.ts:15:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/init.test.ts:4:12)\n(fail) ModuleNotFound > ModuleNotFound_E1 reproduces fixture failure [0.19ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/init.ts',
      expression: "import './inti-config'",
    },
    fix: {
      old: "import { load10 } from './inti-config'",
      new: "import { load10 } from './init-config'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/init.test.ts:\n(pass) ModuleNotFound > ModuleNotFound_E1 passes after fixture fix [0.20ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingExport_A1',
    scenarioType: 'MissingExport',
    errorClass: 'ImportError',
    file: 'src/re-export.ts',
    expression: "import named export 'createReExport'",
    sourceContent:
      'import { createReExport } from \'./exports\'\n\nexport function handleReExport1(): unknown {\n  return createReExport()\n}\n\nexport const source = "src/re-export.ts"\n// Fixture MissingExport_A1 keeps the Phase 19 source file at realistic size.\n// Scenario MissingExport is expected to surface ImportError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      "src/re-export.test.ts:\n6 |   import { createReExport } from './exports'\n                              ^\nImportError: export 'createReExport' not found in './exports'\n    at handleReExport1 (/tmp/octonoesis-demo/src/re-export.ts:6:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/re-export.test.ts:4:12)\n(fail) MissingExport > MissingExport_A1 reproduces fixture failure [0.10ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/re-export.ts',
      expression: "import named export 'createReExport'",
    },
    fix: {
      old: "import { createReExport } from './exports'",
      new: "import { createExport as createReExport } from './exports'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/re-export.test.ts:\n(pass) MissingExport > MissingExport_A1 passes after fixture fix [0.11ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingExport_A2',
    scenarioType: 'MissingExport',
    errorClass: 'ImportError',
    file: 'src/re-export.ts',
    expression: "import named export 'collectReExport'",
    sourceContent:
      'import { collectReExport } from \'./exports\'\n\nexport function handleReExport2(): unknown {\n  return collectReExport()\n}\n\nexport const source = "src/re-export.ts"\n// Fixture MissingExport_A2 keeps the Phase 19 source file at realistic size.\n// Scenario MissingExport is expected to surface ImportError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      "src/re-export.test.ts:\n7 |   import { collectReExport } from './exports'\n                              ^\nImportError: export 'collectReExport' not found in './exports'\n    at handleReExport2 (/tmp/octonoesis-demo/src/re-export.ts:7:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/re-export.test.ts:4:12)\n(fail) MissingExport > MissingExport_A2 reproduces fixture failure [0.11ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/re-export.ts',
      expression: "import named export 'collectReExport'",
    },
    fix: {
      old: "import { collectReExport } from './exports'",
      new: "import { collectExport as collectReExport } from './exports'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/re-export.test.ts:\n(pass) MissingExport > MissingExport_A2 passes after fixture fix [0.12ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingExport_A3',
    scenarioType: 'MissingExport',
    errorClass: 'ImportError',
    file: 'src/re-export.ts',
    expression: "import named export 'makeBarrel'",
    sourceContent:
      'import { makeBarrel } from \'./exports\'\n\nexport function handleReExport3(): unknown {\n  return makeBarrel()\n}\n\nexport const source = "src/re-export.ts"\n// Fixture MissingExport_A3 keeps the Phase 19 source file at realistic size.\n// Scenario MissingExport is expected to surface ImportError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      "src/re-export.test.ts:\n8 |   import { makeBarrel } from './exports'\n                              ^\nImportError: export 'makeBarrel' not found in './exports'\n    at handleReExport3 (/tmp/octonoesis-demo/src/re-export.ts:8:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/re-export.test.ts:4:12)\n(fail) MissingExport > MissingExport_A3 reproduces fixture failure [0.12ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/re-export.ts',
      expression: "import named export 'makeBarrel'",
    },
    fix: {
      old: "import { makeBarrel } from './exports'",
      new: "import { createBarrel as makeBarrel } from './exports'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/re-export.test.ts:\n(pass) MissingExport > MissingExport_A3 passes after fixture fix [0.13ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingExport_B1',
    scenarioType: 'MissingExport',
    errorClass: 'ImportError',
    file: 'src/barrel.ts',
    expression: "import named export 'barrelResolver'",
    sourceContent:
      'import { barrelResolver } from \'./exports\'\n\nexport function handleBarrel4(): unknown {\n  return barrelResolver()\n}\n\nexport const source = "src/barrel.ts"\n// Fixture MissingExport_B1 keeps the Phase 19 source file at realistic size.\n// Scenario MissingExport is expected to surface ImportError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      "src/barrel.test.ts:\n9 |   import { barrelResolver } from './exports'\n                              ^\nImportError: export 'barrelResolver' not found in './exports'\n    at handleBarrel4 (/tmp/octonoesis-demo/src/barrel.ts:9:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/barrel.test.ts:4:12)\n(fail) MissingExport > MissingExport_B1 reproduces fixture failure [0.13ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/barrel.ts',
      expression: "import named export 'barrelResolver'",
    },
    fix: {
      old: "import { barrelResolver } from './exports'",
      new: "import { resolveBarrel as barrelResolver } from './exports'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/barrel.test.ts:\n(pass) MissingExport > MissingExport_B1 passes after fixture fix [0.14ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingExport_B2',
    scenarioType: 'MissingExport',
    errorClass: 'ImportError',
    file: 'src/barrel.ts',
    expression: "import named export 'generateIndexFile'",
    sourceContent:
      'import { generateIndexFile } from \'./exports\'\n\nexport function handleBarrel5(): unknown {\n  return generateIndexFile()\n}\n\nexport const source = "src/barrel.ts"\n// Fixture MissingExport_B2 keeps the Phase 19 source file at realistic size.\n// Scenario MissingExport is expected to surface ImportError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      "src/barrel.test.ts:\n10 |   import { generateIndexFile } from './exports'\n                              ^\nImportError: export 'generateIndexFile' not found in './exports'\n    at handleBarrel5 (/tmp/octonoesis-demo/src/barrel.ts:10:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/barrel.test.ts:4:12)\n(fail) MissingExport > MissingExport_B2 reproduces fixture failure [0.14ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/barrel.ts',
      expression: "import named export 'generateIndexFile'",
    },
    fix: {
      old: "import { generateIndexFile } from './exports'",
      new: "import { generateIndex as generateIndexFile } from './exports'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/barrel.test.ts:\n(pass) MissingExport > MissingExport_B2 passes after fixture fix [0.15ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingExport_B3',
    scenarioType: 'MissingExport',
    errorClass: 'ImportError',
    file: 'src/barrel.ts',
    expression: "import named export 'indexManifest'",
    sourceContent:
      'import { indexManifest } from \'./exports\'\n\nexport function handleBarrel6(): unknown {\n  return indexManifest()\n}\n\nexport const source = "src/barrel.ts"\n// Fixture MissingExport_B3 keeps the Phase 19 source file at realistic size.\n// Scenario MissingExport is expected to surface ImportError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      "src/barrel.test.ts:\n11 |   import { indexManifest } from './exports'\n                              ^\nImportError: export 'indexManifest' not found in './exports'\n    at handleBarrel6 (/tmp/octonoesis-demo/src/barrel.ts:11:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/barrel.test.ts:4:12)\n(fail) MissingExport > MissingExport_B3 reproduces fixture failure [0.15ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/barrel.ts',
      expression: "import named export 'indexManifest'",
    },
    fix: {
      old: "import { indexManifest } from './exports'",
      new: "import { createManifest as indexManifest } from './exports'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/barrel.test.ts:\n(pass) MissingExport > MissingExport_B3 passes after fixture fix [0.16ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingExport_C1',
    scenarioType: 'MissingExport',
    errorClass: 'ImportError',
    file: 'src/index-gen.ts',
    expression: "import named export 'facadeBuilder'",
    sourceContent:
      'import { facadeBuilder } from \'./exports\'\n\nexport function handleIndexGen7(): unknown {\n  return facadeBuilder()\n}\n\nexport const source = "src/index-gen.ts"\n// Fixture MissingExport_C1 keeps the Phase 19 source file at realistic size.\n// Scenario MissingExport is expected to surface ImportError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      "src/index-gen.test.ts:\n12 |   import { facadeBuilder } from './exports'\n                              ^\nImportError: export 'facadeBuilder' not found in './exports'\n    at handleIndexGen7 (/tmp/octonoesis-demo/src/index-gen.ts:12:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/index-gen.test.ts:4:12)\n(fail) MissingExport > MissingExport_C1 reproduces fixture failure [0.16ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/index-gen.ts',
      expression: "import named export 'facadeBuilder'",
    },
    fix: {
      old: "import { facadeBuilder } from './exports'",
      new: "import { buildFacade as facadeBuilder } from './exports'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/index-gen.test.ts:\n(pass) MissingExport > MissingExport_C1 passes after fixture fix [0.17ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingExport_C2',
    scenarioType: 'MissingExport',
    errorClass: 'ImportError',
    file: 'src/index-gen.ts',
    expression: "import named export 'facadeRegistry'",
    sourceContent:
      'import { facadeRegistry } from \'./exports\'\n\nexport function handleIndexGen8(): unknown {\n  return facadeRegistry()\n}\n\nexport const source = "src/index-gen.ts"\n// Fixture MissingExport_C2 keeps the Phase 19 source file at realistic size.\n// Scenario MissingExport is expected to surface ImportError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      "src/index-gen.test.ts:\n13 |   import { facadeRegistry } from './exports'\n                              ^\nImportError: export 'facadeRegistry' not found in './exports'\n    at handleIndexGen8 (/tmp/octonoesis-demo/src/index-gen.ts:13:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/index-gen.test.ts:4:12)\n(fail) MissingExport > MissingExport_C2 reproduces fixture failure [0.17ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/index-gen.ts',
      expression: "import named export 'facadeRegistry'",
    },
    fix: {
      old: "import { facadeRegistry } from './exports'",
      new: "import { registerFacade as facadeRegistry } from './exports'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/index-gen.test.ts:\n(pass) MissingExport > MissingExport_C2 passes after fixture fix [0.18ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingExport_D1',
    scenarioType: 'MissingExport',
    errorClass: 'ImportError',
    file: 'src/facade.ts',
    expression: "import named export 'surfaceAdapter'",
    sourceContent:
      'import { surfaceAdapter } from \'./exports\'\n\nexport function handleFacade9(): unknown {\n  return surfaceAdapter()\n}\n\nexport const source = "src/facade.ts"\n// Fixture MissingExport_D1 keeps the Phase 19 source file at realistic size.\n// Scenario MissingExport is expected to surface ImportError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      "src/facade.test.ts:\n14 |   import { surfaceAdapter } from './exports'\n                              ^\nImportError: export 'surfaceAdapter' not found in './exports'\n    at handleFacade9 (/tmp/octonoesis-demo/src/facade.ts:14:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/facade.test.ts:4:12)\n(fail) MissingExport > MissingExport_D1 reproduces fixture failure [0.18ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/facade.ts',
      expression: "import named export 'surfaceAdapter'",
    },
    fix: {
      old: "import { surfaceAdapter } from './exports'",
      new: "import { adaptSurface as surfaceAdapter } from './exports'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/facade.test.ts:\n(pass) MissingExport > MissingExport_D1 passes after fixture fix [0.19ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingExport_E1',
    scenarioType: 'MissingExport',
    errorClass: 'ImportError',
    file: 'src/surface.ts',
    expression: "import named export 'surfaceSchema'",
    sourceContent:
      'import { surfaceSchema } from \'./exports\'\n\nexport function handleSurface10(): unknown {\n  return surfaceSchema()\n}\n\nexport const source = "src/surface.ts"\n// Fixture MissingExport_E1 keeps the Phase 19 source file at realistic size.\n// Scenario MissingExport is expected to surface ImportError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      "src/surface.test.ts:\n15 |   import { surfaceSchema } from './exports'\n                              ^\nImportError: export 'surfaceSchema' not found in './exports'\n    at handleSurface10 (/tmp/octonoesis-demo/src/surface.ts:15:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/surface.test.ts:4:12)\n(fail) MissingExport > MissingExport_E1 reproduces fixture failure [0.19ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/surface.ts',
      expression: "import named export 'surfaceSchema'",
    },
    fix: {
      old: "import { surfaceSchema } from './exports'",
      new: "import { createSurfaceSchema as surfaceSchema } from './exports'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/surface.test.ts:\n(pass) MissingExport > MissingExport_E1 passes after fixture fix [0.20ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ExpectMismatch_A1',
    scenarioType: 'ExpectMismatch',
    errorClass: 'AssertionError',
    file: 'src/calc.ts',
    expression: 'asserting sumTotal result',
    sourceContent:
      'export function sumTotal(a: number, b: number): number | string {\n  return a + b - 1\n}\n\nexport function handleCalc1(): number | string {\n  return sumTotal(4, 2)\n}\n// Fixture ExpectMismatch_A1 keeps the Phase 19 source file at realistic size.\n// Scenario ExpectMismatch is expected to surface AssertionError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      'src/calc.test.ts:\n6 |   return a + b - 1\n                      ^\nAssertionError: expect(received).toBe(expected)\n    at handleCalc1 (/tmp/octonoesis-demo/src/calc.ts:6:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/calc.test.ts:4:12)\n(fail) ExpectMismatch > ExpectMismatch_A1 reproduces fixture failure [0.10ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/calc.ts',
      expression: 'asserting sumTotal result',
    },
    fix: {
      old: 'return a + b - 1',
      new: 'return a + b',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/calc.test.ts:\n(pass) ExpectMismatch > ExpectMismatch_A1 passes after fixture fix [0.11ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ExpectMismatch_A2',
    scenarioType: 'ExpectMismatch',
    errorClass: 'AssertionError',
    file: 'src/calc.ts',
    expression: 'asserting discountTotal result',
    sourceContent:
      'export function discountTotal(a: number, b: number): number | string {\n  return total - discount + 1\n}\n\nexport function handleCalc2(): number | string {\n  return discountTotal(4, 2)\n}\n// Fixture ExpectMismatch_A2 keeps the Phase 19 source file at realistic size.\n// Scenario ExpectMismatch is expected to surface AssertionError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      'src/calc.test.ts:\n7 |   return total - discount + 1\n                              ^\nAssertionError: expect(received).toBe(expected)\n    at handleCalc2 (/tmp/octonoesis-demo/src/calc.ts:7:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/calc.test.ts:4:12)\n(fail) ExpectMismatch > ExpectMismatch_A2 reproduces fixture failure [0.11ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/calc.ts',
      expression: 'asserting discountTotal result',
    },
    fix: {
      old: 'return total - discount + 1',
      new: 'return total - discount',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/calc.test.ts:\n(pass) ExpectMismatch > ExpectMismatch_A2 passes after fixture fix [0.12ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ExpectMismatch_A3',
    scenarioType: 'ExpectMismatch',
    errorClass: 'AssertionError',
    file: 'src/calc.ts',
    expression: 'asserting formatTitle result',
    sourceContent:
      'export function formatTitle(a: number, b: number): number | string {\n  return title.toLowerCase()\n}\n\nexport function handleCalc3(): number | string {\n  return formatTitle(4, 2)\n}\n// Fixture ExpectMismatch_A3 keeps the Phase 19 source file at realistic size.\n// Scenario ExpectMismatch is expected to surface AssertionError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      'src/calc.test.ts:\n8 |   return title.toLowerCase()\n                              ^\nAssertionError: expect(received).toBe(expected)\n    at handleCalc3 (/tmp/octonoesis-demo/src/calc.ts:8:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/calc.test.ts:4:12)\n(fail) ExpectMismatch > ExpectMismatch_A3 reproduces fixture failure [0.12ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/calc.ts',
      expression: 'asserting formatTitle result',
    },
    fix: {
      old: 'return title.toLowerCase()',
      new: 'return title.toUpperCase()',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/calc.test.ts:\n(pass) ExpectMismatch > ExpectMismatch_A3 passes after fixture fix [0.13ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ExpectMismatch_B1',
    scenarioType: 'ExpectMismatch',
    errorClass: 'AssertionError',
    file: 'src/formatter.ts',
    expression: 'asserting formatCurrency result',
    sourceContent:
      'export function formatCurrency(a: number, b: number): number | string {\n  return `$${amount.toFixed(0)}`\n}\n\nexport function handleFormatter4(): number | string {\n  return formatCurrency(4, 2)\n}\n// Fixture ExpectMismatch_B1 keeps the Phase 19 source file at realistic size.\n// Scenario ExpectMismatch is expected to surface AssertionError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      'src/formatter.test.ts:\n9 |   return `$${amount.toFixed(0)}`\n                              ^\nAssertionError: expect(received).toBe(expected)\n    at handleFormatter4 (/tmp/octonoesis-demo/src/formatter.ts:9:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/formatter.test.ts:4:12)\n(fail) ExpectMismatch > ExpectMismatch_B1 reproduces fixture failure [0.13ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/formatter.ts',
      expression: 'asserting formatCurrency result',
    },
    fix: {
      old: 'return `$${amount.toFixed(0)}`',
      new: 'return `$${amount.toFixed(2)}`',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/formatter.test.ts:\n(pass) ExpectMismatch > ExpectMismatch_B1 passes after fixture fix [0.14ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ExpectMismatch_B2',
    scenarioType: 'ExpectMismatch',
    errorClass: 'AssertionError',
    file: 'src/formatter.ts',
    expression: 'asserting formatPadding result',
    sourceContent:
      "export function formatPadding(a: number, b: number): number | string {\n  return value.padStart(2, '0')\n}\n\nexport function handleFormatter5(): number | string {\n  return formatPadding(4, 2)\n}\n// Fixture ExpectMismatch_B2 keeps the Phase 19 source file at realistic size.\n// Scenario ExpectMismatch is expected to surface AssertionError.\n// The buggy line above remains the exact Edit target for this fixture.\n",
    stderrOutput:
      "src/formatter.test.ts:\n10 |   return value.padStart(2, '0')\n                              ^\nAssertionError: expect(received).toBe(expected)\n    at handleFormatter5 (/tmp/octonoesis-demo/src/formatter.ts:10:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/formatter.test.ts:4:12)\n(fail) ExpectMismatch > ExpectMismatch_B2 reproduces fixture failure [0.14ms]\n",
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/formatter.ts',
      expression: 'asserting formatPadding result',
    },
    fix: {
      old: "return value.padStart(2, '0')",
      new: "return value.padStart(3, '0')",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/formatter.test.ts:\n(pass) ExpectMismatch > ExpectMismatch_B2 passes after fixture fix [0.15ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ExpectMismatch_B3',
    scenarioType: 'ExpectMismatch',
    errorClass: 'AssertionError',
    file: 'src/formatter.ts',
    expression: 'asserting convertMeters result',
    sourceContent:
      'export function convertMeters(a: number, b: number): number | string {\n  return meters * 100\n}\n\nexport function handleFormatter6(): number | string {\n  return convertMeters(4, 2)\n}\n// Fixture ExpectMismatch_B3 keeps the Phase 19 source file at realistic size.\n// Scenario ExpectMismatch is expected to surface AssertionError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      'src/formatter.test.ts:\n11 |   return meters * 100\n                         ^\nAssertionError: expect(received).toBe(expected)\n    at handleFormatter6 (/tmp/octonoesis-demo/src/formatter.ts:11:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/formatter.test.ts:4:12)\n(fail) ExpectMismatch > ExpectMismatch_B3 reproduces fixture failure [0.15ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/formatter.ts',
      expression: 'asserting convertMeters result',
    },
    fix: {
      old: 'return meters * 100',
      new: 'return meters * 1000',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/formatter.test.ts:\n(pass) ExpectMismatch > ExpectMismatch_B3 passes after fixture fix [0.16ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ExpectMismatch_C1',
    scenarioType: 'ExpectMismatch',
    errorClass: 'AssertionError',
    file: 'src/converter.ts',
    expression: 'asserting convertCelsius result',
    sourceContent:
      'export function convertCelsius(a: number, b: number): number | string {\n  return celsius + 32\n}\n\nexport function handleConverter7(): number | string {\n  return convertCelsius(4, 2)\n}\n// Fixture ExpectMismatch_C1 keeps the Phase 19 source file at realistic size.\n// Scenario ExpectMismatch is expected to surface AssertionError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      'src/converter.test.ts:\n12 |   return celsius + 32\n                         ^\nAssertionError: expect(received).toBe(expected)\n    at handleConverter7 (/tmp/octonoesis-demo/src/converter.ts:12:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/converter.test.ts:4:12)\n(fail) ExpectMismatch > ExpectMismatch_C1 reproduces fixture failure [0.16ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/converter.ts',
      expression: 'asserting convertCelsius result',
    },
    fix: {
      old: 'return celsius + 32',
      new: 'return celsius * 1.8 + 32',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/converter.test.ts:\n(pass) ExpectMismatch > ExpectMismatch_C1 passes after fixture fix [0.17ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ExpectMismatch_C2',
    scenarioType: 'ExpectMismatch',
    errorClass: 'AssertionError',
    file: 'src/converter.ts',
    expression: 'asserting aggregateAverage result',
    sourceContent:
      'export function aggregateAverage(a: number, b: number): number | string {\n  return total / (items.length + 1)\n}\n\nexport function handleConverter8(): number | string {\n  return aggregateAverage(4, 2)\n}\n// Fixture ExpectMismatch_C2 keeps the Phase 19 source file at realistic size.\n// Scenario ExpectMismatch is expected to surface AssertionError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      'src/converter.test.ts:\n13 |   return total / (items.length + 1)\n                              ^\nAssertionError: expect(received).toBe(expected)\n    at handleConverter8 (/tmp/octonoesis-demo/src/converter.ts:13:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/converter.test.ts:4:12)\n(fail) ExpectMismatch > ExpectMismatch_C2 reproduces fixture failure [0.17ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/converter.ts',
      expression: 'asserting aggregateAverage result',
    },
    fix: {
      old: 'return total / (items.length + 1)',
      new: 'return total / items.length',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/converter.test.ts:\n(pass) ExpectMismatch > ExpectMismatch_C2 passes after fixture fix [0.18ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ExpectMismatch_D1',
    scenarioType: 'ExpectMismatch',
    errorClass: 'AssertionError',
    file: 'src/aggregator.ts',
    expression: 'asserting scorePercent result',
    sourceContent:
      'export function scorePercent(a: number, b: number): number | string {\n  return correct / total\n}\n\nexport function handleAggregator9(): number | string {\n  return scorePercent(4, 2)\n}\n// Fixture ExpectMismatch_D1 keeps the Phase 19 source file at realistic size.\n// Scenario ExpectMismatch is expected to surface AssertionError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      'src/aggregator.test.ts:\n14 |   return correct / total\n                            ^\nAssertionError: expect(received).toBe(expected)\n    at handleAggregator9 (/tmp/octonoesis-demo/src/aggregator.ts:14:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/aggregator.test.ts:4:12)\n(fail) ExpectMismatch > ExpectMismatch_D1 reproduces fixture failure [0.18ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/aggregator.ts',
      expression: 'asserting scorePercent result',
    },
    fix: {
      old: 'return correct / total',
      new: 'return (correct / total) * 100',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/aggregator.test.ts:\n(pass) ExpectMismatch > ExpectMismatch_D1 passes after fixture fix [0.19ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ExpectMismatch_E1',
    scenarioType: 'ExpectMismatch',
    errorClass: 'AssertionError',
    file: 'src/scorer.ts',
    expression: 'asserting scoreBonus result',
    sourceContent:
      'export function scoreBonus(a: number, b: number): number | string {\n  return base + bonus - 1\n}\n\nexport function handleScorer10(): number | string {\n  return scoreBonus(4, 2)\n}\n// Fixture ExpectMismatch_E1 keeps the Phase 19 source file at realistic size.\n// Scenario ExpectMismatch is expected to surface AssertionError.\n// The buggy line above remains the exact Edit target for this fixture.\n',
    stderrOutput:
      'src/scorer.test.ts:\n15 |   return base + bonus - 1\n                             ^\nAssertionError: expect(received).toBe(expected)\n    at handleScorer10 (/tmp/octonoesis-demo/src/scorer.ts:15:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/scorer.test.ts:4:12)\n(fail) ExpectMismatch > ExpectMismatch_E1 reproduces fixture failure [0.19ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/scorer.ts',
      expression: 'asserting scoreBonus result',
    },
    fix: {
      old: 'return base + bonus - 1',
      new: 'return base + bonus',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/scorer.test.ts:\n(pass) ExpectMismatch > ExpectMismatch_E1 passes after fixture fix [0.20ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'SnapshotDrift_A1',
    scenarioType: 'SnapshotDrift',
    errorClass: 'AssertionError',
    file: 'src/button.tsx',
    expression: 'snapshot for buttonLabel',
    sourceContent:
      'import React from \'react\'\n\nexport function buttonLabel() {\n  return <button className="btn old">Submit</button>\n}\n\nexport function handleButton1() {\n  return <div data-file="src/button.tsx">{buttonLabel()}</div>\n}\n// Fixture SnapshotDrift_A1 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/button.test.tsx:\n6 |   return <button className="btn old">Submit</button>\n                              ^\nAssertionError: Snapshot mismatch in "buttonLabel"\n    at handleButton1 (/tmp/octonoesis-demo/src/button.tsx:6:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/button.test.tsx:4:12)\n(fail) SnapshotDrift > SnapshotDrift_A1 reproduces fixture failure [0.10ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/button.tsx',
      expression: 'snapshot for buttonLabel',
    },
    fix: {
      old: 'return <button className="btn old">Submit</button>',
      new: 'return <button className="btn primary">Submit</button>',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/button.test.tsx:\n(pass) SnapshotDrift > SnapshotDrift_A1 passes after fixture fix [0.11ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'SnapshotDrift_A2',
    scenarioType: 'SnapshotDrift',
    errorClass: 'AssertionError',
    file: 'src/button.tsx',
    expression: 'snapshot for buttonIcon',
    sourceContent:
      'import React from \'react\'\n\nexport function buttonIcon() {\n  return <button aria-label="save old">Save</button>\n}\n\nexport function handleButton2() {\n  return <div data-file="src/button.tsx">{buttonIcon()}</div>\n}\n// Fixture SnapshotDrift_A2 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/button.test.tsx:\n7 |   return <button aria-label="save old">Save</button>\n                              ^\nAssertionError: Snapshot mismatch in "buttonIcon"\n    at handleButton2 (/tmp/octonoesis-demo/src/button.tsx:7:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/button.test.tsx:4:12)\n(fail) SnapshotDrift > SnapshotDrift_A2 reproduces fixture failure [0.11ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/button.tsx',
      expression: 'snapshot for buttonIcon',
    },
    fix: {
      old: 'return <button aria-label="save old">Save</button>',
      new: 'return <button aria-label="save">Save</button>',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/button.test.tsx:\n(pass) SnapshotDrift > SnapshotDrift_A2 passes after fixture fix [0.12ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'SnapshotDrift_A3',
    scenarioType: 'SnapshotDrift',
    errorClass: 'AssertionError',
    file: 'src/button.tsx',
    expression: 'snapshot for cardTitle',
    sourceContent:
      'import React from \'react\'\n\nexport function cardTitle() {\n  return <section className="card legacy">Card</section>\n}\n\nexport function handleButton3() {\n  return <div data-file="src/button.tsx">{cardTitle()}</div>\n}\n// Fixture SnapshotDrift_A3 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/button.test.tsx:\n8 |   return <section className="card legacy">Card</section>\n                              ^\nAssertionError: Snapshot mismatch in "cardTitle"\n    at handleButton3 (/tmp/octonoesis-demo/src/button.tsx:8:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/button.test.tsx:4:12)\n(fail) SnapshotDrift > SnapshotDrift_A3 reproduces fixture failure [0.12ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/button.tsx',
      expression: 'snapshot for cardTitle',
    },
    fix: {
      old: 'return <section className="card legacy">Card</section>',
      new: 'return <section className="card">Card</section>',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/button.test.tsx:\n(pass) SnapshotDrift > SnapshotDrift_A3 passes after fixture fix [0.13ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'SnapshotDrift_B1',
    scenarioType: 'SnapshotDrift',
    errorClass: 'AssertionError',
    file: 'src/card.tsx',
    expression: 'snapshot for cardFooter',
    sourceContent:
      'import React from \'react\'\n\nexport function cardFooter() {\n  return <footer data-tone="muted">Done</footer>\n}\n\nexport function handleCard4() {\n  return <div data-file="src/card.tsx">{cardFooter()}</div>\n}\n// Fixture SnapshotDrift_B1 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/card.test.tsx:\n9 |   return <footer data-tone="muted">Done</footer>\n                              ^\nAssertionError: Snapshot mismatch in "cardFooter"\n    at handleCard4 (/tmp/octonoesis-demo/src/card.tsx:9:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/card.test.tsx:4:12)\n(fail) SnapshotDrift > SnapshotDrift_B1 reproduces fixture failure [0.13ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/card.tsx',
      expression: 'snapshot for cardFooter',
    },
    fix: {
      old: 'return <footer data-tone="muted">Done</footer>',
      new: 'return <footer data-tone="neutral">Done</footer>',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/card.test.tsx:\n(pass) SnapshotDrift > SnapshotDrift_B1 passes after fixture fix [0.14ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'SnapshotDrift_B2',
    scenarioType: 'SnapshotDrift',
    errorClass: 'AssertionError',
    file: 'src/card.tsx',
    expression: 'snapshot for cardBadge',
    sourceContent:
      'import React from \'react\'\n\nexport function cardBadge() {\n  return <span className="badge stale">New</span>\n}\n\nexport function handleCard5() {\n  return <div data-file="src/card.tsx">{cardBadge()}</div>\n}\n// Fixture SnapshotDrift_B2 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/card.test.tsx:\n10 |   return <span className="badge stale">New</span>\n                              ^\nAssertionError: Snapshot mismatch in "cardBadge"\n    at handleCard5 (/tmp/octonoesis-demo/src/card.tsx:10:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/card.test.tsx:4:12)\n(fail) SnapshotDrift > SnapshotDrift_B2 reproduces fixture failure [0.14ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/card.tsx',
      expression: 'snapshot for cardBadge',
    },
    fix: {
      old: 'return <span className="badge stale">New</span>',
      new: 'return <span className="badge fresh">New</span>',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/card.test.tsx:\n(pass) SnapshotDrift > SnapshotDrift_B2 passes after fixture fix [0.15ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'SnapshotDrift_B3',
    scenarioType: 'SnapshotDrift',
    errorClass: 'AssertionError',
    file: 'src/card.tsx',
    expression: 'snapshot for modalHeading',
    sourceContent:
      'import React from \'react\'\n\nexport function modalHeading() {\n  return <h1>Old Modal</h1>\n}\n\nexport function handleCard6() {\n  return <div data-file="src/card.tsx">{modalHeading()}</div>\n}\n// Fixture SnapshotDrift_B3 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/card.test.tsx:\n11 |   return <h1>Old Modal</h1>\n                              ^\nAssertionError: Snapshot mismatch in "modalHeading"\n    at handleCard6 (/tmp/octonoesis-demo/src/card.tsx:11:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/card.test.tsx:4:12)\n(fail) SnapshotDrift > SnapshotDrift_B3 reproduces fixture failure [0.15ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/card.tsx',
      expression: 'snapshot for modalHeading',
    },
    fix: {
      old: 'return <h1>Old Modal</h1>',
      new: 'return <h1>Modal</h1>',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/card.test.tsx:\n(pass) SnapshotDrift > SnapshotDrift_B3 passes after fixture fix [0.16ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'SnapshotDrift_C1',
    scenarioType: 'SnapshotDrift',
    errorClass: 'AssertionError',
    file: 'src/modal.tsx',
    expression: 'snapshot for modalAction',
    sourceContent:
      'import React from \'react\'\n\nexport function modalAction() {\n  return <button>Close now</button>\n}\n\nexport function handleModal7() {\n  return <div data-file="src/modal.tsx">{modalAction()}</div>\n}\n// Fixture SnapshotDrift_C1 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/modal.test.tsx:\n12 |   return <button>Close now</button>\n                              ^\nAssertionError: Snapshot mismatch in "modalAction"\n    at handleModal7 (/tmp/octonoesis-demo/src/modal.tsx:12:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/modal.test.tsx:4:12)\n(fail) SnapshotDrift > SnapshotDrift_C1 reproduces fixture failure [0.16ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/modal.tsx',
      expression: 'snapshot for modalAction',
    },
    fix: {
      old: 'return <button>Close now</button>',
      new: 'return <button>Close</button>',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/modal.test.tsx:\n(pass) SnapshotDrift > SnapshotDrift_C1 passes after fixture fix [0.17ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'SnapshotDrift_C2',
    scenarioType: 'SnapshotDrift',
    errorClass: 'AssertionError',
    file: 'src/modal.tsx',
    expression: 'snapshot for tooltipCopy',
    sourceContent:
      'import React from \'react\'\n\nexport function tooltipCopy() {\n  return <span role="tooltip">Old help</span>\n}\n\nexport function handleModal8() {\n  return <div data-file="src/modal.tsx">{tooltipCopy()}</div>\n}\n// Fixture SnapshotDrift_C2 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/modal.test.tsx:\n13 |   return <span role="tooltip">Old help</span>\n                              ^\nAssertionError: Snapshot mismatch in "tooltipCopy"\n    at handleModal8 (/tmp/octonoesis-demo/src/modal.tsx:13:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/modal.test.tsx:4:12)\n(fail) SnapshotDrift > SnapshotDrift_C2 reproduces fixture failure [0.17ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/modal.tsx',
      expression: 'snapshot for tooltipCopy',
    },
    fix: {
      old: 'return <span role="tooltip">Old help</span>',
      new: 'return <span role="tooltip">Help</span>',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/modal.test.tsx:\n(pass) SnapshotDrift > SnapshotDrift_C2 passes after fixture fix [0.18ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'SnapshotDrift_D1',
    scenarioType: 'SnapshotDrift',
    errorClass: 'AssertionError',
    file: 'src/tooltip.tsx',
    expression: 'snapshot for badgeTone',
    sourceContent:
      'import React from \'react\'\n\nexport function badgeTone() {\n  return <span data-tone="warning">Ready</span>\n}\n\nexport function handleTooltip9() {\n  return <div data-file="src/tooltip.tsx">{badgeTone()}</div>\n}\n// Fixture SnapshotDrift_D1 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/tooltip.test.tsx:\n14 |   return <span data-tone="warning">Ready</span>\n                              ^\nAssertionError: Snapshot mismatch in "badgeTone"\n    at handleTooltip9 (/tmp/octonoesis-demo/src/tooltip.tsx:14:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/tooltip.test.tsx:4:12)\n(fail) SnapshotDrift > SnapshotDrift_D1 reproduces fixture failure [0.18ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/tooltip.tsx',
      expression: 'snapshot for badgeTone',
    },
    fix: {
      old: 'return <span data-tone="warning">Ready</span>',
      new: 'return <span data-tone="success">Ready</span>',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/tooltip.test.tsx:\n(pass) SnapshotDrift > SnapshotDrift_D1 passes after fixture fix [0.19ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'SnapshotDrift_E1',
    scenarioType: 'SnapshotDrift',
    errorClass: 'AssertionError',
    file: 'src/badge.tsx',
    expression: 'snapshot for badgeLabel',
    sourceContent:
      'import React from \'react\'\n\nexport function badgeLabel() {\n  return <span>Beta old</span>\n}\n\nexport function handleBadge10() {\n  return <div data-file="src/badge.tsx">{badgeLabel()}</div>\n}\n// Fixture SnapshotDrift_E1 keeps the Phase 19 source file at realistic size.\n',
    stderrOutput:
      'src/badge.test.tsx:\n15 |   return <span>Beta old</span>\n                              ^\nAssertionError: Snapshot mismatch in "badgeLabel"\n    at handleBadge10 (/tmp/octonoesis-demo/src/badge.tsx:15:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/badge.test.tsx:4:12)\n(fail) SnapshotDrift > SnapshotDrift_E1 reproduces fixture failure [0.19ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'AssertionError',
      file: 'src/badge.tsx',
      expression: 'snapshot for badgeLabel',
    },
    fix: {
      old: 'return <span>Beta old</span>',
      new: 'return <span>Beta</span>',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/badge.test.tsx:\n(pass) SnapshotDrift > SnapshotDrift_E1 passes after fixture fix [0.20ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingEnvVar_A1',
    scenarioType: 'MissingEnvVar',
    errorClass: 'ConfigError',
    file: 'src/db-config.ts',
    expression: 'reading process.env.DATABASE_URL',
    sourceContent:
      "export function handleDbConfig1(): string {\n  const value = process.env.DATABASE_URL\n  if (!value) {\n    throw new Error('Missing required: DATABASE_URL')\n  }\n  return value\n}\n// Fixture MissingEnvVar_A1 keeps the Phase 19 source file at realistic size.\n// Scenario MissingEnvVar is expected to surface ConfigError.\n// The buggy line above remains the exact Edit target for this fixture.\n",
    stderrOutput:
      'src/db-config.test.ts:\n6 |   const value = process.env.DATABASE_URL\n                              ^\nConfigError: Missing required: DATABASE_URL\n    at handleDbConfig1 (/tmp/octonoesis-demo/src/db-config.ts:6:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/db-config.test.ts:4:12)\n(fail) MissingEnvVar > MissingEnvVar_A1 reproduces fixture failure [0.10ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/db-config.ts',
      expression: 'reading process.env.DATABASE_URL',
    },
    fix: {
      old: 'const value = process.env.DATABASE_URL',
      new: 'const value = process.env.DATABASE_URL ?? "sqlite://memory"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/db-config.test.ts:\n(pass) MissingEnvVar > MissingEnvVar_A1 passes after fixture fix [0.11ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingEnvVar_A2',
    scenarioType: 'MissingEnvVar',
    errorClass: 'ConfigError',
    file: 'src/db-config.ts',
    expression: 'reading process.env.DB_POOL_SIZE',
    sourceContent:
      "export function handleDbConfig2(): string {\n  const value = process.env.DB_POOL_SIZE\n  if (!value) {\n    throw new Error('Missing required: DB_POOL_SIZE')\n  }\n  return value\n}\n// Fixture MissingEnvVar_A2 keeps the Phase 19 source file at realistic size.\n// Scenario MissingEnvVar is expected to surface ConfigError.\n// The buggy line above remains the exact Edit target for this fixture.\n",
    stderrOutput:
      'src/db-config.test.ts:\n7 |   const value = process.env.DB_POOL_SIZE\n                              ^\nConfigError: Missing required: DB_POOL_SIZE\n    at handleDbConfig2 (/tmp/octonoesis-demo/src/db-config.ts:7:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/db-config.test.ts:4:12)\n(fail) MissingEnvVar > MissingEnvVar_A2 reproduces fixture failure [0.11ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/db-config.ts',
      expression: 'reading process.env.DB_POOL_SIZE',
    },
    fix: {
      old: 'const value = process.env.DB_POOL_SIZE',
      new: 'const value = process.env.DB_POOL_SIZE ?? "5"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/db-config.test.ts:\n(pass) MissingEnvVar > MissingEnvVar_A2 passes after fixture fix [0.12ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingEnvVar_A3',
    scenarioType: 'MissingEnvVar',
    errorClass: 'ConfigError',
    file: 'src/db-config.ts',
    expression: 'reading process.env.REDIS_URL',
    sourceContent:
      "export function handleDbConfig3(): string {\n  const value = process.env.REDIS_URL\n  if (!value) {\n    throw new Error('Missing required: REDIS_URL')\n  }\n  return value\n}\n// Fixture MissingEnvVar_A3 keeps the Phase 19 source file at realistic size.\n// Scenario MissingEnvVar is expected to surface ConfigError.\n// The buggy line above remains the exact Edit target for this fixture.\n",
    stderrOutput:
      'src/db-config.test.ts:\n8 |   const value = process.env.REDIS_URL\n                              ^\nConfigError: Missing required: REDIS_URL\n    at handleDbConfig3 (/tmp/octonoesis-demo/src/db-config.ts:8:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/db-config.test.ts:4:12)\n(fail) MissingEnvVar > MissingEnvVar_A3 reproduces fixture failure [0.12ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/db-config.ts',
      expression: 'reading process.env.REDIS_URL',
    },
    fix: {
      old: 'const value = process.env.REDIS_URL',
      new: 'const value = process.env.REDIS_URL ?? "redis://localhost:6379"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/db-config.test.ts:\n(pass) MissingEnvVar > MissingEnvVar_A3 passes after fixture fix [0.13ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingEnvVar_B1',
    scenarioType: 'MissingEnvVar',
    errorClass: 'ConfigError',
    file: 'src/cache-config.ts',
    expression: 'reading process.env.CACHE_TTL',
    sourceContent:
      "export function handleCacheConfig4(): string {\n  const value = process.env.CACHE_TTL\n  if (!value) {\n    throw new Error('Missing required: CACHE_TTL')\n  }\n  return value\n}\n// Fixture MissingEnvVar_B1 keeps the Phase 19 source file at realistic size.\n// Scenario MissingEnvVar is expected to surface ConfigError.\n// The buggy line above remains the exact Edit target for this fixture.\n",
    stderrOutput:
      'src/cache-config.test.ts:\n9 |   const value = process.env.CACHE_TTL\n                              ^\nConfigError: Missing required: CACHE_TTL\n    at handleCacheConfig4 (/tmp/octonoesis-demo/src/cache-config.ts:9:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/cache-config.test.ts:4:12)\n(fail) MissingEnvVar > MissingEnvVar_B1 reproduces fixture failure [0.13ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/cache-config.ts',
      expression: 'reading process.env.CACHE_TTL',
    },
    fix: {
      old: 'const value = process.env.CACHE_TTL',
      new: 'const value = process.env.CACHE_TTL ?? "60"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/cache-config.test.ts:\n(pass) MissingEnvVar > MissingEnvVar_B1 passes after fixture fix [0.14ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingEnvVar_B2',
    scenarioType: 'MissingEnvVar',
    errorClass: 'ConfigError',
    file: 'src/cache-config.ts',
    expression: 'reading process.env.SMTP_HOST',
    sourceContent:
      "export function handleCacheConfig5(): string {\n  const value = process.env.SMTP_HOST\n  if (!value) {\n    throw new Error('Missing required: SMTP_HOST')\n  }\n  return value\n}\n// Fixture MissingEnvVar_B2 keeps the Phase 19 source file at realistic size.\n// Scenario MissingEnvVar is expected to surface ConfigError.\n// The buggy line above remains the exact Edit target for this fixture.\n",
    stderrOutput:
      'src/cache-config.test.ts:\n10 |   const value = process.env.SMTP_HOST\n                              ^\nConfigError: Missing required: SMTP_HOST\n    at handleCacheConfig5 (/tmp/octonoesis-demo/src/cache-config.ts:10:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/cache-config.test.ts:4:12)\n(fail) MissingEnvVar > MissingEnvVar_B2 reproduces fixture failure [0.14ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/cache-config.ts',
      expression: 'reading process.env.SMTP_HOST',
    },
    fix: {
      old: 'const value = process.env.SMTP_HOST',
      new: 'const value = process.env.SMTP_HOST ?? "localhost"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/cache-config.test.ts:\n(pass) MissingEnvVar > MissingEnvVar_B2 passes after fixture fix [0.15ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingEnvVar_B3',
    scenarioType: 'MissingEnvVar',
    errorClass: 'ConfigError',
    file: 'src/cache-config.ts',
    expression: 'reading process.env.MAIL_FROM',
    sourceContent:
      "export function handleCacheConfig6(): string {\n  const value = process.env.MAIL_FROM\n  if (!value) {\n    throw new Error('Missing required: MAIL_FROM')\n  }\n  return value\n}\n// Fixture MissingEnvVar_B3 keeps the Phase 19 source file at realistic size.\n// Scenario MissingEnvVar is expected to surface ConfigError.\n// The buggy line above remains the exact Edit target for this fixture.\n",
    stderrOutput:
      'src/cache-config.test.ts:\n11 |   const value = process.env.MAIL_FROM\n                              ^\nConfigError: Missing required: MAIL_FROM\n    at handleCacheConfig6 (/tmp/octonoesis-demo/src/cache-config.ts:11:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/cache-config.test.ts:4:12)\n(fail) MissingEnvVar > MissingEnvVar_B3 reproduces fixture failure [0.15ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/cache-config.ts',
      expression: 'reading process.env.MAIL_FROM',
    },
    fix: {
      old: 'const value = process.env.MAIL_FROM',
      new: 'const value = process.env.MAIL_FROM ?? "noreply@example.test"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/cache-config.test.ts:\n(pass) MissingEnvVar > MissingEnvVar_B3 passes after fixture fix [0.16ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingEnvVar_C1',
    scenarioType: 'MissingEnvVar',
    errorClass: 'ConfigError',
    file: 'src/mail-config.ts',
    expression: 'reading process.env.STORAGE_BUCKET',
    sourceContent:
      "export function handleMailConfig7(): string {\n  const value = process.env.STORAGE_BUCKET\n  if (!value) {\n    throw new Error('Missing required: STORAGE_BUCKET')\n  }\n  return value\n}\n// Fixture MissingEnvVar_C1 keeps the Phase 19 source file at realistic size.\n// Scenario MissingEnvVar is expected to surface ConfigError.\n// The buggy line above remains the exact Edit target for this fixture.\n",
    stderrOutput:
      'src/mail-config.test.ts:\n12 |   const value = process.env.STORAGE_BUCKET\n                              ^\nConfigError: Missing required: STORAGE_BUCKET\n    at handleMailConfig7 (/tmp/octonoesis-demo/src/mail-config.ts:12:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/mail-config.test.ts:4:12)\n(fail) MissingEnvVar > MissingEnvVar_C1 reproduces fixture failure [0.16ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/mail-config.ts',
      expression: 'reading process.env.STORAGE_BUCKET',
    },
    fix: {
      old: 'const value = process.env.STORAGE_BUCKET',
      new: 'const value = process.env.STORAGE_BUCKET ?? "local-bucket"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/mail-config.test.ts:\n(pass) MissingEnvVar > MissingEnvVar_C1 passes after fixture fix [0.17ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingEnvVar_C2',
    scenarioType: 'MissingEnvVar',
    errorClass: 'ConfigError',
    file: 'src/mail-config.ts',
    expression: 'reading process.env.STORAGE_REGION',
    sourceContent:
      "export function handleMailConfig8(): string {\n  const value = process.env.STORAGE_REGION\n  if (!value) {\n    throw new Error('Missing required: STORAGE_REGION')\n  }\n  return value\n}\n// Fixture MissingEnvVar_C2 keeps the Phase 19 source file at realistic size.\n// Scenario MissingEnvVar is expected to surface ConfigError.\n// The buggy line above remains the exact Edit target for this fixture.\n",
    stderrOutput:
      'src/mail-config.test.ts:\n13 |   const value = process.env.STORAGE_REGION\n                              ^\nConfigError: Missing required: STORAGE_REGION\n    at handleMailConfig8 (/tmp/octonoesis-demo/src/mail-config.ts:13:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/mail-config.test.ts:4:12)\n(fail) MissingEnvVar > MissingEnvVar_C2 reproduces fixture failure [0.17ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/mail-config.ts',
      expression: 'reading process.env.STORAGE_REGION',
    },
    fix: {
      old: 'const value = process.env.STORAGE_REGION',
      new: 'const value = process.env.STORAGE_REGION ?? "us-east-1"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/mail-config.test.ts:\n(pass) MissingEnvVar > MissingEnvVar_C2 passes after fixture fix [0.18ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingEnvVar_D1',
    scenarioType: 'MissingEnvVar',
    errorClass: 'ConfigError',
    file: 'src/storage-config.ts',
    expression: 'reading process.env.QUEUE_URL',
    sourceContent:
      "export function handleStorageConfig9(): string {\n  const value = process.env.QUEUE_URL\n  if (!value) {\n    throw new Error('Missing required: QUEUE_URL')\n  }\n  return value\n}\n// Fixture MissingEnvVar_D1 keeps the Phase 19 source file at realistic size.\n// Scenario MissingEnvVar is expected to surface ConfigError.\n// The buggy line above remains the exact Edit target for this fixture.\n",
    stderrOutput:
      'src/storage-config.test.ts:\n14 |   const value = process.env.QUEUE_URL\n                              ^\nConfigError: Missing required: QUEUE_URL\n    at handleStorageConfig9 (/tmp/octonoesis-demo/src/storage-config.ts:14:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/storage-config.test.ts:4:12)\n(fail) MissingEnvVar > MissingEnvVar_D1 reproduces fixture failure [0.18ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/storage-config.ts',
      expression: 'reading process.env.QUEUE_URL',
    },
    fix: {
      old: 'const value = process.env.QUEUE_URL',
      new: 'const value = process.env.QUEUE_URL ?? "memory://queue"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/storage-config.test.ts:\n(pass) MissingEnvVar > MissingEnvVar_D1 passes after fixture fix [0.19ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'MissingEnvVar_E1',
    scenarioType: 'MissingEnvVar',
    errorClass: 'ConfigError',
    file: 'src/queue-config.ts',
    expression: 'reading process.env.QUEUE_CONCURRENCY',
    sourceContent:
      "export function handleQueueConfig10(): string {\n  const value = process.env.QUEUE_CONCURRENCY\n  if (!value) {\n    throw new Error('Missing required: QUEUE_CONCURRENCY')\n  }\n  return value\n}\n// Fixture MissingEnvVar_E1 keeps the Phase 19 source file at realistic size.\n// Scenario MissingEnvVar is expected to surface ConfigError.\n// The buggy line above remains the exact Edit target for this fixture.\n",
    stderrOutput:
      'src/queue-config.test.ts:\n15 |   const value = process.env.QUEUE_CONCURRENCY\n                              ^\nConfigError: Missing required: QUEUE_CONCURRENCY\n    at handleQueueConfig10 (/tmp/octonoesis-demo/src/queue-config.ts:15:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/queue-config.test.ts:4:12)\n(fail) MissingEnvVar > MissingEnvVar_E1 reproduces fixture failure [0.19ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/queue-config.ts',
      expression: 'reading process.env.QUEUE_CONCURRENCY',
    },
    fix: {
      old: 'const value = process.env.QUEUE_CONCURRENCY',
      new: 'const value = process.env.QUEUE_CONCURRENCY ?? "2"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/queue-config.test.ts:\n(pass) MissingEnvVar > MissingEnvVar_E1 passes after fixture fix [0.20ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ConfigInvalid_A1',
    scenarioType: 'ConfigInvalid',
    errorClass: 'ConfigError',
    file: 'src/app-config.ts',
    expression: 'validating appPort',
    sourceContent:
      "function parsePort(value: string, fallback: number): number { const n = Number(value); return Number.isFinite(n) ? n : fallback }\nfunction parsePositive(value: string, fallback: number): number { const n = Number(value); return n > 0 ? n : fallback }\nfunction parseMode(value: string): string { return ['dev', 'prod'].includes(value) ? value : 'dev' }\nfunction parseLogLevel(value: string): string { return ['debug', 'info', 'warn', 'error'].includes(value) ? value : 'info' }\nfunction parseLogFormat(value: string): string { return value === 'json' ? 'json' : 'text' }\nfunction parseUrl(value: string): string { try { return new URL(value).href } catch { return 'http://localhost/' } }\n\nexport function handleAppConfig1(appPort: string): unknown {\n  const parsed = Number(appPort)\n  return parsed\n}\n",
    stderrOutput:
      'src/app-config.test.ts:\n6 |   const parsed = Number(appPort)\n                              ^\nConfigError: Invalid config value for appPort\n    at handleAppConfig1 (/tmp/octonoesis-demo/src/app-config.ts:6:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/app-config.test.ts:4:12)\n(fail) ConfigInvalid > ConfigInvalid_A1 reproduces fixture failure [0.10ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/app-config.ts',
      expression: 'validating appPort',
    },
    fix: {
      old: 'const parsed = Number(appPort)',
      new: 'const parsed = parsePort(appPort, 3000)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/app-config.test.ts:\n(pass) ConfigInvalid > ConfigInvalid_A1 passes after fixture fix [0.11ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ConfigInvalid_A2',
    scenarioType: 'ConfigInvalid',
    errorClass: 'ConfigError',
    file: 'src/app-config.ts',
    expression: 'validating appMode',
    sourceContent:
      "function parsePort(value: string, fallback: number): number { const n = Number(value); return Number.isFinite(n) ? n : fallback }\nfunction parsePositive(value: string, fallback: number): number { const n = Number(value); return n > 0 ? n : fallback }\nfunction parseMode(value: string): string { return ['dev', 'prod'].includes(value) ? value : 'dev' }\nfunction parseLogLevel(value: string): string { return ['debug', 'info', 'warn', 'error'].includes(value) ? value : 'info' }\nfunction parseLogFormat(value: string): string { return value === 'json' ? 'json' : 'text' }\nfunction parseUrl(value: string): string { try { return new URL(value).href } catch { return 'http://localhost/' } }\n\nexport function handleAppConfig2(appMode: string): unknown {\n  const parsed = appMode\n  return parsed\n}\n",
    stderrOutput:
      'src/app-config.test.ts:\n7 |   const parsed = appMode\n                            ^\nConfigError: Invalid config value for appMode\n    at handleAppConfig2 (/tmp/octonoesis-demo/src/app-config.ts:7:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/app-config.test.ts:4:12)\n(fail) ConfigInvalid > ConfigInvalid_A2 reproduces fixture failure [0.11ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/app-config.ts',
      expression: 'validating appMode',
    },
    fix: {
      old: 'const parsed = appMode',
      new: 'const parsed = parseMode(appMode)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/app-config.test.ts:\n(pass) ConfigInvalid > ConfigInvalid_A2 passes after fixture fix [0.12ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ConfigInvalid_A3',
    scenarioType: 'ConfigInvalid',
    errorClass: 'ConfigError',
    file: 'src/app-config.ts',
    expression: 'validating serverHost',
    sourceContent:
      "function parsePort(value: string, fallback: number): number { const n = Number(value); return Number.isFinite(n) ? n : fallback }\nfunction parsePositive(value: string, fallback: number): number { const n = Number(value); return n > 0 ? n : fallback }\nfunction parseMode(value: string): string { return ['dev', 'prod'].includes(value) ? value : 'dev' }\nfunction parseLogLevel(value: string): string { return ['debug', 'info', 'warn', 'error'].includes(value) ? value : 'info' }\nfunction parseLogFormat(value: string): string { return value === 'json' ? 'json' : 'text' }\nfunction parseUrl(value: string): string { try { return new URL(value).href } catch { return 'http://localhost/' } }\n\nexport function handleAppConfig3(serverHost: string): unknown {\n  const parsed = serverHost.trim()\n  return parsed\n}\n",
    stderrOutput:
      'src/app-config.test.ts:\n8 |   const parsed = serverHost.trim()\n                              ^\nConfigError: Invalid config value for serverHost\n    at handleAppConfig3 (/tmp/octonoesis-demo/src/app-config.ts:8:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/app-config.test.ts:4:12)\n(fail) ConfigInvalid > ConfigInvalid_A3 reproduces fixture failure [0.12ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/app-config.ts',
      expression: 'validating serverHost',
    },
    fix: {
      old: 'const parsed = serverHost.trim()',
      new: 'const parsed = serverHost.trim() || "127.0.0.1"',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/app-config.test.ts:\n(pass) ConfigInvalid > ConfigInvalid_A3 passes after fixture fix [0.13ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ConfigInvalid_B1',
    scenarioType: 'ConfigInvalid',
    errorClass: 'ConfigError',
    file: 'src/server-config.ts',
    expression: 'validating serverTimeout',
    sourceContent:
      "function parsePort(value: string, fallback: number): number { const n = Number(value); return Number.isFinite(n) ? n : fallback }\nfunction parsePositive(value: string, fallback: number): number { const n = Number(value); return n > 0 ? n : fallback }\nfunction parseMode(value: string): string { return ['dev', 'prod'].includes(value) ? value : 'dev' }\nfunction parseLogLevel(value: string): string { return ['debug', 'info', 'warn', 'error'].includes(value) ? value : 'info' }\nfunction parseLogFormat(value: string): string { return value === 'json' ? 'json' : 'text' }\nfunction parseUrl(value: string): string { try { return new URL(value).href } catch { return 'http://localhost/' } }\n\nexport function handleServerConfig4(serverTimeout: string): unknown {\n  const parsed = Number(serverTimeout)\n  return parsed\n}\n",
    stderrOutput:
      'src/server-config.test.ts:\n9 |   const parsed = Number(serverTimeout)\n                              ^\nConfigError: Invalid config value for serverTimeout\n    at handleServerConfig4 (/tmp/octonoesis-demo/src/server-config.ts:9:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/server-config.test.ts:4:12)\n(fail) ConfigInvalid > ConfigInvalid_B1 reproduces fixture failure [0.13ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/server-config.ts',
      expression: 'validating serverTimeout',
    },
    fix: {
      old: 'const parsed = Number(serverTimeout)',
      new: 'const parsed = parsePositive(serverTimeout, 30)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/server-config.test.ts:\n(pass) ConfigInvalid > ConfigInvalid_B1 passes after fixture fix [0.14ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ConfigInvalid_B2',
    scenarioType: 'ConfigInvalid',
    errorClass: 'ConfigError',
    file: 'src/server-config.ts',
    expression: 'validating serverLimit',
    sourceContent:
      "function parsePort(value: string, fallback: number): number { const n = Number(value); return Number.isFinite(n) ? n : fallback }\nfunction parsePositive(value: string, fallback: number): number { const n = Number(value); return n > 0 ? n : fallback }\nfunction parseMode(value: string): string { return ['dev', 'prod'].includes(value) ? value : 'dev' }\nfunction parseLogLevel(value: string): string { return ['debug', 'info', 'warn', 'error'].includes(value) ? value : 'info' }\nfunction parseLogFormat(value: string): string { return value === 'json' ? 'json' : 'text' }\nfunction parseUrl(value: string): string { try { return new URL(value).href } catch { return 'http://localhost/' } }\n\nexport function handleServerConfig5(serverLimit: string): unknown {\n  const parsed = Number(serverLimit)\n  return parsed\n}\n",
    stderrOutput:
      'src/server-config.test.ts:\n10 |   const parsed = Number(serverLimit)\n                              ^\nConfigError: Invalid config value for serverLimit\n    at handleServerConfig5 (/tmp/octonoesis-demo/src/server-config.ts:10:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/server-config.test.ts:4:12)\n(fail) ConfigInvalid > ConfigInvalid_B2 reproduces fixture failure [0.14ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/server-config.ts',
      expression: 'validating serverLimit',
    },
    fix: {
      old: 'const parsed = Number(serverLimit)',
      new: 'const parsed = parsePositive(serverLimit, 100)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/server-config.test.ts:\n(pass) ConfigInvalid > ConfigInvalid_B2 passes after fixture fix [0.15ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ConfigInvalid_B3',
    scenarioType: 'ConfigInvalid',
    errorClass: 'ConfigError',
    file: 'src/server-config.ts',
    expression: 'validating logLevel',
    sourceContent:
      "function parsePort(value: string, fallback: number): number { const n = Number(value); return Number.isFinite(n) ? n : fallback }\nfunction parsePositive(value: string, fallback: number): number { const n = Number(value); return n > 0 ? n : fallback }\nfunction parseMode(value: string): string { return ['dev', 'prod'].includes(value) ? value : 'dev' }\nfunction parseLogLevel(value: string): string { return ['debug', 'info', 'warn', 'error'].includes(value) ? value : 'info' }\nfunction parseLogFormat(value: string): string { return value === 'json' ? 'json' : 'text' }\nfunction parseUrl(value: string): string { try { return new URL(value).href } catch { return 'http://localhost/' } }\n\nexport function handleServerConfig6(logLevel: string): unknown {\n  const parsed = logLevel\n  return parsed\n}\n",
    stderrOutput:
      'src/server-config.test.ts:\n11 |   const parsed = logLevel\n                             ^\nConfigError: Invalid config value for logLevel\n    at handleServerConfig6 (/tmp/octonoesis-demo/src/server-config.ts:11:18)\n    at <anonymous> (/tmp/octonoesis-demo/src/server-config.test.ts:4:12)\n(fail) ConfigInvalid > ConfigInvalid_B3 reproduces fixture failure [0.15ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/server-config.ts',
      expression: 'validating logLevel',
    },
    fix: {
      old: 'const parsed = logLevel',
      new: 'const parsed = parseLogLevel(logLevel)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/server-config.test.ts:\n(pass) ConfigInvalid > ConfigInvalid_B3 passes after fixture fix [0.16ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ConfigInvalid_C1',
    scenarioType: 'ConfigInvalid',
    errorClass: 'ConfigError',
    file: 'src/log-config.ts',
    expression: 'validating logFormat',
    sourceContent:
      "function parsePort(value: string, fallback: number): number { const n = Number(value); return Number.isFinite(n) ? n : fallback }\nfunction parsePositive(value: string, fallback: number): number { const n = Number(value); return n > 0 ? n : fallback }\nfunction parseMode(value: string): string { return ['dev', 'prod'].includes(value) ? value : 'dev' }\nfunction parseLogLevel(value: string): string { return ['debug', 'info', 'warn', 'error'].includes(value) ? value : 'info' }\nfunction parseLogFormat(value: string): string { return value === 'json' ? 'json' : 'text' }\nfunction parseUrl(value: string): string { try { return new URL(value).href } catch { return 'http://localhost/' } }\n\nexport function handleLogConfig7(logFormat: string): unknown {\n  const parsed = logFormat\n  return parsed\n}\n",
    stderrOutput:
      'src/log-config.test.ts:\n12 |   const parsed = logFormat\n                              ^\nConfigError: Invalid config value for logFormat\n    at handleLogConfig7 (/tmp/octonoesis-demo/src/log-config.ts:12:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/log-config.test.ts:4:12)\n(fail) ConfigInvalid > ConfigInvalid_C1 reproduces fixture failure [0.16ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/log-config.ts',
      expression: 'validating logFormat',
    },
    fix: {
      old: 'const parsed = logFormat',
      new: 'const parsed = parseLogFormat(logFormat)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/log-config.test.ts:\n(pass) ConfigInvalid > ConfigInvalid_C1 passes after fixture fix [0.17ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ConfigInvalid_C2',
    scenarioType: 'ConfigInvalid',
    errorClass: 'ConfigError',
    file: 'src/log-config.ts',
    expression: 'validating authIssuer',
    sourceContent:
      "function parsePort(value: string, fallback: number): number { const n = Number(value); return Number.isFinite(n) ? n : fallback }\nfunction parsePositive(value: string, fallback: number): number { const n = Number(value); return n > 0 ? n : fallback }\nfunction parseMode(value: string): string { return ['dev', 'prod'].includes(value) ? value : 'dev' }\nfunction parseLogLevel(value: string): string { return ['debug', 'info', 'warn', 'error'].includes(value) ? value : 'info' }\nfunction parseLogFormat(value: string): string { return value === 'json' ? 'json' : 'text' }\nfunction parseUrl(value: string): string { try { return new URL(value).href } catch { return 'http://localhost/' } }\n\nexport function handleLogConfig8(authIssuer: string): unknown {\n  const parsed = new URL(authIssuer).href\n  return parsed\n}\n",
    stderrOutput:
      'src/log-config.test.ts:\n13 |   const parsed = new URL(authIssuer).href\n                              ^\nConfigError: Invalid config value for authIssuer\n    at handleLogConfig8 (/tmp/octonoesis-demo/src/log-config.ts:13:17)\n    at <anonymous> (/tmp/octonoesis-demo/src/log-config.test.ts:4:12)\n(fail) ConfigInvalid > ConfigInvalid_C2 reproduces fixture failure [0.17ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/log-config.ts',
      expression: 'validating authIssuer',
    },
    fix: {
      old: 'const parsed = new URL(authIssuer).href',
      new: 'const parsed = parseUrl(authIssuer)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/log-config.test.ts:\n(pass) ConfigInvalid > ConfigInvalid_C2 passes after fixture fix [0.18ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ConfigInvalid_D1',
    scenarioType: 'ConfigInvalid',
    errorClass: 'ConfigError',
    file: 'src/auth-config.ts',
    expression: 'validating rateWindow',
    sourceContent:
      "function parsePort(value: string, fallback: number): number { const n = Number(value); return Number.isFinite(n) ? n : fallback }\nfunction parsePositive(value: string, fallback: number): number { const n = Number(value); return n > 0 ? n : fallback }\nfunction parseMode(value: string): string { return ['dev', 'prod'].includes(value) ? value : 'dev' }\nfunction parseLogLevel(value: string): string { return ['debug', 'info', 'warn', 'error'].includes(value) ? value : 'info' }\nfunction parseLogFormat(value: string): string { return value === 'json' ? 'json' : 'text' }\nfunction parseUrl(value: string): string { try { return new URL(value).href } catch { return 'http://localhost/' } }\n\nexport function handleAuthConfig9(rateWindow: string): unknown {\n  const parsed = Number(rateWindow)\n  return parsed\n}\n",
    stderrOutput:
      'src/auth-config.test.ts:\n14 |   const parsed = Number(rateWindow)\n                              ^\nConfigError: Invalid config value for rateWindow\n    at handleAuthConfig9 (/tmp/octonoesis-demo/src/auth-config.ts:14:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/auth-config.test.ts:4:12)\n(fail) ConfigInvalid > ConfigInvalid_D1 reproduces fixture failure [0.18ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/auth-config.ts',
      expression: 'validating rateWindow',
    },
    fix: {
      old: 'const parsed = Number(rateWindow)',
      new: 'const parsed = parsePositive(rateWindow, 60)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/auth-config.test.ts:\n(pass) ConfigInvalid > ConfigInvalid_D1 passes after fixture fix [0.19ms]\n\n1 pass\n0 fail\n',
  },
  {
    id: 'ConfigInvalid_E1',
    scenarioType: 'ConfigInvalid',
    errorClass: 'ConfigError',
    file: 'src/rate-config.ts',
    expression: 'validating rateLimit',
    sourceContent:
      "function parsePort(value: string, fallback: number): number { const n = Number(value); return Number.isFinite(n) ? n : fallback }\nfunction parsePositive(value: string, fallback: number): number { const n = Number(value); return n > 0 ? n : fallback }\nfunction parseMode(value: string): string { return ['dev', 'prod'].includes(value) ? value : 'dev' }\nfunction parseLogLevel(value: string): string { return ['debug', 'info', 'warn', 'error'].includes(value) ? value : 'info' }\nfunction parseLogFormat(value: string): string { return value === 'json' ? 'json' : 'text' }\nfunction parseUrl(value: string): string { try { return new URL(value).href } catch { return 'http://localhost/' } }\n\nexport function handleRateConfig10(rateLimit: string): unknown {\n  const parsed = Number(rateLimit)\n  return parsed\n}\n",
    stderrOutput:
      'src/rate-config.test.ts:\n15 |   const parsed = Number(rateLimit)\n                              ^\nConfigError: Invalid config value for rateLimit\n    at handleRateConfig10 (/tmp/octonoesis-demo/src/rate-config.ts:15:16)\n    at <anonymous> (/tmp/octonoesis-demo/src/rate-config.test.ts:4:12)\n(fail) ConfigInvalid > ConfigInvalid_E1 reproduces fixture failure [0.19ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/rate-config.ts',
      expression: 'validating rateLimit',
    },
    fix: {
      old: 'const parsed = Number(rateLimit)',
      new: 'const parsed = parsePositive(rateLimit, 1000)',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/rate-config.test.ts:\n(pass) ConfigInvalid > ConfigInvalid_E1 passes after fixture fix [0.20ms]\n\n1 pass\n0 fail\n',
  },
  // --- RepoQuirk fixtures (appended, not interleaved) ---
  // Each failure is caused by an arbitrary repo-local convention (import map, test preload,
  // barrel export, config schema version) that no model can know a priori — it must be
  // discovered by reading files via the harness's read-action affordance. See
  // docs/distiller_fix_plan.md Task 4 and test/fixtures/learning-demo/fixtures.test.ts for why
  // these are exempt from the legacy per-type/per-class cardinality checks.
  {
    id: 'RepoQuirk_ImportMap',
    scenarioType: 'RepoQuirk',
    errorClass: 'ImportError',
    file: 'src/label.ts',
    expression: "import '#lib/format.ts'",
    sourceContent:
      "import { formatLabel } from '#lib/format.ts'\n\nexport function handleLabel(raw: string): string {\n  return formatLabel(raw)\n}\n",
    stderrOutput:
      'src/label.test.ts:\nImportError: Could not resolve: "#lib/format.ts"\n    at /tmp/octonoesis-demo/src/label.ts:1:29\n    at /tmp/octonoesis-demo/src/label.test.ts:1:1\n(fail) RepoQuirk > RepoQuirk_ImportMap reproduces fixture failure [0.12ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/label.ts',
      expression: "import '#lib/format.ts'",
    },
    fix: {
      old: "import { formatLabel } from '#lib/format.ts'",
      new: "import { formatLabel } from '#lib/strings.ts'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/label.test.ts:\n(pass) RepoQuirk > RepoQuirk_ImportMap passes after fixture fix [0.14ms]\n\n1 pass\n0 fail\n',
    extraFiles: {
      'package.json': JSON.stringify(
        {
          name: 'octonoesis-live-ab',
          type: 'module',
          private: true,
          imports: { '#lib/*': './src/lib/*' },
        },
        null,
        2,
      ),
      'src/lib/strings.ts':
        'export function formatLabel(raw: string): string {\n  return raw.trim().toUpperCase()\n}\n',
    },
    testContent:
      "import { describe, expect, it } from 'bun:test'\nimport * as mod from './label'\n\ndescribe('RepoQuirk RepoQuirk_ImportMap', () => {\n  it('formats a label', () => {\n    expect(mod.handleLabel(' hi ')).toBe('HI')\n  })\n})\n",
  },
  // RepoQuirk_Preload (bunfig.toml preload wiring) was tried and dropped after live testing:
  // the underlying Bun mechanism worked correctly (verified manually, broken/fixed states both
  // behaved as expected), but control only solved it ~3/8 times across two 16-run live batches
  // with claude-haiku-4-5 (vs. ~100% for the three fixtures kept below) — the model would
  // repeatedly re-read bunfig.toml instead of committing to the fix, even after a prompt
  // rewrite that fixed every other RepoQuirk fixture's reliability. Per the plan's "minimum 3,
  // drop what's flaky" allowance, this fixture was removed rather than forced through. See the
  // Task 4 implementation report for details.
  {
    id: 'RepoQuirk_BarrelExport',
    scenarioType: 'RepoQuirk',
    errorClass: 'ImportError',
    file: 'src/slug.ts',
    expression: "import { slugify } from './lib'",
    sourceContent:
      "import { slugify } from './lib'\n\nexport function handleSlug(raw: string): string {\n  return slugify(raw)\n}\n",
    stderrOutput:
      'src/slug.test.ts:\nImportError: Export named "slugify" not found in module "./lib"\n    at /tmp/octonoesis-demo/src/slug.ts:1:1\n    at /tmp/octonoesis-demo/src/slug.test.ts:1:1\n(fail) RepoQuirk > RepoQuirk_BarrelExport reproduces fixture failure [0.11ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/slug.ts',
      expression: "import { slugify } from './lib'",
    },
    fix: {
      old: "export { titleCase } from './helper'",
      new: "export { titleCase, slugify } from './helper'",
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/slug.test.ts:\n(pass) RepoQuirk > RepoQuirk_BarrelExport passes after fixture fix [0.16ms]\n\n1 pass\n0 fail\n',
    fixFile: 'src/lib/index.ts',
    extraFiles: {
      'src/lib/helper.ts':
        "export function slugify(raw: string): string {\n  return raw.trim().toLowerCase().replace(/\\s+/g, '-')\n}\n\nexport function titleCase(raw: string): string {\n  return raw.trim().replace(/\\b\\w/g, (c) => c.toUpperCase())\n}\n",
      'src/lib/index.ts': "export { titleCase } from './helper'\n",
    },
    testContent:
      "import { describe, expect, it } from 'bun:test'\nimport * as mod from './slug'\n\ndescribe('RepoQuirk RepoQuirk_BarrelExport', () => {\n  it('slugifies a title', () => {\n    expect(mod.handleSlug('Hello World')).toBe('hello-world')\n  })\n})\n",
  },
  {
    id: 'RepoQuirk_SettingsVersion',
    scenarioType: 'RepoQuirk',
    errorClass: 'ConfigError',
    file: 'src/settings.ts',
    expression: 'validating schema_version',
    sourceContent:
      "import { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\n\nexport function handleSettings(): string {\n  const raw = readFileSync(join(import.meta.dir, '..', 'config', 'settings.json'), 'utf8')\n  const parsed = JSON.parse(raw) as { schema_version: number }\n  if (parsed.schema_version !== 2) {\n    throw new Error(`ConfigError: expected schema_version 2, got ${parsed.schema_version}`)\n  }\n  return 'ok'\n}\n",
    stderrOutput:
      'src/settings.test.ts:\n7 |   if (parsed.schema_version !== 2) {\n8 |     throw new Error(`ConfigError: expected schema_version 2, got ${parsed.schema_version}`)\n                    ^\nConfigError: expected schema_version 2, got 1\n    at handleSettings (/tmp/octonoesis-demo/src/settings.ts:8:11)\n    at <anonymous> (/tmp/octonoesis-demo/src/settings.test.ts:4:12)\n(fail) RepoQuirk > RepoQuirk_SettingsVersion reproduces fixture failure [0.17ms]\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ConfigError',
      file: 'src/settings.ts',
      expression: 'validating schema_version',
    },
    fix: {
      old: '"schema_version": 1',
      new: '"schema_version": 2',
    },
    passingOutput:
      'bun test v1.2.0\n\nsrc/settings.test.ts:\n(pass) RepoQuirk > RepoQuirk_SettingsVersion passes after fixture fix [0.18ms]\n\n1 pass\n0 fail\n',
    fixFile: 'config/settings.json',
    extraFiles: {
      'config/settings.json': JSON.stringify(
        { schema_version: 1, feature_flags: { betaSearch: true } },
        null,
        2,
      ),
    },
    testContent:
      "import { describe, it } from 'bun:test'\nimport * as mod from './settings'\n\ndescribe('RepoQuirk RepoQuirk_SettingsVersion', () => {\n  it('validates settings schema version', () => {\n    mod.handleSettings()\n  })\n})\n",
  },
]

export function byScenario(scenarioType: string): FixtureDef[] {
  return ALL_FIXTURES.filter((fixture) => fixture.scenarioType === scenarioType)
}

export function byErrorClass(errorClass: string): FixtureDef[] {
  return ALL_FIXTURES.filter((fixture) => fixture.errorClass === errorClass)
}

export function byFile(scenarioType: string, file: string): FixtureDef[] {
  return ALL_FIXTURES.filter(
    (fixture) => fixture.scenarioType === scenarioType && fixture.file === file,
  )
}

export async function materializeRepo(tempDir: string, fixtures: FixtureDef[]): Promise<void> {
  await mkdir(tempDir, { recursive: true })

  await writeFile(
    join(tempDir, 'package.json'),
    JSON.stringify(
      {
        name: 'octonoesis-learning-demo',
        type: 'module',
        private: true,
        scripts: {
          test: 'bun test',
        },
      },
      null,
      2,
    ),
    'utf8',
  )

  await writeFile(
    join(tempDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
        },
      },
      null,
      2,
    ),
    'utf8',
  )

  for (const fixture of fixtures) {
    const target = join(tempDir, fixture.file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, fixture.sourceContent, 'utf8')
  }
}
