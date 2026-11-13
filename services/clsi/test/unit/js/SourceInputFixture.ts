import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { CompilerAdmission } from '../../../app/js/CompilerAdmission.ts'
import {
  CompilerLease,
  OwnedJobReconciler,
} from '../../../app/js/JobOwnership.ts'
import type { JobRequest } from '../../../app/js/JobRequest.ts'
import { OwnershipApiFixture } from './OwnershipApiFixture.ts'
export async function withSourceFixture(
  use: (
    root: string,
    manager: CompilerAdmission,
    api: OwnershipApiFixture
  ) => Promise<void>,
  executor?: ConstructorParameters<typeof CompilerAdmission>[0]
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fresh-source-'))
  const api = new OwnershipApiFixture()
  let manager: CompilerAdmission | undefined
  try {
    await fs.mkdir(path.join(root, 'operations'), { mode: 0o700 })
    await fs.mkdir(path.join(root, 'plans'), { mode: 0o700 })
    manager = new CompilerAdmission(
      executor ?? {
        async run(_request: JobRequest) {
          throw new Error('this source unit must not execute commands')
        },
      },
      new OwnedJobReconciler(
        await api.open(),
        await CompilerLease.acquire(path.join(root, 'manager.sock'))
      ),
      { sweepIntervalMs: 60000 }
    )
    await manager.start()
    await use(root, manager, api)
  } finally {
    await manager?.retryCleanup()
    await manager?.close()
    await api.close()
    await fs.rm(root, { recursive: true, force: true })
  }
}
