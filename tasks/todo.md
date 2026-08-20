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
- The client notice and server gate advertise the same proven 20-minute limit.
- The exact production provider error is classified as a duration-limit failure if it reaches the worker.

### Checklist

- [x] Inspect the failed production job, timings, and refund ledger.
- [x] Confirm the provider's 1,400-second rejection against the current request path.
- [x] Restore the shared server/client limit to 20 minutes, leaving 200 seconds below the provider cap.
- [x] Add regression coverage for the 29-minute failure and provider error classification.
- [x] Run focused and full tests, build, and diff review.
- [ ] Merge after separate release approval, then verify Railway and `/api/health`.

### Results

- Production job `d86aab09` proved the model rejects 1,704.94 seconds because its maximum is 1,400 seconds.
- The 29-minute reservation and refund ledger entries cancel exactly; no credit loss was found.
- Focused duration/readability tests passed 12/12, the full suite passed 208/208, the production build transformed 61 modules, and `git diff --check` passed.

## Result screen readability

### Goal and acceptance criteria

- Completion summary labels and values are readable without browser zoom.
- Download format names, details, and actions are clearly legible.
- Longer labels wrap inside their own column without creating horizontal overflow on desktop or mobile.

### Checklist

- [x] Increase summary and export typography with matching row spacing.
- [x] Give the export panel enough stable width on desktop and stack it at the existing responsive breakpoint.
- [x] Allow download copy to wrap inside a `min-width: 0` column.
- [x] Run focused tests, full tests, build, and desktop/mobile visual checks.

### Results

- At 1,440px, summary text renders at 14/16px and export text at 20/16/14px in a 360px tool column, with no overflowing result elements.
- At 390px, the summary uses two columns, the export tool fills the available width, and no result element creates horizontal overflow.

# Large WAV pre-upload optimization

## Acceptance criteria

- [x] MP3, M4A, video, and other supported formats keep the existing 150MB selection and server limit.
- [x] PCM and IEEE Float WAV files up to 500MB can be selected and are converted in the browser to 16-bit mono speech WAV before upload.
- [x] Large WAV processing reads the source incrementally in a Web Worker instead of loading the full original into the page memory.
- [x] Unsupported or malformed WAV files fail before network upload and before any credit reservation.
- [x] The optimized file must be 150MB or smaller and preserve the original filename for history.
- [x] Progress, cancellation/reselection, mobile layout, and accessible status messaging are complete.
- [ ] Focused tests, full tests, production build, responsive browser checks, CI, and production health pass.

## Checklist

- [x] Verify production account count, balances, active reservations, and usage-ledger consistency.
- [x] Trace client selection, validation, upload ownership, and server size boundaries.
- [x] Implement and test the PCM/Float WAV parser and streaming downsampler.
- [x] Add the worker bridge and HomePage preparation states.
- [x] Update upload guidance without changing the 150MB server boundary.
- [x] Run focused and full tests, build, responsive browser checks, and diff review.
- [ ] Commit, open and merge the PR, then verify Railway and `/api/health`.

## Working notes

- Production currently has 10 confirmed active accounts and 1,269 total remaining minutes; no missing profiles, orphan profiles, negative balances, or active reserved jobs were found.
- Browser output will remain WAV rather than adding a browser MP3 encoder dependency. Mono 16kHz 16-bit PCM is about 1.92MB per minute and remains suitable for speech transcription.
- The 500MB value is a client-side source-selection ceiling only. Multer, Railway, and the transcription API remain capped at 150MB.
- A synthetic 151MB, 48kHz stereo PCM WAV completed optimization in 1.66 seconds, read no source slice larger than 4MB, and produced an uploadable file below 150MB.
- Focused tests passed 13/13, the full suite passed 218/218, and the production build emitted the dedicated WAV worker bundle.
- Responsive checks passed at 1440x900 and 390x844 without upload guidance overflow. The local browser could not inject a file into the login-gated hidden chooser, so the real-size conversion engine was verified separately from the signed-in UI flow.

# Single-line spoken subtitle invariant

## Acceptance criteria

- [x] SRT and ASS normalize edited line breaks and tabs into spaces.
- [x] Every generated spoken-subtitle cue remains a single visual line and at most 28 characters.
- [x] ASS disables automatic player wrapping and never emits `\\N` line breaks.
- [x] The result preview shows only the first single-line 28-character cue.
- [x] Targeted tests, full tests, and the production build pass.
- [ ] CI, deployment health, and Notion synchronization pass.

## Checklist

- [x] Confirm the existing SRT, ASS, preview, and regression-test behavior.
- [x] Normalize whitespace at the subtitle export boundary.
- [x] Disable ASS automatic wrapping and constrain the preview to one line.
- [x] Replace the prior two-line regression expectation with the product invariant.
- [x] Run local verification and review the diff.
- [ ] Publish and verify production.

## Working notes

- This release changes subtitle formatting only. It does not change transcription, diarization, credits, payments, or database behavior.
- Multi-speaker audio quality and dual-pass word timing remain separate benchmark-gated work.
- Focused subtitle tests passed 13/13, focused result-editor tests passed 7/7, the full suite passed 225/225, and the production build completed successfully.

# History date and filename overlap

## Acceptance criteria

- [x] Usage and redownload timestamps cannot paint over the adjacent column.
- [x] Dates and times remain readable at the existing 14px minimum without widening the desktop table.
- [x] Long filenames keep their desktop ellipsis and mobile wrapping behavior.
- [x] Focused tests, full tests, build, and responsive visual checks pass.
- [ ] CI, deployment health, and Notion synchronization pass.

## Checklist

