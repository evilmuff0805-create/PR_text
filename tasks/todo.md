# Account deletion safety

## Acceptance criteria

- [x] Free promotional credits can be forfeited only after an explicit confirmation.
- [x] Active transcription jobs and unresolved payment/refund states block deletion.
- [x] A remaining balance with an unresolved paid order routes the user to refund review.
- [x] Payment orders survive account deletion without retaining the account email.
- [x] Transcription data, usage history, temporary audio, sessions, and the Auth user are removed.
- [x] Google-only users reauthenticate with Google rather than entering a password.
- [x] A deletion tombstone prevents a still-valid JWT from recreating the profile.
- [x] Tests and the production client build pass before deployment.

## Checklist

- [x] Inspect current Auth, payment, job, Storage, and foreign-key behavior.
- [x] Validate Supabase's current user deletion and session behavior.
- [x] Add the backward-compatible database migration.
- [x] Add account deletion preview and execution APIs.
- [x] Add the account settings confirmation flow.
- [x] Align terms and privacy copy with the deletion policy.
- [x] Add regression coverage.
- [x] Run tests and build.
- [x] Review the final diff and deployment order.

## Working notes

- `profiles.credits` does not distinguish free and paid balances.
- Conservative rule: any positive balance plus an unrefunded paid order requires review.
- All pending orders block automatic deletion; stale orders require payment reconciliation before the account can be removed.
- `payment_orders.user_id` currently cascades from `profiles`; it must become nullable with `ON DELETE SET NULL`.
- Auth access tokens may remain valid until expiry, so a hashed deletion tombstone must block profile recreation.
- Supabase CLI is not installed in this workspace; the migration file is being added directly and will be validated before application.

## Results

- `npm test`: 98 passed, 0 failed.
- `npm run build`: passed with 56 modules transformed.
- Desktop and 390px mobile account-deletion screens render without horizontal overflow.
- Google reauthentication returns to `/settings`, uses the real `last_sign_in_at`, and requests account selection.
- Production migration applied before the app deployment; existing payment rows were unchanged.
- Database verification: payment FK uses `ON DELETE SET NULL`, deletion RLS is enabled, browser RPC access is denied, and `service_role` access is enabled.
- Supabase advisors reported only intentional no-policy RLS notices plus pre-existing leaked-password protection and unused-index notices.

# Basic plan price adjustment

## Acceptance criteria

- [x] New Basic orders are created for 5,900 KRW and 100 minutes.
- [x] The payment page shows 5,900 KRW, 40% off, and 59 KRW per minute.
- [x] Margin calculations use 59 KRW per minute for the Basic plan.
- [x] Existing orders keep their stored amount for confirmation and refunds.
- [x] Local tests and the production build pass.
- [ ] CI and production deployment pass.

## Checklist

- [x] Locate the server catalog, client display, benchmark, and payment tests.
- [x] Update the new-order price without rewriting historical order amounts.
- [x] Add regression coverage for server/client/benchmark price alignment.
- [x] Run the full test suite and production build.
- [ ] Review the final diff and deploy.

## Working notes

- The server plan catalog is authoritative for new Toss orders.
- Confirmation and refund paths use the amount stored on each order, so pre-change 4,900 KRW orders remain valid.
- The 9,900 KRW reference price remains unchanged; the displayed discount changes from 50% to 40%.

## Results

- `npm test`: 135 passed, 0 failed.
- `npm run build`: passed with 58 modules transformed.
- `git diff --check`: passed.
- CI and production deployment are pending.

# Public personal phone removal

## Acceptance criteria

- [x] The site footer no longer displays the owner's personal mobile number.
- [x] The privacy policy no longer displays the owner's personal mobile number.
- [x] The customer support email remains available in both locations.
- [x] Regression coverage prevents a Korean mobile number from being reintroduced in these public views.
- [x] Local tests and the production build pass.
- [ ] CI and production deployment pass.

## Checklist

- [x] Search the public client for mobile-number and contact references.
- [x] Remove only the personal phone fields without leaving duplicate separators.
- [x] Add regression coverage.
- [x] Run the full test suite, production build, and diff checks.
- [ ] Deploy and verify the production footer, privacy page, and health endpoint.

## Working notes

- The personal mobile number appeared only in `Layout.jsx` and `PrivacyPage.jsx`.
- Email remains the public privacy and customer-support contact channel.
- Before commercial launch, replace the removed number with a dedicated business/customer-service number to satisfy applicable online-sales disclosure requirements.

## Results

- `npm test`: 136 passed, 0 failed.
- `npm run build`: passed with 58 modules transformed.
- `git diff --check`: passed.
- Current client source and production build contain no Korean mobile-number pattern.
- CI and production deployment are pending.

# Persistent transcription status and word-safe subtitles

## Acceptance criteria

