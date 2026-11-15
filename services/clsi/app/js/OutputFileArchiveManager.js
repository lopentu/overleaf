import { isOutputZipFile } from './OutputArchiveFiles.ts'
import archiver from 'archiver'
import OutputCacheManager from './OutputCacheManager.js'
import OutputFileFinder from './OutputFileFinder.js'
import Settings from '@overleaf/settings'
import { open } from 'node:fs/promises'
import { NotFoundError } from './Errors.js'
import logger from '@overleaf/logger'

function getContentDir(projectId, userId) {
  let subDir
  if (userId != null) {
    subDir = `${projectId}-${userId}`
  } else {
    subDir = projectId
  }
  return `${Settings.path.outputDir}/${subDir}/`
}

export default {
  async archiveFilesForBuild(projectId, userId, build) {
    logger.debug({ projectId, userId, build }, 'Will create zip file')

    const contentDir = getContentDir(projectId, userId)

    const outputFiles = await this._getAllOutputFiles(
      contentDir,
      projectId,
      userId,
      build
    )

    const archive = archiver('zip')

    archive.on('error', err => {
      logger.warn(
        { err, projectId, userId, build },
        'error emitted when creating output files archive'
      )
    })

    archive.on('warning', err => {
      logger.warn(
        { err, projectId, userId, build },
        'warning emitted when creating output files archive'
      )
    })

    const missingFiles = []

    for (const { path } of outputFiles) {
      let fileHandle
      try {
        fileHandle = await open(
          `${contentDir}${OutputCacheManager.path(build, path)}`
        )
      } catch (error) {
        logger.warn(
          { path, error, projectId, userId, build },
          'error opening file to add to output files archive'
        )
        missingFiles.push(path)
        continue
      }
      const fileStream = fileHandle.createReadStream()
      archive.append(fileStream, { name: path })
    }

    if (missingFiles.length > 0) {
      archive.append(missingFiles.join('\n'), {
        name: 'missing_files.txt',
      })
    }

    archive.finalize().catch(error => {
      logger.error(
        { error, projectId, userId, build },
        'error finalizing output files archive'
      )
    })

    return archive
  },

  async _getAllOutputFiles(contentDir, projectId, userId, build) {
    try {
      const { outputFiles } = await OutputFileFinder.promises.findOutputFiles(
        [],
        `${contentDir}${OutputCacheManager.path(build, '.')}`
      )

      return outputFiles.filter(({ path }) => isOutputZipFile(path))
    } catch (error) {
      if (
        error.code === 'ENOENT' ||
        error.code === 'ENOTDIR' ||
        error.code === 'EACCES'
      ) {
        throw new NotFoundError('Output files not found')
      }
      throw error
    }
  },
}
