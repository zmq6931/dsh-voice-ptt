# dsh-voice-ptt

DSH（DeepSeek Harness）的**按住说话**语音输入插件：**按住右 Ctrl** 说话，文字**边说边出现在输入框里**，松开右 Ctrl 后显示最终识别结果。

[![npm version](https://img.shields.io/npm/v/dsh-voice-ptt.svg)](https://www.npmjs.com/package/dsh-voice-ptt)

[English](README.md)

- 🎤 **按住右 Ctrl 说话**：松开结束；输入框右侧的 🎤 按钮也可以点击开始/停止
- ✍️ **边说边写**：说话过程中每约 0.7 秒把当前这段重新识别一次并原地刷新草稿
- 🔒 **默认本地识别**：复用 DSH 官方「语音输入（Voice Input）」Bundle 已经下载好的本地 **SenseVoice** 模型——不额外下模型、不需要 API Key、音频不出本机
- 🧠 **组合键不误触发**：按下右 Ctrl 后 220ms 内又按了别的键（如 Ctrl+C、Ctrl+V）就当组合键处理，不会开始录音
- ☁️ **可选云端 ASR**：可接入任意 OpenAI 兼容的 `/audio/transcriptions` 接口（硅基流动、阿里、Groq、自建等），失败自动回退本地

## 为什么默认用右 Ctrl

Windows 上**右 Alt** 常被其他桌面助手（例如 Kimi 客户端）抢占做语音输入。本插件默认用**右 Ctrl**、完全不动右 Alt，两个工具可以共存；如果你喜欢别的键，热键是可配置的。

## 前置条件

- **DSH 0.2.x**（在 `0.2.2-rc.1` 桌面端实测；Web GUI 同理）
- 官方实验性**语音输入 Bundle** 已启用并已下载本地模型：DSH 里打开 **插件（Plugins）→ Voice Input → Download and prepare**。模型位于 `$DSH_HOME/speech-to-text/sensevoice`
- 本插件只是把 DSH 的 `ctx.speechToText` 服务桥接成「按住说话 + 实时草稿」，**自身不打包、不下载 ASR 模型**

如果语音输入 Bundle 未启用/被禁用，插件的宿主部分会停留在 pending，按热键会显示错误提示而不是录音。

## 安装

```bash
# npm（推荐）
dsh plugin --profile desktop add dsh-voice-ptt

# Web profile
dsh plugin --profile web add dsh-voice-ptt
```

其他方式：

```bash
# 直接从 GitHub
dsh plugin --profile desktop add github:zmq6931/dsh-voice-ptt

# 本地目录（开发/自用）
dsh plugin --profile desktop add link:/absolute/path/to/dsh-voice-ptt
```

DSH 的 **插件（Plugins）** 面板里填入同样的 spec 也可以。安装后重启 DSH 或刷新界面，出现 🎤 按钮并绑上热键即生效。

## 使用

| 操作 | 效果 |
| --- | --- |
| **按住右 Ctrl**（≥ 0.2 秒） | 开始听写，文字实时写进草稿 |
| 松开右 Ctrl | 用最终识别结果替换中间稿 |
| 右 Ctrl + 其他键（220ms 内） | 按组合键处理，不录音 |
| 输入框右侧 🎤 按钮 | 点击开始/停止 |
| 录音中切到其他窗口 | 自动结束本次听写 |

右下角会有状态气泡：`🎙 聆听中…`、`⏳ 识别中…`、`✓ 已写入` 或错误提示。

单次听写超过约 15 秒会自动分段提交，避免识别延迟越拖越长。

## 配置

配置文件：`$DSH_HOME/voice-ptt.json`（UTF-8 **无 BOM**）。浏览器端在插件挂载时读取，改完刷新/重启生效。

```json
{
  "language": "auto",
  "hotkey": "ControlRight"
}
```

| 键 | 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `language` | `auto` / `zh` / `yue` / `en` / `ja` / `ko` | `auto` | 识别语言提示；`yue` 为粤语优先 |
| `hotkey` | 内置键盘 code 之一 | `ControlRight` | 按住说话的热键 |
| `asr` | `local` / `cloud` | `local` | 识别后端 |
| `fallbackLocal` | `true` / `false` | `true` | 云端失败时是否回退本地 |

内置热键 code：`ControlRight`、`ControlLeft`、`AltRight`、`AltLeft`、`ShiftRight`、`MetaRight`。

还可以用 localStorage 覆盖（优先级更高、立即生效）：

```js
localStorage["dsh-voice-ptt:language"] = "yue";
localStorage["dsh-voice-ptt:hotkey"] = "AltRight";
```

### 云端 ASR（可选，音频会出网）

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

- `baseUrl` 填到 OpenAI 兼容接口的根（`…/v1`），插件会 `POST {baseUrl}/audio/transcriptions`（multipart：`file`、`model`、`language`）
- `fallbackLocal: true`：云端失败时自动改用本地 SenseVoice，不中断听写
- API Key 只存在 host 端，`/voice-ptt/config` 返回给浏览器时会脱敏（只暴露 `hasKey`）
- 云端模式下说话过程中每约 0.7 秒重发当前整段音频，长句会产生多次请求（有费用的话注意）

## 识别效果说明

这是**分段重新转写**模拟的「流式」：说话中草稿每约 0.7 秒刷新一次，松开后的终稿是对整段重新识别的结果（通常最准）。预期延迟约 0.5–1.5 秒，也会有本地小模型常见的同音字/专有名词错误。

改善方式：麦克风近一点/环境安静、一次说完整短句、明确设置 `language`（纯粤语用 `yue` 通常比 `auto` 稳）、或切云端 ASR。

## 隐私

- 本地模式：浏览器把音频转成 16kHz 单声道 WAV，只发给插件自己的本机回环接口，再交给本地 SenseVoice Provider 处理，音频不出本机
- 云端模式：只把这一段 WAV 上传到你配置的端点
- 插件路由做了 loopback/可信主机 + 同源请求的限制

## 已知限制

- 依赖官方语音输入 Bundle 的实验性 `ctx.speechToText` 服务，未来 DSH 升级可能变更该接口导致插件失效
- 热键只在 DSH 窗口内生效，不是系统级全局热键
- 右 Ctrl 本身是修饰键：按住超过 220ms 后再按快捷键会先开始录音（松开即停）
- 没有唤醒词、自动发送、音色选择等附加功能

## 开发 / 测试

```bash
node test/smoke.mjs                      # 离线单测：浏览器录音管线 + host 路由 + 云端模式
node test/e2e-live.mjs <mono-pcm16.wav>  # 真机链路：把 WAV 送进正在运行的插件转写接口
```

## 许可

MIT，见 [LICENSE](LICENSE)。

本项目与 DeepSeek 官方无关联。插件写法参考了 MIT 协议的 `dsh-voice-scribe`、`dsh-voice-mode` 等开源 DSH 插件；识别服务对接官方 `@deepseek-ai/dsh-experimental-speech-to-text`。
