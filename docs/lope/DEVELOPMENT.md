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

The portable Compose hook needs Docker with the Compose v2 plugin. It checks
the rendered configuration with a synthetic environment and runs without a
Docker daemon.

Git bridge changes also require a full JDK 21, with `JAVA_HOME` pointing to the
JDK directory, and Apache Maven 3.9.16 on `PATH`. Install Maven from the
[official Apache distribution](https://maven.apache.org/download.cgi) and verify
its published SHA-512 checksum before extracting it. A Java runtime without
`javac` is insufficient. Run `tools/lope/check-git-bridge.sh` directly to check
Java formatting, compile production and test sources, and run the Maven tests.
The blocking hook covers git-bridge sources, its POM and quality-gate inputs;
CI provides Temurin JDK 21 and checksum-verified Maven 3.9.16 for the same hook.

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
  suite. The archive and ephemeral-job modules/tests use a separate strict
  `tsconfig.archive.json` gate, including `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, checked JavaScript and `erasableSyntaxOnly`.
  The existing compiler regression hook first imports the real job module with
  pinned Node 24.18.1, without type transformation, then runs all 575 selected
  runner/archive/job/source/publication/command/native tests, including all ten
  original LatexRunner cases. Shared command/environment modules use the strict
  archive scope; the legacy-graph regression uses the existing source-input scope
  with ordinary legacy JavaScript still unchecked. Native tests cover the actual repository paths
  and child compiler PATH; Docker API fixtures do not establish native container
  acceptance. Dockerode uses its real pinned `@types/dockerode` dependency.
  Disposable job containers explicitly disable Docker logging, independently
  from the host daemon's default log driver; their bounded exec output is separate. The original configuration leaves ordinary unannotated JS unchecked;
  this is not a claim of full JavaScript type coverage.
- New frontend regression tests also have their own strict TypeScript gate,
  `services/web/tsconfig.lope-tests.json`.
- Dependency security: the new `services/web/tsconfig.dependency-security.json`
  gate checks only the dependency/credential regression files as strict checked
  JavaScript. It uses the real direct `@types/multer` declaration and a narrow
  model of the runtime's new `fieldArrayIndexLimit`, which that declaration
  predates. This supplements all existing gates; ordinary upstream JavaScript
  outside this focused scope is unchanged.
  The static-file cancellation regression uses real local HTTP sockets and the
  actual patched `send` dependency in isolated children. It checks cancellation
  before and after pipeline setup, descriptor cleanup, complete normal transfers,
  and propagation of file-read and unexpected pipeline errors. The patch closes
  a newly created file stream when its response has already been destroyed; it
  does not enable a global exception handler.
- GitHub authentication: `services/web/tsconfig.github-auth.json` strictly checks
  the token manager, grant validator and auth regressions through `@ts-check`. Their
  imported legacy modules retain the existing backend type coverage; the full
  legacy controller is not claimed as strict checked JavaScript. Matching blocking
  hooks run these types and provider/credential regressions locally and in CI.
  Tests use synthetic tokens with mocked provider HTTP, storage and encryption;
  no GitHub account, repository or real credentials are used. Tests cover
  rotating a grant once across concurrent requests, legacy credential
  compatibility, rejected and partial refresh responses, and disconnect
  without renewal.
- Zotero authentication: `services/web/tsconfig.zotero-auth.json` strictly checks
  the closed failure-metadata helper, OAuth module and focused regressions via
  `@ts-check`. The legacy API/controller graph retains existing backend coverage;
  this is not a claim of strict checking for every Zotero module. Matching local
  and CI hooks exercise synthetic credential/error isolation, unchanged HTTP
  status mappings and actual bounded cancellation of stalled loopback response
  bodies. No provider account or real credentials are used. Transport failures
  retain only fixed operation, allowlisted error class and bounded HTTP status;
  raw provider URLs, headers, bodies and cause chains do not cross that boundary.
- Provider HTTPS transport: `services/web/tsconfig.provider-https.json` strictly
  checks the web-local helper and real loopback CONNECT/TLS regressions. The
  optional nonsecret `OVERLEAF_PROVIDER_HTTPS_PROXY` setting accepts only an
  HTTP(S) origin without userinfo, path, query or fragment. Unset preserves the
  identical existing options/transport. When configured, only the GitHub/Zotero
  fetch callsites use it; internal/global agents stay unchanged. Both the initial
  URL and every redirect require HTTPS443 and exact provider hostnames (GitHub:
  `github.com`, `api.github.com`, `codeload.github.com`; Zotero: `www.zotero.org`,
  `api.zotero.org`). Each request has its own standard proxy agent bound to its
  existing AbortSignal, including the pending CONNECT socket; redirects share
  the request deadline. Missing cancellation refuses, with no direct fallback.
  The matching blocking type/test hooks use generated ephemeral TLS fixtures,
  actual client requests, stalled CONNECT/body cancellation, redirect/host/TLS
  refusal and a trap against external DNS. Production TLS verification is never
  disabled. A separately managed private allowlisted proxy and real provider
  qualification are still required; this source change deploys no proxy, network,
  service or credentials.
- Behavioral regressions: comment deletion permissions, chat API contracts,
  linked-file controllers/creation, plan telemetry, GitHub state, admin actions
  and template settings, including the admin all-project recovery endpoint. Unit tests do not replace actual migration or sandbox
  acceptance. Dependency tests cover proxy trust, Mongoose prototype/filter
  safety, multipart limits/request lockdown, compression abort cleanup and the
  exact body-parser backport. SMTP/SES send-path tests use mocked transports and
  captured logs to prevent credential dumping. Empty focused selections must fail.
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

## Unprivileged image readability

Production code and dependencies in `/overleaf` contain no runtime secrets or
state. The image build normalizes their read/traversal permissions and removes
group/other write access, then loads application settings and the native bcrypt
module as `www-data` under the actual PnP configuration. This build step is
blocking: a root-only `.yarn` parent must fail the image build rather than first
appear during service startup. Runtime secrets/state remain external mounts.

## Bounded archive transfer

`BoundedProjectArchive.ts` and the focused `ArchiveFileIo.ts` helper stream
validated project inputs and untrusted compiler outputs. They are an adapter
foundation, not an activated replacement runner. The input directory and output
parent must be private/trusted and protected from concurrent mutation; extraction
creates a new output directory and never overwrites an existing one.

Limits are 4,096 entries, 50 MiB/file and 100 MiB total input; output is
16 MiB/file and 64 MiB total, with bounded metadata/wire parsing. Links, devices,
noncanonical/traversing/duplicate paths and unsafe parents are rejected. UID/GID
and modes are normalized. Errors cancel the source and settle writers before
removing only the newly created partial output. FileHandle ownership stays with
the caller: custom bounded I/O avoids native/PnP stream double-close on abort.
Tests include active-I/O failure/cancellation and partial writes, not just happy
paths and pre-aborted signals. CI runs these same blocking regressions.

Use a uniquely named, labeled local-driver tmpfs volume for native archive
transfer under a read-only root; ordinary Docker tmpfs variants did not establish
working upload visibility. Pause the container before output collection and
remove its exact container/volume. Rootless mounts, aggregate memory accounting,
queue/restart cleanup, authenticated transport and production integration still
require separate acceptance. Canonical fleet evidence lives in server-utils.

## Final-image build-tool cleanup

The final `server-ce/Dockerfile` step uses a temporary read-only context mount
and `--network=none` to prune the reviewed ten development packages and the
NodeSource global npm tree/shims after compilation. The helper refuses an
unexpected removal/version, install/configure action, Essential package,
unsafe npm owner/path/symlink, or a change to any remaining installed package
version. Root UID, the canonical project, explicit build intent and the actual
read-only helper mount are required; it is not a host administration command.
The helper is not copied into the resulting image. The public receipt at
`/usr/share/overleaf/runtime-cleanup.json` records intentional npm file pruning;
it does not claim complete file integrity for the still-installed nodejs package.

Node, Corepack/Yarn, `/opt/corepack`, TeX2026/latexmk, Python, Perl, GCC/make,
Git and runtime shared libraries remain in scope for preservation. Custom C/C++
compilation, node-gyp installation and runtime npm hotfixes are unsupported in
this final image; use the source/build workflow. The blocking cleanup type and
offline refusal hooks run locally and through the existing CI hook runner:

```sh
corepack yarn workspace @overleaf/web exec tsc -p tsconfig.runtime-cleanup.json --noEmit --pretty false
node --test server-ce/runtime-cleanup.test.cjs
```

These source checks do not establish image security or functional acceptance.
The actual built image still needs independent package/file provenance, a fresh
full scan, Node/native-addon ABI, offline runtime Yarn, TeX/PDF and complete
application restore/rollback qualification. Selected path fingerprints are not
an exhaustive TeX/Corepack tree proof. Removing files in the merged runtime does
not erase old immutable layer bytes. No scanner report is waived or relabelled,
and this cleanup makes no host-kernel, console-recovery or untrusted-compile
acceptance claim.
