# Project editor update queue

`ProjectUpdateQueue.js` exposes an opt-in queue protocol. Instantiate it with
the existing document-updater Redis client and `Keys.pendingProjectUpdates`.
Importing the module does not change either service’s live queue behavior.

`enqueue` checks an operation’s document fence and appends to the existing
project list in one Lua evaluation. `claimBatch` keeps up to eight operations
in a separate in-flight list until `acknowledgeBatch` advances the batch
generation. A restart can recover the active ID and generation with
`getBatchState` and replay the same claim. Before acknowledging, the caller
must account for every operation's effects, including operations that reached
storage before a lost response.

`fenceDocument` installs a pending fence only with no queued or in-flight
operations. `resolveDocumentFence` reopens a matching pending fence on a
durable Web abort and keeps the fence closed on commit. Completion records
reject later requests carrying the same operation ID. They require durable
reconciliation before removal.

`popLegacyBatch` checks queue protection and pops up to eight entries in one
project-slot evaluation. It reports `guarded` when the generation key, an
in-flight batch, or a project retirement record exists. The updater's legacy
drain forwards this refusal as `ProjectUpdateQueueGuardedError`. The caller
must use the guarded path before assuming the queue is drained. A separate
`getDrainMode` read helps choose a path and cannot authorize a later raw pop.
`RealTimeRedisManager.guardedProjectQueue` reuses the same queue instance
and Redis connection for guarded processing.

`protectLegacyDrain` explicitly arms a project by creating its existing
non-expiring generation key with value `0`. Guarded admission, a nonempty
claim, and a successful fence arm the same marker in the script before they
publish queue state. Empty polls preserve the default legacy state. The
marker survives batch acknowledgement and service configuration changes. A
Stream marker for the first admitted operation also wakes any older entries
still on the shared project list. Explicit protection of an already queued
project requires a guarded wake to drain that backlog.

Deploy the guarded-aware legacy consumer before enabling guarded producers.
Complete any already-popped legacy work and switch producers together with
consumers before relying on retirement fences. A patched consumer rejects
a stale legacy wake after the project becomes guarded. An unpatched
consumer or raw legacy producer can still bypass the protocol. There is no
supported switch back to destructive draining for a protected project.
Preserve the generation, active batch, admission and retirement data when
rolling back configuration or restoring Redis. Pending guarded work needs a
compatible consumer to reconcile it before any downgrade to older software.
Direct document writes, cache loaders, dispatch, and the authoritative Web
and history transactions have their own recovery requirements.
