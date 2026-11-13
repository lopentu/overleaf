# CE+ development foundation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a reproducible and explicitly scoped quality baseline for the lab CE+ fork before changing production.

**Architecture:** Preserve CE+ history and runtime interfaces. Repair dependency and tooling defects in small reviewed commits; use shared commands for blocking pre-commit and CI. Keep application parity/security promotion as separately accepted work.

**Tech Stack:** Node 24.18.1, Yarn 4.18.0 PnP, TypeScript, ESLint, Prettier, Vitest, pre-commit, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-13-ceplus-foundation-design.md`

## Global constraints

- Base `ae07e781ab20dac2378420e5cf7a47f7d8bccbb5`; preserve `ext-ce` and work on a topic branch.
- Node 24.18.1 and Yarn 4.18.0; keep production/toolchain identity unchanged.
- No bypasses, warning-only gates or blanket type suppression.
- New code is strictly typed; inherited-code coverage is stated explicitly.
- Stock CE 6.3.2 remains production with its existing backup/rollback boundary.

## Task1: Reconcile dependency metadata

**Files:** `yarn.lock`, `.gitignore`, and only package manifests normalized by Yarn.
**Consumes:** unchanged CE+ manifests and pinned Yarn.
**Produces:** reproducible dependency graph and recorded before/after resolution inventory.

- [x] Reproduce `corepack yarn install --immutable --mode=skip-build`; retain the failure log separately.
- [x] Reconcile using `corepack yarn install --mode=update-lockfile` on the topic branch.
- [x] Compared old/new resolution identities:17added extension dependencies,340removed unavailable-workspace dependencies, no retained version/checksum changes. Evidence retained separately.
- [x] Ignore only generated PnP/cache/parser/test output; retain patches and `.pnp.register.mjs`.
- [x] Reconciled immutable installation passed;35seconds initial fetch/link, no additional graph changes.
- [x] Ran needed parser generation, public web/CLSI checks and focused regressions. Ruling: native/full image builds are promotion gates, not prerequisites for this source-only foundation; no build acceptance is claimed.
- [ ] Commit the reviewed graph correction without weakening immutable installation.

## Task2: Define and enforce the quality boundary

**Files:** `.pre-commit-config.yaml`, `.github/workflows/lope-quality.yml`, root ESLint/Prettier configuration, `tools/lope/`, `AGENTS.md`, development documentation.
**Consumes:** Task1's working dependency graph and existing workspace commands.
**Produces:** shared fail-closed commands with documented coverage.

- [x] Inventoried existing scripts and fixtures; explicit public production/new-test type boundaries are documented, original upstream commands retained.
- [x] Restored explicit lint/format configurations; changed maintained source passes zero-warning lint.
- [x] Ruling: use pre-commit itself as the shared runner, avoiding a redundant custom TypeScript orchestrator. Its system hooks propagate command failures. Add the explicit Node 24.18.1 check and prove hook rejection before acceptance.
- [x] Added17blocking hooks using pre-commit as shared runner: exact toolchain, immutable graph, actual parsers, public production and new-test types, lint/format, schema and nonempty focused regressions.
- [x] Installed hooks; wrong Node and undefined-source fixtures rejected; complete17-hook local run passed.
- [ ] Independently review the immutable diff and test evidence before publishing the quality branch.

## Task3: Record the accepted development baseline

**Files:** development/evidence docs and the existing Notion Overleaf task.
**Consumes:** Task1/Task2 results and immutable reviewed commit.
**Produces:** accurate continuation record and parity/security acceptance backlog.

- [ ] Record source pins, exact commands, coverage, unresolved failures and the next acceptance action.
- [ ] Update/re-fetch the existing Notion task; preserve stock production facts and note that CE+ is not deployed.
- [ ] Push a reviewable PR, inspect final status/diff and report what passed and what remains incomplete.

Feature implementations and production sandbox placement are outside this foundation plan; they require their own concrete designs and tests after the inherited baseline is known.
