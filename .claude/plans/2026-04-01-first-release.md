# First Release — agent-view v0.1.0
Date: 2026-04-01
Type: config
TDD Strategy: verification checklist

## Context
Publish first public release: GitHub Release + npm publish.

## Environment
Framework: Node.js + TypeScript (ESM)
Test runner: none
Linters: none

## Decisions
- Version: 0.1.0 (pre-stable first public release, not 1.0.0)
- Scope: GitHub Release (tag + notes) + npm publish
- README: write full usage docs with all commands
- package.json: fill metadata (description, author, keywords, repository, files, engines)
- `.gitignore` has `dist` — use `files` field in package.json to include dist in npm package
- `prepublishOnly` script to ensure build runs before publish
- No CHANGELOG for v0.1.0 — release notes in GitHub Release

## Slices
1. Fix package.json (version, metadata, files, scripts, engines)
2. Write README.md
3. Push all commits to origin
4. Build, verify dist works
5. npm login + npm publish
6. Create GitHub Release v0.1.0 with release notes
7. Update current-stage.md

## Status
- Current phase: execution
