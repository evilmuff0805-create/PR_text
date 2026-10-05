# Lessons

- Persistent server work must not be represented by a route-local timer. Keep request and polling ownership above routes, and show an indeterminate state unless the API exposes real progress.
- Korean sentence-ending syllables such as `다` and `요` are safe subtitle cut points only at a word boundary; otherwise they can split ordinary words.
- Place generated-content history beside the workflow that creates and reuses it. Keep account usage pages focused on ledger changes so users do not have to guess where past results live.
- Do not raise a public media-duration limit because documentation omits a cap. Verify the provider boundary with a real request first, then keep a small measurement margin so users are rejected before credits are reserved.
- PR_text spoken subtitles are a strict single-line product format. Normalize all edited whitespace before export, forbid ASS automatic wrapping and `\\N`, and keep every generated cue within the existing 28-character boundary.
- Locale-formatted timestamps must not rely on a narrow fixed column with visible overflow. Split date and time into stable lines and contain the cell so adjacent history columns can never overlap.
- Never derive speaker IDs with character arithmetic from a provider label. Normalize opaque labels by identity and first appearance, and repair legacy out-of-range IDs at the download boundary.
- Explicit silence-marker filters do not catch plausible-language Whisper loops. Guard only strong provider-shaped repetition evidence, preserve ordinary repeated speech, and run the guard before GPT correction can legitimize the loop.
- When an expiring credit lot has both available and reserved amounts, releasing an expired reservation must atomically zero and subtract any still-available balance. Marking the lot expired without reconciling that balance leaves `profiles.credits` stale.
- Diarized short-cue merging must not bridge even a brief positive silence between the same speaker's turns. Regressions must check original end times and the blank interval in both SRT and ASS; reading-duration targets do not authorize padding into silence.
- Korean quoted forms ending in `-라고/-다고/-냐고/-자고` are not independent clause endings merely because their last syllable is `고`. Keep dependent phrases with their predicates and check the user's complete sentence, not an isolated token.
- A two-second SRT start marker is an explicit export exception, not an audio-alignment fix. Keep it outside dialogue normalization, preserve original speech times, and disclose editor style support and overlap limits.
- Commit, push, passing CI, and a healthy production deployment are separate evidence. Verify the target SHA through production health; verify Notion writes by reading the page again rather than marking synchronization done when only local Markdown exists.
