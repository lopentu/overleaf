# Bounded compile output publication — November 14

This source unit publishes complete output under the existing immutable build
namespace. It remains unselected. Production still uses the stock compiler;
this change does not activate the compiler bridge or establish sandboxing,
migration acceptance, reader access or hosted feature parity.

Open `openCompileOutputPublisher(admission, configuration)` against an owned
canonical output root. Publication requires completed source preparation and
an exact completed `runArtifacts` result on that same manager's flow. One flow
record retains the checked output path and existing job UUID as its revision;
every accepted next job invalidates it. Publication captures that revision and
checks path/revision before copying, before rename and before synchronous commit.
No-job, generic/stdout, active/rejected and wrong-path results cannot authorize
publication. A nonzero compiler exit may still supply completed diagnostics;
this is not an exit-code-zero requirement. The factory's single optional
filesystem transaction slot is reused by the plan cache and
publisher sequentially. No second queue, registry or cleanup stack is added.

The candidate is copied under the owned private operation before entering the
existing logical output-directory queue. Generated files are limited to 16 MiB
each, 64 MiB total and 4,096 entries including the root. Hidden and strace files
are charged before the existing filter. The walk holds one directory handle.
File/link/inode/owner checks, bounded streaming and joined close precede commit.
Artifact, candidate and output roots must share a device; no cross-device copy
fallback is supplied. These limits are application budgets, not disk/RSS quotas.

Explicit occupied build IDs always fail, including identical bytes, empty
directories and symlinks. Generated IDs try at most three candidates. Complete
rename and exact target/cancellation checks precede synchronous commit. All
trusted writers must share the existing queue: Node rename is not a hostile
same-UID no-replace primitive. A complete cancelled tree can be transiently
visible before rollback. Failed or uncertain cleanup holds the original flow
and capacity, joins outstanding I/O, and retries the exact owned target even if
its private parent is already gone. Committed builds survive cancellation.

Retention reuses the original ledger and non-queuing expiry primitive while
owning the original queue. Its inclusive index semantics remain three recent
project builds or two per-user builds. Expiry is best effort after commit and
stays registered with the existing scheduler; it cannot revoke publication.

A genuine internal `BuildIdConflictError` maps to HTTP 409 with
`compile.status: error`, `error: build-id-conflict`, and empty `outputFiles`.
The web response policy recognizes only that exact pair, removes attached old
output identities, and avoids a full resync/recompile. Other HTTP 409 errors
and missing-updates keep their existing retry behavior.

Optional host qpdf, archived logs/strace, PDF cache/worker and CLSI cache
profiles explicitly refuse publication until their separate finite contracts
are accepted. ZIP, SyncTeX, static-reader lifetime, actual commands, Express
original-body capture and route selection remain follow-on work.

Initial publication tests did not prove artifact provenance: an idle source
scope could publish its original input output.pdf. Independent actual-API
reproductions exposed that P2, including wrong-source acceptance after a genuine
`runArtifacts` call using a synthetic filesystem executor. The repaired flow
record closes both cases without a second owner or registry. Real Node held-I/O
controls also change the job revision while preserving the same directory/inode;
copy and post-rename publication refuse or roll back the stale revision.

The narrow repair has 12 exact source paths on the initial publication commit,
10 existing and two new; patch SHA256
`7beb4dbdfcf993f90d9e89d5f1d3fccc23bd7d3c0a268be72f78c0ee50d953fa`.
Its frozen 303-input manifest is
`0ee9fed91b67346cb79b1a6d130222b665997b9514e1dba642e45bc7ea13d8b7`.
Composed replay passes 515 cases in 34 files and all five genuine type gates,
with zero-warning lint/formatting. Sixteen omission controls fail behaviorally
and restore exact bytes. Independent review reruns the original two API
reproductions, eight authority cases and three same-inode revision controls.
The 17 publication native modes are actual Node/filesystem tests, not Docker,
cross-device mount, different-reader-UID or real compiler acceptance. The
existing 19 hooks and required quality CI remain blocking and unchanged;
actual integration results belong to the final PR record.
