let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;
let micSource = null;
let audioChunks = [];
let recordingStartTime = 0;
let timerInterval = null;
let bookShuttleTimer = null;
let micStartPromise = null;
let micStopPromise = null;
let micEpoch = 0;
let micActive = false;
let assistantPlaybackVersion = 0;
let bookPlaybackVersion = 0;

export function playEarcon(freqStart, freqEnd, durationSec = 0.14) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freqStart, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(freqEnd, ctx.currentTime + durationSec);

    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationSec);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + durationSec);
  } catch (err) {
    console.warn("Earcon error:", err);
  }
}

export async function playBootWaterSound() {
  let ctx;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;
    ctx = new AudioCtx();
    if (ctx.state !== "running") {
      await Promise.race([
        ctx.resume(),
        new Promise((resolve) => setTimeout(resolve, 180))
      ]);
    }
    if (ctx.state !== "running") {
      await ctx.close();
      return false;
    }

    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.34, now + 0.18);
    master.gain.setValueAtTime(0.34, now + 1.45);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 2.2);
    master.connect(ctx.destination);

    // Filtered noise makes a short soft wash; rounded droplets add a water-like ripple.
    const sampleCount = Math.floor(ctx.sampleRate * 2.2);
    const noiseBuffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
    const samples = noiseBuffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) samples[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const washGain = ctx.createGain();
    noise.buffer = noiseBuffer;
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(700, now);
    filter.frequency.exponentialRampToValueAtTime(1800, now + .75);
    filter.frequency.exponentialRampToValueAtTime(550, now + 2.1);
    filter.Q.setValueAtTime(.55, now);
    washGain.gain.setValueAtTime(.0001, now);
    washGain.gain.exponentialRampToValueAtTime(.22, now + .22);
    washGain.gain.setValueAtTime(.14, now + 1.1);
    washGain.gain.exponentialRampToValueAtTime(.0001, now + 2.15);
    noise.connect(filter);
    filter.connect(washGain);
    washGain.connect(master);
    noise.start(now);
    noise.stop(now + 2.2);

    [0.24, 0.72, 1.18].forEach((offset, index) => {
      const start = now + offset;
      const drop = ctx.createOscillator();
      const dropGain = ctx.createGain();
      drop.type = "sine";
      drop.frequency.setValueAtTime([980, 740, 1120][index], start);
      drop.frequency.exponentialRampToValueAtTime([540, 420, 650][index], start + .22);
      dropGain.gain.setValueAtTime(.0001, start);
      dropGain.gain.exponentialRampToValueAtTime(.24, start + .025);
      dropGain.gain.exponentialRampToValueAtTime(.0001, start + .32);
      drop.connect(dropGain);
      dropGain.connect(master);
      drop.start(start);
      drop.stop(start + .34);
    });

    setTimeout(() => ctx.close().catch(() => {}), 2700);
    return true;
  } catch (err) {
    if (ctx && ctx.state !== "closed") ctx.close().catch(() => {});
    console.info("Boot sound needs a user gesture:", err);
    return false;
  }
}

export function getBookPlayer() {
  return document.getElementById("bookAudioPlayer");
}

export function getAssistantPlayer() {
  return document.getElementById("assistantAudioPlayer");
}

function setStreamVisualState(boxId, isPlaying) {
  const box = document.getElementById(boxId);
  if (box) box.classList.toggle("stream-playing", isPlaying);
}