- [x] Trace the shared history table structure and reproduce the fixed-column overflow cause.
- [x] Render history date and time on stable separate lines through one shared component.
- [x] Add a cell containment rule and regression coverage for both pages.
- [x] Run local verification and review the diff.
- [ ] Publish and verify production.

## Working notes

- The 176px date track leaves about 144px after cell padding, while the Korean locale timestamp is wider and was allowed to overflow because of `white-space: nowrap`.
- Widening the fixed track would reduce filename space and increase clipping risk near the desktop/mobile breakpoint, so this fix keeps the grid widths unchanged.
- The first five-width visual pass found the fixed desktop history grid clipping its download column at 1024px, so the existing card layout now starts at 1100px instead of 768px.
- Focused history checks passed 11/11, the full suite passed 226/226, and the production build completed successfully.
- Synthetic responsive history rows passed at 375, 390, 768, 1024, and 1440px with no date-to-filename overlap, page overflow, or download-column escape.

# Diarization result download failure

## Acceptance criteria

- [x] Existing completed diarization results with legacy speaker IDs can download as SRT, TXT, and ASS.
- [x] New provider speaker labels always become stable non-negative IDs below the 20-speaker boundary.
- [x] Valid existing speaker IDs and color assignments are preserved during legacy repair.
- [x] Invalid untrusted speaker metadata still fails with a safe 400 response.
- [x] Focused tests, full tests, and the production build pass.
- [x] CI, deployment health, and Notion synchronization pass.

## Checklist

- [x] Compare the latest completed production job shape with the download validator without reading transcript text.
- [x] Confirm the latest job contains one legacy `speaker: -1` segment and that the download route rejects it.
- [x] Add shared speaker normalization for provider output and legacy download payloads.
- [x] Add regression coverage for the reported result shape and unsafe metadata.
- [x] Run local verification, publish, and verify production.

## Working notes

- The latest completed production job had 264 segments with valid text/start/end fields; one segment had `speaker: -1`, while the remaining speaker range was 0 through 5.
- The old provider mapping assumed every string label was a single uppercase letter and calculated `charCodeAt(0) - 65`; an exceptional label therefore produced a negative ID.
- `/api/download` validates speaker IDs and speaker-color keys before generating every format, so the single negative ID blocked TXT even though TXT does not render speaker metadata.
- Focused download, diarization, and subtitle tests passed 33/33, including the 264-segment reported shape across SRT, TXT, and ASS.
- The full suite passed 230/230 and the production build completed successfully.
- PR #98 merged as `4c2c9e5`; Railway stabilized after the provider incident and `/api/health` returned HTTP 200 with the same commit.

# Whisper repeated-speech hallucination guard

## Acceptance criteria

- [x] The reported low-confidence seven-segment repetition is recognized before GPT correction.
- [x] Normal two- or three-fold repetitions and high-confidence repeated speech remain untouched.
- [x] Speaker-labeled diarization output is never changed by the regular Whisper guard.
- [x] Segment order and timestamps stay monotonic after a guarded run is collapsed.
- [ ] Focused tests, full tests, production build, CI, deployment health, and Notion synchronization pass.

## Checklist

- [x] Compare the reported WAV interval with the stored provider segments and local silence analysis.
- [x] Trace the existing silence filter and confirm that it only removes explicit silence or music markers.
- [x] Characterize consecutive exact-repeat runs across production history without reading other transcript text.
- [x] Add regression tests for the reported provider shape and legitimate repetition counterexamples.
- [x] Implement the smallest evidence-gated regular-Whisper guard before GPT correction.
- [ ] Run local verification, publish, and verify production.

## Working notes

- The reported result contains seven consecutive `아 진짜요?` segments from 376.793s to 384.433s. They share one decode window, nearly identical durations, no speaker label, and `avg_logprob` about -0.826.
- The existing filter removes labels such as `(무음)` and `[음악]`, but natural-language Whisper hallucinations pass through and GPT correction intentionally preserves repetition.
- Production aggregates show 49 exact runs of at least three segments; none are speaker-labeled. Only four runs satisfy the conservative four-plus, single-window, uniform-duration, low-confidence signature.
- The parallel chunk boundary can amplify a low-energy decode, but similar runs predate parallel transcription, so the provider loop plus the missing semantic guard is the root cause.
- Focused processing tests passed 17/17, the full suite passed 239/239, and the production build completed successfully.

# Toss review payment window and business contact

## Acceptance criteria

- [x] The payment page opens Toss Payments' integrated card window without filtering issuers.
- [x] Card availability and issuer-review messages are removed from payment and failure pages.
- [x] The public footer displays `010-4901-1421` as the business contact.
- [x] The privacy policy remains email-only and does not duplicate the mobile number.
- [ ] Production uses a matched Toss API individual test key pair before checkout is enabled.
- [x] Focused tests, full tests, build, and responsive checks pass.
- [ ] CI, deployment health, and Notion synchronization pass.

## Working notes

- Railway currently reports Toss Payments `live` mode, so `PAYMENTS_ENABLED` must remain closed until the production variables are changed to a matched `test_ck`/`test_sk` pair.
- The order, confirmation, idempotency, credit, refund, and webhook paths are unchanged.
- `.env.example` keeps `PAYMENTS_ENABLED=false` as the safe default; Railway production is opened only after the test key switch is verified in startup logs.

## Results

- Focused payment, contact, and accessibility tests passed 49/49.
- The full suite passed 239/239 with `--test-isolation=none`; the production build transformed 63 modules.
- Desktop 1440x900 and mobile 390x844 checks found no horizontal overflow, no issuer-specific copy, and the exact business contact in the footer.
- The checkout still creates orders from the server catalog, verifies amount and ownership, and uses idempotent confirmation and recovery paths.
