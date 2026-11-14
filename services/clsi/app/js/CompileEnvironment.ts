/** Finite environment/profile vocabulary shared by admission and final policy.
 * Profiles are trusted configuration facts, never supplied request authority.
 * This module contains no configured image or assertion of native eligibility. */
import path from 'node:path'
export const GENERIC_ENVIRONMENT_KEYS: readonly string[] = Object.freeze([
  'SOURCE_DATE_EPOCH',
  'FORCE_SOURCE_DATE',
  'TZ',
])
export const COMPILE_ENVIRONMENT_KEYS: readonly string[] = Object.freeze([
  ...GENERIC_ENVIRONMENT_KEYS,
  'OVERLEAF_PROJECT_ID',
  'openout_any',
  'max_print_line',
  'CHKTEX_OPTIONS',
  'CHKTEX_ULIMIT_OPTIONS',
  'CHKTEX_EXIT_ON_ERROR',
  'CHKTEX_VALIDATE',
  'ENABLE_CHECKPOINT',
])
export const GENERIC_JOB_ENVIRONMENT = Object.freeze({
  HOME: '/home/tex',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  TEXMFVAR: '/tmp/texmf-var',
  TEXMFCONFIG: '/tmp/texmf-config',
})
export const PROTECTED_ENVIRONMENT_KEYS: readonly string[] = Object.freeze([
  'HOME',
  'PATH',
  'TEXMFVAR',
  'TEXMFCONFIG',
  'CLSI',
])
const PIN = /^(?:sha256:|[a-zA-Z0-9./:_-]+@sha256:)[a-f0-9]{64}$/
export function safeCommandString(
  value: unknown,
  maximum = 4096
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value) > maximum ||
    Array.from(value).some(
      character =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new Error('Invalid bounded command value')
}
export function validateAdmittedEnvironment(
  environment: Readonly<Record<string, string>>,
  compile: boolean
): Readonly<Record<string, string>> {
  const keys: readonly string[] = compile
    ? COMPILE_ENVIRONMENT_KEYS
    : GENERIC_ENVIRONMENT_KEYS
  const entries = Object.entries(environment)
  if (entries.length > keys.length)
    throw new Error('Unapproved compile environment')
  for (const [key, value] of entries) {
    if (!keys.includes(key)) throw new Error('Unapproved compile environment')
    safeCommandString(value, 1024)
  }
  return Object.freeze(Object.fromEntries(entries))
}
export function requireCompilerProfileIdentifier(id: string): void {
  safeCommandString(id, 128)
  if (!/^[a-zA-Z0-9._-]+$/.test(id))
    throw new Error('Invalid compiler profile identifier')
}
export interface TrustedCompilerProfile {
  readonly id: string
  readonly image: string
  readonly aliases: readonly string[]
  readonly variant: 'standard' | 'checkpoint'
  readonly texBinDirectory: string
  readonly tools: Readonly<{
    latexmk: string
    texcount: string
    synctex: string
    time?: string
  }>
  readonly latexmkCommandPrefix?: readonly string[]
}
function absoluteTool(value: string): void {
  safeCommandString(value, 1024)
  if (
    !path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.includes('\\') ||
    value === '/' ||
    value.endsWith('/')
  )
    throw new Error('Missing absolute trusted tool binding')
}
export function snapshotCompilerProfiles(
  profiles: readonly TrustedCompilerProfile[] = []
): readonly TrustedCompilerProfile[] {
  if (!Array.isArray(profiles) || profiles.length > 64)
    throw new Error('Invalid compiler profile inventory')
  const identities = new Set<string>(),
    aliases = new Set<string>()
  return Object.freeze(
    profiles.map(input => {
      const { id, image, variant, texBinDirectory } = input
      const names = [...input.aliases],
        tools = { ...input.tools },
        prefix = [...(input.latexmkCommandPrefix ?? [])]
      requireCompilerProfileIdentifier(id)
      if (
        identities.has(id) ||
        !PIN.test(image) ||
        !['standard', 'checkpoint'].includes(variant) ||
        names.length === 0 ||
        names.length > 64
      )
        throw new Error('Invalid compiler profile binding')
      identities.add(id)
      absoluteTool(texBinDirectory)
      for (const tool of [tools.latexmk, tools.texcount, tools.synctex])
        absoluteTool(tool)
      if (tools.time !== undefined) absoluteTool(tools.time)
      if (
        prefix.length !== 0 &&
        (tools.time === undefined ||
          prefix.length !== 2 ||
          prefix[0] !== tools.time ||
          prefix[1] !== '-v')
      )
        throw new Error('Unsupported compiler prefix profile')
      for (const alias of new Set([image, ...names])) {
        safeCommandString(alias, 512)
        const key = variant + ':' + alias
        if (aliases.has(key)) throw new Error('Ambiguous compiler alias')
        aliases.add(key)
      }
      return Object.freeze({
        id,
        image,
        variant,
        texBinDirectory,
        aliases: Object.freeze(names),
        tools: Object.freeze(tools),
        latexmkCommandPrefix: Object.freeze(prefix),
      })
    })
  )
}
export function protectedProfileEnvironment(
  profile: TrustedCompilerProfile
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...GENERIC_JOB_ENVIRONMENT,
    PATH: `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${profile.texBinDirectory}`,
    CLSI: '1',
  })
}
export function selectedCompilerProfile(
  profiles: readonly TrustedCompilerProfile[] | undefined,
  id: string,
  image: string,
  argv: readonly string[]
): TrustedCompilerProfile {
  const profile = profiles?.find(profile => profile.id === id)
  if (!profile || profile.image !== image)
    throw new Error('Unapproved compiler image/profile')
  const prefix = profile.latexmkCommandPrefix ?? []
  const filename = argv[3]
  const wordcount =
    argv.length === 4 &&
    argv[0] === profile.tools.texcount &&
    argv[1] === '-nocol' &&
    argv[2] === '-inc' &&
    filename !== undefined &&
    filename.startsWith('/compile/') &&
    !filename.includes('\\') &&
    path.posix.normalize(filename) === filename &&
    !filename.endsWith('/')
  const latex =
    argv[prefix.length] === profile.tools.latexmk &&
    prefix.every((arg, i) => argv[i] === arg) &&
    argv.includes('-auxdir=/compile') &&
    argv.includes('-outdir=/compile')
  if (latex)
    throw new Error('Bounded compiler content preparation is not implemented')
  if (!wordcount) throw new Error('Compiler tools do not match trusted profile')
  return profile
}
/** A caller cannot opt a configured image out of its trusted profile policy.
 * Equivalent immutable-pin spellings still identify the same image digest. */
