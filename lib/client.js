// SPDX-License-Identifier: MIT
// dsh-voice-ptt — browser half.
//
// Loaded by dsh-client-modules at /plugins/dsh-voice-ptt/client.js and
// executed through the vendored cordis Loader's lazy-CJS module table
// (window.__ModuleLoader__.load).
//
// Interaction: hold RIGHT CTRL, speak, and the transcript is written into the
// composer draft while you talk (the current segment is re-transcribed every
// ~0.7 s and refreshed in place). Release Right Ctrl and the final transcript
// replaces the interim text. The composer microphone button can also toggle
// recording by click.
//
// Audio never leaves the machine when the selected speech provider is the
// local SenseVoice provider: the browser posts 16 kHz PCM16 WAV to this
// plugin's own host route, which forwards it to ctx.speechToText.

window.__ModuleLoader__.load({
	id: "dsh-voice-ptt",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");

		//#region constants
		/** Host route prefix (must match lib/index.js). */
		const API_PREFIX = "/voice-ptt";
		/** Canonical speech rate expected by the local provider. */
		const TARGET_RATE = 16000;
		/** How often the in-progress segment is re-transcribed while talking. */
		const POLL_MS = 700;
		/** Do not send tiny slices: wait for this much audio. */
		const MIN_AUDIO_MS = 250;
		/** Commit the current segment once it grows past this (keeps latency flat). */
		const MAX_SEGMENT_MS = 15_000;
		/** One host transcription call (cold worker startup included). */
		const TRANSCRIBE_TIMEOUT_MS = 60_000;
		/** Status pill id. */
		const PILL_ID = "dsh-voice-ptt-pill";
		/**
		 * Recognition language hint. "auto" lets SenseVoice detect the language;
		 * set "yue" for dedicated Cantonese (粤语) recognition. Override per
		 * origin: localStorage["dsh-voice-ptt:language"] = "yue".
		 */
		const LANGUAGE_STORAGE_KEY = "dsh-voice-ptt:language";
		const LANGUAGES = ["auto", "zh", "yue", "en", "ja", "ko"];
		/** Host-side config ($DSH_HOME/voice-ptt.json), read at mount. */
		let hostConfig = {};
		//#endregion

		//#region draft channel
		// Filled by the composer slot bridge below: the DSH composer slot hands
		// session-scope components `useInput` (draft snapshot) and `inputActions`
		// (setDraft). When the slot has not rendered (or the shell has no such
		// slot) we fall back to DOM read/write on the Lexical contenteditable.
		const draftChannel = {
			getDraft: null,
			setDraft: null
		};

		function findComposerEditor() {
			if (typeof document === "undefined") return null;
			try {
				const card = document.querySelector('[data-composer-card="true"]') || document.querySelector("[data-composer-card]");
				if (card) {
					const textarea = card.querySelector("textarea");
					if (textarea) return textarea;
					const editable = card.querySelector('[contenteditable="true"]');
					if (editable) return editable;
				}
			} catch {
				/* fall through */
			}
			return null;
		}

		function readEditorText(editor) {
			if (!editor) return "";
			if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") return editor.value || "";
			const text = typeof editor.innerText === "string" && editor.innerText !== "" ? editor.innerText : (editor.textContent || "");
			return text.replace(/\n+$/, "");
		}

		function writeEditorText(editor, text) {
			if (!editor) return false;
			if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") {
				editor.value = text;
				editor.dispatchEvent(new Event("input", { bubbles: true }));
				return true;
			}
			try {
				editor.focus();
				const selection = window.getSelection();
				if (selection) {
					const range = document.createRange();
					range.selectNodeContents(editor);
					selection.removeAllRanges();
					selection.addRange(range);
				}
				if (typeof document.execCommand === "function") {
					const done = text === "" ? document.execCommand("delete", false) : document.execCommand("insertText", false, text);
					if (done) return true;
				}
			} catch {
				/* fall through */
			}
			try {
				editor.textContent = text;
				editor.dispatchEvent(new Event("input", { bubbles: true }));
				return true;
			} catch {
				return false;
			}
		}

		function readDraft() {
			try {
				if (typeof draftChannel.getDraft === "function") {
					const value = draftChannel.getDraft();
					if (typeof value === "string") return value;
				}
			} catch {
				/* fall through to DOM */
			}
			return readEditorText(findComposerEditor());
		}

		function writeDraft(text) {
			try {
				if (typeof draftChannel.setDraft === "function") {
					const result = draftChannel.setDraft(text);
					if (result !== false) return true;
				}
			} catch {
				/* fall through to DOM */
			}
			return writeEditorText(findComposerEditor(), text);
		}
		//#endregion

		//#region status pill
		let pill = null;
		let pillHideTimer = null;
		let pillText = "";

		function ensurePill() {
			if (pill && pill.isConnected) return pill;
			if (typeof document === "undefined" || !document.body) return null;
			const existing = document.getElementById(PILL_ID);
			if (existing) {
				pill = existing;
				return pill;
			}
			pill = document.createElement("div");
			pill.id = PILL_ID;
			pill.setAttribute("role", "status");
			pill.setAttribute("aria-live", "polite");
			pill.style.cssText = [
				"position:fixed",
				"right:24px",
				"bottom:104px",
				"z-index:2147483000",
				"max-width:320px",
				"padding:6px 12px",
				"border-radius:999px",
				"font:12px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif",
				"color:#e9eef7",
				"background:rgba(24,28,38,.92)",
				"border:1px solid rgba(255,255,255,.12)",
				"box-shadow:0 6px 20px rgba(0,0,0,.28)",
				"backdrop-filter:blur(6px)",
				"pointer-events:none",
				"display:none",
				"white-space:nowrap",
				"overflow:hidden",
				"text-overflow:ellipsis"
			].join(";");
			document.body.appendChild(pill);
			return pill;
		}

		function setStatus(text, options) {
			pillText = text;
			const node = ensurePill();
			if (!node) return;
			node.textContent = text;
			node.style.display = "block";
			if (pillHideTimer) {
				clearTimeout(pillHideTimer);
				pillHideTimer = null;
			}
			const hideAfter = options && options.hideAfter;
			if (typeof hideAfter === "number" && hideAfter > 0) {
				pillHideTimer = setTimeout(() => {
					pillHideTimer = null;
					if (node.isConnected) node.style.display = "none";
				}, hideAfter);
			}
		}

		function hideStatus(delayMs) {
			const node = ensurePill();
			if (!node) return;
			if (pillHideTimer) clearTimeout(pillHideTimer);
			pillHideTimer = setTimeout(() => {
				pillHideTimer = null;
				if (node.isConnected) node.style.display = "none";
			}, typeof delayMs === "number" ? delayMs : 0);
		}

		function currentStatus() {
			return pillText;
		}

		// Record-state subscribers (the composer microphone button uses one).
		const stateListeners = new Set();

		function notifyState() {
			const recording = state.recording;
			for (const listener of [...stateListeners]) {
				try {
					listener(recording);
				} catch {
					/* a broken subscriber must not break recording */
				}
			}
		}

		function subscribeRecordState(listener) {
			stateListeners.add(listener);
			try {
				listener(state.recording);
			} catch {
				/* ignore */
			}
			return () => stateListeners.delete(listener);
		}
		//#endregion

		//#region recorder state
		const state = {
			recording: false,
			starting: false,
			busy: false,
			/** Draft text that existed before recording started. */
			prefix: "",
			/** Text committed by earlier segments (long dictation only). */
			committed: "",
			/** Latest interim hypothesis for the current segment. */
			interim: "",
			/** Last full draft we wrote (avoid redundant setDraft calls). */
			lastApplied: null,
			/** Float32 mono chunks at `rate`. */
			chunks: [],
			samples: 0,
			rate: TARGET_RATE,
			/** Generation counter: invalidates async results after stop/restart. */
			generation: 0,
			/** Media handles. */
			stream: null,
			audioContext: null,
			source: null,
			processor: null,
			sink: null,
			pollTimer: null
		};
		//#endregion

		//#region audio helpers
		function resetAudio() {
			state.chunks = [];
			state.samples = 0;
			state.interim = "";
			state.busy = false;
		}

		/** Drop the current segment audio but keep the live capture rate. */
		function resetSegmentAudio() {
			state.chunks = [];
			state.samples = 0;
			state.interim = "";
			state.busy = false;
		}

		/** Concatenate buffered chunks into one Float32Array at the native rate. */
		function collectedSamples() {
			const total = state.samples;
			const merged = new Float32Array(total);
			let offset = 0;
			for (const chunk of state.chunks) {
				merged.set(chunk, offset);
				offset += chunk.length;
			}
			return merged;
		}

		/** Linear-interpolation resample to 16 kHz (no-op if already there). */
		function resampleTo16k(input, inputRate) {
			if (inputRate === TARGET_RATE || inputRate <= 0) return input;
			const outputLength = Math.max(1, Math.round(input.length * TARGET_RATE / inputRate));
			const output = new Float32Array(outputLength);
			const ratio = inputRate / TARGET_RATE;
			for (let i = 0; i < outputLength; i += 1) {
				const position = i * ratio;
				const index = Math.floor(position);
				const fraction = position - index;
				const a = input[index] || 0;
				const b = index + 1 < input.length ? input[index + 1] : a;
				output[i] = a + (b - a) * fraction;
			}
			return output;
		}

		/** Encode Float32 mono samples as a canonical 16 kHz PCM16 WAV. */
		function encodeWav(samples) {
			const length = samples.length;
			const buffer = new ArrayBuffer(44 + length * 2);
			const view = new DataView(buffer);
			const writeString = (offset, text) => {
				for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
			};
			writeString(0, "RIFF");
			view.setUint32(4, 36 + length * 2, true);
			writeString(8, "WAVE");
			writeString(12, "fmt ");
			view.setUint32(16, 16, true); // fmt chunk size
			view.setUint16(20, 1, true); // PCM
			view.setUint16(22, 1, true); // mono
			view.setUint32(24, TARGET_RATE, true);
			view.setUint32(28, TARGET_RATE * 2, true); // byte rate
			view.setUint16(32, 2, true); // block align
			view.setUint16(34, 16, true); // bits per sample
			writeString(36, "data");
			view.setUint32(40, length * 2, true);
			let offset = 44;
			for (let i = 0; i < length; i += 1) {
				const sample = Math.max(-1, Math.min(1, samples[i]));
				view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
				offset += 2;
			}
			return new Uint8Array(buffer);
		}

		function bytesToBase64(bytes) {
			let binary = "";
			const chunk = 0x8000;
			for (let i = 0; i < bytes.length; i += chunk) {
				binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
			}
			return btoa(binary);
		}

		/** Current segment audio as a 16 kHz PCM16 WAV. */
		function segmentWav() {
			const raw = collectedSamples();
			if (raw.length === 0) return null;
			return encodeWav(resampleTo16k(raw, state.rate));
		}
		//#endregion

		//#region host calls
		async function postJson(path, payload, timeoutMs) {
			const controller = typeof AbortController === "function" ? new AbortController() : null;
			const timer = controller ? setTimeout(() => controller.abort(new Error("timeout")), timeoutMs) : null;
			try {
				const response = await fetch(API_PREFIX + path, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
					credentials: "same-origin",
					signal: controller ? controller.signal : undefined
				});
				let json = null;
				try {
					json = await response.json();
				} catch {
					json = null;
				}
				if (!response.ok || !json || json.ok !== true) {
					const message = json && json.error && json.error.message ? json.error.message : ("HTTP " + response.status);
					throw new Error(message);
				}
				return json;
			} finally {
				if (timer) clearTimeout(timer);
			}
		}

		async function getStatus() {
			const response = await fetch(API_PREFIX + "/status", { credentials: "same-origin" });
			let json = null;
			try {
				json = await response.json();
			} catch {
				json = null;
			}
			if (!response.ok || !json || json.ok !== true) throw new Error("speech status unavailable");
			return json;
		}

		async function transcribeWav(wav) {
			const payload = { audioBase64: bytesToBase64(wav) };
			const language = activeLanguage();
			if (language !== "auto") payload.language = language;
			const result = await postJson("/transcribe", payload, TRANSCRIBE_TIMEOUT_MS);
			return typeof result.text === "string" ? result.text : "";
		}

		/** Make sure the local provider is prepared; called once per recording. */
		async function ensureReady() {
			const status = await getStatus();
			const providers = Array.isArray(status.providers) ? status.providers : [];
			const selectedId = status.selection && status.selection.providerId;
			const selected = providers.find((provider) => provider.id === selectedId) || providers[0];
			if (!selected) throw new Error("没有可用的语音识别服务");
			const phase = selected.preparation && selected.preparation.phase;
			if (phase !== "ready" && phase !== "standby") {
				setStatus("⏳ 正在准备本地语音模型…");
				await postJson("/prepare", { providerId: selected.id }, 15_000).catch(() => {});
			}
			return selected;
		}
		//#endregion

		//#region draft write
		function composeDraft(extraInterim) {
			const interim = typeof extraInterim === "string" ? extraInterim : state.interim;
			return state.prefix + state.committed + interim;
		}

		function applyInterim(text) {
			state.interim = text;
			const next = composeDraft();
			if (next === state.lastApplied) return;
			if (writeDraft(next)) state.lastApplied = next;
		}

		/** Commit the current segment (long dictation): freeze text, clear audio. */
		function commitSegment() {
			if (state.interim.length === 0) return false;
			state.committed += state.interim;
			state.interim = "";
			resetSegmentAudio();
			state.lastApplied = null;
			applyInterim("");
			return true;
		}

		function audioMs() {
			return state.rate > 0 ? (state.samples / state.rate) * 1000 : 0;
		}
		//#endregion

		//#region recording lifecycle
		function stopCapture() {
			if (state.pollTimer) {
				clearInterval(state.pollTimer);
				state.pollTimer = null;
			}
			if (state.processor) {
				try {
					state.processor.onaudioprocess = null;
					state.processor.disconnect();
				} catch {
					/* already disconnected */
				}
				state.processor = null;
			}
			if (state.source) {
				try {
					state.source.disconnect();
				} catch {
					/* ignore */
				}
				state.source = null;
			}
			if (state.sink) {
				try {
					state.sink.disconnect();
				} catch {
					/* ignore */
				}
				state.sink = null;
			}
			if (state.stream) {
				try {
					state.stream.getTracks().forEach((track) => track.stop());
				} catch {
					/* ignore */
				}
				state.stream = null;
			}
			if (state.audioContext) {
				const audioContext = state.audioContext;
				state.audioContext = null;
				Promise.resolve(audioContext.close()).catch(() => {});
			}
		}

		function captureAudio() {
			const stream = state.stream;
			const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
			let audioContext;
			try {
				audioContext = new AudioContextCtor({ sampleRate: TARGET_RATE });
			} catch {
				audioContext = new AudioContextCtor();
			}
			state.audioContext = audioContext;
			if (typeof audioContext.resume === "function") {
				Promise.resolve(audioContext.resume()).catch(() => {});
			}
			const source = audioContext.createMediaStreamSource(stream);
			const processor = audioContext.createScriptProcessor ? audioContext.createScriptProcessor(4096, 1, 1) : null;
			if (!processor) throw new Error("浏览器不支持音频采集");
			state.rate = audioContext.sampleRate || TARGET_RATE;
			processor.onaudioprocess = (event) => {
				if (!state.recording) return;
				const channel = event.inputBuffer.getChannelData(0);
				if (channel && channel.length > 0) {
					state.chunks.push(new Float32Array(channel));
					state.samples += channel.length;
				}
			};
			const sink = audioContext.createGain();
			sink.gain.value = 0;
			source.connect(processor);
			processor.connect(sink);
			sink.connect(audioContext.destination);
			state.source = source;
			state.processor = processor;
			state.sink = sink;
		}

		async function startRecording() {
			if (state.recording || state.starting) return;
			state.starting = true;
			state.generation += 1;
			const generation = state.generation;
			try {
				state.prefix = readDraft();
				state.committed = "";
				state.lastApplied = null;
				resetAudio();
				setStatus("🎙 聆听中…（松开" + hotkeyLabel() + "结束）");
				const media = navigator.mediaDevices;
				if (!media || typeof media.getUserMedia !== "function") throw new Error("浏览器不支持麦克风采集");
				const stream = await media.getUserMedia({
					audio: {
						channelCount: 1,
						echoCancellation: true,
						noiseSuppression: true,
						autoGainControl: true
					}
				});
				if (generation !== state.generation) {
					stream.getTracks().forEach((track) => track.stop());
					return;
				}
				state.stream = stream;
				captureAudio();
				state.recording = true;
				notifyState();
				state.pollTimer = setInterval(tick, POLL_MS);
				ensureReady().catch(() => {
					/* the first transcribe call surfaces the real error */
				});
			} catch (error) {
				stopCapture();
				setStatus("⚠ " + describeError(error), { hideAfter: 4000 });
				state.recording = false;
				notifyState();
			} finally {
				state.starting = false;
			}
		}

		async function endRecording() {
			if (!state.recording && !state.starting) return;
			const generation = state.generation;
			state.recording = false;
			notifyState();
			stopCapture();
			const hadAudio = state.samples > 0;
			if (!hadAudio) {
				state.interim = "";
				applyInterim("");
				hideStatus(600);
				return;
			}
			setStatus("⏳ 识别中…");
			try {
				const wav = segmentWav();
				if (!wav) throw new Error("没有采集到音频");
				const text = await transcribeWav(wav);
				if (generation !== state.generation) return;
				state.interim = text;
				const next = composeDraft();
				if (next !== state.lastApplied) {
					writeDraft(next);
					state.lastApplied = next;
				}
				if (text.trim().length === 0) setStatus("未识别到语音", { hideAfter: 1800 });
				else setStatus("✓ 已写入", { hideAfter: 1200 });
			} catch (error) {
				setStatus("⚠ " + describeError(error), { hideAfter: 4000 });
			}
		}

		/** One polling step: re-transcribe the current segment while talking. */
		async function tick() {
			if (!state.recording || state.busy) return;
			if (audioMs() < MIN_AUDIO_MS) return;
			// Long dictation: freeze the finished segment so inference stays short.
			if (audioMs() > MAX_SEGMENT_MS && state.interim.length > 0) {
				commitSegment();
			}
			const generation = state.generation;
			const wav = segmentWav();
			if (!wav) return;
			state.busy = true;
			try {
				const text = await transcribeWav(wav);
				if (generation !== state.generation || !state.recording) return;
				if (text.length === 0) return;
				applyInterim(text);
				setStatus("🎙 聆听中… " + text.slice(-24));
			} catch {
				/* transient failure: keep the last hypothesis, retry next tick */
			} finally {
				state.busy = false;
			}
		}

		function describeError(error) {
			const message = error && error.message ? String(error.message) : "未知错误";
			if (/Permission|NotAllowed/i.test(message)) return "没有麦克风权限";
			if (/NotFound|Devices/i.test(message)) return "没有找到麦克风";
			return message.length > 60 ? message.slice(0, 57) + "…" : message;
		}
		//#endregion

		//#region hotkey
		// Right Ctrl is the default push-to-talk key (right Alt is taken by the
		// Kimi desktop client). An override can be stored per-origin, e.g.
		//   localStorage["dsh-voice-ptt:hotkey"] = "AltRight"
		const HOTKEY_STORAGE_KEY = "dsh-voice-ptt:hotkey";
		const DEFAULT_HOTKEY_CODE = "ControlRight";
		const HOTKEY_LABELS = {
			ControlRight: "右 Ctrl",
			ControlLeft: "左 Ctrl",
			AltRight: "右 Alt",
			AltLeft: "左 Alt",
			ShiftRight: "右 Shift",
			MetaRight: "右 Win"
		};
		/** Ignore a press shorter than this (a Ctrl+C combo must not dictate). */
		const HOLD_START_DELAY_MS = 220;

		let hotkeyBound = false;
		let pendingStart = null;

		function activeHotkeyCode() {
			try {
				const stored = typeof localStorage !== "undefined" ? localStorage.getItem(HOTKEY_STORAGE_KEY) : null;
				if (typeof stored === "string" && Object.prototype.hasOwnProperty.call(HOTKEY_LABELS, stored)) return stored;
			} catch {
				/* storage unavailable */
			}
			if (typeof hostConfig.hotkey === "string" && Object.prototype.hasOwnProperty.call(HOTKEY_LABELS, hostConfig.hotkey)) {
				return hostConfig.hotkey;
			}
			return DEFAULT_HOTKEY_CODE;
		}

		function hotkeyLabel() {
			const code = activeHotkeyCode();
			return HOTKEY_LABELS[code] || code;
		}

		function activeLanguage() {
			try {
				const stored = typeof localStorage !== "undefined" ? localStorage.getItem(LANGUAGE_STORAGE_KEY) : null;
				if (typeof stored === "string" && LANGUAGES.indexOf(stored) >= 0) return stored;
			} catch {
				/* storage unavailable */
			}
			if (typeof hostConfig.language === "string" && LANGUAGES.indexOf(hostConfig.language) >= 0) return hostConfig.language;
			return "auto";
		}

		/** Read the host-side config once per mount; failures keep defaults. */
		function fetchHostConfig() {
			try {
				fetch(API_PREFIX + "/config", { credentials: "same-origin" })
					.then((response) => (response.ok ? response.json() : null))
					.then((json) => {
						if (json && json.ok === true && json.config && typeof json.config === "object") {
							hostConfig = json.config;
						}
					})
					.catch(() => {});
			} catch {
				/* defaults are fine */
			}
		}

		function cancelPendingStart() {
			if (pendingStart !== null) {
				clearTimeout(pendingStart);
				pendingStart = null;
			}
		}

		function onKeyDown(event) {
			if (!event) return;
			// Any other key means the trigger is being used as a modifier
			// (Ctrl+C, Alt+Tab, ...): do not treat this gesture as dictation.
			if (event.code !== activeHotkeyCode()) {
				cancelPendingStart();
				return;
			}
			if (event.repeat) return;
			if (event.preventDefault) event.preventDefault();
			cancelPendingStart();
			// Delay the start so a quick modifier press stays a modifier press.
			pendingStart = setTimeout(() => {
				pendingStart = null;
				startRecording().catch(() => {});
			}, HOLD_START_DELAY_MS);
		}

		function onKeyUp(event) {
			if (!event || event.code !== activeHotkeyCode()) return;
			if (event.preventDefault) event.preventDefault();
			// Released before the hold delay: it was a tap, not dictation.
			if (pendingStart !== null) {
				cancelPendingStart();
				return;
			}
			endRecording().catch(() => {});
		}

		function onWindowBlur() {
			cancelPendingStart();
			if (state.recording) endRecording().catch(() => {});
		}

		function bindHotkey() {
			if (hotkeyBound || typeof window === "undefined") return;
			hotkeyBound = true;
			window.addEventListener("keydown", onKeyDown, true);
			window.addEventListener("keyup", onKeyUp, true);
			window.addEventListener("blur", onWindowBlur);
		}

		function unbindHotkey() {
			if (!hotkeyBound || typeof window === "undefined") return;
			hotkeyBound = false;
			cancelPendingStart();
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("keyup", onKeyUp, true);
			window.removeEventListener("blur", onWindowBlur);
			if (state.recording || state.starting) endRecording().catch(() => {});
			stopCapture();
			if (stateListeners.size === 0 && pill && pill.isConnected) {
				pill.remove();
				pill = null;
			}
		}
		//#endregion

		//#region composer bridge + mic button
		function MicButton(props) {
			const { inputActions } = props || {};
			const useDraft = props && typeof props.useInput === "function"
				? props.useInput
				: () => undefined;
			let draft = useDraft((session) => (session && typeof session.draft === "string" ? session.draft : ""));
			const [recording, setRecording] = react.useState(false);

			react.useEffect(() => {
				draftChannel.getDraft = () => (typeof draft === "string" ? draft : "");
			}, [draft]);

			react.useEffect(() => {
				if (!inputActions || typeof inputActions.setDraft !== "function") return undefined;
				draftChannel.setDraft = (text) => {
					try {
						inputActions.setDraft(text);
						return true;
					} catch {
						return false;
					}
				};
				return () => {
					draftChannel.setDraft = null;
				};
			}, [inputActions]);

			react.useEffect(() => subscribeRecordState(setRecording), []);

			const style = {
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				width: "28px",
				height: "28px",
				padding: "0",
				border: "0",
				borderRadius: "8px",
				background: recording ? "rgba(239,68,68,.18)" : "transparent",
				color: "inherit",
				cursor: "pointer",
				fontSize: "15px",
				lineHeight: "1",
				opacity: recording ? 1 : 0.72
			};

			return react.createElement("button", {
				type: "button",
				title: recording ? ("停止听写（或松开" + hotkeyLabel() + "）") : ("按住" + hotkeyLabel() + "说话；也可点击开始"),
				"aria-label": "语音输入（" + hotkeyLabel() + "）",
				"aria-pressed": recording,
				style,
				onClick: () => {
					if (state.recording) endRecording().catch(() => {});
					else startRecording().catch(() => {});
				}
			}, recording ? "🔴" : "🎤");
		}

		/** Presence beacon: lets the host (and us) confirm this bundle executed. */
		function reportPresence() {
			try {
				fetch(API_PREFIX + "/client-hello", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						version: "0.3.0",
						hotkey: activeHotkeyCode(),
						language: activeLanguage(),
						platform: typeof navigator !== "undefined" && navigator.userAgent ? String(navigator.userAgent).slice(0, 120) : "unknown",
						rightAltCapable: true
					}),
					credentials: "same-origin"
				}).catch(() => {});
			} catch {
				/* diagnostics only */
			}
		}

		/** Required services: slots for the composer bridge + hotkey lifecycle. */
		const inject = ["slots"];

		function apply(ctx) {
			ctx.effect(() => {
				bindHotkey();
				fetchHostConfig();
				reportPresence();
				return () => unbindHotkey();
			}, "dsh-voice-ptt: hotkey");

			try {
				ctx.effect(() => {
					ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
						name: "conversation.input.right",
						id: "dsh-voice-ptt-mic",
						order: 45,
						inject: () => ({})
					}, MicButton));
					return () => {};
				}, "dsh-voice-ptt: mic button");
			} catch (error) {
				console.warn("[dsh-voice-ptt] mic button registration skipped:", error && error.message ? error.message : error);
			}
		}
		//#endregion

		module.exports = {
			apply,
			inject,
			name: "dsh-voice-ptt",
			// exported for offline tests / shell-console debugging
			startRecording,
			endRecording,
			tick,
			getStatus,
			currentStatus
		};
		return module.exports;
	}
});
