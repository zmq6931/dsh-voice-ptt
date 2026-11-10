// SPDX-License-Identifier: MIT
// dsh-voice-ptt — host half.
//
// A thin HTTP bridge from the browser half onto the existing
// `ctx.speechToText` service (provided by @deepseek-ai/dsh-experimental-speech-to-text,
// already mounted by the official voice-input bundle). No new model, no new
// download, no API key: audio goes to the same local SenseVoice provider the
// official microphone button uses.
//
// Routes (fenced to loopback / trusted hosts, same-origin only):
//   GET  /voice-ptt/status     -> provider readiness + current selection
//   POST /voice-ptt/prepare    { providerId? } -> start model preparation
//   POST /voice-ptt/transcribe { audioBase64, language? } -> { ok, text }
//
// Audio is 16 kHz mono PCM16 WAV, base64 encoded (canonical encoding).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "dsh-voice-ptt";

// webServer: register our routes; webStartup: trusted host list;
// speechToText: the local ASR registry used by the official voice input.
export const inject = ["webServer", "webStartup", "speechToText"];

/** Route prefix owned by this plugin. */
const API_PREFIX = "/voice-ptt";
/** Max accepted request body (base64 WAV; 15 s of 16 kHz PCM16 is ~640 KB). */
const MAX_BODY_BYTES = 24 * 1024 * 1024;
/** One transcription call may need to cold-start the local worker. */
const TRANSCRIBE_TIMEOUT_MS = 180_000;

/**
 * Optional user config, e.g. {"language": "yue"} to prefer Cantonese.
 * Lives in $DSH_HOME/voice-ptt.json; the browser half reads it at mount.
 */
function configPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "voice-ptt.json");
}

function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Browser-facing view of the config: never expose the cloud API key. */
function sanitizeConfig(config) {
  const out = { ...config };
  if (out.cloud && typeof out.cloud === "object" && !Array.isArray(out.cloud)) {
    const { apiKey, ...rest } = out.cloud;
    out.cloud = { ...rest, hasKey: typeof apiKey === "string" && apiKey.length > 0 };
  }
  return out;
}

/**
 * Cloud ASR settings, when configured:
 *   {"asr":"cloud","cloud":{"baseUrl":"https://api.siliconflow.cn/v1",
 *     "apiKey":"sk-...","model":"...","language":"yue"}}
 * baseUrl must be an OpenAI-compatible endpoint root (…/v1).
 */
function cloudSettings(config) {
  if (config.asr !== "cloud") return null;
  const cloud = config.cloud;
  if (!cloud || typeof cloud !== "object" || Array.isArray(cloud)) return null;
  if (typeof cloud.baseUrl !== "string" || !/^https?:\/\//i.test(cloud.baseUrl)) return null;
  if (typeof cloud.apiKey !== "string" || cloud.apiKey.length === 0) return null;
  if (typeof cloud.model !== "string" || cloud.model.length === 0) return null;
  return {
    baseUrl: cloud.baseUrl.replace(/\/+$/, ""),
    apiKey: cloud.apiKey,
    model: cloud.model,
    language: typeof cloud.language === "string" ? cloud.language : undefined,
    timeoutMs: Number.isFinite(cloud.timeoutMs) && cloud.timeoutMs > 0 ? Math.min(cloud.timeoutMs, 120_000) : 60_000
  };
}

/** POST one WAV recording to an OpenAI-compatible /audio/transcriptions endpoint. */
async function cloudTranscribe(settings, audio, languageHint) {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "speech.wav");
  form.append("model", settings.model);
  form.append("response_format", "json");
  const language = languageHint || settings.language;
  if (typeof language === "string" && language.length > 0 && language !== "auto") form.append("language", language);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("cloud transcription timed out")), settings.timeoutMs);
  try {
    const response = await fetch(settings.baseUrl + "/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer " + settings.apiKey },
      body: form,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error("cloud ASR HTTP " + response.status + ": " + text.slice(0, 200));
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("cloud ASR returned a non-JSON body");
    }
    if (typeof parsed.text === "string") return parsed.text;
    if (typeof parsed.text === "object" && parsed.text !== null) return String(parsed.text);
    throw new Error("cloud ASR response has no text");
  } finally {
    clearTimeout(timer);
  }
}

