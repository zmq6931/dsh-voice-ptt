// Live end-to-end check for dsh-voice-ptt.
//
// Converts any mono PCM16 WAV to 16 kHz and POSTs it through the plugin's
// transcribe route (the host must be running with the plugin installed).
//
//   node test/e2e-live.mjs <wav-path> [language]
//
// language: auto (default) | zh | yue | en | ja | ko
import { readFileSync } from "node:fs";

const wavPath = process.argv[2];
if (wavPath === undefined) {
  console.error("usage: node e2e-live.mjs <mono-pcm16-wav> [language]");
  process.exit(2);
}
const language = process.argv[3];
const source = readFileSync(wavPath);
if (source.toString("ascii", 0, 4) !== "RIFF") throw new Error("not RIFF");

let offset = 12;
let fmt = null;
let data = null;
while (offset + 8 <= source.length) {
  const id = source.toString("ascii", offset, offset + 4);
  const size = source.readUInt32LE(offset + 4);
  const body = offset + 8;
  if (id === "fmt ") {
    fmt = {
      format: source.readUInt16LE(body),
      channels: source.readUInt16LE(body + 2),
      rate: source.readUInt32LE(body + 4),
      bits: source.readUInt16LE(body + 14)
    };
  } else if (id === "data") {
    data = source.subarray(body, body + size);
  }
  offset = body + size + (size % 2);
}
if (!fmt || !data) throw new Error("missing fmt/data");
console.log("input:", fmt);
if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels !== 1) throw new Error("expected mono PCM16");

const input = new Int16Array(data.buffer, data.byteOffset, data.length / 2);
const targetRate = 16000;
const outputLength = Math.max(1, Math.round(input.length * targetRate / fmt.rate));
const output = new Int16Array(outputLength);
const ratio = fmt.rate / targetRate;
for (let i = 0; i < outputLength; i += 1) {
  const position = i * ratio;
  const index = Math.floor(position);
  const fraction = position - index;
  const a = input[index] ?? 0;
  const b = input[index + 1] ?? a;
  output[i] = Math.round(a + (b - a) * fraction);
}

const length = output.length;
const wav = Buffer.alloc(44 + length * 2);
wav.write("RIFF", 0, "ascii");
wav.writeUInt32LE(36 + length * 2, 4);
wav.write("WAVE", 8, "ascii");
wav.write("fmt ", 12, "ascii");
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(targetRate, 24);
wav.writeUInt32LE(targetRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36, "ascii");
wav.writeUInt32LE(length * 2, 40);
for (let i = 0; i < length; i += 1) wav.writeInt16LE(output[i], 44 + i * 2);
console.log("converted:", { bytes: wav.length, ms: Math.round(length / 16) });

const port = (process.env.DSH_WEB_URL || "http://127.0.0.1:61726").split(":").pop();
const payload = { audioBase64: wav.toString("base64") };
if (language !== undefined && language !== "auto") payload.language = language;
const started = Date.now();
const response = await fetch(`http://127.0.0.1:${port}/voice-ptt/transcribe`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload)
});
const json = await response.json();
console.log("status:", response.status, "elapsed_ms:", Date.now() - started, "language:", language || "auto");
console.log("result:", JSON.stringify(json, null, 2));
