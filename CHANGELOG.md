# LOPE fork changes

## 2026-11-13 — CE+ adoption foundation

Forked CE+ at ae07e781; reconciled its immutable dependency graph without
upgrading retained resolutions. Added pinned development tooling, blocking
pre-commit/CI checks and explicit public production type boundaries. Repaired
concrete public type/API defects, the read-only runner crash and reviewer
comment-deletion authorization, with focused regressions. Preserved upstream
structure, licensing and attributions.

The fork is a source candidate. Complete image builds, native sandbox testing,
workflow/migration parity and production promotion are not accepted. See
[the acceptance matrix](docs/lope/FEATURE_MATRIX.md) and
[baseline evidence](docs/lope/BASELINE_2026-11-13.md).
