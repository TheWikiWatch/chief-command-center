# Roadmap to the first release

Each phase lands with its own tests and a note in `docs/PROGRESS.md`.

| # | Phase | Done when |
| --- | --- | --- |
| 0 | Feasibility: bundled Hermes payload, gateway + bridge on it, speech model size, Electron shell basics | Measured and documented |
| 1 | This repository: config-driven code (no personal defaults), merged chat platform plugin, in-process Web Push, standalone web build, privacy scan in CI | Suites green; scan clean |
| 2 | Provider connection through Hermes's own provider catalog; first-run onboarding; Connection settings | A fresh home connects to a keyed provider and to a keyless local endpoint |
| 3 | Edit SOUL and memory in the app (Hermes's locking and scanning, version history, conflict handling) | Round-trip, limits, conflict and restore tests |
| 4 | Second Brain: template, scaffold (new or existing folder, with clear choices), built-in Today indexer, bundled skill | Scaffold + agent round-trip on a fresh home |
| 5 | Voice defaults and "Check my system": microphone choice, levels, test phrase, consented speech-model download | Every error state tested; text chat unaffected by voice failures |
| 6 | Backup and restore: everything / setup / Second Brain, optional encryption, safety backup before restore, path remapping | Round trip, including a different user name and path |
| 7 | Desktop shell: single instance, profile lock, readiness, crash restart, graceful quit, tray, native notifications, secret storage | Supervisor tests; runs a fresh home end to end |
| 8 | Packaging: MSIX with the payload; clean-machine install | Install → provider → Second Brain → check → chat on a clean VM |
| 9 | Adopting an existing Hermes install in place (dry run first, journaled, reversible) | Every feature of the previous setup verified afterwards |
| 10 | Updater and signed release manifest; backup at first launch of a new version | Success and every failure mode recover without data loss |
| 11 | Upstream Hermes tracking: candidate upgrade PRs with the compatibility suite | One real upgrade shipped through it |
| 12 | Public release: license audit of the payload, SignPath signing, public repository | Signed build installs on a clean VM |
