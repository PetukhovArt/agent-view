# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-04-06

### Added
- CLI commands: `init`, `discover`, `dom`, `click`, `fill`, `screenshot`, `scene`, `snap`, `launch`, `wait`, `stop`
- Lazy TCP server with auto-shutdown after 5min idle
- CDP transport with IPv4/IPv6 dual-stack support
- Runtime adapters: Electron, Tauri (with internal target filtering), Browser
- PixiJS scene extractor with diff support
- DOM accessibility tree inspector with ref IDs and filtering
- Multiwindow support via `--window` flag
- Claude Code plugin with `verify` skill
- Security: TCP auth token, shell injection protection, buffer limits, args validation
