# Bounded compile artifacts and stdout collection

This is source-unit integration. No public route or compiler backend selects
these modes. Stock production and the legacy compiler path remain unchanged.
Full materialization/publication, rootless/private transport, host baseline,
whole-service recovery and hosted parity remain separate acceptance gates.

The existing input producer returns a bounded trusted path/size/SHA256 manifest
through its same completion promise. The existing TAR parser classifies complete
compile output against that manifest. Large byte-identical originals are hashed
and drained without host materialization; smaller candidates use the bounded
provisional file before classification/removal. Changed or new payload uses the
existing 64 MiB total / 16 MiB file / 4096-entry output limits. Input limits
remain 100 MiB / 50 MiB / 4096. One bounded provisional file and shared-parent
namespace accounting avoid a second parser or unbounded path history. Generated
payload remains charged even if replaced by captured stdout/stderr diagnostics.
Generic extraction and its budgets remain compatible.

EphemeralDockerJob shares one lifecycle among run, runArtifacts and runStdout.
Stdout-only mode rejects an outputDirectory at runtime and uses no fake path,
collection or pause. Each mode preserves UUID ownership, cancellation joins,
producer final read/close, Docker log suppression and exact resource cleanup.
The workflow manager dispatches the exact discriminated request snapshot that
passed workspace authorization. Independent review reproduced the first
version re-reading a typed getter after its checks and crossing into another
active workspace; all three modes now retain the checked plain copy, without
an unsafe cast or second snapshot. The rejected preparation is retained.

Actual checkout validation passes 336 cases, including all 277 prior cases,
strict archive types and native child probes for real TAR streams, large echoed
inputs, changed output.pdf, byte/entry budgets, diagnostics, late reads/closes, cancellation
and root replacement. Independent V2 closure verifies the getter regression
and exact patch. All normal installed hooks and required CI remain mandatory
for commit acceptance; these local results do not replace them.

A synthetic actual-Docker test passes generic and artifact PDF compilation
(13,805 bytes each), verifies unchanged main.tex is omitted from artifacts, and
passes exact stdout-only word counting. All three inspected job log policies
are none, and all six exact container/volume resources are absent afterward.
Proof is root-private at /tmp/ceplus-native-three-collection-modes-20261114/.
This tests single-job modes with synthetic data, not rootless/aggregate/private
transport or the full workflow bridge. A hung/ambiguous daemon reply and
manual-recovery limitations remain explicit.