/** Presence diagnostics: proves the browser half actually executed. */
const diagnostics = {
  clientHelloCount: 0,
  lastClientHelloAt: null,
  lastClientInfo: null
};

// ── trust fence (same shape as other local plugins) ─────────────────────────
// Loopback is always allowed; extra authorities may come from trustedHosts.

function parseAuthority(authority) {
  if (typeof authority !== "string" || authority === "" || /[\s\\/@?#]/.test(authority)) return undefined;
  try {
    return new URL("http://" + authority);
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4
    && parts[0] === "127"
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== "" ? entryUrl.port : new URL("https://" + entry).port;
  return port === "" ? entryUrl.hostname : entryUrl.hostname + ":" + port;
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host;
  });
}

function isTrustedRequest(req, trustedHosts) {
  const host = typeof req.headers.host === "string" ? req.headers.host : undefined;
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function buildTrustedHosts(entries, warn) {
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const parsed = parseAuthority(entry);
    if (parsed === undefined) {
      if (warn) warn("ignoring invalid trustedHosts entry: " + JSON.stringify(String(entry)));
      continue;
    }
    out.push(entry);
  }
  return out;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function writeJson(res, status, value) {
  let body;
  try {
    body = JSON.stringify(value);
  } catch {
    body = '{"ok":false,"error":{"code":"internal","message":"internal error"}}';
    status = 500;
  }
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

/** Read + JSON.parse a request body with a hard size cap. */
function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        req.removeAllListeners("data");
        req.resume();
        finish({ tooLarge: true });
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(text);
        finish(parsed !== null && typeof parsed === "object" ? parsed : { invalid: true });
      } catch {
        finish({ invalid: true });
      }
    });
    req.on("error", () => finish({ invalid: true }));
    req.on("aborted", () => finish({ invalid: true }));
  });
}

function errorBody(code, message) {
  return { ok: false, error: { code, message } };
}

/** Decode a canonical base64 string into a Buffer, or fail closed. */
function decodeBase64(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0) throw new Error("missing audio");
  if (encoded.length > Math.ceil(MAX_BODY_BYTES / 3) * 4) throw new Error("audio too large");
  const audio = Buffer.from(encoded, "base64");
  if (audio.length === 0) throw new Error("empty audio");
  if (audio.length > MAX_BODY_BYTES) throw new Error("audio too large");
  // Reject non-canonical encodings: stops a huge/odd payload from being
  // silently re-encoded into a different request size downstream.
  if (audio.toString("base64") !== encoded) throw new Error("non-canonical audio encoding");
  if (audio.length < 44) throw new Error("audio is not a WAV recording");
  return audio;
}

// ── speech service bridge ───────────────────────────────────────────────────

function providerSnapshot(speechToText) {
  try {
    const snapshot = speechToText.snapshot();
    return {
      ok: true,
      selection: snapshot.selection,
      providers: (snapshot.providers || []).map((provider) => ({
        id: provider.id,
        name: provider.name,
        languages: provider.languages,
        preparation: provider.preparation
      }))
    };
  } catch (error) {
    return errorBody("status-unavailable", error && error.message ? error.message : "status unavailable");
  }
}

async function requestTranscription(speechToText, audio, language) {
  const request = { audio };
  if (typeof language === "string" && language.length > 0 && language !== "auto") request.language = language;
  const spec = speechToText.resolve(request);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("speech transcription timed out")), TRANSCRIBE_TIMEOUT_MS);
  try {
    const result = await speechToText.transcribe(spec, controller.signal);
    // The local provider resolves a transcript object ({ text, audioSeconds,
    // inferenceSeconds }); custom providers may resolve a bare string.
    if (typeof result === "string") return result;
    if (result && typeof result.text === "string") return result.text;
    return "";
  } finally {
    clearTimeout(timer);
  }
}

// ── routing ─────────────────────────────────────────────────────────────────

function routeOf(req) {
  let pathname = API_PREFIX;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    /* fall through with the prefix */
  }
  if (pathname === API_PREFIX) return "/";
  if (!pathname.startsWith(API_PREFIX + "/")) return undefined;
  return pathname.slice(API_PREFIX.length);
}

