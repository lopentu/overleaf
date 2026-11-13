# Workflow parity and acceptance matrix

CE+ is the development base, not a claim of complete Overleaf.com parity.
Source presence, unit tests, native acceptance and production deployment are
separate results. The current live service remains stock CE 6.3.2.

| Workflow                                     | Candidate evidence                                                                     | Still required                                                                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Source editing, collaboration and PDF output | Existing upstream runtime; stock deployment passed real browser workflow               | Repeat on the CE+ candidate with representative projects, engines, fonts and packages                                                     |
| Threaded comments and tracked changes        | CE+ module present; reviewer deletion defect repaired and regression-tested            | Real multi-user concurrent edits, replies, resolve/reopen, accept/reject, reconnect and permission matrix                                 |
| Sandboxed compilation                        | CE+ runner with bounded CPU/PID/swap and temporary home defaults; 67 runner tests pass | Native adversarial isolation, CPU/PID/scratch limits, cleanup and a reviewed compiler privilege boundary                                  |
| Git and GitHub synchronization               | CE+ implementations present; public types and GitHub state regressions repaired        | Authenticated push/pull, conflicts, concurrency, credential revocation and failure recovery                                               |
| Zotero/reference workflows                   | Collection/reference components present; concrete public type repairs                  | Authenticated library/collection round-trip, citation-key preservation and failure handling                                               |
| Visual editing                               | Bibliography editing exists; full TeX visual-editor parity is unverified               | Inventory missing TeX visual provider and implement/test an independent compatible workflow                                               |
| Templates and administration                 | Public contracts and focused action/settings regressions repaired                      | Browser/API round-trips, permissions, publishing and upload compatibility                                                                 |
| Hosted project migration                     | No hosted project accepted as a migration fixture yet                                  | Preserve source/assets/settings/references, authors, comments, tracked changes, history and access mapping; verify originals before/after |
| Cloud/identity integrations                  | Source/account mechanisms require per-service configuration                            | Provider registration and private credential custody; hosted account credentials are not automatically transferable                       |
| Recovery and handoff                         | Stock service has accepted cold backup/isolated restore and fleet monitoring           | Candidate image build, state migration, consistent backup and isolated functional restore before promotion                                |

A hosted source ZIP contains source files, not proof of transferred review
metadata or full history. Migration acceptance must use a named authorized
source project and compare preserved records. See the official
[download documentation](https://docs.overleaf.com/managing-projects-and-files/downloading-a-project).

## Reviewed limitations

The all-project admin fallback now uses a dedicated `/admin/projects` JSON
endpoint protected by the existing site-admin middleware. Regression tests cover
missing/present prefetch, owner-specific requests, query scope and error
forwarding. Native authenticated authorization/retry acceptance remains open.

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
acceptance. The running lab application remains stock CE.
