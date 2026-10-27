import {
  LANGUAGES,
  store,
  getCurrentLanguage,
  getCurrentParagraph
} from "./state.js";
import {
  fetchSessionState,
  checkLlmConnection,
  requestTTS,
  uploadPdfDocument,
  submitInterruptedDoubt
} from "./api.js";
import {
  playEarcon,
  stopAssistantAudio,
  pauseBookStream,
  playBookChunkBase64,
  playAssistantBase64,
  startMicCapture,
  stopMicCapture
} from "./audio.js";
import {
  hideWelcomeOverlay,
  setStatusBadge,
  updateLanguageDisplay,
  renderReaderView,
  updateBookTimestamp,
  setMicButtonState,
  renderDoubtAnswer
} from "./ui.js";

window.addEventListener("DOMContentLoaded", async () => {
  // 1. Bind UI and Keyboard events FIRST so the Welcome Overlay always closes on click/space
  bindUIEvents();
  bindKeyboardController();

  // 2. Load session state and verify LLM connection
  try {
    store.serverData = await fetchSessionState();
    renderReaderView(false);

    const llmCheck = await checkLlmConnection();
    if (!llmCheck.connected) {
      setStatusBadge("Voice assistance is temporarily unavailable. You can continue reading.", "error");
    } else {
      setStatusBadge(`System Ready • LLM Connected (${llmCheck.model})`, "idle");
    }
  } catch (err) {
    setStatusBadge("VANI could not connect to the reading service. Please refresh to try again.", "error");
  }
});

function getSelectedVoice() {
  return document.getElementById("voiceSelect")?.value || "Nalini";
}

async function getOrFetchSentenceAudio(paraIdx, sentIdx) {
  const paras = store.serverData.paragraphs || [];
  if (paraIdx < 0 || paraIdx >= paras.length) return null;
  const sentences = paras[paraIdx].sentences || [];
  if (sentIdx < 0 || sentIdx >= sentences.length) return null;

  const voice = getSelectedVoice();
  const cacheKey = `${paraIdx}_${sentIdx}_${voice}`;
  if (store.sentenceAudioCache.has(cacheKey)) {
    return store.sentenceAudioCache.get(cacheKey);
  }

  const b64 = await requestTTS(sentences[sentIdx], "en-IN", voice);
  store.sentenceAudioCache.set(cacheKey, b64);
  return b64;
}

function prefetchNextSentence(paraIdx, sentIdx) {
  const paras = store.serverData.paragraphs || [];
  if (!paras.length) return;
  const currentSents = paras[paraIdx]?.sentences || [];

  if (sentIdx + 1 < currentSents.length) {
    getOrFetchSentenceAudio(paraIdx, sentIdx + 1).catch(() => {});
  } else if (paraIdx + 1 < paras.length) {
    getOrFetchSentenceAudio(paraIdx + 1, 0).catch(() => {});
  }
}

async function startReadingCurrentSentence() {
  stopAssistantAudio();
  store.isPlayingWelcome = false;
  store.isBookPausedForDoubt = false;
  store.isReadingBook = true;
  renderReaderView(true);

  const paras = store.serverData.paragraphs || [];
  if (!paras.length) return;

  const para = getCurrentParagraph();
  const sentences = para.sentences || [];
  if (!sentences.length) return;

  setStatusBadge(
    `Reading Paragraph ${store.currentParagraphIdx + 1}, Sentence ${store.currentSentenceIdx + 1} of ${sentences.length}`,
    "reading"
  );

  try {
    const b64 = await getOrFetchSentenceAudio(
      store.currentParagraphIdx,
      store.currentSentenceIdx
    );

    prefetchNextSentence(store.currentParagraphIdx, store.currentSentenceIdx);

    playBookChunkBase64(
      b64,
      async () => {
        if (!store.isReadingBook) return;

        if (store.currentSentenceIdx < sentences.length - 1) {
          store.currentSentenceIdx++;
          await startReadingCurrentSentence();
        } else if (store.currentParagraphIdx < paras.length - 1) {
          store.currentParagraphIdx++;
          store.currentSentenceIdx = 0;
          await startReadingCurrentSentence();
        } else {
          store.isReadingBook = false;
          renderReaderView(false);
          setStatusBadge("Finished reading the entire document!", "idle");
          speakSystemAnnouncement("Finished reading the document.");
        }
      },
      (currentTime) => updateBookTimestamp(currentTime)
    );
  } catch (err) {
    store.isReadingBook = false;
    renderReaderView(false);
    setStatusBadge("Book TTS Error: " + err.message, "error");
  }
}

