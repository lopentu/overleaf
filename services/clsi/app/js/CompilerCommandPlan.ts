import path from 'node:path'
import {
  buildSyncTexCommand,
  PreparedSyncTexInput,
} from './PreparedSyncTexInput.ts'
import { buildLatexCommand, deriveCompileEnvironment } from './LatexCommand.ts'
import {
  requirePreparedCompilerInput,
  PreparedCompilerInput,
} from './PreparedCompilerInput.ts'
import {
  assertActiveWorkflowScope,
  type CompilerAdmission,
  type WorkflowScope,
} from './CompilerAdmission.ts'
import {
  configuredCompilerEnvironment,
  isCompilerProjectId,
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
  preparedInput?: unknown
}
export interface CompileCommandPlan extends Omit<CommandPlan, 'timeoutMs'> {
  readonly timeoutMs: number
  readonly preparedInput: PreparedCompilerInput
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
    kind: 'compile' | 'wordcount' | 'output-read'
  ): string {
    assertActiveWorkflowScope(scope, manager, true)
    const { projectId, kind: actualKind } = scope.metadata
    if (actualKind !== kind || !isCompilerProjectId(projectId))
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
    synctex(
      scope: WorkflowScope,
      preparedInput: PreparedSyncTexInput,
      selectedImage?: string
    ): CommandPlan & { readonly preparedInput: PreparedSyncTexInput } {
      const projectId = scopeContext(scope, 'output-read')
      if (preparedInput.scope !== scope || preparedInput.manager !== manager)
        throw new Error('Invalid SyncTeX workflow')
      const query = PreparedSyncTexInput.require(
        preparedInput,
        preparedInput.inputDirectory,
        projectId
      )
      const image = selectedImage ?? defaultImage
      safeCommandString(image, 512)
      const profile = profiles.find(
        profile =>
          profile.variant === 'standard' &&
          (profile.image === image || profile.aliases.includes(image))
      )
      if (!profile) throw new Error('Missing trusted image/tool profile')
      scopeContext(scope, 'output-read')
      return Object.freeze({
        image: profile.image,
        argv: Object.freeze(buildSyncTexCommand(profile.tools.synctex, query)),
        cwd: '/compile',
        timeoutMs: 60000,
        compilerProfile: profile.id,
        projectId,
        preparedInput,
        environment: Object.freeze({
          ...environment,
          OVERLEAF_PROJECT_ID: projectId,
        }),
      })
    },
    compile(scope: WorkflowScope, options: CompileOptions): CompileCommandPlan {
      const projectId = scopeContext(scope, 'compile')
      const { mainFile, compiler, preparedInput } = options
      if (!(preparedInput instanceof PreparedCompilerInput))
        throw new Error('Missing bounded compiler content preparation')
      const actual = requirePreparedCompilerInput(
        preparedInput,
        preparedInput.inputDirectory,
        projectId
      )
      if (
        mainFile !== actual.mainFile ||
        compiler !== actual.compiler ||
        preparedInput.manager !== manager ||
        preparedInput.scope !== scope
      )
        throw new Error('Compiler preparation does not match workflow')
      if (
        Object.keys(options).some(
          key =>
            !['mainFile', 'compiler', 'image', 'preparedInput'].includes(key)
        )
      )
        throw new Error('Unsupported compile command options')
      const image = options.image ?? actual.imageName ?? defaultImage
      safeCommandString(image, 512)
      const profile = profiles.find(
        profile =>
          profile.variant ===
            (actual.enableCheckpoint ? 'checkpoint' : 'standard') &&
          (profile.image === image || profile.aliases.includes(image))
      )
      if (!profile) throw new Error('Missing trusted image/tool profile')
      const generated = deriveCompileEnvironment({
        projectId,
        mainFile,
        ...(actual.check === undefined ? {} : { check: actual.check }),
      })
      scopeContext(scope, 'compile')
      return Object.freeze({
        image: profile.image,
        argv: Object.freeze(
          buildLatexCommand(
            mainFile,
            actual,
            { latexmkCommandPrefix: profile.latexmkCommandPrefix ?? [] },
            { directory: '/compile', executable: profile.tools.latexmk }
          )
        ),
        cwd: '/compile',
        timeoutMs: actual.timeoutMs,
        compilerProfile: profile.id,
        projectId,
        preparedInput,
        environment: configuredCompilerEnvironment({
          ...configured,
          ...generated,
          ...(actual.enableCheckpoint ? { ENABLE_CHECKPOINT: '1' } : {}),
        }),
      })
    },
  })
}
