let audioContext = null;
let soundContext = null;
let mediaStream = null;
let scriptProcessor = null;
let micSource = null;
let audioChunks = [];
let recordingStartTime = 0;
let timerInterval = null;
let bookShuttleTimer = null;
let micStartPromise = null;
let micStopPromise = null;
let micStreamPromise = null;
let micEpoch = 0;
let micCaptureGeneration = 0;
let micActive = false;
let assistantPlaybackVersion = 0;
let bookPlaybackVersion = 0;
let bookPlaybackRate = 1;

async function getSoundContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;

  if (!soundContext || soundContext.state === "closed") {
    soundContext = new AudioCtx();
  }
  if (soundContext.state !== "running") {
    try {
      const resume = soundContext.resume().catch(() => {});
      await Promise.race([
        resume,
        new Promise((resolve) => window.setTimeout(resolve, 180))
      ]);
    } catch (_) {
      return null;
    }
  }
  return soundContext.state === "running" ? soundContext : null;
}

function createNoiseBuffer(context, duration) {
  const sampleCount = Math.floor(context.sampleRate * duration);
  const buffer = context.createBuffer(1, sampleCount, context.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) samples[i] = Math.random() * 2 - 1;
  return buffer;
}

export function adjustBookPlaybackRate(direction) {
  const nextRate = Math.round((bookPlaybackRate + direction * 0.1) * 10) / 10;
  bookPlaybackRate = Math.max(0.8, Math.min(1.5, nextRate));
  const book = getBookPlayer();
  if (book) book.playbackRate = bookPlaybackRate;
  return bookPlaybackRate;
}

export function playEarcon(freqStart, freqEnd, durationSec = 0.14) {
  void getSoundContext().then((ctx) => {
    if (!ctx) return;
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
  }).catch((err) => console.warn("Earcon error:", err));
}

export async function playPageTurnSound() {
  try {
    const context = await getSoundContext();
    if (!context) return false;

    const now = context.currentTime;
    const duration = 0.62;
    const source = context.createBufferSource();
    const paperBody = context.createBiquadFilter();
    const paperAir = context.createBiquadFilter();
    const bodyGain = context.createGain();
    const airGain = context.createGain();
    const master = context.createGain();

    source.buffer = createNoiseBuffer(context, duration);
    paperBody.type = "bandpass";
    paperBody.frequency.setValueAtTime(850, now);
    paperBody.frequency.exponentialRampToValueAtTime(2100, now + 0.18);
    paperBody.frequency.exponentialRampToValueAtTime(700, now + duration);
    paperBody.Q.value = 0.65;
    paperAir.type = "highpass";
    paperAir.frequency.value = 1700;
    bodyGain.gain.setValueAtTime(0.0001, now);
    bodyGain.gain.exponentialRampToValueAtTime(0.44, now + 0.12);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    airGain.gain.setValueAtTime(0.0001, now);
    airGain.gain.exponentialRampToValueAtTime(0.16, now + 0.16);
    airGain.gain.exponentialRampToValueAtTime(0.0001, now + duration * 0.8);
    master.gain.value = 0.72;

    source.connect(paperBody);
    paperBody.connect(bodyGain);
    bodyGain.connect(master);
    source.connect(paperAir);
    paperAir.connect(airGain);
    airGain.connect(master);
    master.connect(context.destination);
    source.start(now);
    source.stop(now + duration);
    return true;
  } catch (err) {
    console.warn("Page-turn sound error:", err);
    return false;
  }
}