async function handleApi(req, res, ctx, trustedHosts) {
  if (!isTrustedRequest(req, trustedHosts)) {
    writeJson(res, 403, errorBody("forbidden", "forbidden"));
    return;
  }
  const route = routeOf(req);
  if (route === undefined) {
    writeJson(res, 404, errorBody("not-found", "not found"));
    return;
  }

  if (route === "/status" && req.method === "GET") {
    writeJson(res, 200, providerSnapshot(ctx.speechToText));
    return;
  }

  if (route === "/prepare" && req.method === "POST") {
    const body = await readJsonBody(req, 64 * 1024);
    if (body.tooLarge) {
      writeJson(res, 413, errorBody("payload-too-large", "payload too large"));
      return;
    }
    if (body.invalid) {
      writeJson(res, 400, errorBody("invalid-request", "invalid request"));
      return;
    }
    const selection = providerSnapshot(ctx.speechToText);
    const providerId = typeof body.providerId === "string" && body.providerId.length > 0
      ? body.providerId
      : selection.ok && selection.selection ? selection.selection.providerId : undefined;
    if (!providerId) {
      writeJson(res, 409, errorBody("no-provider", "no speech provider is configured"));
      return;
    }
    try {
      ctx.speechToText.prepare(providerId);
    } catch (error) {
      writeJson(res, 409, errorBody("prepare-failed", error && error.message ? error.message : "prepare failed"));
      return;
    }
    writeJson(res, 200, providerSnapshot(ctx.speechToText));
    return;
  }

  if (route === "/client-hello" && req.method === "POST") {
    const body = await readJsonBody(req, 16 * 1024);
    diagnostics.clientHelloCount += 1;
    diagnostics.lastClientHelloAt = new Date().toISOString();
    diagnostics.lastClientInfo = body && !body.invalid && !body.tooLarge ? body : null;
    writeJson(res, 200, { ok: true });
    return;
  }

  if (route === "/config" && req.method === "GET") {
    writeJson(res, 200, { ok: true, config: sanitizeConfig(readConfig()) });
    return;
  }

  if (route === "/debug" && req.method === "GET") {
    writeJson(res, 200, { ok: true, ...diagnostics, config: sanitizeConfig(readConfig()), configPath: configPath() });
    return;
  }

  if (route === "/transcribe" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (body.tooLarge) {
      writeJson(res, 413, errorBody("payload-too-large", "audio exceeds the route limit"));
      return;
    }
    if (body.invalid || typeof body.audioBase64 !== "string") {
      writeJson(res, 400, errorBody("invalid-request", "missing audio"));
      return;
    }
    let audio;
    try {
      audio = decodeBase64(body.audioBase64);
    } catch (error) {
      writeJson(res, 400, errorBody("invalid-audio", error && error.message ? error.message : "invalid audio"));
      return;
    }
    const language = typeof body.language === "string" ? body.language : undefined;
    const config = readConfig();
    const cloud = cloudSettings(config);
    if (cloud) {
      try {
        const text = await cloudTranscribe(cloud, audio, language);
        writeJson(res, 200, { ok: true, text, via: "cloud" });
        return;
      } catch (error) {
        // Never echo upstream detail: it may contain the endpoint or response body.
        console.warn("[dsh-voice-ptt] cloud ASR failed, falling back to local:", error && error.message ? error.message : error);
        if (config.fallbackLocal === false) {
          writeJson(res, 502, errorBody("transcribe-failed", "cloud transcription failed"));
          return;
        }
      }
    }
    try {
      const text = await requestTranscription(ctx.speechToText, audio, language);
      writeJson(res, 200, { ok: true, text, via: "local" });
    } catch (error) {
      // Never echo internal error text: it can carry paths / provider details.
      writeJson(res, 500, errorBody("transcribe-failed", "speech transcription failed"));
    }
    return;
  }

  writeJson(res, 404, errorBody("not-found", "not found"));
}

/** Host loader entry: mount the fenced bridge. */
export function apply(ctx) {
  const trustedHosts = buildTrustedHosts(ctx.webStartup ? ctx.webStartup.trustedHosts : undefined, (message) => {
    console.warn("[dsh-voice-ptt]", message);
  });

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        await handleApi(req, res, ctx, trustedHosts);
      } catch (error) {
        console.error("[dsh-voice-ptt] request failed:", error && error.stack ? error.stack : error);
        if (!res.headersSent) writeJson(res, 500, errorBody("internal", "internal error"));
        else res.end();
      }
    }
  }), "dsh-voice-ptt: routes");
}
