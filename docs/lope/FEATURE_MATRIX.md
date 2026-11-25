# Workflow parity and acceptance matrix

CE+ is the development base. [Operations](OPERATIONS.md) records the serving
image and links to the current promotion checklist. Production acceptance of
isolated compilation and full hosted workflow parity remain open.

| Workflow                                     | Candidate evidence                                                                                         | Still required                                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Source editing, collaboration and PDF output | Stock workflow plus private CE+ v7 synthetic two-user edit/reload/PDF passed                               | Representative real projects, engines, fonts and packages; final isolated worker workflow                                                 |
| Threaded comments and tracked changes        | Private CE+ v7 comments/replies/resolve/reopen, role denial, accept/reject and reconnect passed            | Repeat against the final resource-accepted sandboxed deployment and authorized real projects                                              |
| Sandboxed compilation                        | CE+ runner with bounded CPU/PID/swap and temporary home defaults; 67 runner tests pass                     | Native adversarial isolation, CPU/PID/scratch limits, cleanup and a reviewed compiler privilege boundary                                  |
| Git and GitHub synchronization               | CE+ implementations present; public types and GitHub state regressions repaired                            | Authenticated push/pull, conflicts, concurrency, credential revocation and failure recovery                                               |
| Zotero/reference workflows                   | Collection/reference components present; concrete public type repairs                                      | Authenticated library/collection round-trip, citation-key preservation and failure handling                                               |
| Visual editing                               | Built-in TeX Visual Editor and bibliography editing exist; representative v7 visual behavior is under test | Accept existing math/table/figure/source/review workflows against hosted limits; implement only a verified gap                            |
| Templates and administration                 | Public contracts and focused action/settings regressions repaired                                          | Browser/API round-trips, permissions, publishing and upload compatibility                                                                 |
| Hosted project migration                     | No hosted project accepted as a migration fixture yet                                                      | Preserve source/assets/settings/references, authors, comments, tracked changes, history and access mapping; verify originals before/after |
| Cloud/identity integrations                  | Source/account mechanisms require per-service configuration                                                | Provider registration and private credential custody; hosted account credentials are not automatically transferable                       |
| Recovery and handoff                         | Accepted f5 image/build, migration, pre/post cold backups, isolated full app restore and fleet monitoring  | 0104 deployment/recovery; kernel/console, rootless/untrusted compilation, full parity and offsite/downstream recovery                     |

A hosted source ZIP contains source files, not proof of transferred review
metadata or full history. Migration acceptance must use a named authorized
source project and compare preserved records. See the official
[download documentation](https://docs.overleaf.com/managing-projects-and-files/downloading-a-project).

## Visual inventory correction

The earlier missing-TeX-provider assessment was incorrect. Valid TeX files enable
the built-in CodeMirror Visual Editor; the separate bibliography provider is
additional. Math, table and figure components are already present. The default
Code mode and an empty optional visual-extension provider list do not establish
absence of TeX visual editing. Use the Code/Visual toggle and representative
round-trip, persistence, actual MathJax/PDF and cross-user tests before claiming
parity. Do not create a duplicate editor based on that earlier assumption.

## Reviewed limitations

The all-project admin fallback now uses a dedicated `/admin/projects` JSON
endpoint protected by the existing site-admin middleware. Regression tests cover
missing/present prefetch, owner-specific requests, query scope and error
forwarding. Private v6 authenticated admin fallback and non-admin denial passed. Production
promotion and other administration/template workflows remain separate gates.

The sandbox runner defaults to a read-only root, 1 CPU, 256 processes, 1 GiB
memory with swap capped to the same amount, and bounded temporary/home tmpfs.
Existing administrator-controlled group overrides remain possible; promotion
must inspect the final effective configuration. The writable project bind is
not a per-job disk quota. These defaults do not prove runtime isolation. Its Docker API/socket privilege boundary and aggregate resource
limits remain promotion blockers. The fork is not exposed to untrusted users.

CE+ supplies substantial reusable functionality. Reuse audited modules and fix
verified gaps; preserve attribution and minimize the delta when tracking CE+.
Complete parity is the target, and each row stays open until its acceptance
criteria have actual evidence.

## November 13 native control probe

The repaired runner's actual generated options passed disposable controller
container tests: real PDF output, read-only root, 64 MiB temporary/16 MiB home
limits, no network or Docker socket, no synthetic second-project visibility,
actual one-CPU/256-PID/1-GiB/no-swap cgroup values, fork-limit rejection and
a deliberate memory overrun terminated with OOM/exit 137. Probe containers
were removed by exact ID after verification. This is rootful controller
evidence, not rootless-worker, timeout/cleanup or per-project disk-quota
acceptance. At that November 13 checkpoint the running lab application was
stock CE; the later accepted f5 base deployment is recorded in
[operations](OPERATIONS.md).

## Private image and promotion checkpoint

The v6 image built and passed unprivileged module loading and synthetic review
workflows. Its test runtime was removed by exact identity. Requested Compose
no-swap settings did not match effective cgroups in that run; resource acceptance
remains blocked despite zero observed swap usage. Do not equate HostConfig or a
passing minimal probe with the accepted whole deployment.

The focused bounded archive unit has strict types and active-I/O cancellation
regressions, but it is not the production runner. Stock migration/history files
match the candidate; an additional active-project Zotero migration has a no-op
rollback, so compatibility/rollback needs separate fresh stock restores.
Production-source dependency audit findings also need patch-aware triage before
promotion; the existing body-parser pipeline backport must be preserved and
regression-tested. No broad audit ignore is justified. Private evidence and the
current operational handoff are maintained in the canonical server-utils repo.

## November 21 editable-file retirement checkpoint

The local candidate saves a durable dispatch marker before admitting an edit.
After interruption, the updater reclaims the marker and reuses the original
batch identity. It retains the queue entry until history-v1 verifies the exact
receipt from the Mongo activation transaction. Project history keeps each tagged
edit separate and refuses a queue reset while tagged entries remain.

The integrated source passed 592 document-updater tests, 645 project-history
tests, 25 Redis-wrapper tests, 17 storage-entry fixtures and seven
private HTTP socket cases. A disposable Redis rehearsal covered worker exit,
reclaim, a pending history receipt, a sibling edit and replay. The HTTP and
storage fixtures simulated the persistence boundaries they exercised.

The legacy Redis drain now checks the persistent protection marker in the same
operation that would trim the queue. The document HTTP wrappers defer actions
while protected updates are pending. The project flush checks for work before
enumerating cached documents, including an empty cache. The local retirement
preparation checks the exact editor revision after the project queue drains.

The candidate remains default-off. GitHub import uses the exact source commit,
case-sensitive path and editor revision to recover the same operation. Web
holds an ordering barrier until the updater verifies durable history and
finishes cache eviction. Docstore compares the saved editor and storage
revisions. Binary replacement requires both the old document's removal and
the exact uploaded file's addition. Review found and the draft addressed
premature abort on a sibling action and repeated file-tree events. The focused
GitHub merge and Web persistence run passed 35 cases. Browser acceptance with
the actual GitHub app, Redis, Mongo and history storage remains open.

Portable Compose enables Redis AOF with one-second fsync. Interruption
acceptance includes the chosen deployment's persistence and recovery behavior.
The pinned compiler archive passed offline admission. The production compiler,
restored project, provider integrations and hosted migration have gates in the
server-utils release checklist.