export async function playBootWaterSound() {
  try {
    const ctx = await getSoundContext();
    if (!ctx) return false;
    const now = ctx.currentTime;
    const duration = 2.8;
    const swell = ctx.createBufferSource();
    const swellFilter = ctx.createBiquadFilter();
    const swellGain = ctx.createGain();
    swell.buffer = createNoiseBuffer(ctx, duration);
    swellFilter.type = "lowpass";
    swellFilter.frequency.setValueAtTime(320, now);
    swellFilter.frequency.exponentialRampToValueAtTime(1150, now + 1.25);
    swellFilter.frequency.exponentialRampToValueAtTime(430, now + duration);
    swellFilter.Q.value = 0.45;
    swellGain.gain.setValueAtTime(0.0001, now);
    swellGain.gain.linearRampToValueAtTime(0.018, now + 0.35);
    swellGain.gain.linearRampToValueAtTime(0.105, now + 1.25);
    swellGain.gain.linearRampToValueAtTime(0.078, now + 1.75);
    swellGain.gain.linearRampToValueAtTime(0.0001, now + duration);
    swell.connect(swellFilter);
    swellFilter.connect(swellGain);
    swellGain.connect(ctx.destination);
    swell.start(now);
    swell.stop(now + duration);

    const foam = ctx.createBufferSource();
    const foamFilter = ctx.createBiquadFilter();
    const foamGain = ctx.createGain();
    foam.buffer = createNoiseBuffer(ctx, duration);
    foamFilter.type = "bandpass";
    foamFilter.frequency.setValueAtTime(1150, now + 0.55);
    foamFilter.frequency.exponentialRampToValueAtTime(2500, now + 1.55);
    foamFilter.frequency.exponentialRampToValueAtTime(900, now + duration);
    foamFilter.Q.value = 0.42;
    foamGain.gain.setValueAtTime(0.0001, now);
    foamGain.gain.linearRampToValueAtTime(0.0001, now + 0.5);
    foamGain.gain.linearRampToValueAtTime(0.022, now + 1.5);
    foamGain.gain.linearRampToValueAtTime(0.0001, now + duration);
    foam.connect(foamFilter);
    foamFilter.connect(foamGain);
    foamGain.connect(ctx.destination);
    foam.start(now);
    foam.stop(now + duration);
    return true;
  } catch (err) {
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
  book.playbackRate = Math.min(2, bookPlaybackRate * 2);
  clearTimeout(bookShuttleTimer);
  bookShuttleTimer = window.setTimeout(() => {
    if (!book.paused) book.playbackRate = bookPlaybackRate;
  }, 1800);
  return true;
}

export function playBookChunkBase64(base64String, onChunkFinished, onTimeUpdate) {
  const book = getBookPlayer();
  if (!book || !base64String) return;

  const playbackVersion = ++bookPlaybackVersion;
  book.playbackRate = bookPlaybackRate;
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
    const stream = await acquireMicStream();
    if (epoch !== micEpoch) {
      return false;
    }

    stream.getAudioTracks().forEach((track) => { track.enabled = true; });
    if (!audioContext || audioContext.state === "closed") {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    } else if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
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
  if (mediaStream) {
    mediaStream.getAudioTracks().forEach((track) => { track.enabled = false; });
  }
  await releaseMicResources(false);
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

async function acquireMicStream() {
  if (mediaStream?.getAudioTracks().some((track) => track.readyState === "live")) {
    return mediaStream;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support microphone capture.");
  }
  if (!micStreamPromise) {
    const generation = micCaptureGeneration;
    micStreamPromise = navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        if (generation !== micCaptureGeneration) {
          stream.getTracks().forEach((track) => track.stop());
          throw new Error("Microphone setup was cancelled.");
        }
        mediaStream = stream;
        stream.getAudioTracks().forEach((track) => { track.enabled = false; });
        return stream;
      })
      .finally(() => { micStreamPromise = null; });
  }
  return micStreamPromise;
}

export async function prepareMicCapture() {
  const stream = await acquireMicStream();
  if (!micActive) stream.getAudioTracks().forEach((track) => { track.enabled = false; });
  return true;
}

export async function releaseMicCapture() {
  micCaptureGeneration++;
  micEpoch++;
  micActive = false;
  clearMicTimer();
  await releaseMicResources(true);
  audioChunks = [];
}

async function releaseMicResources(closeStream = true) {
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
  if (closeStream && mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (closeStream && audioContext && audioContext.state !== "closed") {
    const contextToClose = audioContext;
    audioContext = null;
    try { await contextToClose.close(); } catch (_) { /* Context was already closing. */ }
  } else if (closeStream) {
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
