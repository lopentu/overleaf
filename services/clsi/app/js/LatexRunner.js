import Path from 'node:path'
import { buildLatexCommand } from './LatexCommand.ts'
import { promisify } from 'node:util'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import CommandRunner from './CommandRunner.js'
import LatexMetrics from './LatexMetrics.js'
import fs from 'node:fs'

const { addLatexMkMetrics } = LatexMetrics

const ProcessTable = {} // table of currently running jobs (pids or docker container names)

const TIME_V_METRICS = [
  ['cpu-percent', /Percent of CPU this job got: (\d+)/m],
  ['cpu-time', /User time.*: (\d+.\d+)/m],
  ['sys-time', /System time.*: (\d+.\d+)/m],
]

function runLatex(projectId, options, callback) {
  const {
    directory,
    mainFile,
    image,
    environment,
    flags,
    compileGroup,
    stopOnFirstError,
    stats,
    timings,
  } = options
  const compiler = options.compiler || 'pdflatex'
  const timeout = options.timeout || 60000 // milliseconds

  logger.debug(
    {
      directory,
      compiler,
      timeout,
      mainFile,
      environment,
      flags,
      compileGroup,
      stopOnFirstError,
    },
    'starting compile'
  )

  let command
  try {
    command = _buildLatexCommand(mainFile, {
      compiler,
      stopOnFirstError,
      flags,
    })
  } catch (err) {
    return callback(err)
  }

  const id = `${projectId}` // record running project under this id

  ProcessTable[id] = CommandRunner.run(
    projectId,
    command,
    directory,
    image,
    timeout,
    environment,
    compileGroup,
    null,
    function (error, output) {
      delete ProcessTable[id]
      if (error) {
        return callback(error)
      }
      if (stats.latexmk) {
        try {
          addLatexMkMetrics(output, stats, timings)
        } catch (err) {
          logger.error({ err, projectId }, 'error adding latexmk metrics')
        }
      }
      // number of latex runs and whether there were errors
      const runs =
        output?.stdout?.match(/^Run number \d+ of .*latex/gm)?.length || // TeXLive 2022 and later
        output?.stderr?.match(/^Run number \d+ of .*latex/gm)?.length || // TeXLive 2021 and earlier
        0
      const failed = output?.stdout?.match(/^Latexmk: Errors/m) != null ? 1 : 0
      // counters from latexmk output
      stats['latexmk-errors'] = failed
      stats['latex-runs'] = runs
      stats['latex-runs-with-errors'] = failed ? runs : 0
      stats[`latex-runs-${runs}`] = 1
      stats[`latex-runs-with-errors-${runs}`] = failed ? 1 : 0
      // timing information from /usr/bin/time
      const stderr = (output && output.stderr) || ''
      if (stderr.includes('Command being timed:')) {
        // Add metrics for runs with `$ time -v ...`
        for (const [timing, matcher] of TIME_V_METRICS) {
          const match = stderr.match(matcher)
          if (match) {
            timings[timing] = parseFloat(match[1])
          }
        }
      }
      // record output files
      _writeLogOutput(projectId, directory, output, () => {
        callback(error, output)
      })
    }
  )
}

function _writeLogOutput(projectId, directory, output, callback) {
  if (!output) {
    return callback()
  }
  // internal method for writing non-empty log files
  function _writeFile(file, content, cb) {
    if (content && content.length > 0) {
      fs.unlink(file, () => {
        fs.writeFile(file, content, { flag: 'wx' }, err => {
          if (err) {
            // don't fail on error
            logger.error({ err, projectId, file }, 'error writing log file')
          }
          cb()
        })
      })
    } else {
      cb()
    }
  }
  // write stdout and stderr, ignoring errors
  _writeFile(Path.join(directory, 'output.stdout'), output.stdout, () => {
    _writeFile(Path.join(directory, 'output.stderr'), output.stderr, () => {
      callback()
    })
  })
}

function isRunning(projectId) {
  const id = `${projectId}`
  return ProcessTable[id] != null
}

function killLatex(projectId, callback) {
  const id = `${projectId}`
  logger.debug({ id }, 'killing running compile')
  if (!isRunning(projectId)) {
    logger.warn({ id }, 'no such project to kill')
    callback(null)
  } else {
    CommandRunner.kill(ProcessTable[id], callback)
  }
}

function _buildLatexCommand(mainFile, opts = {}) {
  const settings = Settings.clsi
  return buildLatexCommand(mainFile, opts, {
    strace: settings?.strace,
    latexmkCommandPrefix: settings?.latexmkCommandPrefix,
  })
}

export default {
  isRunning,
  runLatex,
  killLatex,
  promises: {
    runLatex: promisify(runLatex),
    killLatex: promisify(killLatex),
  },
}
