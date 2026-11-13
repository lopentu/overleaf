# Ephemeral compiler job unit — November 13, 2026

This increment integrates the reviewed private V3 job unit into CLSI. It does
not select a new CommandRunner or activate a worker. Production remains the
separately managed stock service.

## Responsibilities and contracts

`EphemeralDockerJob.ts` owns one fresh labeled container and named tmpfs volume,
archive upload, argument-array execution, paused output collection and both
cleanup attempts. `JobRequest.ts` defines concrete request/result/policy types
and validates immutable image pins, absolute executable allowlists, bounded
arguments/environment, compile working directories and private trusted staging.
`DockerExecOutput.ts` validates bounded Docker framing before the unchanged
upstream decoder. The existing archive/file-descriptor/resource helpers remain
unchanged.

The caller must own an immutable private input staging tree and a new output
path. The caller also owns host staging cleanup: a later cancellation or Docker
cleanup failure can leave an already extracted output tree. A rejected promise
is not evidence that every path or daemon resource is absent. Output is returned
on a nonzero compiler exit; transport, validation, cancellation and cleanup
failures reject. Cleanup attempts the separately owned volume even after a
container error and preserves resources whose labels do not match.

Jobs use UID/GID33, one CPU, 1GiB memory/no additional swap, 256 PIDs, read-only
root, no network/capabilities, no-new-privileges, 64MiB temporary space and a
16MiB home. A fresh named local tmpfs volume bounds /compile to256MiB with
nodev/nosuid/noexec and NoCopy. Explicit LogConfig:none disables per-job Docker
logs; bounded exec output is separate. The trusted image entrypoint is replaced
by fixed /bin/sleep infinity and commands execute as argument arrays.

Input limits remain4096 entries,50MiB/file and100MiB total; output limits remain
4096 entries,16MiB/file and64MiB total. Exec decoded output is bounded at1MiB and
wire data at2MiB. The framing transform rejects truncated/invalid frames and
prevents a valid many-frame burst from overflowing the upstream decoder.
These policies require representative-project acceptance before deployment.

## Integration and local evidence

The three reviewed V3 production modules are unchanged except for one deliberate
HostConfig.LogConfig:none hardening line, with a failing-then-passing options
regression. Collector SHA256 remains
`53d39c0fe0d37435f83f611f41426b490bd20ba04721a05646c22c4e38bc75de`;
job SHA256 is
`b311e7a2e43f515c3efbf5b4e382f3252236a4f4b9e54120f4bf0a6cb8e92046`.
Independent integration review replayed all13 paths byte-identically and found
no blocking issue. Genuine Dockerode declarations add five type-only locators;
retained checksums are unchanged. There are no replacement declarations or
unchecked any/ignore directives.

The existing strict archive type scope now includes all job helpers, fixtures
and the native gate, with checkJs and erasableSyntaxOnly. All19 blocking hook IDs
remain; the compiler hook first imports the actual module under pinned Node
24.18.1 without experimental type transformation, then runs166 regressions:
67 existing runner,53 archive/ownership,32 lifecycle,12 framing and two native
runtime cases. The actual checkout passes that166-test selection and native
import; all remaining hooks and required CI still need exact-head acceptance.

A real isolated controller job using this integrated source produced a13,805-byte
PDF with effective LogConfig:none and an empty Docker LogPath. A second job
successfully wrote a synthetic marker through PID1 stdout; Docker rejected log
reads because its driver is none, and normal bounded exec output still arrived.
Both jobs' exact containers/volumes were absent afterward. This is rootful
controller evidence, not rootless or whole-application acceptance. The original
V3's seven native failure/isolation cases and independent framing review remain
separately preserved; this increment does not claim they were all rerun.

## Open boundaries

Hung Docker APIs can delay return beyond a client deadline. A disconnected
create response may precede a later daemon resource, so immediate cleanup is
insufficient proof against orphans. Bounded admission, periodic/restart
reconciliation and aggregate daemon/job accounting remain separate unfinished
units. No caller bridge, private mutual TLS, rootless worker, catalog adoption,
full application image, migration or recovery acceptance follows from this unit.

The worker still requires a patched shared-host kernel baseline and a prepared
attended boot/rollback path. Preserve the historical whole-canary swap failure
and repeat effective leaf/ancestor gates in the final managed runtime. Keep
stock serving and trusted-user restrictions until the complete boundary passes.
