# Workflow lease and pre-body admission unit

This unit is integrated source, not a selected CLSI backend or enabled route.
Stock production and the legacy compiler path remain unchanged. The full
materializer, artifact/publication bridge, rootless runtime, private transport,
host baseline and recovery acceptance remain separate gates.

CompilerAdmission owns one queue: two active entries, eight metadata waiters and
a 30-second queue deadline. Its real acquire/run API admits metadata before any
body parser or workspace creation. WorkflowAdmissionHttp pauses queued requests,
parses only after admission, observes genuine disconnects, and maps existing busy/
queue outcomes. It is not mounted in the application. Legacy real-JobRequest
submit remains compatible; no fake command or output fields satisfy admission.

A running scope must register one real canonical, owned, private workspace through
ownWorkspace(rootDirectory, cleanup). Every job input and new output is a strict
protected descendant. The whole workspace remains reserved through sequential
jobs, pending writers, cancellation, cleanup failure/retry and lease.closed.
The first version replaced earlier path reservations after a later job; genuine
input/output reuse regressions reproduced that P2. The enforced root fixes it
without an unbounded history of paths. Stop/reset bypass work capacity with
bounded control fences, and failed host cleanup is not cleared by a Docker sweep.

JobOwnership retains the exclusive guarded Unix lease, exact labels, protected
manager UUIDs and nonoverlapping reconciliation. A hung call retains ownership;
SIGKILL/stale lease and manual recovery remain explicit limitations. This is not
an orphan-free or hard API deadline guarantee. Listener and ownership now share
the same reviewed private Unix-path validator; numeric TCP bind-host handling,
producer-completion joins and Docker log suppression remain intact.

The actual compiler selection has 277 passing cases, including the retained
209 earlier cases and new admission/ownership/workflow/real HTTP cases. The
private focused selection alone missed the legacy actual bootstrap: Chai's
promise plugin overrides Vitest rejection assertions, and vi.resetModules plus a
dynamic HTTP import duplicated AdmissionError. Existing Node assert.rejects
and one stable static factory import fix the tests without production changes,
removed plugins, weakened outcomes or reduced selections. The original 21-failure
run is retained; private actual-context and actual-checkout 277 cases now pass.
Strict archive types also pass. Normal installed hooks and required CI are still
needed for any final commit acceptance.

Before runtime selection, finish full authoritative materialization, bounded
source plans for GET wordcount, input/output budget composition, immutable build
publication, joined history/log readers, command policy and native whole-service
acceptance. The legacy 600-second ceiling is the later compatibility target;
this standalone job unit still caps at 300 seconds until the reviewed adapter
change lands. Public Overleaf.com parity is not established by this unit.
