# Reliability Fixes Implementation Plan

**Goal:** Fix the nine defects confirmed in the 2026-09-08 system review and restore the existing smoke tests.

**Architecture:** Keep the existing Electron/React/MQTT design. Bind control authority to current telemetry, bound pending publications, preserve edits across sync transactions, use conditional WebDAV lock deletion, and make desktop resource lifecycles cancellable.

**Tech Stack:** TypeScript, Electron, React, mqtt.js, Vitest, Playwright.

**Spec:** The nine verified findings in the preceding review and the user's instruction to fix them.

## Constraints

- Work in the clean main checkout; leave the sibling integration worktree untouched.
- No real device commands, public broker publishing, deployment, or release.
- Preserve current credential and backup scope decisions.
- Add regression tests that fail before production fixes, then run focused tests.
- Use existing patterns and keep independent task file ownership separate.

## Task 1: MQTT Publication and Reply Lifecycle

Files: `src/main/mqtt-manager.ts`, MQTT tests, `src/renderer/src/App.tsx`, `src/renderer/src/lib/dji.ts`, related tests.

- [x] Regress a missing PUBACK, disconnect before PUBACK, late callback, and a device reply received before the outbound log.
- [x] Bound publish waits; abort outstanding publishes on disconnect and remove cancelled packets from mqtt.js retry storage.
- [x] Ensure service timeout/disconnect can finish the caller while publication is pending.
- [x] Correlate replies independently of record order and preserve accurate timestamps.
- [x] Verify actual mqtt.js reconnect behavior using an in-memory transport.

## Task 2: Current Device Authority

Files: `src/renderer/src/views/CommandCenter.tsx`, `src/renderer/src/lib/telemetry-cache.ts`, tests; coordinate any App telemetry reset with Task 1.

- [x] Regress cached/offline/expired authority and valid current authority.
- [x] Require current online device state for control gating and strip session-only control state from persisted cache.
- [x] Invalidate session control state on disconnect without losing unrelated telemetry.
- [x] Run focused command and cache tests.

## Task 3: WebDAV Consistency and Backup Boundaries

Files: `src/main/webdav-*`, persistence stores and `src/main/index.ts` as required for a shared mutation boundary, related tests.

- [x] Regress edits acknowledged during remote downloads, expired-lock replacement, post-restore network failure, and 25 MiB backup round trips.
- [x] Serialize local mutations with snapshot application or atomically detect and reconcile intervening edits; protect all participating stores.
- [x] Delete locks using the observed ETag and If-Match; never delete a replacement lock without a matching validator.
- [x] Finish fallible remote reads before applying a restore and preserve consistent state on failure.
- [x] Align plaintext, encoded envelope, and HTTP response limits; reject oversized output before upload.
- [x] Run focused storage, merge, crypto, and client tests.

## Task 4: Desktop Download and Media Lifecycle

Files: `src/main/app-update-manager.ts`, `src/main/media-server-manager.ts`, new focused tests.

- [x] Regress ENOSPC and asynchronous stream-open failures, plus stop during media startup preparation.
- [x] Observe stream errors throughout download and remove partial files without uncaught exceptions.
- [x] Cancel stale media startups so a successful stop cannot be followed by a late spawn.
- [x] Run focused desktop lifecycle tests.

## Task 5: Integration Verification

Files: `scripts/electron-smoke.mjs`, `scripts/remote-log-smoke.mjs`, `scripts/webdav-smoke.mjs` and this plan.

- [x] Correct stale control-state assertions, device button selectors, and auth-switch credential setup.
- [x] Run the complete unit suite, typecheck, and production build.
- [x] Run isolated Electron UI, remote-log, and local WebDAV smoke tests; examine failures and screenshots.
- [x] Review the complete diff against all nine findings and record final validation.

## Validation Log

- Baseline from the review: 56 test files / 350 tests passed; typecheck and build passed. All three smoke scripts had stale fixture or selector failures.
- Final: 60 test files / 395 tests passed; typecheck, production build, and git diff --check passed.
- Electron UI smoke passed with 18 layout snapshots and an added disconnect/reconnect authority invalidation assertion. Remote-log and two-client local WebDAV smoke tests passed with no errors. All used temporary user-data directories.
- Real mqtt.js in-memory transport tests cover both clean and retained sessions, exactly one reconnect, no cancelled-command replay, fresh publication, and replies preceding PUBACK.
- Follow-up regressions cover truncated HTTP responses, a total request deadline including redirects and Digest retries, release of blocked store saves, sync rollback, and retry discovery of an already uploaded immutable version.
- No real device or public-broker operations, Windows runtime validation, release, deployment, or commit performed. The sibling integration worktree's six existing modified files were left untouched.
