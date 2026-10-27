let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;
let audioChunks = [];
let recordingStartTime = 0;
let timerInterval = null;

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
  const book = getBookPlayer();
  setStreamVisualState("bookStreamBox", false);
  if (!book) return 0;
  book.pause();
  const safeTime = Math.max(0, book.currentTime - rewindSeconds);
  book.currentTime = safeTime;
  return safeTime;
}

export function playBookChunkBase64(base64String, onChunkFinished, onTimeUpdate) {
  const book = getBookPlayer();
  if (!book || !base64String) return;

  setStreamVisualState("bookStreamBox", true);
  book.onended = () => {
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
  const assistant = getAssistantPlayer();
  if (!assistant || !base64String) {
    if (onFinishedCallback) onFinishedCallback();
    return;
  }

  setStreamVisualState("assistantStreamBox", true);
  assistant.onended = () => {
    setStreamVisualState("assistantStreamBox", false);
    if (onFinishedCallback) onFinishedCallback();
  };
  assistant.src = "data:audio/wav;base64," + base64String;
  assistant.play().catch((err) => {
    setStreamVisualState("assistantStreamBox", false);
    console.warn("Assistant audio blocked:", err);
    if (onFinishedCallback) onFinishedCallback();
  });
}

export async function startMicCapture(onTick) {
  stopAssistantAudio();
  playEarcon(440, 880, 0.15);

  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(mediaStream);
  scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

  audioChunks = [];
  scriptProcessor.onaudioprocess = (event) => {
    const channelData = event.inputBuffer.getChannelData(0);
    audioChunks.push(new Float32Array(channelData));
  };

  source.connect(scriptProcessor);
  scriptProcessor.connect(audioContext.destination);

  recordingStartTime = Date.now();
  timerInterval = setInterval(() => {
    const elapsedSec = ((Date.now() - recordingStartTime) / 1000).toFixed(1);
    if (onTick) onTick(elapsedSec);
  }, 100);
}

export async function stopMicCapture() {
  clearInterval(timerInterval);
  playEarcon(880, 440, 0.15);

  const durationMs = Date.now() - recordingStartTime;
  if (scriptProcessor) scriptProcessor.disconnect();
  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
  if (audioContext) await audioContext.close();

  if (durationMs < 600) {
    return null;
  }
  return encodePCM16Wav(audioChunks, 16000);
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