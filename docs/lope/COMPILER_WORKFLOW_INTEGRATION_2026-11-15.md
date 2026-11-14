# Compiler workflow source integration — November 15

`CompilerWorkflow.ts` now composes admission, authoritative source preparation,
commands, ephemeral collection, publication and readers. `CompilerWorkflowHttp.ts`
connects the existing compile, stop/reset, GET/POST wordcount, output and SyncTeX
paths to that composition. It creates no Docker client or public listener.

The actual application and legacy runner entrypoints validate
`CLSI_COMPILER_WORKFLOW_MODE`. `legacy-trusted` retains the existing default.
`isolated` fails with `ISOLATED_RUNTIME_UNQUALIFIED` before legacy backend
construction, expiry monitors or listener startup. No qualified rootless/kernel
bootstrap or native image/tool profiles ship in this change. The internal router
factory is not runtime authority; source tests do not activate an isolated worker.

Compile requests enter the existing metadata queue before parsing or staging.
Express verifies/captures the original bounded decoded JSON bytes, including
compressed requests. The real source parser consumes those bytes rather than a
reserialized or mutated request body. Full/history-full input uses the existing
materializer; incomplete state retains full-resync/missing-updates responses.

Plain `.tex` preparation applies the actual draft prefix and TikZ/pstool
`output.tex` rule within the original 50 MiB/file, 100 MiB input and 4,096-entry
limits. Existing `output.tex` is preserved. A private prepared-input instance
exists only during the joined sealed-snapshot callback. Final job policy checks
that same live instance, exact scope/manager/project/input path, command and
deadline. A copied object, selector or arbitrary request cannot replace it.
Input preparation and publication reuse the factory's single transaction slot
sequentially; artifacts remain under the owned operation after input cleanup.

Successful collection publishes under the original immutable build namespace and
output queue. Explicit occupied IDs retain the exact HTTP 409
`build-id-conflict` response and no old output identities. GET wordcount reloads
the bounded original full plan into fresh input; POST wordcount also accepts full
source. Reset owns cancel/join/cache clearing once, without nesting another reset.
The original legacy texcount interpretation is shared, not reimplemented.

Published file/range and ZIP readers hold the existing output queue through
joined production/read/close. ZIP uses genuine archiver types, one file descriptor
at a time and the shared legacy exclusion list; no archive is written to the
host. Every namespace member is charged before filtering. An ordinary pending
read is joined before close; failed closure remains owned for manager cleanup
retry even if its pathname has gone. ZIP wire output has a finite additional cap.
These are application bounds, not filesystem quotas or hard syscall deadlines.

SyncTeX copies the exact requested published build into its own admitted private
workspace and uses the same stdout-only ephemeral lifecycle. The actual legacy
view/edit argv and parser are reused with `/compile` paths, including nested
Unicode filenames. Missing build IDs and remote-cache fallback are refused.
Returned positions are finite and capped at 4,096. Direct file access, ZIP and
SyncTeX never substitute mutable latest compile input.

The compile maximum remains 600 seconds, queue wait 30 seconds, and wordcount/
SyncTeX 60 seconds. Output collection remains 16 MiB/file, 64 MiB generated data
and 4,096 entries. Protected environment defaults and the finite shared key policy
remain; submission identifiers use the actual legacy alphabet and admission bound.
Non-TeX transformations, PNG conversion, strace/archive-log, host qpdf and optional
PDF/CLSI cache profiles remain unsupported and fail closed. There is no host runner
fallback for isolated selection.

The original 575 selected regressions and all 19 hook IDs remain; new integration
and actual legacy parser/archive cases are appended. Native checks import the real
workflow graph under pinned Node24 strip-only semantics with isolated selection.
No type/lint waiver or replacement declaration is added. The only dependency edge
is matching-major `@types/archiver`5.3.4 and its genuine `@types/readdir-glob`1.1.5
transitive type package; primary age/SRI verification and normal Yarn installation
retain all existing dependency records/checksums and the three-day age gate.

Final source checks, failure controls and exact after-hashes belong to the private
review handoff before commit. Actual rootless execution, effective aggregate
limits, host kernel, image/tool paths, private transport, guarded restart and
whole-service acceptance remain deployment blockers. This source change does not
establish untrusted compile, migration, hosted parity or public promotion acceptance.
