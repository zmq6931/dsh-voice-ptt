// Offline smoke tests for dsh-voice-ptt (run: node test/smoke.mjs).
// Verifies: syntax of both halves, client bundle contract, host route logic
// (trust fence / status / prepare / transcribe / invalid payloads).

import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// ── client bundle contract ──────────────────────────────────────────────────
let spec = null;
const listeners = new Map();
const fakeWindow = {
  addEventListener(type, handler) {
    const list = listeners.get(type) || [];
    list.push(handler);
    listeners.set(type, list);
  },
  removeEventListener(type, handler) {
    const list = (listeners.get(type) || []).filter((entry) => entry !== handler);
    listeners.set(type, list);
  }
};
const fakeElement = () => ({
  style: {},
  isConnected: false,
  setAttribute() {},
  appendChild() {},
  remove() {},
  textContent: ""
});
const fakeDocument = {
  body: { appendChild() {} },
  getElementById() { return null; },
  createElement() { return fakeElement(); }
};

const sandbox = {
  window: {
    ...fakeWindow,
    __ModuleLoader__: { load(s) { spec = s; } }
  },
  document: fakeDocument,
  navigator: {},
  fetch: async () => { throw new Error("no network in tests"); },
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  AbortController,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Math,
  Date
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, "lib", "client.js"), "utf8"), sandbox, { filename: "client.js" });

assert.ok(spec, "client bundle calls window.__ModuleLoader__.load");
assert.equal(spec.id, "dsh-voice-ptt");

const reactStub = {
  useState(value) { return [value, () => {}]; },
  useEffect() {},
  createElement() { return { type: "button" }; }
};
const clientExports = spec.factory((id) => {
  if (id === "react") return reactStub;
  throw new Error("unexpected require: " + id);
});
assert.equal(typeof clientExports.apply, "function");
assert.equal(JSON.stringify(clientExports.inject), '["slots"]');

const registered = [];
const clientCtx = {
  effect(fn) { fn(); return () => {}; },
  slots: {
    inject(name, register) { assert.equal(name, "conversation.input.right"); register(); },
    register(options, component) { registered.push({ options, component }); return () => {}; }
  }
};
clientExports.apply(clientCtx);
assert.equal(registered.length, 1);
assert.equal(registered[0].options.id, "dsh-voice-ptt-mic");
assert.equal(typeof registered[0].component, "function");
assert.ok(listeners.get("keydown"), "client binds keydown");
assert.ok(listeners.get("keyup"), "client binds keyup");

// MicButton renders without a draft channel and returns an element.
const element = registered[0].component({
  inputActions: { setDraft: () => {} },
  useInput: (selector) => selector({ draft: "" })
});
assert.equal(element.type, "button");

// ── simulated recording pipeline (fake DOM + fake audio + fake host) ────────
const editor = {
  tagName: "TEXTAREA",
  value: "",
  dispatchEvent() {},
  focus() {}
};
const card = { querySelector: (selector) => (selector === "textarea" ? editor : null) };
sandbox.document.querySelector = (selector) => (String(selector).includes("composer-card") ? card : null);
sandbox.navigator.mediaDevices = {
  getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] })
};
sandbox.navigator.userAgent = "dsh-smoke-test";
// Language hint comes from localStorage ("yue" here) while the hotkey keeps
// its default (ControlRight).
sandbox.localStorage = {
  getItem(key) {
    return String(key).endsWith(":language") ? "yue" : null;
  }
};

let processor = null;
class FakeAudioContext {
  constructor() {
    this.sampleRate = 48000; // force the resampling path
    this.destination = {};
  }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() {
    processor = { connect() {}, disconnect() {}, onaudioprocess: null };
    return processor;
  }
  createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
}
sandbox.window.AudioContext = FakeAudioContext;

const hostCalls = [];
sandbox.fetch = async (url, options = {}) => {
  const path = String(url);
  const respond = (value) => ({ ok: true, status: 200, json: async () => value });
  if (path.endsWith("/status")) {
    return respond({
      ok: true,
      selection: { providerId: "sensevoice-local" },
      providers: [{ id: "sensevoice-local", preparation: { phase: "ready" } }]
    });
  }
  if (path.endsWith("/config")) return respond({ ok: true, config: {} });
  if (path.endsWith("/client-hello")) return respond({ ok: true });
  if (path.endsWith("/prepare")) return respond({ ok: true });
  if (path.endsWith("/transcribe")) {
    const payload = JSON.parse(options.body);
    hostCalls.push(payload);
    return respond({ ok: true, text: "你好世界" });
  }
  throw new Error("unexpected fetch: " + path);
};
let intervalFn = null;
sandbox.setInterval = (fn) => { intervalFn = fn; return 1; };
sandbox.clearInterval = () => { intervalFn = null; };

