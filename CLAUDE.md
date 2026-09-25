# Frugal-Takeoff — Claude Code Instructions

## Git Workflow

- **Always push changes directly to the `testing` branch.**
- Do not push to `claude/code-review-nuJ1Q` or any other branch unless explicitly asked.
- Do not create pull requests unless the user explicitly asks for one.

## ONLYOFFICE project (`onlyoffice` branch only)

- On the `onlyoffice` branch, this overrides the `testing` rule above: commit and push ONLYOFFICE work to **`onlyoffice`**, never to `testing`. The branch merges into `testing` once, when the whole project is done and tested.
- Progress, decisions and open questions live in `docs/superpowers/specs/2026-09-25-onlyoffice-checklist.md`. Read it first; tick items off in the same commit as the work.
- Remove this section when `onlyoffice` is merged into `testing`.
