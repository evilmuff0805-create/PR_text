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

# Toss payment widget and one-year paid-credit validity

## Acceptance criteria

- [x] Toss checkout uses the current order-sheet Payment Widget with a matched `gck/gsk` key pair.
- [x] Production checkout remains disabled until the test widget key pair and startup mode are verified.
- [x] The server remains authoritative for plan, amount, order ownership, confirmation, webhook recovery, and refunds.
- [x] Newly paid credits expire one year after payment approval; pre-policy balances are not expired retroactively.
- [x] Paid credits are consumed by earliest expiry first and refunds reclaim only the originating order's unused credits.
- [x] Diarization cancellation restores the exact reserved sources without reviving already-expired paid credits.
- [x] The payment page, intro copy, terms, and payment history explain the one-year policy consistently.
- [ ] Database replay, focused tests, full tests, build, responsive checks, CI, deployment health, and Notion synchronization pass.
- [ ] A Toss review PPT is created from the verified test checkout flow after all preceding gates pass.

## Checklist

- [x] Compare the current `payment()` integration with Toss's current `widgets()` order-sheet guide and key families.
- [x] Audit production balances, paid orders, active jobs, and every credit mutation path.
- [x] Implement the Payment Widget UI, public configuration endpoint, and widget-key validation.
- [x] Add backward-compatible paid-credit lot fields and atomic consume, restore, expire, payment, and refund functions.
- [x] Rewire transcription, diarization, caption ideas, authentication refresh, and maintenance to the new credit functions.
- [x] Add regression coverage for key pairing, widget order, expiry, allocation restoration, concurrency, and refunds.
- [x] Replay the migration in a disposable Supabase branch and run database invariants before production approval.
- [x] Run the full local verification and responsive browser checks.
- [ ] Open and merge a PR only after CI passes; apply production schema and deploy only after an explicit go/no-go.
- [ ] Verify `/api/health`, update and re-fetch the canonical Notion page, then produce the Toss review PPT.

## Working notes

- Toss's current order-sheet integration uses `widgets()` and widget key pairs (`gck/gsk`); the existing `payment()` flow uses API individual keys (`ck/sk`).
- Production currently has no open unrefunded paid order and no active queued or running job, so the key-family cutover does not need a legacy secret-key fallback.
- Existing `profiles.credits` remain the displayed aggregate for compatibility. Only payments approved after this migration receive an expiry and tracked remaining balance.
- The exact customer-facing wording is `충전 시간은 최대 1년입니다`.
- Checkout stays closed while Railway still has live API-individual keys. Code readiness is not permission to enable payment or apply the production migration.
- The migration now blocks both pending payments and unresolved paid orders, and it blocks active diarization reservations before backfilling legacy balances.
- `npm test -- --test-isolation=none`: 250 passed, 0 failed. `npm run build`: passed with 63 modules transformed. `git diff --check`: passed.
- Codex Browser responsive QA is not complete: two connection attempts failed at the trusted RPC boundary before a page opened. This is an environment limitation, not a verified UI result.
- The user approved the disposable Supabase branch cost of USD 0.01344 per hour. The first replay exposed a stale aggregate-balance bug when an expired lot still had both reserved and available credits; the migration and regression coverage now reconcile both amounts atomically.
- Branch SQL scenarios passed for welcome credit, paid completion and idempotency, FEFO consumption, expiry, refund and idempotency, normal reservation cancellation, and cancellation after expiry. Invariants reported zero ledger mismatches, negative profiles, invalid lots, or expired lots with available credit.
- The first branch was repaired with follow-up validation migrations after the defect was found, so a fresh branch replay of the final migration files was required before production approval.
- A fresh disposable branch then applied all 23 repository migration files in order without follow-up patches. The same functional SQL scenarios passed, all six ledger/cleanup invariants were zero, server-only privileges were enforced, and the branch was deleted after verification.
- Local verification after the fix passed the full 250-test suite, the 63-module production build, and `git diff --check`. Chrome QA at 1440x900 and 393x852 found no horizontal overflow, no console errors, a 14px minimum visible font size, all three plans, and the required business contact.

# 2026-10-05 PR_text documentation and Notion synchronization

## Acceptance criteria

- [x] Store essential PR_text product and engineering rules in a repository Markdown file read by future agents.
- [x] Correct stale silence-duration, correction-model, language, and subtitle-boundary guidance.
- [x] Record the SRT/login and diarization changes with verified commit, CI, and production evidence.
- [ ] Update the supplied PR_text Notion page and publish the Markdown rules, then re-read the page to verify persistence.

## Working notes

- Rules are in `AGENTS.md`; the update record is `docs/updates/2026-10-05-subtitles-and-login.md`.
- Application commit `9d00498` passed 342 tests, production build, both GitHub CI jobs, and production health with the matching commit and homepage HTTP 200.
- Target Notion page: `39a825f6-6465-818f-9aae-cf2f2c0ade25`.
- Notion publication remains blocked by missing connector/authentication. Do not mark remote synchronization complete based on local files alone.


# 2026-10-11 다화자 누락·화자별 자막 분리

## 이번 범위