await clientExports.startRecording();
assert.ok(processor, "startRecording created the audio processor");
assert.ok(intervalFn, "startRecording started the polling loop");
assert.equal(editor.value, "");

const oneSecond = new Float32Array(48000); // 1 s at the fake 48 kHz context rate
oneSecond.fill(0.1);
processor.onaudioprocess({ inputBuffer: { getChannelData: () => oneSecond } });
await clientExports.tick();
assert.equal(hostCalls.length, 1, "tick posted one transcription");
const wav = Buffer.from(hostCalls[0].audioBase64, "base64");
assert.equal(hostCalls[0].language, "yue", "language hint is forwarded to the host");
assert.equal(wav.toString("ascii", 0, 4), "RIFF");
assert.equal(wav.readUInt16LE(22), 1, "mono");
assert.equal(wav.readUInt32LE(24), 16000, "resampled to 16 kHz");
assert.equal(wav.readUInt16LE(34), 16, "PCM16");
assert.equal(editor.value, "你好世界", "interim hypothesis written to the draft");

await clientExports.endRecording();
assert.equal(hostCalls.length, 2, "release triggers the final transcription");
assert.equal(editor.value, "你好世界", "final transcript kept");

// second recording appends to the existing draft
await clientExports.startRecording();
processor.onaudioprocess({ inputBuffer: { getChannelData: () => oneSecond } });
await clientExports.tick();
await clientExports.endRecording();
assert.ok(editor.value.startsWith("你好世界"), "existing draft is preserved as a prefix");

// ── right Ctrl push-to-talk semantics ──────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keyEvent = (code) => ({ code, repeat: false, preventDefault() {} });
const handlers = (type) => listeners.get(type) || [];

const beforeHold = hostCalls.length;
handlers("keydown").forEach((fn) => fn(keyEvent("ControlRight")));
await sleep(320);
assert.ok(intervalFn !== null, "holding right Ctrl starts dictation");
assert.ok(processor, "holding right Ctrl creates the audio processor");
processor.onaudioprocess({ inputBuffer: { getChannelData: () => oneSecond } });
handlers("keyup").forEach((fn) => fn(keyEvent("ControlRight")));
await sleep(150);
assert.equal(hostCalls.length, beforeHold + 1, "releasing right Ctrl transcribes once");

// right Ctrl + C inside the hold window must stay a modifier combo
intervalFn = null;
processor = null;
handlers("keydown").forEach((fn) => fn(keyEvent("ControlRight")));
handlers("keydown").forEach((fn) => fn(keyEvent("KeyC")));
await sleep(320);
assert.equal(intervalFn, null, "right Ctrl + C does not start dictation");
assert.equal(processor, null, "no microphone capture was created for the combo");

// ── host half ──────────────────────────────────────────────────────────────
const host = await import(pathToFileURL(join(root, "lib", "index.js")).href);
assert.equal(host.name, "dsh-voice-ptt");
assert.deepEqual(host.inject, ["webServer", "webStartup", "speechToText"]);

let routeHandler = null;
const speechCalls = [];
const hostCtx = {
  effect(fn) { fn(); return () => {}; },
  webServer: {
    register(options) {
      assert.equal(options.kind, "prefix");
      assert.equal(options.path, "/voice-ptt");
      routeHandler = options.handler;
      return () => {};
    }
  },
  webStartup: { trustedHosts: [] },
  speechToText: {
    snapshot() {
      return {
        selection: { providerId: "sensevoice-local", language: "auto" },
        providers: [{ id: "sensevoice-local", name: "SenseVoice", languages: ["auto"], preparation: { phase: "ready" } }]
      };
    },
    resolve(request) {
      return { provider: { info: { id: "sensevoice-local" } }, audio: request.audio, language: "auto" };
    },
    async transcribe(spec) {
      speechCalls.push(spec);
      return { text: "你好世界", audioSeconds: 0.01, inferenceSeconds: 0.005 };
    },
    prepare(id) {
      speechCalls.push({ prepared: id });
    }
  }
};
host.apply(hostCtx);
assert.equal(typeof routeHandler, "function");

function makeReq({ method = "POST", url = "/voice-ptt/transcribe", host = "127.0.0.1:61726", headers = {}, body = "" } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host, origin: "http://" + host, "sec-fetch-site": "same-origin", ...headers };
  req.resume = () => {};
  process.nextTick(() => {
    if (body !== "") req.emit("data", Buffer.from(body, "utf8"));
    req.emit("end");
  });
  return req;
}