async function restartInterruptedSentence() {
  setStatusBadge(
    `Restarting Sentence ${store.currentSentenceIdx + 1}...`,
    "reading"
  );
  await startReadingCurrentSentence();
}

async function toggleManualPauseResume() {
  if (store.isRecordingDoubt) return;

  if (store.isReadingBook) {
    pauseBookStream(0);
    store.isReadingBook = false;
    renderReaderView(false);
    setStatusBadge(
      `Paused on Sentence ${store.currentSentenceIdx + 1} • Press P to Resume`,
      "idle"
    );
  } else {
    await restartInterruptedSentence();
  }
}

async function speakSystemAnnouncement(text, onComplete = null, isWelcome = false) {
  store.isPlayingWelcome = isWelcome;
  if (!text) {
    store.isPlayingWelcome = false;
    if (onComplete) onComplete();
    return;
  }

  try {
    const b64 = await requestTTS(text, "en-IN", getSelectedVoice());
    playAssistantBase64(b64, () => {
      store.isPlayingWelcome = false;
      if (onComplete) onComplete();
    });
  } catch (err) {
    store.isPlayingWelcome = false;
    if (onComplete) onComplete();
  }
}

async function initializeAppAndStart() {
  if (store.appInitialized) return;
  store.appInitialized = true;
  hideWelcomeOverlay();
  playEarcon(440, 660, 0.14);

  setStatusBadge("Playing Welcome Guide • Press Spacebar to Skip to Book", "reading");
  await speakSystemAnnouncement(
    store.serverData.welcome_script,
    async () => {
      await startReadingCurrentSentence();
    },
    true
  );
}

async function cycleLanguage(direction) {
  const wasReading = store.isReadingBook;
  if (wasReading) {
    pauseBookStream(0);
    store.isReadingBook = false;
  }

  store.currentLangIdx =
    (store.currentLangIdx + direction + LANGUAGES.length) % LANGUAGES.length;
  updateLanguageDisplay(true);
  playEarcon(500, 720, 0.1);

  const langObj = getCurrentLanguage();
  setStatusBadge(`Doubt Language Set: ${langObj.spokenName}`, "idle");

  await speakSystemAnnouncement(`Language set to ${langObj.spokenName}.`, async () => {
    if (wasReading) {
      await restartInterruptedSentence();
    }
  });
}

async function handleSpacebarInterruptOrSend() {
  if (!store.appInitialized) {
    await initializeAppAndStart();
    return;
  }

  // 1. If Welcome Guide is playing, Spacebar skips it and begins reading the book
  if (store.isPlayingWelcome) {
    store.isPlayingWelcome = false;
    stopAssistantAudio();
    playEarcon(520, 780, 0.12);
    await startReadingCurrentSentence();
    return;
  }

  // 2. Interrupt current sentence and start recording doubt
  if (!store.isRecordingDoubt) {
    pauseBookStream(0);
    store.isReadingBook = false;
    store.isBookPausedForDoubt = true;
    store.isRecordingDoubt = true;
    renderReaderView(false);

    const langObj = getCurrentLanguage();
    setMicButtonState(true, `Listening in ${langObj.spokenName} • Press Space to Send`);
    setStatusBadge(
      `Interrupted Sentence ${store.currentSentenceIdx + 1} • Speak Doubt in ${langObj.spokenName}`,
      "recording"
    );

    try {
      await startMicCapture((elapsedSec) => {
        const timerEl = document.getElementById("micTimer");
        if (timerEl) {
          timerEl.textContent = `Recording (${langObj.code}): ${elapsedSec}s • Press Space to Send`;
        }
      });
    } catch (err) {
      store.isRecordingDoubt = false;
      setMicButtonState(false);
      setStatusBadge("Mic Error: " + err.message, "error");
    }
    return;
  }

  // 3. Stop recording, send doubt, play answer in target language, then restart interrupted sentence
  store.isRecordingDoubt = false;
  setMicButtonState(false);

  const wavBlob = await stopMicCapture();
  if (!wavBlob) {
    setStatusBadge("Recording too short (<0.6s) • Restarting sentence...", "idle");
    await restartInterruptedSentence();
    return;
  }

  const langObj = getCurrentLanguage();
  const voice = getSelectedVoice();

  setStatusBadge(
    `Reasoning & Translating Answer into ${langObj.spokenName}...`,
    "recording"
  );

  try {
    const result = await submitInterruptedDoubt(
      store.currentParagraphIdx,
      store.currentSentenceIdx,
      langObj.code,
      voice,
      wavBlob
    );
    renderDoubtAnswer(result);

    setStatusBadge(
      `Speaking Explanation in ${langObj.spokenName} • Will Restart Sentence ${store.currentSentenceIdx + 1}`,
      "reading"
    );

    playAssistantBase64(result.audio_base64, async () => {
      playEarcon(600, 450, 0.12);
      await restartInterruptedSentence();
    });
  } catch (err) {
    document.getElementById("formattedOutputBox").textContent = "Voice assistance is temporarily unavailable. You can continue reading and try again later.";
    setStatusBadge("Voice assistance is temporarily unavailable. You can continue reading.", "error");
  }
}

