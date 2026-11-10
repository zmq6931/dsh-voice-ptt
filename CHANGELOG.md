# Changelog

## 0.3.0 — 2026-11-10

Initial public release.

- Push-to-talk dictation on **Right Ctrl** (configurable), with live text refreshed in the composer draft roughly every 0.7 s and a final re-recognition on key release.
- Bridges to DSH's `ctx.speechToText` service, so it reuses the official Voice Input bundle's local SenseVoice model — no extra model download, no API key, audio stays local.
- Combo-safe hotkey handling (a modifier combo within 220 ms does not start dictation).
- Recognition language hint support: `auto` / `zh` / `yue` (Cantonese) / `en` / `ja` / `ko`.
- Optional OpenAI-compatible cloud ASR with automatic local fallback and a redacted config endpoint.
- Composer 🎤 button, status pill, per-origin overrides, and offline smoke tests (browser pipeline in a `vm` sandbox + host route tests, including cloud fallback).