function makeRes() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headersSent = false;
  res.headers = {};
  res.body = "";
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.end = (chunk) => {
    if (chunk !== undefined) res.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    res.headersSent = true;
  };
  return res;
}

async function call(req) {
  const res = makeRes();
  await routeHandler(req, res);
  return { status: res.statusCode, headers: res.headers, json: res.body ? JSON.parse(res.body) : null };
}

// 1. status
let result = await call(makeReq({ method: "GET", url: "/voice-ptt/status" }));
assert.equal(result.status, 200);
assert.equal(result.json.ok, true);
assert.equal(result.json.selection.providerId, "sensevoice-local");
assert.equal(result.json.providers[0].preparation.phase, "ready");

// 2. cross-site / foreign host is fenced
result = await call(makeReq({ host: "evil.example:80", headers: { origin: "http://evil.example:80" } }));
assert.equal(result.status, 403);
result = await call(makeReq({ headers: { "sec-fetch-site": "cross-site" } }));
assert.equal(result.status, 403);

// 2b. host-side config is exposed for the browser half
result = await call(makeReq({ method: "GET", url: "/voice-ptt/config" }));
assert.equal(result.status, 200);
assert.equal(result.json.ok, true);
assert.equal(typeof result.json.config, "object");

// 3. transcribe happy path
const hostWav = Buffer.alloc(44 + 320); // 10 ms of silence, header only matters here
hostWav.write("RIFF", 0, "ascii");
hostWav.write("WAVE", 8, "ascii");
result = await call(makeReq({ body: JSON.stringify({ audioBase64: hostWav.toString("base64") }) }));
assert.equal(result.status, 200);
assert.equal(result.json.ok, true);
assert.equal(result.json.text, "你好世界");
assert.equal(speechCalls.length, 1);
assert.equal(speechCalls[0].audio.length, hostWav.length);

// 4. invalid / empty / oversized payloads
result = await call(makeReq({ body: JSON.stringify({}) }));
assert.equal(result.status, 400);
result = await call(makeReq({ body: "not json" }));
assert.equal(result.status, 400);
result = await call(makeReq({ body: JSON.stringify({ audioBase64: "AAAA" }) }));
assert.equal(result.status, 400); // too short to be a WAV

// 5. prepare route
result = await call(makeReq({ url: "/voice-ptt/prepare", body: JSON.stringify({}) }));
assert.equal(result.status, 200);
assert.equal(speechCalls.at(-1).prepared, "sensevoice-local");

// 6. unknown route
result = await call(makeReq({ url: "/voice-ptt/nope" }));
assert.equal(result.status, 404);

// 7. method mismatch on status
result = await call(makeReq({ method: "POST", url: "/voice-ptt/status" }));
assert.equal(result.status, 404);

// 8. optional cloud ASR mode (config file + OpenAI-compatible endpoint)
const tempHome = mkdtempSync(join(tmpdir(), "rav-home-"));
writeFileSync(join(tempHome, "voice-ptt.json"), JSON.stringify({
  asr: "cloud",
  cloud: { baseUrl: "https://api.example.com/v1/", apiKey: "sk-secret", model: "whisper-large-v3" },
  language: "yue"
}));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = tempHome;

result = await call(makeReq({ method: "GET", url: "/voice-ptt/config" }));
assert.equal(result.status, 200);
assert.equal(result.json.config.cloud.hasKey, true);
assert.equal(result.json.config.cloud.apiKey, undefined, "API key must never reach the browser");
assert.equal(result.json.config.language, "yue");

const cloudCalls = [];
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  cloudCalls.push({ url: String(url), options });
  return { ok: true, status: 200, text: async () => JSON.stringify({ text: "云端识别结果" }) };
};
result = await call(makeReq({ body: JSON.stringify({ audioBase64: hostWav.toString("base64"), language: "yue" }) }));
assert.equal(result.status, 200);
assert.equal(result.json.text, "云端识别结果");
assert.equal(result.json.via, "cloud");
assert.ok(cloudCalls[0].url.endsWith("/audio/transcriptions"), "cloud endpoint is the OpenAI-compatible one");
assert.equal(cloudCalls[0].options.headers.authorization, "Bearer sk-secret");

// cloud failure falls back to the local provider by default
globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => "upstream down" });
result = await call(makeReq({ body: JSON.stringify({ audioBase64: hostWav.toString("base64") }) }));
assert.equal(result.status, 200);
assert.equal(result.json.via, "local");
assert.equal(result.json.text, "你好世界");

globalThis.fetch = previousFetch;
process.env.DSH_HOME = previousHome;
rmSync(tempHome, { recursive: true, force: true });

console.log("smoke: OK — client bundle contract, host routes, trust fence, payload validation, cloud ASR mode.");
