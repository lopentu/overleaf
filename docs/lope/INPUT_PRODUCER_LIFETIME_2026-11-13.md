# Compiler input ownership — November 13, 2026

The new createInputArchiveBundle API exposes one TAR stream and the completion
of its existing asynchronous producer. The original createInputArchive remains
a Readable wrapper, retaining its interface. No TAR parser is duplicated and
the frozen input limits remain 4,096 entries, 50 MiB per file and 100 MiB total.

Stream close alone can occur while a source FileHandle.read is still pending.
The snapshot helper and Docker upload now join producer traversal, reads and
owned closes before cleanup or settlement. Cancellation and deadlines do not
release that ownership early. Hung source I/O can delay completion beyond the
requested deadline; this is deliberately not a hard I/O timeout guarantee.
Transfer/producer/late-close errors remain observable and retain their causes.

withCompileInputSnapshot creates one fresh owned private job directory, copies
through the same bounded TAR functions, seals input files/directories, and gives
the trusted consumer a new output path. Cleanup removes only that exact owned
job identity; replacement or foreign paths are preserved and failures surface.
Its source/root exclusivity and quiescence are caller prerequisites. It remains
unwired: no cache publication, workflow coordinator, host quota or rootless
boundary is activated by this helper.

Independent review reproduced the original lifetime gap with a held real read.
Four native-child regressions prove both snapshot and adapter remain pending
until read/close settlement, including late close errors, exactly one close,
no consumer/exec, cleanup and strict unhandled-rejection handling. The original
25 snapshot filesystem cases include an 80 MiB input proving the input policy
is reused rather than the narrower output policy. Original artifacts remain
unchanged and the framing collector remains byte-identical.

Actual integration retains all previous listener/lock/native/type selections:
209 outer tests pass (180 previous plus 25 snapshot and four lifetime cases).
The listener wrapper separately runs its 75 native cases. Strict/erasable types
pass with prior options unchanged. No dependency, lock, hook ID or CI workflow
change is introduced. Final installed hooks, independent integration readback
and required/post-merge CI remain exact-head acceptance gates.

Existing cache expiry, wordcount/output coordination and the input/output archive
policy need further workflow design. In particular, returning original large
inputs through the narrower generated-output policy requires an explicit
reviewed collection boundary. Do not silently raise limits or infer full
sandbox/promotion acceptance from these source units. Production remains stock.