- 기존 OpenAI 전사 서비스를 유지한다. 사용자가 추가 서비스 연동보다 누락·분리 수정 우선을 선택했다.
- 화자 수 직접 지정과 새로운 전사 공급자, DB·정산·작업 상태 변경은 이번 범위에서 제외한다.
- 실제 고객 음원과 운영 API 요청 없이 로컬 합성 오디오·모의 API로 검증한다.

## 완료 기준

- [x] 동일 시작 시각의 여러 화자 큐가 SRT·ASS에서 삭제되는 문제를 회귀 테스트로 재현한다.
- [x] 공백 교정 결과와 순수 대사 삭제·추가를 감지하면 해당 줄의 원문·화자·시간을 보존한다.
- [x] 다른 화자의 짧은 응답은 개별 큐로 유지하고 무음까지 늘리지 않는다.
- [x] 다화자 M4A는 원본 전송을 우선하고 필요한 변환은 강제 모노·16kHz 대신 128kbps 정책을 적용한다.
- [x] 대용량 WAV의 채널 평균으로 인한 위상 상쇄를 막고 업로드·메모리 한도를 유지한다.
- [x] 독립 QA, Node.js 22 전체 테스트, 프로덕션 빌드, diff 검사를 완료한다.

## 현재 검증 근거

- 새 누락 회귀 7개를 수정 전에 실행해 5개 실패를 확인했다(동일 시작, 빈 큐 간섭, 공백·반복 삭제·추가).
- Node.js 22.23.3에서 최종 전체 테스트 374/374 통과(실패·건너뜀 0), 프로덕션 빌드 68개 모듈 성공, git diff --check 성공. 독립 QA도 통과.
- FFmpeg 9.0.2 실제 합성 검증: 20분 반대 위상 2채널 WAV → 채널 보존 32kHz WAV 153,600,044B → 128kbps MP3 19,201,580B. 길이 1,200초·2채널·양채널 RMS 약 0.26857 유지.
- 첫 샌드박스 실행은 로컬 HTTP·realpath 제약으로 실패해 같은 명령을 제한 없이 재실행했다. 실 API 호출과 실제 고객 음원 검증은 하지 않았다.
- 실제 음성 인식 정확도·인물 동일성은 아직 검증하지 않았다. 이번 수정은 공급자가 이미 누락하거나 잘못 나눈 말을 복원하지 않는다.
- 이 기록은 로컬 코드·합성 음원 검증 근거다. 검토용 PR·원격 CI는 별도로 확인하며 운영 배포·운영 확인은 수행하지 않았다.
- 상세 결과: docs/updates/2026-10-11-diarization-preservation.md.


# 2026-10-11 일반 자막 의미 분할·시간 겹침 확인

## 범위와 완료 기준

- [x] 일반 한국어의 긴 앞 구절 + 짧은 종속 서술어 분할을 익명 동형 문장으로 재현한다.
- [x] 28자·한 줄·원문을 보존하면서 의미 경계와 꼬리 구절을 고려해 분할한다.
- [x] 공급자가 별도 구간으로 나눈 종속 서술어도 일반 0.3초 이내에서만 재분할하며 다화자·영어 단어 시간 경로를 보존한다.
- [x] 같은 시작 시각과 긴 구간 분할에 따른 일반 자막 겹침·원문 순서 문제를 수정한다.
- [x] 29.97fps 설정 여부를 코드와 SRT 형식 근거로 확인하고 화면 시간을 밀리초로 표시한다.
- [x] 최종 성능 점검, 독립 QA, 전체 테스트·빌드·diff 검사를 확인하고 검토용 PR 변경을 준비한다.

## 검증과 확인 범위

- 새 일반 export 회귀 10개 중 수정 전 6개 실패로 분할·겹침·순서 오류를 재현했다.
- 최종 Node.js 22 전체 테스트 400/400 통과, 실패·건너뜀 0. 프로덕션 빌드 69개 모듈 성공, 기본 git diff --check 성공.
- 독립 QA: 이전 DP와 6,042개 선택 결과 동일, 무작위 2,000원본/7,970출력 큐의 원문·순서·길이·일반 비중첩 보존. 347,200개 프레임 왕복과 5,000개 양수 간격 큐에서 계산·파일 겹침 오류 0.
- 허용 최대 100만 자 동일 시작 입력의 분할 계획을 최적화해 띄어쓴 사례 동기 처리 4.34초 → 1.16초(해당 로컬 QA 환경)로 줄였다. 실제 편집기 성능 보장은 아니다.
- SRT에는 fps 메타데이터가 없고 앱의 기존 내보내기는 초를 밀리초로 반올림한다. 29.97fps 기본 설정은 없었다. 프리미어 시퀀스 설정은 편집 프로그램에서 관리하며, 실제 가져오기 재현 없이 강제 프레임 보정을 추가하지 않았다.
- 사진 속 프리미어 중첩의 정확한 원인은 원본 SRT 없이 확정하지 않았다. 별도 합성 입력에서 재현한 파일상 일반 자막 겹침을 수정했다.
- 고객 이미지·대사 원문·영상은 저장소에 추가하지 않는다. 원문 예시의 두 구절 분리는 로컬 임시 검증으로만 확인했다.
- 운영 배포·실제 고객 음원 전사·프리미어 2026 가져오기 검증은 수행하지 않았다.
- 상세 결과: docs/updates/2026-10-11-ordinary-subtitle-boundaries.md.
