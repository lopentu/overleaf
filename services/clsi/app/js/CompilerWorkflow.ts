import type {
  CompilerAdmission,
  WorkflowScope,
  WorkflowFilter,
} from './CompilerAdmission.ts'
import { assertActiveWorkflowScope } from './CompilerAdmission.ts'
import { CompileSourcePlanCache } from './CompileSourcePlanCache.ts'
import {
  parseFullSourcePlan,
  materializeFullSource,
  withPreparedCompileInput,
} from './FreshCompileInput.ts'
import {
  materializedHistoryVersion,
  materializedCompileOptions,
} from './CompileSourcePlan.ts'
import { withCompileInputSnapshot } from './CompileInputSnapshot.ts'
import {
  openCompileOutputPublisher,
  type PublicationProfile,
  type CompileOutputPublisher,
} from './CompileOutputPublisher.ts'
import { createCompilerCommandPlanner } from './CompilerCommandPlan.ts'
import type { TrustedCompilerProfile } from './CompileEnvironment.ts'
import { parseWordcountOutput } from './WordcountOutput.ts'
import SynctexOutputParser from './SynctexOutputParser.js'
import { z } from '@overleaf/validation-tools'
import { canonicalProjectArchivePath } from './BoundedProjectArchive.ts'
import type { SyncTexQuery } from './PreparedSyncTexInput.ts'
import { openPublishedOutputReader } from './PublishedOutputReader.ts'
import type { SourceDownloadPolicy } from './SourceDownloadUrls.ts'

export interface CompilerWorkflowConfiguration {
  readonly stagingRoot: string
  readonly sourceCacheRoot: string
  readonly sourceDownload?: SourceDownloadPolicy
  readonly outputRoot: string
  readonly defaultImage: string
  readonly profiles: readonly TrustedCompilerProfile[]
  readonly environment?: Readonly<Record<string, unknown>>
  readonly publication: PublicationProfile
}
interface WordcountOptions {
  mainFile: string
  image?: string
}
/** Internal orchestration over the one genuine existing manager. Constructing this
 * object does not qualify a daemon, kernel or runtime, or open any public route. */
export async function openCompilerWorkflow(
  manager: CompilerAdmission,
  configuration: CompilerWorkflowConfiguration
) {
  const {
    stagingRoot,
    sourceCacheRoot,
    sourceDownload,
    outputRoot,
    defaultImage,
    profiles,
    environment,
    publication,
  } = configuration
  const planner = createCompilerCommandPlanner(manager, {
    profiles,
    defaultImage,
    ...(environment === undefined ? {} : { environment }),
  })
  const cache = await CompileSourcePlanCache.open(manager, sourceCacheRoot)
  const publisher: CompileOutputPublisher = await openCompileOutputPublisher(
    manager,
    { outputRoot, profile: publication }
  )
  const reader = await openPublishedOutputReader(manager, outputRoot)
  const sourceConfiguration = {
    stagingRoot,
    ...(sourceDownload === undefined ? {} : { sourceDownload }),
  }
  return Object.freeze({
    reader,
    async compile(scope: WorkflowScope, decodedBytes: Buffer) {
      assertActiveWorkflowScope(scope, manager, true)
      if (scope.metadata.kind !== 'compile')
        throw new Error('Invalid compile workflow')
      const plan = await parseFullSourcePlan(scope, decodedBytes)
      await materializeFullSource(scope, plan, sourceConfiguration)
      await cache.install(scope, plan)
      const result = await withPreparedCompileInput(
        scope,
        manager,
        plan,
        async prepared => {
          const command = planner.compile(scope, {
            mainFile: prepared.options.mainFile,
            compiler: prepared.options.compiler,
            preparedInput: prepared,
          })
          const execution = await scope.runArtifacts({
            ...command,
            inputDirectory: prepared.inputDirectory,
            outputDirectory: prepared.outputDirectory,
          })
          return {
            execution,
            buildId: prepared.options.buildId,
            check: prepared.options.check,
            stopOnFirstError: prepared.options.stopOnFirstError,
          }
        }
      )
      const published = await publisher.publish(scope, {
        outputDirectory: result.execution.outputDirectory,
        ...(result.buildId === undefined ? {} : { buildId: result.buildId }),
      })
      const baseHistoryVersion = materializedHistoryVersion(scope, plan)
      return Object.freeze({
        ...published,
        exitCode: result.execution.exitCode,
        check: result.check,
        stopOnFirstError: result.stopOnFirstError,
        ...(baseHistoryVersion === undefined ? {} : { baseHistoryVersion }),
      })
    },
    async wordcount(
      scope: WorkflowScope,
      options: WordcountOptions,
      decodedBytes?: Buffer
    ) {
      assertActiveWorkflowScope(scope, manager, true)
      if (scope.metadata.kind !== 'wordcount')
        throw new Error('Invalid wordcount workflow')
      const plan =
        decodedBytes === undefined
          ? await cache.load(scope)
          : await parseFullSourcePlan(scope, decodedBytes)
      const source = await materializeFullSource(
        scope,
        plan,
        sourceConfiguration
      )
      materializedCompileOptions(scope, plan)
      if (decodedBytes !== undefined) await cache.install(scope, plan)
      return await withCompileInputSnapshot(
        { ...source, signal: scope.signal },
        async snapshot => {
          const command = planner.wordcount(scope, options)
          const result = await scope.runStdout({
            ...command,
            inputDirectory: snapshot.inputDirectory,
          })
          if (result.exitCode !== 0)
            throw new Error('Wordcount execution failed')
          return parseWordcountOutput(result.stdout.toString('utf8'))
        }
      )
    },
    async synctex(
      scope: WorkflowScope,
      buildId: string,
      query: SyncTexQuery,
      image?: string
    ) {
      return await reader.withSnapshot(
        scope,
        buildId,
        stagingRoot,
        query,
        async prepared => {
          const command = planner.synctex(scope, prepared, image)
          const result = await scope.runStdout({
            ...command,
            inputDirectory: prepared.inputDirectory,
          })
          if (result.exitCode !== 0) throw new Error('SyncTeX execution failed')
          const output = result.stdout.toString('utf8')
          if (query.kind === 'code') {
            const positions: unknown =
              SynctexOutputParser.parseViewOutput(output)
            return {
              pdf: z
                .array(
                  z.object({
                    page: z.number().finite().optional(),
                    h: z.number().finite().optional(),
                    v: z.number().finite().optional(),
                    width: z.number().finite().optional(),
                    height: z.number().finite().optional(),
                  })
                )
                .max(4096)
                .parse(positions),
              downloadedFromCache: false,
            }
          }
          const positions: unknown = SynctexOutputParser.parseEditOutput(
            output,
            '/compile'
          )
          const parsed = z
            .array(
              z.object({
                file: z.string().optional(),
                line: z.number().finite().optional(),
                column: z.number().finite().optional(),
              })
            )
            .max(4096)
            .parse(positions)
          for (const position of parsed)
            if (position.file !== undefined)
              canonicalProjectArchivePath(position.file, false)
          return { code: parsed, downloadedFromCache: false }
        }
      )
    },
    reset(filter: WorkflowFilter): Promise<void> {
      if (filter.kind !== undefined) throw new Error('Invalid reset scope')
      return cache.resetAndClear({
        projectId: filter.projectId,
        ...(filter.userId === undefined ? {} : { userId: filter.userId }),
      })
    },
    stop(filter: WorkflowFilter): Promise<void> {
      return manager.cancelAndWait(filter)
    },
  })
}
export type CompilerWorkflow = Awaited<ReturnType<typeof openCompilerWorkflow>>
