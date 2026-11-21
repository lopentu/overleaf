# LOPE lab deployment and candidate acceptance

For a standalone installation, use the [portable Docker Compose guide](../../deploy/README.md).
It includes image preparation, configuration, accounts and recovery on a
separate Linux Docker host.

The [LOPE lab service](https://overleaf.lopen.linguistics.ntu.edu.tw/) serves
source `cb7f6803035fb8f4a5df5db9bc215a1f025cbecd` and image
`sha256:19957473a0d23ddfc363a0882a9584a8b08ece6b28979932cce138f93e7704a2`.
Its deployment and recovery use the managed
[runtime contract](https://github.com/lopentu/server-utils/blob/main/services/overleaf/lope-service.json)
and [lab operations runbook](https://github.com/lopentu/server-utils/blob/main/services/overleaf/OPERATIONS.md).

## Build and local checks

Follow the [development guide](DEVELOPMENT.md) for the pinned toolchain and
blocking source checks. Review the
[release checklist](https://github.com/lopentu/server-utils/blob/main/docs/OVERLEAF_RELEASE_CHECKLIST.md)
for the current lab candidate, tested workflows and promotion decisions.

## Promotion gates

Validate lope-service.json with the canonical lifecycle checker and the actual
fleet catalog before any further promotion. Portable schema validation in CI does not
verify catalog ownership, resource placement, backup evidence or live behavior.
Resolve and test the compiler privilege boundary; prove no cross-project,
application-secret or host-socket access, bounded resources and safe cleanup.
Test commenting/tracked changes under concurrent edits and each permission role.
Verify Git/GitHub/Zotero and visual editing, then migration of source/assets,
settings, references, comments, suggestions and history. A source ZIP is not
proof of full review/history transfer. Never modify hosted account credentials
or existing projects merely to test a proposed import.

## Recovery and rollback

The serving image's fresh pre-upgrade cold state and portable image recovery
are governed by the canonical runbook. Preserve the stock rollback and never
downgrade migrated stores in place. Test new releases against isolated state, project names and private test origins with
explicit health and useful-workflow acceptance. Preserve failed evidence privately.

## Handoff

Read AGENTS.md, DEVELOPMENT.md and the foundation design/plan under
../superpowers/. Record exact build/source pins, check coverage, unresolved
issues and the next acceptance action. Update Git/fleet/Notion after any live
change and re-fetch every written record. Git, provider, SMTP and Google Drive
acceptance, untrusted compilation and complete hosted parity remain open;
accepting the serving image does not qualify those capabilities or promote the
candidate.

## GitHub export and conflict recovery

Export to a new repository keeps the initial GitHub commit in history. If
the export stops after repository creation, check the named repository and
its default branch before retrying.

MongoDB records one export claim per project in `githubSyncExportClaims`.
The collection uses the project's ObjectId as its unique `_id`. This keeps
another export from creating a repository even if the Redis lease expires.
An interrupted worker, unconfirmed repository creation or sync-state write,
or failed claim release can leave a claim in place. A conflicting request
returns HTTP 409.

To reconcile a retained claim, read its `_id`, `claimId`, `startedAt`, `userId`,
`repositoryName`, and `organization` from the primary database. Confirm the
original request stopped or completed. If its worker cannot be identified,
drain the Web workers that could still be running it under an authorized
maintenance window. Claim age alone is insufficient. Check the project's
local sync state on the primary and verify the target repository and branch
with the GitHub account or organization owner. Record the outcome and preserve
the repository for review. Once the outcomes are known and the original
request can no longer perform writes, an authorized operator can remove only
the captured `{ _id, claimId }` with a majority-acknowledged `deleteOne` and
verify that the claim is gone. Leave the claim in place while the request or
either write outcome remains uncertain.

On conflict, the app publishes a uniquely named branch with the Overleaf
changes. Merge that branch into the GitHub default branch with a merge
commit. Once that commit is on the default branch, use **Continue** in
Overleaf to import the resolution. The app checks the commit history before
it applies the GitHub snapshot.

The app downloads the files before checking the Overleaf version again. It
verifies deletions and keeps unrelated edits out of the sync position. Before
replacing an editable document, GitHub sync checks its identity under the
project structure lock and its version under the document updater lock. A
newer version, a moved document, or a newly created editable document at the
target of a planned text import stops the write. The user can retry sync.
The conditional-write route makes a staged Web build reject replacements
against an older document updater.

Imports can apply several files concurrently. Deletions and binary file
writes still use their existing paths. GitHub sync stops if an incoming
binary file would replace an editable document. Those operations and live
provider verification remain rollout checks.

## Final-image dependency projection

The image build keeps the normal developer manifests, lockfile and native build
steps. After compilation, a network-disabled step uses the installed Yarn 4.18.0
to create an image-local production map. Yarn's npm resolver adds `node-gyp` to
packages whose scripts mention `node-gyp` or `prebuild-install`, including test
scripts and names such as `node-gyp-build`. Disabling install scripts alone does
not remove these injected dependencies.

The checked helper materializes the eleven reviewed, already-built packages
outside Yarn's managed unplugged directories, preserving their original names,
versions, complete manifests and file bytes. Normal portal resolutions let Yarn
regenerate the map with network and install scripts disabled. A strict graph
comparison permits only the injected compiler edges and their unreachable build
support to disappear. Every other dependency and peer must remain unchanged.
The source checkout's manifests and lockfile remain unchanged.

The helper removes unreferenced ZIP and unplugged code, then records the actual
retained package manifests, hashes, patch origins, HTTPS forks and nested
metadata in `/usr/share/overleaf/runtime-dependencies.json`. This is provenance,
not a security clearance. A source-lock audit alone can miss portal identities
and off-map ZIP code; audit the actual physical inventory locally against fresh
public advisory data, including each portal's original package version. Keep
fork and patched-package applicability explicit and retain lower findings.

Runtime npm, node-gyp installation and custom native rebuilds remain unsupported.
Static guards and local fixture tests do not establish image compatibility: a
new image still needs its actual Node/native ABI checks, startup, migrations,
TeX/PDF and candidate/rollback recovery tests, full image plus ZIP-aware security
coverage and archive recovery before promotion. No production configuration,
provider access or untrusted-compilation gate changes with this source helper.

CI deliberately applies the existing HIGH/CRITICAL failure threshold to this
same generated physical runtime closure, replacing the former source-graph
`yarn npm audit` step. It first focuses a separate public-source copy to the
production graph, then invokes the shared projection helper. The developer graph
retains ordinary build tools; their presence is not silently relabeled as the
runtime graph. CI copies source and warm dependencies with executable modes
preserved, without Git metadata, untracked credentials or application state.

Only the complete public npm OSV dataset and checksum-pinned official
OSV-Scanner 2.7.1 are downloaded. Inventory matching uses `--offline --no-resolve`
locally; no inventory is posted to a registry or advisory API. Each scan uses a
generated empty configuration and isolated home, so repository or user ignore
rules cannot waive findings. [The pinned scanner's configuration
contract](https://github.com/google/osv-scanner/blob/v2.7.1/docs/configuration.md)
explains this explicit override. The gate checks exact SBOM/report identity
coverage, all eleven original portal versions, patched original and actual
versions, nested named metadata and conservative fork candidates. Unknown
severity or incomplete coverage fails, as does any HIGH or CRITICAL result. A
separate picomatch 4.0.4 control must detect its known HIGH advisory against the
same local database. Lower findings remain in the reports; passing this threshold
is not a zero-vulnerability claim, fork-applicability decision or image/runtime
qualification. Source CI does not compile or qualify the image's native binaries.

The CI wrapper starts through `corepack yarn node` and requires the official PnP3
filesystem before reading ZIP packages. Tracked source comes from an immutable
`git archive HEAD`, while only the named generated PnP/cache/unplugged paths are
copied with ancestor-link and executable-mode guards. Failures emit a fixed class
and allowlisted code, without raw package bodies or environment values.

This remains a single-stage image build. Pruning removes files from the merged
runtime filesystem through whiteouts; their bytes remain in older portable
layers and build caches. Removed clone bytes and a clean merged runtime inventory
do not prove a smaller image archive, Docker Image.Size or target load budget.
Those sizes and storage requirements need actual artifact measurements; this
change performs no flattening or multistage conversion.
