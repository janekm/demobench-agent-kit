import { PcmAudioPlayer } from './audio-player.js';

const $ = (id) => document.getElementById(id);
const canvas = $("screen");
const context = canvas.getContext("2d", { alpha: false });
context.imageSmoothingEnabled = false;

const controls = {
  example: $("example-select"), quality: $("quality-select"), backend: $("renderer-select"), source: $("source"), assemble: $("assemble-button"),
  play: $("play-button"), step: $("step-button"), reset: $("reset-button"),
  sound: $("sound-button"), volume: $("volume-slider"),
  png: $("png-button"), cartridge: $("cartridge-button"),
};
const FORMAT = ["I1", "I2", "I4", "I8", "RGB888"];
const GPU_EXAMPLE = "examples/gpu-ray-tracer.asm";
const PIXEL_SHIFT_LINE = /^([ \t]*\.equ[ \t]+PIXEL_SHIFT[ \t]*,[ \t]*)([^;\r\n]*?)([ \t]*(?:;[^\r\n]*)?)(\r?)$/gmi;
let workerReady = false;
let wasmSha256 = null;
let hasProgram = false;
let hasFrame = false;
let cartridge = null;
let cartridgeName = "demo.db32";
let loadedExamplePath = null;
let sourceRevision = 0;
let pendingBackend = null;
let stickyError = false;
let soundPending = false;
let latest = Object.freeze({ ready: false, playing: false, status: "loading", profile: null, profileCode: 0, gpu: null, audio: Object.freeze({ available: false }), audioPlayback: Object.freeze({ enabled: false, epoch: null, volume: 0.5, outputRate: null, contextState: null, queuedFrames: 0, underruns: 0, playedFrames: 0, droppedFrames: 0, peak: 0 }), backend: Object.freeze({ requested: "auto", active: "wasm", available: false, reason: null, dispatchMs: null, fps: null }), frameCount: 0, tick: "0", pc: 0, payloadSize: 0, format: null, frameHash: null, registers: Object.freeze([]) });

const audioPlayer = new PcmAudioPlayer(renderPlaybackMetrics);

// Read-only, copied observations of the actual machine output for browser tests.
Object.defineProperty(window, "__demoBench", { enumerable: false, configurable: false, get: () => latest });

function setMessage(text, error = false) {
  const node = $("message");
  node.textContent = text;
  node.classList.toggle("error", error);
  stickyError = error;
}

function overlay(title, detail, error = false) {
  const node = $("screen-overlay");
  node.querySelector("strong").textContent = title;
  node.querySelector("span").textContent = detail;
  node.querySelector(".overlay-glyph").textContent = error ? "!" : "◇";
  node.classList.toggle("error", error);
  node.classList.remove("hidden");
}

function updateControls() {
  controls.example.disabled = !workerReady;
  controls.source.disabled = !workerReady;
  controls.quality.disabled = !workerReady || controls.example.value !== GPU_EXAMPLE || loadedExamplePath !== GPU_EXAMPLE;
  controls.backend.disabled = !workerReady || !hasProgram || latest.profileCode < 2;
  controls.sound.disabled = !workerReady || !hasProgram || latest.profileCode < 3 || !latest.audio.available || soundPending;
  controls.volume.disabled = !workerReady || !hasProgram || latest.profileCode < 3 || !latest.audio.available;
  controls.assemble.disabled = !workerReady;
  controls.play.disabled = !workerReady || !hasProgram || latest.status === "fault";
  controls.step.disabled = !workerReady || !hasProgram || latest.status === "fault";
  controls.reset.disabled = !workerReady || !hasProgram;
  controls.png.disabled = !hasFrame;
  controls.cartridge.disabled = !cartridge;
  $("play-label").textContent = latest.playing ? "Pause" : "Play";
  $("play-icon").textContent = latest.playing ? "Ⅱ" : "▶";
  $("machine-label").textContent = !workerReady ? "MACHINE OFFLINE" : latest.playing ? "MACHINE RUNNING" : "MACHINE READY";
  document.querySelector(".machine-tag").classList.toggle("ready", workerReady);
  document.querySelector(".machine-tag").classList.toggle("error", !workerReady && stickyError);
}

