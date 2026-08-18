# Lessons

- Persistent server work must not be represented by a route-local timer. Keep request and polling ownership above routes, and show an indeterminate state unless the API exposes real progress.
- Korean sentence-ending syllables such as `다` and `요` are safe subtitle cut points only at a word boundary; otherwise they can split ordinary words.
- Place generated-content history beside the workflow that creates and reuses it. Keep account usage pages focused on ledger changes so users do not have to guess where past results live.
- Do not raise a public media-duration limit because documentation omits a cap. Verify the provider boundary with a real request first, then keep a small measurement margin so users are rejected before credits are reserved.
- PR_text spoken subtitles are a strict single-line product format. Normalize all edited whitespace before export, forbid ASS automatic wrapping and `\\N`, and keep every generated cue within the existing 28-character boundary.