export function stopAssistantAudio() {
  assistantPlaybackVersion++;
  const assistant = getAssistantPlayer();
  if (assistant) {
    assistant.onended = null;
    assistant.pause();
    assistant.currentTime = 0;
  }
  setStreamVisualState("assistantStreamBox", false);
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

export function pauseBookStream(rewindSeconds = 0) {
  bookPlaybackVersion++;
  const book = getBookPlayer();
  setStreamVisualState("bookStreamBox", false);
  if (!book) return 0;
  book.pause();
  const safeTime = Math.max(0, book.currentTime - rewindSeconds);
  book.currentTime = safeTime;
  return safeTime;
}

export function shuttleBookStream(direction, seconds = 10) {
  const book = getBookPlayer();
  if (!book || book.paused || !Number.isFinite(book.duration)) return false;

  const maxTime = Math.max(0, book.duration - 0.05);
  const nextTime = Math.max(0, Math.min(maxTime, book.currentTime + direction * seconds));
  if (Math.abs(nextTime - book.currentTime) < 0.05) return false;

  book.currentTime = nextTime;
  book.playbackRate = 2;
  clearTimeout(bookShuttleTimer);
  bookShuttleTimer = window.setTimeout(() => {
    if (!book.paused) book.playbackRate = 1;
  }, 1800);
  return true;
}

export function playBookChunkBase64(base64String, onChunkFinished, onTimeUpdate) {
  const book = getBookPlayer();
  if (!book || !base64String) return;

  const playbackVersion = ++bookPlaybackVersion;
  book.playbackRate = 1;
  setStreamVisualState("bookStreamBox", true);
  book.onended = () => {
    if (playbackVersion !== bookPlaybackVersion) return;
    setStreamVisualState("bookStreamBox", false);
    if (onChunkFinished) onChunkFinished();
  };
  book.onpause = () => setStreamVisualState("bookStreamBox", false);
  book.onplay = () => setStreamVisualState("bookStreamBox", true);
  book.ontimeupdate = () => {
    if (onTimeUpdate) onTimeUpdate(book.currentTime);
  };

  book.src = "data:audio/wav;base64," + base64String;
  book.play().catch((err) => {
    setStreamVisualState("bookStreamBox", false);
    console.warn("Book playback blocked:", err);
  });
}

export function playAssistantBase64(base64String, onFinishedCallback = null) {
  stopAssistantAudio();
  const playbackVersion = assistantPlaybackVersion;
  const assistant = getAssistantPlayer();
  if (!assistant || !base64String) {
    if (onFinishedCallback) onFinishedCallback();
    return;
  }

  setStreamVisualState("assistantStreamBox", true);
  assistant.onended = () => {
    if (playbackVersion !== assistantPlaybackVersion) return;
    setStreamVisualState("assistantStreamBox", false);
    if (onFinishedCallback) onFinishedCallback();
  };
  assistant.src = "data:audio/wav;base64," + base64String;
  assistant.play().catch((err) => {
    if (playbackVersion !== assistantPlaybackVersion) return;
    setStreamVisualState("assistantStreamBox", false);
    console.warn("Assistant audio blocked:", err);
    if (onFinishedCallback) onFinishedCallback();
  });
}

export async function startMicCapture(onTick) {
  if (micStartPromise || micActive) {
    throw new Error("Microphone capture is already starting or active.");
  }

  clearMicTimer();
  audioChunks = [];
  const epoch = ++micEpoch;
  stopAssistantAudio();
  playEarcon(440, 880, 0.15);

  const startPromise = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (epoch !== micEpoch) {
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }

    mediaStream = stream;
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    if (epoch !== micEpoch) {
      await releaseMicResources();
      return false;
    }

    micSource = audioContext.createMediaStreamSource(mediaStream);
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    scriptProcessor.onaudioprocess = (event) => {
      if (!micActive || epoch !== micEpoch) return;
      audioChunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    micSource.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    recordingStartTime = Date.now();
    micActive = true;
    timerInterval = window.setInterval(() => {
      if (!micActive || epoch !== micEpoch) return;
      const elapsedSec = ((Date.now() - recordingStartTime) / 1000).toFixed(1);
      if (onTick) onTick(elapsedSec);
    }, 100);
    return true;
  })();

  micStartPromise = startPromise;
  try {
    return await startPromise;
  } catch (err) {
    micEpoch++;
    await releaseMicResources();
    throw err;
  } finally {
    if (micStartPromise === startPromise) micStartPromise = null;
  }
}

export function stopMicCapture() {
  if (micStopPromise) return micStopPromise;
  micStopPromise = stopMicCaptureInternal().finally(() => {
    micStopPromise = null;
  });
  return micStopPromise;
}

async function stopMicCaptureInternal() {
  const wasActive = micActive;
  const durationMs = wasActive ? Date.now() - recordingStartTime : 0;
  const capturedChunks = audioChunks.slice();
  const pendingStart = micStartPromise;

  micEpoch++;
  micActive = false;
  clearMicTimer();
  playEarcon(880, 440, 0.15);

  if (pendingStart && !wasActive) {
    try { await pendingStart; } catch (_) { /* Permission or device startup failed. */ }
  }
  await releaseMicResources();
  audioChunks = [];
  recordingStartTime = 0;

  if (!wasActive || durationMs < 600) return null;
  return encodePCM16Wav(capturedChunks, 16000);
}

function clearMicTimer() {
  if (timerInterval !== null) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

async function releaseMicResources() {
  clearMicTimer();
  if (micSource) {
    try { micSource.disconnect(); } catch (_) { /* Already disconnected. */ }
    micSource = null;
  }
  if (scriptProcessor) {
    scriptProcessor.onaudioprocess = null;
    try { scriptProcessor.disconnect(); } catch (_) { /* Already disconnected. */ }
    scriptProcessor = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (audioContext && audioContext.state !== "closed") {
    const contextToClose = audioContext;
    audioContext = null;
    try { await contextToClose.close(); } catch (_) { /* Context was already closing. */ }
  } else {
    audioContext = null;
  }
}

function encodePCM16Wav(buffers, sampleRate) {
  let totalLength = 0;
  for (const b of buffers) totalLength += b.length;
  const samples = new Float32Array(totalLength);
  let offset = 0;
  for (const b of buffers) {
    samples.set(b, offset);
    offset += b.length;
  }

  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (off, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(off + i, str.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let index = 44;
  for (let i = 0; i < samples.length; i++, index += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(index, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return new Blob([view], { type: "audio/wav" });
}
