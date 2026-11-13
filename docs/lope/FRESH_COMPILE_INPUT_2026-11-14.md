# Fresh authoritative compile input — November 14

This source unit prepares complete input inside a genuine active workflow lease.
It remains unmounted and unselected. It does not activate a worker, change
production, complete publication/commands or establish hosted feature parity.

Use `parseFullSourcePlan(scope, decodedBytes)` followed by
`materializeFullSource(scope, plan, { stagingRoot })`. The caller supplies the
original decoded HTTP JSON bytes, bounded at 7 MiB. The actual Express verify
adapter is still pending; reserializing a mutated parsed body is not equivalent.
The real RequestParser and editor-core interpret full/history-full requests.
Incomplete requests preserve the existing full-resync/missing-updates protocol.
No second parser, scheduler or mutable legacy source cache is added.

The private operation root has separate source/project and jobs directories.
Inline/URL/history writes enforce 50 MiB per file, 100 MiB retained input and
4,096 canonical entries while materializing. Actual fetch-utils handles bounded
cancellation/retries and the existing URL/404 policy. Observed successful/partial
2xx source payload has a finite 300 MiB cumulative ceiling; non-2xx error bodies
have a separate 64 KiB per-response cap. Headers, framing and buffers are
additional. Source URLs, bodies and original transport
exceptions are absent from the sanitized failure objects. These are application
budgets, not heap or filesystem quotas.

The factory claims the manager's single workspace cleanup callback before
allocation, then binds the validated root. Cleanup joins allocator, identity,
writer and the optional current source-plan transaction. Unknown created paths,
failed cleanup and outstanding I/O retain the flow/capacity for safe repair and
retry. A hung syscall has no hard deadline. No host-orphan sweep or durable GC
is supplied. Jobs cannot use a claimed but unbound workspace.

After successful materialization, optional `cache.install(scope, plan)` stores
the bounded original full-request bytes. A later admitted GET wordcount can
`cache.load(scope)` and use the same fresh materializer. The derivative cache
binds to its exact manager: another manager's genuine scope is insufficient.
The aggregate 64 MiB allowance includes pending and old/new overlap; at most
128 plans remain, with 24-hour sliding expiry matching the configured default.
Expiry skips active work using the same non-cancelling control fence.
`resetAndClear` owns cancel/join/fence itself; never nest it inside its own
active scope or another matching reset. Whole-bridge reset must factor one
owner for both plans and legacy state.

The unit preserves the accepted 600-second job/admission ceiling and its eleven
regressions. The source preparation passes 455 actual-bootstrap tests in 27
files: 347 prior, 40 real legacy parser/history and 68 new cases, including 23
native cases. Independent review reruns 108 focused cases, types, quality and
native imports; removing the manager, precreation-claim or sibling-join guards
fails the relevant controls before exact restoration. Actual-fork hooks and CI
are separate integration gates recorded in the final PR.

All 19 hook IDs and the original 20 compiler selections remain; new selections
are appended. New TS has strict/noImplicitAny/erasable checks. Tiny existing
checked-JS forwarders keep the actual existing-backend policy; its historical
extra-flag diagnostics are retained rather than represented as new-code strict
success. Original archive/lock gates, quality workflow and dependency graph are
unchanged. See `DEVELOPMENT.md` for normal blocking hook/CI usage.

The private immutable review packet is
`/tmp/ceplus-fresh-input-materialization-prep-20261114/`, patch SHA256
`1828a1c93f32d7c4fa5addb965b5384e6fc7609ef11eca351dbcb4d6cd3c411c`.
Independent review:
`/tmp/ceplus-fresh-input-materialization-independent-review-20261114/REVIEW.md`,
SHA256 `9d3c7b685cf72f78d92e9ca8149aa03ccd843d3295feb9677eb8b567911d01fb`.
The original 60-hour proposal and earlier failures are historical; the final
24-hour contract and deliberately composed accepted source base govern this unit.
