import path from 'node:path'

export interface LatexCommandOptions {
  compiler?: string
  stopOnFirstError?: boolean
  flags?: readonly string[]
}
export interface LatexCommandSettings {
  strace?: boolean
  latexmkCommandPrefix?: readonly string[]
}
export interface LatexCommandContext {
  directory: string
  executable: string
}
const COMPILER_FLAGS: Readonly<Record<string, string>> = Object.freeze({
  latex: '-pdfdvi',
  lualatex: '-lualatex',
  pdflatex: '-pdf',
  xelatex: '-xelatex',
})
/** Pure extraction of the legacy builder. Context changes only constructed slots,
 * never text inside a literal filename or supplied flag. No execution/import side effects. */
export function buildLatexCommand(
  mainFile: string,
  opts: LatexCommandOptions = {},
  settings: LatexCommandSettings = {},
  context: LatexCommandContext = {
    directory: '$COMPILE_DIR',
    executable: 'latexmk',
  }
): string[] {
  const { compiler, stopOnFirstError, flags } = opts
  const copiedFlags = flags === undefined ? undefined : [...flags]
  const { strace, latexmkCommandPrefix } = settings
  const prefix =
    latexmkCommandPrefix === undefined ? undefined : [...latexmkCommandPrefix]
  const { directory, executable } = context
  const command: string[] = []
  if (strace) command.push('strace', '-o', 'strace', '-ff')
  if (prefix) command.push(...prefix)
  command.push(
    executable,
    '-cd',
    '-jobname=output',
    `-auxdir=${directory}`,
    `-outdir=${directory}`,
    '-synctex=1',
    '-interaction=batchmode',
    '-time'
  )
  command.push(stopOnFirstError ? '-halt-on-error' : '-f')
  if (copiedFlags) command.push(...copiedFlags)
  const flag =
    compiler === undefined || !Object.hasOwn(COMPILER_FLAGS, compiler)
      ? undefined
      : COMPILER_FLAGS[compiler]
  if (!flag) throw new Error(`unknown compiler: ${compiler}`)
  command.push(flag)
  mainFile = mainFile.replace(/\.(Rtex|md|Rmd|Rnw)$/, '.tex')
  command.push(path.join(directory, mainFile))
  return command
}
export interface CompileEnvironmentOptions {
  projectId: string
  mainFile?: string
  check?: string
  openoutAny?: string
  maxPrintLine?: string
}
/** CompileManager's actual generated values precede its existing variant merge.
 * Numeric switches deliberately remain numeric for the unchanged legacy path. */
export function deriveCompileEnvironment(
  options: CompileEnvironmentOptions
): Record<string, string | 1> {
  const { projectId, mainFile, check, openoutAny, maxPrintLine } = options
  const env: Record<string, string | 1> = { OVERLEAF_PROJECT_ID: projectId }
  if (openoutAny && openoutAny !== '') env.openout_any = openoutAny
  if (maxPrintLine && maxPrintLine !== '') env.max_print_line = maxPrintLine
  if (check != null && mainFile?.match(/\.tex$/i)) {
    env.CHKTEX_OPTIONS = '-nall -e9 -e10 -w15 -w16'
    env.CHKTEX_ULIMIT_OPTIONS = '-t 5 -v 64000'
    if (check === 'error') env.CHKTEX_EXIT_ON_ERROR = 1
    if (check === 'validate') env.CHKTEX_VALIDATE = 1
  }
  return env
}