async function handlePdfSelection(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  pauseBookStream(0);
  stopAssistantAudio();
  store.isReadingBook = false;
  setStatusBadge(`Uploading & Parsing "${file.name}"...`, "recording");

  try {
    const data = await uploadPdfDocument(file);
    store.serverData.pdf_title = data.pdf_title;
    store.serverData.paragraphs = data.paragraphs;
    store.currentParagraphIdx = 0;
    store.currentSentenceIdx = 0;
    store.sentenceAudioCache.clear();
    renderReaderView(true);

    setStatusBadge(`Loaded ${data.count} paragraphs • Starting reading...`, "reading");
    await speakSystemAnnouncement(
      `Loaded ${data.pdf_title}. Starting from paragraph 1, sentence 1.`,
      async () => {
        await startReadingCurrentSentence();
      }
    );
  } catch (err) {
    setStatusBadge("PDF Upload Error: " + err.message, "error");
  }
}

async function navigateParagraph(delta) {
  const paras = store.serverData.paragraphs || [];
  const nextIdx = store.currentParagraphIdx + delta;
  if (nextIdx >= 0 && nextIdx < paras.length) {
    pauseBookStream(0);
    store.currentParagraphIdx = nextIdx;
    store.currentSentenceIdx = 0;
    await startReadingCurrentSentence();
  }
}

function bindUIEvents() {
  document.getElementById("welcomeOverlay")?.addEventListener("click", initializeAppAndStart);
  document.getElementById("btnWelcomeStart")?.addEventListener("click", (e) => {
    e.stopPropagation();
    initializeAppAndStart();
  });
  document.getElementById("btnInterruptMic")?.addEventListener("click", handleSpacebarInterruptOrSend);
  document.getElementById("btnToggleRead")?.addEventListener("click", toggleManualPauseResume);
  document.getElementById("btnPrevChunk")?.addEventListener("click", () => navigateParagraph(-1));
  document.getElementById("btnNextChunk")?.addEventListener("click", () => navigateParagraph(1));

  const fileInput = document.getElementById("pdfFileInput");
  document.getElementById("btnUploadPdf")?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", handlePdfSelection);
}

function bindKeyboardController() {
  window.addEventListener("keydown", async (event) => {
    const activeTag = document.activeElement?.tagName?.toLowerCase();
    if (activeTag === "select" || activeTag === "input" || activeTag === "textarea" || document.activeElement?.isContentEditable) return;

    if (!store.appInitialized) {
      if (event.code !== "Space" && event.key !== "Enter") return;
      event.preventDefault();
      await initializeAppAndStart();
      return;
    }

    if (event.code === "Space") {
      event.preventDefault();
      await handleSpacebarInterruptOrSend();
      return;
    }

    if (store.isRecordingDoubt) return;

    switch (event.code) {
      case "ArrowDown":
        event.preventDefault();
        await cycleLanguage(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        await cycleLanguage(-1);
        break;
      case "ArrowRight":
        event.preventDefault();
        await navigateParagraph(1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        await navigateParagraph(-1);
        break;
      default:
        break;
    }

    const key = event.key.toLowerCase();
    if (key === "p") {
      event.preventDefault();
      await toggleManualPauseResume();
    } else if (key === "u") {
      event.preventDefault();
      document.getElementById("pdfFileInput")?.click();
    }
  });
}
