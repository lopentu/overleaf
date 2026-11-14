import path from 'node:path'
import {
  assertActiveWorkflowScope,
  type CompilerAdmission,
  type WorkflowScope,
} from './CompilerAdmission.ts'
import {
  configuredCompilerEnvironment,
  snapshotCompilerProfiles,
  safeCommandString,
  type TrustedCompilerProfile,
} from './CompileEnvironment.ts'
export interface CommandPlan {
  readonly image: string
  readonly argv: readonly string[]
  readonly cwd: '/compile'
  readonly timeoutMs: 60000
  readonly environment: Readonly<Record<string, string>>
  readonly compilerProfile: string
  readonly projectId: string
}
interface Settings {
  profiles: readonly TrustedCompilerProfile[]
  defaultImage: string
  environment?: Readonly<Record<string, unknown>>
}
interface WordcountOptions {
  mainFile: string
  image?: string
}
interface CompileOptions extends WordcountOptions {
  compiler: string
}
/** Pure unselected planner. A configured object or returned plan is not a job
 * capability. No real image/tool profile ships here; final JobPolicy remains
 * authoritative for any future request. No staging paths or execution port. */
export function createCompilerCommandPlanner(
  manager: CompilerAdmission,
  settings: Settings
) {
  if (
    Object.keys(settings).some(
      key => !['profiles', 'defaultImage', 'environment'].includes(key)
    )
  )
    throw new Error('Unsupported compiler profile options')
  const profiles = snapshotCompilerProfiles(settings.profiles)
  const defaultImage = settings.defaultImage
  safeCommandString(defaultImage, 512)
  const configured = configuredCompilerEnvironment(settings.environment)
  const environment = Object.fromEntries(
    Object.entries(configured).filter(([key]) =>
      ['SOURCE_DATE_EPOCH', 'FORCE_SOURCE_DATE', 'TZ'].includes(key)
    )
  )
  function scopeContext(
    scope: WorkflowScope,
    kind: 'compile' | 'wordcount'
  ): string {
    assertActiveWorkflowScope(scope, manager, true)
    const { projectId, kind: actualKind } = scope.metadata
    if (actualKind !== kind || !/^[a-f0-9]{24}$/.test(projectId))
      throw new Error('Invalid command workflow context')
    scope.signal.throwIfAborted()
    return projectId
  }
  return Object.freeze({
    wordcount(scope: WorkflowScope, options: WordcountOptions): CommandPlan {
      const projectId = scopeContext(scope, 'wordcount')
      const { mainFile, image = defaultImage } = options
      safeCommandString(mainFile)
      safeCommandString(image, 512)
      if (
        Object.keys(options).some(
          key => !['mainFile', 'image'].includes(key)
        ) ||
        path.posix.isAbsolute(mainFile) ||
        mainFile.includes('\\') ||
        mainFile
          .split('/')
          .some(part => part === '' || part === '.' || part === '..')
      )
        throw new Error('Invalid wordcount source name')
      const profile = profiles.find(
        profile =>
          profile.variant === 'standard' &&
          (profile.image === image || profile.aliases.includes(image))
      )
      if (!profile) throw new Error('Missing trusted image/tool profile')
      scopeContext(scope, 'wordcount')
      return Object.freeze({
        image: profile.image,
        argv: Object.freeze([
          profile.tools.texcount,
          '-nocol',
          '-inc',
          path.posix.join('/compile', mainFile),
        ]),
        cwd: '/compile',
        timeoutMs: 60000,
        compilerProfile: profile.id,
        projectId,
        environment: Object.freeze({
          ...environment,
          OVERLEAF_PROJECT_ID: projectId,
        }),
      })
    },
    compile(scope: WorkflowScope, _options: CompileOptions): never {
      scopeContext(scope, 'compile')
      // .tex and a caller-provided flag do not prove bounded TikZ/transformation
      // preparation. The future real materialized-source contract must earn this.
      throw new Error('Bounded compiler content preparation is not implemented')
    },
  })
}