export function resolveCompilerProfile(
  profiles: readonly TrustedCompilerProfile[] | undefined,
  id: string | undefined,
  image: string,
  argv: readonly string[]
): TrustedCompilerProfile | undefined {
  if (id === undefined) {
    const knownCompilerImage =
      profiles?.some(
        profile => profile.image.slice(-64) === image.slice(-64)
      ) ?? false
    if (knownCompilerImage) throw new Error('Missing selected compiler profile')
    return undefined
  }
  return selectedCompilerProfile(profiles, id, image, argv)
}
/** Validate the concrete legacy defaults without coercing arbitrary values. */
export function configuredCompilerEnvironment(
  input: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, string>> {
  const defaults: Readonly<Record<string, string | number>> = {
    HOME: '/tmp',
    TEXMFVAR: '/tmp/texmf-var',
    TEXMFCONFIG: '/tmp/texmf-config',
    CLSI: 1,
  }
  const output: Record<string, string> = {}
  for (const [key, raw] of Object.entries(input)) {
    if (Object.hasOwn(defaults, key)) {
      if (raw !== defaults[key] && !(key === 'CLSI' && raw === '1'))
        throw new Error('Unsupported protected compiler setting')
      continue
    }
    if (PROTECTED_ENVIRONMENT_KEYS.includes(key))
      throw new Error('Unsupported protected compiler setting')
    if (!COMPILE_ENVIRONMENT_KEYS.includes(key))
      throw new Error('Unapproved configured environment key')
    const value =
      raw === 1 &&
      ['CHKTEX_EXIT_ON_ERROR', 'CHKTEX_VALIDATE', 'ENABLE_CHECKPOINT'].includes(
        key
      )
        ? '1'
        : raw
    safeCommandString(value, 1024)
    output[key] = value
  }
  validateAdmittedEnvironment(output, true)
  return Object.freeze(output)
}

export function validateSelectedEnvironment(
  environment: Readonly<Record<string, string>>,
  profile: TrustedCompilerProfile
): void {
  if (!/^[a-f0-9]{24}$/.test(environment.OVERLEAF_PROJECT_ID ?? ''))
    throw new Error('Missing compiler project context')
  const exact: Readonly<Record<string, string>> = {
    CHKTEX_OPTIONS: '-nall -e9 -e10 -w15 -w16',
    CHKTEX_ULIMIT_OPTIONS: '-t 5 -v 64000',
    CHKTEX_EXIT_ON_ERROR: '1',
    CHKTEX_VALIDATE: '1',
    ENABLE_CHECKPOINT: '1',
  }
  for (const [key, value] of Object.entries(environment))
    if (Object.hasOwn(exact, key) && value !== exact[key])
      throw new Error('Unsupported compiler environment value')
  if (
    environment.CHKTEX_EXIT_ON_ERROR !== undefined &&
    environment.CHKTEX_VALIDATE !== undefined
  )
    throw new Error('Conflicting compiler checks')
  if (
    (environment.ENABLE_CHECKPOINT === '1') !==
    (profile.variant === 'checkpoint')
  )
    throw new Error('Compiler variant environment mismatch')
}
