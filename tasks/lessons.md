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
