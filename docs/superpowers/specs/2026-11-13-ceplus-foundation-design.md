# LOPE CE+ adoption foundation

Richard selected CE+ as the development base and requires online workflow
parity, maintainability, typing, linting and blocking pre-commits. This design
covers the development foundation; it does not accept an untested production
image, compiler privilege boundary or migration.

## Source and runtime boundaries

- Fork: https://github.com/lopentu/overleaf, default branch `ext-ce`.
- CE+ base: `ae07e781ab20dac2378420e5cf7a47f7d8bccbb5` (2026-11-06).
- Remotes: `origin` is LOPE, `ceplus` is yu-i-i/overleaf-cep, `upstream` is
  overleaf/overleaf. Preserve upstream history and minimize the lab patch set.
- Development checkout: `/home/richard/github/lope-overleaf`; this is not a
  production placement. The separate official source clone is unchanged.
- Production remains stock CE 6.3.2, defined by server-utils
  `services/overleaf/lope-service.json`, with its accepted NAS recovery path.
- Node 24.18.1 and Yarn 4.18.0 are the initial exact development versions.
  Use the declared `packageManager` and immutable installation; do not change
  the host or production Node version to configure development.

## Verified baseline findings

Immutable installation rejects the upstream lockfile: missing extension
packages are added and packages belonging to absent workspaces are pruned.
Reconciliation belongs on a topic branch with before/after dependency evidence;
the final acceptance remains `yarn install --immutable`.
Upstream supplies lint scripts and an ESLint rule library, but no shared ESLint
configuration in the published tree. Establish an explicit configuration before
claiming lint passes. The existing web and CLSI TypeScript checks and tests
remain the reference; new maintained code needs strict types.

## Quality boundary

Use pre-commit itself as the shared runner for local blocking hooks and CI;
do not add a second custom orchestration layer. Commands must fail closed on missing tools, bad Node/Yarn versions,
invalid lockfiles, lint/type/format errors, failed tests or zero selected tests.
No `SKIP`, `--no-verify`, continue-on-error, warning-only quality gates or
blanket type suppression. Use existing Yarn workspaces and test frameworks;
no second dependency manager or editor implementation.

Apply strict typing to new code and changed feature boundaries. Do not perform
an unrelated monorepo rewrite to normalize inherited style. Record inherited
failures and resolve the defined baseline deliberately; do not claim whole-tree
coverage from a narrow check. Hooks must document their exact coverage and CI
must run the same commands without path filters that omit code checks.

## Feature acceptance after the foundation

The requested matrix includes comments/replies/resolution, tracked edits with
accept/reject and concurrent editing, compile sandboxing, Git/GitHub sync,
Zotero/reference workflows, visual editing, project/history/review migration,
and the existing source editing/PDF/export/account workflows. A README claim
is not acceptance. Test permissions and cross-project denial alongside success.
Visual editing and migration of hosted review/history are currently unverified;
a source ZIP is not accepted as proof of preserving those records.

CE+ DockerRunner uses Docker API/socket access and has configurable security
controls. Its production privilege boundary requires separate security design
and adversarial tests. Do not mount the main host Docker socket into the live
application or expose a candidate while evaluating it. Keep public signup off;
retain administrator-created accounts and the existing production rollback.

## Promotion and records

A candidate must pass reproducible build, quality gates, functional/migration
checks, isolation tests, fresh consistent backup and isolated restore before
an authorized promotion. Update service/catalog bindings, fleet monitoring,
Git runbooks/handoff and Notion records, verifying each saved/live result.
No feature-parity or production acceptance claim follows from creating a fork.
