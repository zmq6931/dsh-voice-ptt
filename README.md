# dsh-voice-ptt

Push-to-talk voice input for **DeepSeek Harness (DSH)**: hold **Right Ctrl**, speak, and the transcript appears in the composer **while you talk** — then the final result replaces the interim text when you release the key.

[![npm version](https://img.shields.io/npm/v/dsh-voice-ptt.svg)](https://www.npmjs.com/package/dsh-voice-ptt)

> 📦 **Published on npm:** [`dsh-voice-ptt`](https://www.npmjs.com/package/dsh-voice-ptt) &nbsp;·&nbsp; **GitHub:** [zmq6931/dsh-voice-ptt](https://github.com/zmq6931/dsh-voice-ptt)
>
> Install: `dsh plugin --profile desktop add dsh-voice-ptt`

[中文说明](README.zh.md)

- 🎤 **Hold Right Ctrl to dictate.** Release to finalize. A 🎤 button in the composer toggles recording by click as well.
- ✍️ **Live text.** The current utterance is re-transcribed about every 0.7 s and refreshed in place, so words show up while you speak.
- 🔒 **Local by default.** Reuses the local **SenseVoice** model that the official *Voice Input* bundle already downloaded — no extra model download, no API key, audio never leaves the machine.
- 🧠 **Combo-safe.** Right Ctrl followed by another key within 220 ms is treated as a modifier combo (`Ctrl+C`, `Ctrl+V`, …), so shortcuts keep working.
- ☁️ **Optional cloud ASR.** Point it at any OpenAI-compatible `/audio/transcriptions` endpoint (SiliconFlow, Alibaba, Groq, self-hosted, …) with automatic fallback to the local provider.

## Why Right Ctrl

On Windows the **right Alt** key is commonly captured by other desktop assistants (for example the Kimi client) for their own voice input. This plugin defaults to **Right Ctrl** and leaves right Alt alone, so both tools can coexist. The key is configurable if you prefer another one.

## Requirements

- **DSH 0.2.x** (tested on `0.2.2-rc.1`, desktop app; the web GUI should work the same way).
- The official experimental **Voice Input bundle** enabled, with its local model downloaded. In DSH: **Plugins → Voice Input → Download and prepare**. The model lives in `$DSH_HOME/speech-to-text/sensevoice`.
- This plugin is a thin bridge to DSH's `ctx.speechToText` service. It does **not** bundle or download an ASR model of its own.

If the Voice Input bundle is missing/disabled, the plugin's host half stays pending and the hotkey shows an error status instead of recording.

## Install

```bash
# from npm (recommended)
dsh plugin --profile desktop add dsh-voice-ptt

# web profile
dsh plugin --profile web add dsh-voice-ptt
```

Alternative sources:

```bash
# straight from GitHub
dsh plugin --profile desktop add github:zmq6931/dsh-voice-ptt

# manual, from a local checkout
dsh plugin --profile desktop add link:/absolute/path/to/dsh-voice-ptt
```

The DSH **Plugins** panel accepts the same specs. Restart DSH (or refresh the GUI page) after installing; the 🎤 button and the hotkey appear once the plugin is loaded.

## Usage

| Gesture | Effect |
| --- | --- |
| Hold **Right Ctrl** (≥ 0.2 s) | Start dictation; text streams into the composer draft |
| Release Right Ctrl | Final transcription replaces the interim draft |
| Right Ctrl + another key within 220 ms | Treated as a normal modifier combo, no recording |
| 🎤 button in the composer | Click to start / stop dictation |
| Switch to another window while recording | Recording ends automatically |

A small status pill appears in the bottom-right corner: `🎙 聆听中…`, `⏳ 识别中…`, `✓ 已写入`, or an error message.

Long dictation is committed in segments every ~15 s so per-chunk inference latency stays flat.

## Configuration

Settings live in `$DSH_HOME/voice-ptt.json` (UTF-8 **without BOM**). The browser half reads it at plugin mount, so refresh/restart after editing.

```json
{
  "language": "auto",
  "hotkey": "ControlRight"
}
```

| Key | Values | Default | Meaning |
| --- | --- | --- | --- |
| `language` | `auto` / `zh` / `yue` / `en` / `ja` / `ko` | `auto` | Recognition language hint. `yue` = Cantonese. |
| `hotkey` | any `KeyboardEvent.code` in the small built-in list below | `ControlRight` | Push-to-talk key. |
| `asr` | `local` / `cloud` | `local` | Recognition backend. |
| `fallbackLocal` | `true` / `false` | `true` | Fall back to the local provider when cloud ASR fails. |

Built-in hotkey codes: `ControlRight`, `ControlLeft`, `AltRight`, `AltLeft`, `ShiftRight`, `MetaRight`.

Per-origin overrides (take precedence over the file, and apply immediately):

```js
localStorage["dsh-voice-ptt:language"] = "yue";
localStorage["dsh-voice-ptt:hotkey"] = "AltRight";
```

### Cloud ASR (optional, audio leaves the machine)

```json
{
  "asr": "cloud",
  "language": "auto",
  "fallbackLocal": true,
  "cloud": {
    "baseUrl": "https://api.siliconflow.cn/v1",
    "apiKey": "sk-...",
    "model": "FunAudioLLM/SenseVoiceSmall",
    "language": "auto",
    "timeoutMs": 60000
  }
}
```

- `baseUrl` is an OpenAI-compatible endpoint root; the plugin calls `POST {baseUrl}/audio/transcriptions` (multipart: `file`, `model`, `language`).
- `fallbackLocal: true` keeps dictation working when the cloud request fails.
- The API key stays in the host process: `/voice-ptt/config` returns a redacted view (`hasKey` only).
- In cloud mode the current utterance is re-sent roughly every 0.7 s while you speak, which costs requests; longer drafts mean repeated calls.

## Accuracy

This is **chunked re-transcription**, not true per-character streaming: the in-progress draft is re-recognized roughly every 0.7 s, and the text you get on release is a full re-recognition of the utterance (usually the most accurate). Expect ~0.5–1.5 s of lag during speech and the usual small-model mistakes (homophones, proper nouns, noisy rooms).

Ways to improve: closer/quieter microphone, speak in complete short sentences, set `language` explicitly (`yue` for Cantonese beats `auto` for dedicated Cantonese use), or switch to cloud ASR.

## Privacy

- Local mode: audio is converted to 16 kHz mono WAV in the browser, posted to the plugin's own loopback host route, and handed to the local SenseVoice provider. Nothing leaves the machine.
- Cloud mode: only the WAV segment is uploaded to the endpoint you configure.
- The plugin's routes are fenced to loopback/trusted hosts and same-origin requests.

## Known limitations

- Depends on the **experimental** `ctx.speechToText` service from the official Voice Input bundle; a future DSH release may change that API and break this plugin.
- The hotkey is scoped to the DSH window (not a system-wide global hotkey).
- Right Ctrl is also a real modifier: holding it longer than the 220 ms grace period and only then pressing a shortcut will start dictation (release to stop).
- No speaker/voice selection, no wake word, no auto-send — dictation only.

## Development

```bash
node test/smoke.mjs                      # offline: browser recording pipeline + host routes + cloud mode
node test/e2e-live.mjs <mono-pcm16.wav>  # live: POST a WAV to the running plugin's transcribe route
```

`test/smoke.mjs` runs the browser half in a `vm` sandbox with fake DOM/media/AudioContext and exercises the host half's routing, trust fence, payload validation, and cloud fallback.

## License

MIT. See [LICENSE](LICENSE).

Not affiliated with DeepSeek. Plugin conventions were informed by the MIT-licensed `dsh-voice-scribe` and `dsh-voice-mode` plugins, and the host bridge targets the official `@deepseek-ai/dsh-experimental-speech-to-text` service.