function renderPlaybackMetrics(metrics) {
  latest = Object.freeze({ ...latest, audioPlayback: Object.freeze({ ...metrics }) });
  $("audio-queue-value").textContent = formatNumber(metrics.queuedFrames);
  $("audio-underruns-value").textContent = formatNumber(metrics.underruns);
  $("audio-played-value").textContent = formatNumber(metrics.playedFrames);
  $("audio-peak-value").textContent = Number.isFinite(metrics.peak) ? metrics.peak.toFixed(2) : "—";
  $("audio-drops-value").textContent = formatNumber(metrics.droppedFrames);
  controls.sound.textContent = metrics.enabled ? "Sound off" : "Sound on";
  controls.sound.setAttribute("aria-pressed", String(metrics.enabled));
  $("audio-output-status").textContent = metrics.enabled ? "PCM output enabled" : "Muted until Sound on";
}

function pixelShiftMatches(source) {
  return [...source.matchAll(PIXEL_SHIFT_LINE)];
}

function syncQualityControl() {
  const gpuExample = controls.example.value === GPU_EXAMPLE;
  $("quality-toolbar").hidden = !gpuExample;
  controls.quality.disabled = !workerReady || !gpuExample || loadedExamplePath !== GPU_EXAMPLE;
  if (!gpuExample) return;
  const matches = pixelShiftMatches(controls.source.value);
  const value = matches.length === 1 ? matches[0][2].trim() : "";
  controls.quality.value = value === "0" || value === "1" ? value : "";
}

function formatNumber(value) {
  try { return BigInt(value).toLocaleString("en-US"); } catch { return String(value); }
}

function hex(value) { return `0x${(value >>> 0).toString(16).padStart(8, "0").toUpperCase()}`; }