- [x] Audio-to-text processing stays visibly active when navigating between app tabs.
- [x] Processing uses an indeterminate spinner instead of a fabricated ETA or percentage.
- [x] The processing view says that the app will notify the user when conversion completes.
- [x] Completion shows a non-disruptive in-app notification with a result action.
- [x] Existing durable diarization jobs still restore after a refresh and remain cancellable.
- [x] SRT and ASS lines remain at most 28 characters without splitting Korean words when a whitespace boundary is available.
- [x] Existing timing and speaker metadata remain intact.
- [ ] Tests, production build, responsive visual checks, CI, and production health pass.

## Checklist

- [x] Trace current HomePage state, polling, persistence, and subtitle splitting behavior.
- [x] Confirm the server job continues independently while the HomePage display timer restarts on remount.
- [x] Move transcription upload, polling, completion, and cancellation into an app-level provider.
- [x] Add processing and completion notification UI with accessible reduced-motion behavior.
- [x] Add word-boundary subtitle reflow and regression tests for the reported Korean sentence.
- [x] Run targeted and full tests, build, responsive screenshots, and diff checks.
- [ ] Commit, open and merge the PR, then verify Railway and `/api/health`.

## Working notes

- The current fake progress is calculated from a component-local `Date.now()` value and restarts after route remount.
- The queued diarization worker is already server-side and keyed in local storage, so no database migration is required.
- Standard transcription stays in one HTTP request; keeping that request in an app-level provider preserves it across SPA route changes, but not a full browser close.
- The 28-character product rule remains unchanged. The fix must prefer whitespace boundaries and retain the original segment timeline.

## Results

- Targeted regression tests: 9 passed, 0 failed.
- `npm test`: 140 passed, 0 failed.
- `npm run build`: passed with 59 modules transformed.
- `git diff --check`: passed.
- Local browser QA confirmed that a standard transcription continued after navigating to Caption Ideas, completed without forcing a route change, and opened the result from the notification action.
- Desktop and 390px mobile processing/notification layouts rendered without horizontal overflow.
- Browser console review found no errors from this change; only pre-existing React Router v7 future-flag warnings were present.
- A read-only production data check confirmed completed server-side transcription jobs; no schema migration is required for this change.
- CI, merged deployment, and production health verification are pending.

# Caption idea history relocation

## Acceptance criteria

- [x] Usage shows only credit and time changes, including caption-idea credit charges.
- [x] Caption Ideas exposes a collapsed history control below the creation workflow.
- [x] History loads only after the user opens the control.
- [x] Existing 90-day history, copy, pagination, empty, loading, and error states remain available.
- [x] A successful generation refreshes the history on its next render.
- [x] Local tests, production build, and responsive browser checks pass.
- [ ] CI and production health pass after merge.

## Checklist

- [x] Trace the current history endpoint, user scoping, UsagePage ownership, and styles.
- [x] Move history state and rendering into a focused component.
- [x] Add an accessible disclosure to CaptionIdeasPage.
- [x] Remove the history fetch and section from UsagePage.
- [x] Add regression coverage for lazy ownership and removal from UsagePage.
- [x] Run tests, build, responsive browser checks, and diff review.
- [ ] Commit, open and merge the PR, then verify Railway and `/api/health`.

## Working notes

- The existing authenticated `/api/caption-ideas/history` endpoint and database policies remain unchanged.
- The panel is conditionally mounted, so the history request is not sent while it is collapsed.
- The usage ledger keeps the `caption_ideas` action label because the one-minute pack charge is still a real time change.
- Targeted tests passed 9/9; the full suite passed 140/140 with `--test-isolation=none` because this Windows runner blocks the default child-process isolation with `spawn EPERM`.
- The production build passed with 60 modules transformed.
- Local browser QA confirmed zero history requests before opening, one request on first open, no duplicate request after closing and reopening, and no horizontal overflow at 390 x 844.
- Usage retained the caption-idea credit ledger row but no longer rendered the caption-idea history section.

## Diarization provider duration limit

### Goal and acceptance criteria

- A file above the provider's 1,400-second diarization limit is rejected before queueing or credit reservation.
- The client notice and server gate advertise the same conservative 23-minute limit.
- The exact production provider error is classified as a duration-limit failure if it reaches the worker.

### Checklist

- [x] Inspect the failed production job, timings, and refund ledger.
- [x] Confirm the provider's 1,400-second rejection against the current request path.
- [x] Set the shared server/client limit with a 20-second measurement margin.
- [x] Add regression coverage for the 29-minute failure and provider error classification.
- [x] Run focused and full tests, build, and diff review.
- [ ] Publish separately after release approval, then verify Railway and `/api/health`.

### Results

- Production job `d86aab09` proved the model rejects 1,704.94 seconds because its maximum is 1,400 seconds.
- The 29-minute reservation and refund ledger entries cancel exactly; no credit loss was found.
- Focused tests passed 20/20, the full suite passed 207/207, the production build transformed 61 modules, and `git diff --check` passed.
