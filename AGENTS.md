# AGENTS.md — SCAD (Stellator Cognitive Architecture Driver)

## Project

- Location: `C:\Users\terlo\Documents\GitHub\SCAD`
- Repo: `origin/main` on GitHub (Terrad77/SCAD) — pushed.
- Purpose: modular reasoning pipeline for documentary-film concepts. Pipeline of 7 stages:
  `research → claims → hypotheses → factCheck → narrative → visual → selfCheck`.
- Stack: TypeScript, modern ESM, strict TS, Zod schemas, Vitest tests, ESLint, Prettier.
  LLM provider is abstract (opencode / ollama / mock).

## Source of truth for the task

The full specification (20 sections + Definition of Done) lives in
`C:\Users\terlo\Downloads\OpenCode Task — Stellator - SCAD Documentary Engine.md`.
When it is pasted into chat it tends to get truncated around section 1 —
always cross-check against the file.

## Status

- MVP per the task is complete, including #12 Human Approval
  (`--interactive` checkpoints `a/r/m/g`, approvals stored in `memory/approved.json`).
- Checks are green: `npm run build`, `npm run lint`, `npm run format:check`, `npm test` (51 tests).
- Last commit: `5a8e6bf` (pushed).

## Useful commands

- Tests: `npm test` (Vitest, 8 files)
- Build: `npm run build`
- Lint: `npm run lint` / format: `npm run format:check`
- CLI (offline demo): `LLM_PROVIDER=mock node dist/cli/bin.js documentary <name> --force [--interactive]`
  Use `bin.js`. `cli.js` is just the module without a main entry point.
- CI expects `scad documentary <name>` to produce all artifacts with mock provider.

## Windows specifics

- Files/folders can be held by SYSTEM or other processes (`EPERM`/`Access denied`).
  Prefer cleaning via PowerShell `Remove-Item -Recurse -Force`.
- `:` is not allowed in storage key filenames on NTFS (creates ADS) — use safe keys
  (e.g. single `approved` key with a nested record instead of `approved:<stage>`).

## Open follow-ups (optional)

- Add OpenAI / Anthropic providers (interface is `LLMProvider.generate`).
- Richer approve/reject/modify UI.
- Vector storage later — the `MemoryStore` abstraction already exists as the seam.
