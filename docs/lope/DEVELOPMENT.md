# Development and blocking checks

Base: CE+ ae07e781ab20dac2378420e5cf7a47f7d8bccbb5. Load Node 24.18.1 from
`.nvmrc`; use the packageManager-pinned Yarn 4.18.0 through Corepack.

```sh
nvm install
nvm use
corepack yarn install --immutable
python3 -m venv .lope-tools
.lope-tools/bin/pip install pre-commit==4.6.2
.lope-tools/bin/pre-commit install
.lope-tools/bin/pre-commit run
```

Commits run installed blocking hooks. Do not bypass them. CI runs the same
hookset against the PR/push diff: lint and formatting cover changed files,
while dependencies, parser generation, public types, service schema and focused
regressions run regardless of changed paths. There are no CI path filters.
Actions are pinned to immutable official commits; jobs have read-only contents
permission and checkout does not retain credentials.

The initial install was verified with package build scripts deferred using
`--mode=skip-build`; native/complete image builds are separate acceptance gates.
Do not substitute that result for a successful production image build.

## Exact coverage

- Frontend production: `services/web/tsconfig.ce.json`, all public frontend,
  module frontend, shared and type contracts. Actual Lezer parsers are generated
  before checking; no placeholder module declarations.
- Backend: `services/web/tsconfig.backend.ce.json`, preserving the original
  backend scope except Python browser-worker tests, which require DOM/JSX and
  are not backend code. Browser runtime is covered by frontend production types.
- CLSI: original declaration/TypeScript check, plus the real DockerRunner unit
  suite. The original configuration leaves ordinary unannotated JS unchecked;
  this is not a claim of full JavaScript type coverage.
- New frontend regression tests also have their own strict TypeScript gate,
  `services/web/tsconfig.lope-tests.json`.
- Behavioral regressions: comment deletion permissions, chat API contracts,
  linked-file controllers/creation, plan telemetry, GitHub state, admin actions
  and template settings, including the admin all-project recovery endpoint. Unit tests do not replace actual migration or sandbox
  acceptance. Empty focused selections must fail.
- Changed-source lint: explicit JS/TS configuration with zero warnings. Format
  uses existing single quotes, no semicolons, omitted single-arg arrow parens
  and ES5 trailing commas. No unrelated monorepo normalization is intended.

Original `web type-check` remains available: its remaining diagnostics are
unshipped development fixtures/stories/Cypress. Retain their exact inventory in
the acceptance record. Do not claim a whole-tree pass from production checking.
The root schema gate validates declaration structure; deployment still requires
canonical catalog binding and operational acceptance on the managed controller.

## Upstream maintenance

Keep CE+ updates separate from lab fixes and preserve notices/CREDITS. Compare
the candidate against the official supported release before building; source
version equivalence to the current stock image is unverified. Re-run every gate,
review the source diff, build reproducibly and exercise isolated restore before
promotion. Preserve the stock rollback until feature/security/migration tests
have passed. No CI deployment or production credentials are configured here.

## Candidate image baseline

Do not use the inherited default `sharelatex/sharelatex-base:latest` as a
compatible build base: the inspected digest
`sha256:be5ab5c8c7e9575a29d9d2aab973eeae192ff52f382c9b3e1be6a959cbb05e2e`
contains Node 16.20.0. Build `server-ce/Dockerfile-base` from its current Noble/
Node 24 recipe, resolve its OS base to an immutable digest, then supply the
resulting base explicitly as `OVERLEAF_BASE_TAG` to `server-ce/Dockerfile`.
Keep dependency and build logs, output image ID, installed versions and source
revision as private evidence. A successful image build is still separate from
application, compiler isolation, migration and restore acceptance.

## Git dependency bootstrap caches

The immutable-install hook and image recipe set `npm_config_cache_folder=node_modules/.cache/lope-yarn-v1`.
Yarn 4 ignores this legacy compatibility setting and keeps the same repository-local
cache even when invoked from nested workspaces. Git dependencies that bootstrap
with Yarn Classic resolve that relative path inside their own temporary
checkouts. Node modules are excluded from package archives, even when an
inherited ignore file lacks its final newline. This prevents concurrent prepares from corrupting the shared legacy
`~/.cache/yarn/v6` cache. The original failed post-merge run is retained; cache
isolation does not waive immutable lockfile or checksum verification.
