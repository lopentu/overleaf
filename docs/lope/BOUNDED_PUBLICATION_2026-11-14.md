# Bounded compile output publication — November 14

This source unit publishes complete output under the existing immutable build
namespace. It remains unselected. Production still uses the stock compiler;
this change does not activate the compiler bridge or establish sandboxing,
migration acceptance, reader access or hosted feature parity.

Open `openCompileOutputPublisher(admission, configuration)` against an owned
canonical output root. Only a completed fresh source operation belonging to
that exact manager can publish; an active or failed job cannot. The factory's
single optional filesystem transaction slot is reused by the plan cache and
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

The independent preparation review verified 354 frozen input hashes, all 13
existing preimages and 11 absent new paths. Its 24-file patch SHA256 is
`a8a393580048f80d9bed671b6f68a46f8348d1220e86c20989e381745f764ee9`.
Independent replay passed all 504 cases in 33 files, all five genuine type
configurations, and zero-warning lint/formatting. Eleven omitted guards each
failed behaviorally, then exact restoration passed all 504 cases again.
Fourteen new native publication modes exercise actual Node/filesystem behavior;
these are not Docker, cross-device mount or different-reader-UID acceptance.
The existing 19 hooks and required quality CI remain blocking and unchanged.
Actual-fork hook and CI results belong to the final integration record.