function hashFrame(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function renderState(state) {
  const backend = state.backend || { requested: "auto", active: "wasm", available: false, reason: null, dispatchMs: null, fps: null };
  const audio = state.audio || { available: false, samples: 0, blocks: 0, peak: 0, overruns: 0, backend: "wasm", lastTicks: 0, dispatchMs: null };
  const audioVisible = hasProgram && state.profileCode >= 3 && !!audio.available;
  audioPlayer.setAvailable(audioVisible);
  audioPlayer.setPlaying(audioVisible && !!state.playing);
  let frameHash = latest.frameHash;
  if (state.frame) {
    const pixels = state.frame instanceof Uint8Array ? state.frame : new Uint8Array(state.frame);
    if (pixels.length === 160 * 120 * 4) {
      context.putImageData(new ImageData(new Uint8ClampedArray(pixels), 160, 120), 0, 0);
      frameHash = hashFrame(pixels);
      hasFrame = true;
    }
  }
  latest = Object.freeze({
    ready: workerReady,
    wasmSha256,
    playing: !!state.playing,
    status: state.status,
    statusCode: state.statusCode,
    profile: state.profile,
    profileCode: state.profileCode,
    gpu: Object.freeze({ ...state.gpu }),
    audio: Object.freeze({ ...audio }),
    audioPlayback: Object.freeze(audioPlayer.metrics()),
    backend: Object.freeze({ ...backend }),
    frameCount: state.frameCount,
    tick: state.tick,
    pc: state.pc,
    payloadSize: state.payloadSize,
    format: state.format,
    frameHash,
    registers: Object.freeze([...state.registers]),
  });
  let label = state.status.toUpperCase();
  let detail = "Machine loaded";
  if (state.status === "running" && !state.playing) { label = "PAUSED"; detail = "Ready to run"; }
  else if (state.status === "running") detail = "Executing program";
  else if (state.status === "waiting") detail = state.gpu.statusCode === 1 ? "Waiting for GPU or vblank" : "Waiting for vblank";
  else if (state.status === "halted") detail = state.gpu.statusCode === 1 ? "CPU halted · GPU busy" : "Video keeps scanning";
  else if (state.status === "fault") detail = "Execution stopped";
  else if (state.status === "empty") detail = "No cartridge loaded";
  $("status-value").textContent = label;
  $("status-detail").textContent = detail;
  $("frames-value").textContent = formatNumber(state.frameCount);
  $("ticks-value").textContent = formatNumber(state.tick);
  $("pc-value").textContent = hex(state.pc);
  $("frame-caption").textContent = `FRAME ${String(state.frameCount).padStart(6, "0")}`;
  $("format-label").textContent = FORMAT[state.format] || "—";
  $("profile-tag").textContent = `${state.profile.toUpperCase()} / ABI 01`;
  $("footer-profile").textContent = `DB32 / ${state.profile.toUpperCase()} PROFILE`;
  const accelerated = backend.active === "webgpu";
  $("footer-video").textContent = state.profileCode >= 3 ? (accelerated ? "GPU + SPU · WEBGPU FAST MATH" : "GPU + SPU · WASM REFERENCE") : state.profileCode === 2 ? (accelerated ? "WEBGPU FAST MATH · WASM MACHINE" : "GPU REFERENCE · LOCAL WEBASSEMBLY") : "CPU-WRITTEN VIDEO · LOCAL WEBASSEMBLY";
  const gpuVisible = hasProgram && state.profileCode >= 2;
  $("gpu-telemetry").hidden = !gpuVisible;
  $("renderer-toolbar").hidden = !gpuVisible;
  if (!gpuVisible) pendingBackend = null;
  if (gpuVisible) {
    if (pendingBackend === backend.requested) pendingBackend = null;
    const requested = pendingBackend || backend.requested;
    if (["auto", "wasm", "webgpu"].includes(requested)) controls.backend.value = requested;
    const activeLabel = accelerated ? "WebGPU · fast math" : "WASM · reference";
    if ($("renderer-active").textContent !== activeLabel) $("renderer-active").textContent = activeLabel;
    $("renderer-note").textContent = accelerated ? "Host timing · virtual tick budget not comparable" : "Virtual tick budget applies to the reference renderer";
    const reason = backend.reason || (!backend.available && !accelerated && backend.requested !== "wasm" ? "WebGPU unavailable; using the WASM reference renderer." : "");
    if ($("renderer-reason").textContent !== reason) $("renderer-reason").textContent = reason;
    $("renderer-reason").hidden = !reason;
    $("gpu-status-value").textContent = state.gpu.status.toUpperCase();
    $("gpu-ticks-label").textContent = accelerated ? "DISPATCH WALL TIME" : "LAST DISPATCH";
    $("gpu-ticks-value").textContent = accelerated ? (Number.isFinite(backend.dispatchMs) && backend.dispatchMs >= 0 ? `${backend.dispatchMs.toFixed(1)} ms` : "—") : (state.gpu.dispatches ? formatNumber(state.gpu.lastTicks) : "—");
    $("gpu-ticks-detail").textContent = accelerated ? "Host time · WebGPU" : "Virtual ticks · WASM reference";
    $("gpu-budget-label").textContent = accelerated ? "HOST FPS" : "FRAME BUDGET";
    $("gpu-budget-value").textContent = accelerated ? (Number.isFinite(backend.fps) && backend.fps >= 0 ? backend.fps.toFixed(1) : "—") : (state.gpu.frameBudgetPercent === null ? "—" : `${state.gpu.frameBudgetPercent.toFixed(1)}%`);
    $("gpu-budget-detail").textContent = accelerated ? "Measured host output" : "204,800 virtual ticks";
    $("gpu-dispatches-value").textContent = formatNumber(state.gpu.dispatches);
    $("gpu-status-detail").textContent = state.gpu.statusCode === 1 ? (accelerated ? "Accelerated dispatch in progress" : `${formatNumber(state.gpu.ticks)} ticks elapsed · ${formatNumber(state.gpu.invocations)} invocations`) : "Dispatch state";
  }
  $("audio-toolbar").hidden = !audioVisible;
  $("audio-telemetry").hidden = !audioVisible;
  $("audio-playback").hidden = !audioVisible;
  if (audioVisible) {
    $("spu-blocks-value").textContent = formatNumber(audio.blocks);
    $("spu-samples-value").textContent = formatNumber(audio.samples);
    const hardwareSpu = audio.backend === "webgpu";
    $("spu-kernel-value").textContent = hardwareSpu ? (Number.isFinite(audio.dispatchMs) ? `${audio.dispatchMs.toFixed(1)} ms` : "—") : (audio.blocks ? `${formatNumber(audio.lastTicks)} ticks` : "—");
    $("spu-kernel-detail").textContent = hardwareSpu ? "WebGPU host time" : "WASM virtual work";
    $("spu-peak-value").textContent = Number.isFinite(audio.peak) ? audio.peak.toFixed(2) : "—";
    $("spu-overruns-value").textContent = formatNumber(audio.overruns);
    renderPlaybackMetrics(audioPlayer.metrics());
  }
  $("display-led").classList.toggle("live", hasProgram && state.status !== "fault");
  if (hasProgram) $("screen-overlay").classList.add("hidden");
  if (!stickyError && hasProgram) setMessage(`${formatNumber(state.payloadSize)}-byte payload · ${FORMAT[state.format] || "unknown"} video · ${state.playing ? "playing" : "ready"}`);
  updateControls();
}

function setSource(source, path) {
  controls.source.value = source;
  loadedExamplePath = path;
  syncQualityControl();
  const name = path.split("/").pop() || "UNTITLED.ASM";
  $("file-label").textContent = name.toUpperCase();
  $("source-indicator").textContent = "EXAMPLE";
  $("source-indicator").classList.remove("edited");
  countLines();
  cartridgeName = name.replace(/\.asm$/i, "") + ".db32";
}

function countLines() {
  const text = controls.source.value;
  const lines = text ? text.split("\n").length : 0;
  $("line-count").textContent = `${lines} ${lines === 1 ? "LINE" : "LINES"}`;
}

async function loadExample(path) {
  const revision = ++sourceRevision;
  audioPlayer.invalidate();
  loadedExamplePath = null;
  syncQualityControl();
  overlay("Loading source", path);
  setMessage(`Loading ${path}…`);
  try {
    const response = await fetch(new URL(path, import.meta.url));
    if (!response.ok) throw new Error(`Could not fetch ${path} (HTTP ${response.status}).`);
    const source = await response.text();
    if (revision !== sourceRevision) return;
    setSource(source, path);
    worker.postMessage({ type: "assemble", source, autoPlay: true });
    setMessage(`Assembling ${path} inside DB32…`);
  } catch (error) {
    if (revision !== sourceRevision) return;
    setMessage(error.message || String(error), true);
    if (!hasProgram) overlay("Example unavailable", error.message || String(error), true);
    else $("screen-overlay").classList.add("hidden");
  }
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const worker = new Worker(new URL("./machine-worker.js", import.meta.url), { type: "module" });
worker.onmessage = ({ data }) => {
  switch (data.type) {
    case "ready":
      workerReady = true;
      wasmSha256 = data.wasmSha256;
      updateControls();
      loadExample(controls.example.value);
      break;
    case "state":
      renderState(data);
      break;
    case "audio":
      audioPlayer.push(data.samples, data.rate, data.epoch);
      break;
    case "audio-reset":
      audioPlayer.reset(data.epoch);
      break;
    case "assembled":
      cartridge = new Uint8Array(data.cartridge);
      hasProgram = true;
      stickyError = false;
      $("listing").textContent = data.listing || "(No listing available)";
      $("listing-size").textContent = `${formatNumber(cartridge.byteLength)} B CART`;
      setMessage(`Assembled ${formatNumber(data.payloadSize)}-byte payload. Running in DB32.`);
      updateControls();
      break;
    case "error":
      setMessage(data.message, true);
      if (!hasProgram) overlay("Assembly stopped", data.message, true);
      else $("screen-overlay").classList.add("hidden");
      break;
    case "init-error":
      workerReady = false;
      audioPlayer.setAvailable(false);
      setMessage(data.message, true);
      overlay("Machine unavailable", data.message, true);
      updateControls();
      break;
  }
};
worker.onerror = (event) => {
  workerReady = false;
  audioPlayer.setAvailable(false);
  setMessage(event.message || "The machine worker failed to start.", true);
  overlay("Machine unavailable", event.message || "The machine worker failed to start.", true);
  updateControls();
};

controls.example.addEventListener("change", () => {
  syncQualityControl();
  loadExample(controls.example.value);
});
controls.backend.addEventListener("change", () => {
  if (!workerReady || !hasProgram || latest.profileCode < 2) return;
  pendingBackend = controls.backend.value;
  audioPlayer.invalidate();
  worker.postMessage({ type: "backend", backend: pendingBackend });
});
controls.sound.addEventListener("click", async () => {
  if (soundPending || latest.profileCode < 3 || !latest.audio.available) return;
  if (audioPlayer.enabled) {
    audioPlayer.disable();
    return;
  }
  soundPending = true;
  updateControls();
  try {
    await audioPlayer.enableFromGesture();
  } catch (error) {
    setMessage(`Audio output unavailable: ${error.message || String(error)}`, true);
  } finally {
    soundPending = false;
    updateControls();
  }
});
controls.volume.addEventListener("input", () => {
  $("volume-value").textContent = `${controls.volume.value}%`;
  audioPlayer.setVolume(Number(controls.volume.value) / 100);
});
controls.source.addEventListener("input", () => {
  ++sourceRevision;
  countLines();
  syncQualityControl();
  $("source-indicator").textContent = "MODIFIED";
  $("source-indicator").classList.add("edited");
});
controls.quality.addEventListener("change", () => {
  if (!workerReady || controls.example.value !== GPU_EXAMPLE) return;
  const source = controls.source.value;
  const matches = pixelShiftMatches(source);
  if (matches.length !== 1 || !matches[0][2].trim()) {
    setMessage("Ray quality needs exactly one .equ PIXEL_SHIFT, value line in the editor. The source was not changed.", true);
    syncQualityControl();
    return;
  }
  const match = matches[0];
  const replacement = `${match[1]}${controls.quality.value}${match[3]}${match[4]}`;
  controls.source.value = source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
  controls.source.dispatchEvent(new Event("input"));
  controls.assemble.click();
});
controls.source.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    const { selectionStart: start, selectionEnd: end, value } = controls.source;
    controls.source.value = value.slice(0, start) + "    " + value.slice(end);
    controls.source.selectionStart = controls.source.selectionEnd = start + 4;
    controls.source.dispatchEvent(new Event("input"));
  }
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    controls.assemble.click();
  }
});
controls.assemble.addEventListener("click", () => {
  if (!workerReady) return;
  audioPlayer.invalidate();
  stickyError = false;
  setMessage("Assembling source inside DB32…");
  worker.postMessage({ type: "assemble", source: controls.source.value, autoPlay: true });
});
controls.play.addEventListener("click", () => {
  if (latest.playing) audioPlayer.setPlaying(false);
  worker.postMessage({ type: latest.playing ? "pause" : "play" });
});
controls.step.addEventListener("click", () => { audioPlayer.invalidate(); worker.postMessage({ type: "step" }); });
controls.reset.addEventListener("click", () => { stickyError = false; audioPlayer.invalidate(); worker.postMessage({ type: "reset" }); });
controls.png.addEventListener("click", () => canvas.toBlob((blob) => { if (blob) saveBlob(blob, `db32-frame-${String(latest.frameCount).padStart(6, "0")}.png`); }, "image/png"));
controls.cartridge.addEventListener("click", () => { if (cartridge) saveBlob(new Blob([cartridge], { type: "application/octet-stream" }), cartridgeName); });
window.addEventListener("keydown", (event) => {
  if (event.code === "Space" && !event.repeat && !["TEXTAREA", "INPUT", "SELECT", "BUTTON"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    if (!controls.play.disabled) controls.play.click();
  }
});
