import assert from 'node:assert/strict'
import { test } from 'vitest'

// Missing-feature RED is an assertion in each case, not a failed test loader.
async function seam() {
  const value = await import('../../../app/js/LatexCommand.ts').catch(
    () => undefined
  )
  assert.ok(value, 'strict shared command seam is absent')
  return value
}
const BASE = [
  'latexmk',
  '-cd',
  '-jobname=output',
  '-auxdir=$COMPILE_DIR',
  '-outdir=$COMPILE_DIR',
  '-synctex=1',
  '-interaction=batchmode',
  '-time',
]
for (const [compiler, flag] of [
  ['latex', '-pdfdvi'],
  ['pdflatex', '-pdf'],
  ['lualatex', '-lualatex'],
  ['xelatex', '-xelatex'],
] as const) {
  test(`shared legacy command preserves exact ${compiler} argv`, async () => {
    const { buildLatexCommand } = await seam()
    assert.deepEqual(buildLatexCommand('chapter/文 space.tex', { compiler }), [
      ...BASE,
      '-f',
      flag,
      '$COMPILE_DIR/chapter/文 space.tex',
    ])
  })
}
test('shared builder preserves prefix, strace, halt and literal extra flag ordering', async () => {
  const { buildLatexCommand } = await seam()
  assert.deepEqual(
    buildLatexCommand(
      'main.tex',
      {
        compiler: 'pdflatex',
        stopOnFirstError: true,
        flags: ['-shell-restricted', 'literal;$(no)'],
      },
      { strace: true, latexmkCommandPrefix: ['/usr/bin/time', '-v'] }
    ),
    [
      'strace',
      '-o',
      'strace',
      '-ff',
      '/usr/bin/time',
      '-v',
      ...BASE,
      '-halt-on-error',
      '-shell-restricted',
      'literal;$(no)',
      '-pdf',
      '$COMPILE_DIR/main.tex',
    ]
  )
})
for (const extension of ['Rtex', 'Rmd', 'md', 'Rnw']) {
  test(`shared legacy builder retains ${extension} naming conversion only`, async () => {
    const { buildLatexCommand } = await seam()
    assert.equal(
      buildLatexCommand(`source.${extension}`, { compiler: 'pdflatex' }).at(-1),
      '$COMPILE_DIR/source.tex'
    )
  })
}
test('candidate construction binds absolute tools/context without rewriting literal placeholders in filenames', async () => {
  const { buildLatexCommand } = await seam()
  assert.deepEqual(
    buildLatexCommand(
      'nested/$COMPILE_DIR literal.tex',
      { compiler: 'xelatex' },
      {},
      { directory: '/compile', executable: '/fixture/latexmk' }
    ),
    [
      '/fixture/latexmk',
      '-cd',
      '-jobname=output',
      '-auxdir=/compile',
      '-outdir=/compile',
      '-synctex=1',
      '-interaction=batchmode',
      '-time',
      '-f',
      '-xelatex',
      '/compile/nested/$COMPILE_DIR literal.tex',
    ]
  )
})
test('shared environment derives numeric chktex switches and actual tex-only behavior', async () => {
  const { deriveCompileEnvironment } = await seam()
  assert.deepEqual(
    deriveCompileEnvironment({
      projectId: 'logical-project',
      mainFile: 'main.TeX',
      check: 'validate',
      openoutAny: 'p',
      maxPrintLine: '1000',
    }),
    {
      OVERLEAF_PROJECT_ID: 'logical-project',
      openout_any: 'p',
      max_print_line: '1000',
      CHKTEX_OPTIONS: '-nall -e9 -e10 -w15 -w16',
      CHKTEX_ULIMIT_OPTIONS: '-t 5 -v 64000',
      CHKTEX_VALIDATE: 1,
    }
  )
  assert.deepEqual(
    deriveCompileEnvironment({
      projectId: 'logical-project',
      mainFile: 'main.Rtex',
      check: 'error',
    }),
    { OVERLEAF_PROJECT_ID: 'logical-project' }
  )
  assert.equal(
    deriveCompileEnvironment({
      projectId: 'logical-project',
      mainFile: 'main.tex',
      check: 'error',
    }).CHKTEX_EXIT_ON_ERROR,
    1
  )
})
test('shared builder captures option/settings/context getters once before using their values', async () => {
  const { buildLatexCommand } = await seam()
  let compilerReads = 0,
    prefixReads = 0,
    directoryReads = 0
  const argv = buildLatexCommand(
    'main.tex',
    {
      get compiler() {
        compilerReads++
        return 'pdflatex'
      },
    },
    {
      get latexmkCommandPrefix() {
        prefixReads++
        return ['/fixture/time', '-v']
      },
    },
    {
      get directory() {
        directoryReads++
        return '/compile'
      },
      executable: '/fixture/latexmk',
    }
  )
  assert.equal(compilerReads, 1)
  assert.equal(prefixReads, 1)
  assert.equal(directoryReads, 1)
  assert.deepEqual(argv, [
    '/fixture/time',
    '-v',
    '/fixture/latexmk',
    '-cd',
    '-jobname=output',
    '-auxdir=/compile',
    '-outdir=/compile',
    '-synctex=1',
    '-interaction=batchmode',
    '-time',
    '-f',
    '-pdf',
    '/compile/main.tex',
  ])
})
test('environment derivation snapshots configured getters instead of validating one value and emitting another', async () => {
  const { deriveCompileEnvironment } = await seam()
  let reads = 0
  const result = deriveCompileEnvironment({
    projectId: 'project',
    mainFile: 'main.tex',
    get openoutAny() {
      reads++
      return reads === 1 ? 'p' : 'a'
    },
  })
  assert.equal(reads, 1)
  assert.equal(result.openout_any, 'p')
})
test('unknown inherited engine names cannot become executable argv values', async () => {
  const { buildLatexCommand } = await seam()
  assert.throws(
    () => buildLatexCommand('main.tex', { compiler: 'constructor' }),
    /unknown compiler/
  )
})
