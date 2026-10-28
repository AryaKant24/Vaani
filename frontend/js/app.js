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
  playBootWaterSound,
  stopAssistantAudio,
  pauseBookStream,
  shuttleBookStream,
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

let bootSequenceFinished = false;
let openingGuideStarted = false;
let readerPlaybackRequest = 0;
let assistantSpeechRequest = 0;

window.addEventListener("DOMContentLoaded", async () => {
  bindUIEvents();
  bindKeyboardController();
  void runBootSequence();

  // 2. Load session state and verify LLM connection
  try {
    store.serverData = await fetchSessionState();
    renderReaderView(false);
    maybePlayOpeningGuide();

    const llmCheck = await checkLlmConnection();
    if (!llmCheck.connected && !store.isPlayingWelcome) {
      setStatusBadge("Voice assistance is temporarily unavailable. You can continue reading.", "error");
    } else if (llmCheck.connected && !store.isPlayingWelcome) {
      setStatusBadge(`System Ready • LLM Connected (${llmCheck.model})`, "idle");
    }
  } catch (err) {
    setStatusBadge("VANI could not connect to the reading service. Please refresh to try again.", "error");
  }
});

async function runBootSequence() {
  let soundStarted = await playBootWaterSound();
  if (!soundStarted) {
    const caption = document.getElementById("introCaption");
    const soundButton = document.getElementById("btnStartWithSound");
    if (caption) caption.textContent = "Your browser needs a quick gesture to play sound.";
    soundButton?.classList.remove("hidden");
    soundButton?.focus();
    await waitForSoundGesture(soundButton);
    soundButton?.classList.add("hidden");
    soundStarted = await playBootWaterSound();
    if (caption) {
      caption.textContent = soundStarted
        ? "A moment of calm before you begin"
        : "Opening your reading space.";
    }
  }

  await new Promise((resolve) => window.setTimeout(resolve, 3000));
  store.appInitialized = true;
  store.isPlayingWelcome = true;
  bootSequenceFinished = true;
  hideWelcomeOverlay();
  maybePlayOpeningGuide();
}

function waitForSoundGesture(button) {
  return new Promise((resolve) => {
    const cleanup = () => {
      window.removeEventListener("keydown", onKeyDown);
      button?.removeEventListener("click", onClick);
    };
    const onKeyDown = (event) => {
      if (["Tab", "Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
      event.preventDefault();
      cleanup();
      resolve();
    };
    const onClick = () => {
      cleanup();
      resolve();
    };
    window.addEventListener("keydown", onKeyDown);
    button?.addEventListener("click", onClick);
  });
}

function maybePlayOpeningGuide() {
  if (!bootSequenceFinished || openingGuideStarted || !store.serverData.welcome_script) return;
  openingGuideStarted = true;
  replayWelcomeGuide();
}

function getSelectedVoice() {
  return document.getElementById("voiceSelect")?.value || "Nalini";
}

function cancelPendingAssistantSpeech() {
  assistantSpeechRequest++;
  stopAssistantAudio();
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
  if (store.isDoubtFlowActive) return;
  const playbackRequest = ++readerPlaybackRequest;
  cancelPendingAssistantSpeech();
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

    if (playbackRequest !== readerPlaybackRequest || !store.isReadingBook || store.isDoubtFlowActive) return;

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
    if (playbackRequest !== readerPlaybackRequest) return;
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
  if (store.isDoubtFlowActive || store.isDocumentLoading) return;

  if (store.isReadingBook) {
    readerPlaybackRequest++;
    pauseBookStream(0);
    store.isReadingBook = false;
    renderReaderView(false);
    setStatusBadge(
      `Paused on Sentence ${store.currentSentenceIdx + 1} • Press S to Resume`,
      "idle"
    );
  } else {
    await restartInterruptedSentence();
  }
}

async function speakSystemAnnouncement(text, onComplete = null, isWelcome = false) {
  cancelPendingAssistantSpeech();
  const requestId = assistantSpeechRequest;
  store.isPlayingWelcome = isWelcome;
  if (!text) {
    store.isPlayingWelcome = false;
    if (onComplete) onComplete();
    return;
  }

  try {
    const b64 = await requestTTS(text, "en-IN", getSelectedVoice());
    if (requestId !== assistantSpeechRequest) return;
    if (store.isReadingBook || store.isDoubtFlowActive || store.isDocumentLoading) {
      store.isPlayingWelcome = false;
      return;
    }
    playAssistantBase64(b64, () => {
      if (requestId !== assistantSpeechRequest) return;
      store.isPlayingWelcome = false;
      if (onComplete) onComplete();
    });
  } catch (err) {
    if (requestId !== assistantSpeechRequest) return;
    store.isPlayingWelcome = false;
    if (onComplete) onComplete();
  }
}

async function replayWelcomeGuide() {
  if (!store.appInitialized || store.isDoubtFlowActive || store.isDocumentLoading) return;
  readerPlaybackRequest++;
  pauseBookStream(0);
  cancelPendingAssistantSpeech();
  store.isReadingBook = false;
  store.isBookPausedForDoubt = false;
  store.isPlayingWelcome = true;
  renderReaderView(false);
  setStatusBadge("Playing Welcome Guide • Press Space to Skip to Book", "reading");
  await speakSystemAnnouncement(store.serverData.welcome_script, () => {
    setStatusBadge("Guide finished • Reading paused; press S to start", "idle");
  }, true);
}

async function cycleLanguage(direction) {
  if (store.isDoubtFlowActive || store.isDocumentLoading) return;
  readerPlaybackRequest++;
  pauseBookStream(0);
  cancelPendingAssistantSpeech();
  store.isReadingBook = false;
  store.isPlayingWelcome = false;
  store.isBookPausedForDoubt = false;

  store.currentLangIdx =
    (store.currentLangIdx + direction + LANGUAGES.length) % LANGUAGES.length;
  updateLanguageDisplay(true);
  playEarcon(500, 720, 0.1);

  const langObj = getCurrentLanguage();
  renderReaderView(false);
  setStatusBadge(`Language set to ${langObj.spokenName} • Paused; press S to read`, "idle");
}

function setDoubtFlowActive(active) {
  store.isDoubtFlowActive = active;
  if (!active) {
    store.isStartingMicCapture = false;
    store.isPlayingDoubtAnswer = false;
  }
  syncInteractionControls();
}

function setDocumentLoading(loading) {
  store.isDocumentLoading = loading;
  syncInteractionControls();
}

function syncInteractionControls() {
  const locked = store.isDoubtFlowActive || store.isDocumentLoading;
  ["btnToggleRead", "btnPrevChunk", "btnNextChunk", "sectionSeek", "btnUploadPdf", "voiceSelect"]
    .forEach((id) => {
      const control = document.getElementById(id);
      if (control) control.disabled = locked;
    });
  const micButton = document.getElementById("btnInterruptMic");
  if (micButton) {
    micButton.disabled = store.isDocumentLoading || (store.isDoubtFlowActive && !store.isRecordingDoubt);
  }
  const bookPlayer = document.getElementById("bookAudioPlayer");
  if (bookPlayer) bookPlayer.controls = !locked;
  const assistantPlayer = document.getElementById("assistantAudioPlayer");
  if (assistantPlayer) {
    assistantPlayer.controls = !store.isDocumentLoading &&
      (!store.isDoubtFlowActive || store.isPlayingDoubtAnswer);
  }
}

async function handleSpacebarInterruptOrSend() {
  if (!store.appInitialized || store.isDocumentLoading) return;

  if (store.isDoubtFlowActive) {
    // Ignore extra presses while permission, submission, or answer playback is in progress.
    if (!store.isRecordingDoubt || store.isStartingMicCapture) return;

    store.isRecordingDoubt = false;
    setMicButtonState(false);
    setDoubtFlowActive(true);

    const wavBlob = await stopMicCapture();
    if (!wavBlob) {
      setDoubtFlowActive(false);
      setStatusBadge("Recording too short (<0.6s) • Restarting sentence...", "idle");
      await restartInterruptedSentence();
      return;
    }

    const langObj = getCurrentLanguage();
    const voice = getSelectedVoice();
    setStatusBadge(`Reasoning & Translating Answer into ${langObj.spokenName}...`, "recording");

    try {
      const result = await submitInterruptedDoubt(
        store.currentParagraphIdx,
        store.currentSentenceIdx,
        langObj.code,
        voice,
        wavBlob
      );
      if (!store.isDoubtFlowActive) return;
      renderDoubtAnswer(result);
      setStatusBadge(
        `Speaking Explanation in ${langObj.spokenName} • Will Restart Sentence ${store.currentSentenceIdx + 1}`,
        "reading"
      );

      store.isPlayingDoubtAnswer = true;
      syncInteractionControls();
      playAssistantBase64(result.audio_base64, async () => {
        if (!store.isDoubtFlowActive) return;
        playEarcon(600, 450, 0.12);
        setDoubtFlowActive(false);
        await restartInterruptedSentence();
      });
    } catch (err) {
      setDoubtFlowActive(false);
      document.getElementById("formattedOutputBox").textContent =
        "Voice assistance is temporarily unavailable. You can continue reading and try again later.";
      setStatusBadge("Voice assistance is temporarily unavailable. You can continue reading.", "error");
    }
    return;
  }

  // 1. If Welcome Guide is playing, Spacebar skips it and begins reading the book
  if (store.isPlayingWelcome) {
    readerPlaybackRequest++;
    store.isPlayingWelcome = false;
    cancelPendingAssistantSpeech();
    playEarcon(520, 780, 0.12);
    await startReadingCurrentSentence();
    return;
  }

  // 2. Interrupt reading and begin a single, exclusive doubt flow.
  readerPlaybackRequest++;
  cancelPendingAssistantSpeech();
  pauseBookStream(0);
  store.isReadingBook = false;
  store.isBookPausedForDoubt = true;
  store.isRecordingDoubt = true;
  store.isStartingMicCapture = true;
  setDoubtFlowActive(true);
  renderReaderView(false);

  const langObj = getCurrentLanguage();
  setMicButtonState(true, `Listening in ${langObj.spokenName} • Press Space to Send`);
  setStatusBadge(
    `Interrupted Sentence ${store.currentSentenceIdx + 1} • Speak Doubt in ${langObj.spokenName}`,
    "recording"
  );
  try {
    const started = await startMicCapture((elapsedSec) => {
      if (!store.isRecordingDoubt || !store.isDoubtFlowActive) return;
      const timerEl = document.getElementById("micTimer");
      if (timerEl) {
        timerEl.textContent = `Recording (${langObj.code}): ${elapsedSec}s • Press Space to Send`;
      }
    });
    store.isStartingMicCapture = false;
    if (!started) {
      store.isRecordingDoubt = false;
      setMicButtonState(false);
      setDoubtFlowActive(false);
      setStatusBadge("Microphone capture did not start. Press S to continue reading.", "error");
    }
  } catch (err) {
    store.isStartingMicCapture = false;
    store.isRecordingDoubt = false;
    await stopMicCapture();
    setMicButtonState(false);
    setDoubtFlowActive(false);
    setStatusBadge("Mic Error: " + err.message, "error");
  }
}

async function handlePdfSelection(event) {
  if (store.isDoubtFlowActive || store.isDocumentLoading) return;
  const file = event.target.files?.[0];
  if (!file) return;

  readerPlaybackRequest++;
  pauseBookStream(0);
  cancelPendingAssistantSpeech();
  store.isReadingBook = false;
  store.isPlayingWelcome = false;
  setDocumentLoading(true);
  setStatusBadge(`Uploading & Parsing "${file.name}"...`, "recording");

  try {
    const data = await uploadPdfDocument(file);
    store.serverData.pdf_title = data.pdf_title;
    store.serverData.paragraphs = data.paragraphs;
    store.currentParagraphIdx = 0;
    store.currentSentenceIdx = 0;
    store.sentenceAudioCache.clear();
    renderReaderView(true);
    setDocumentLoading(false);

    setStatusBadge(`Loaded ${data.count} paragraphs • Starting reading...`, "reading");
    await speakSystemAnnouncement(
      `Loaded ${data.pdf_title}. Starting from paragraph 1, sentence 1.`,
      async () => {
        await startReadingCurrentSentence();
      }
    );
  } catch (err) {
    setDocumentLoading(false);
    setStatusBadge("PDF Upload Error: " + err.message, "error");
  }
}

async function navigateParagraph(delta) {
  if (store.isDoubtFlowActive || store.isDocumentLoading) return;
  const paras = store.serverData.paragraphs || [];
  const nextIdx = store.currentParagraphIdx + delta;
  if (nextIdx >= 0 && nextIdx < paras.length) {
    pauseBookStream(0);
    store.currentParagraphIdx = nextIdx;
    store.currentSentenceIdx = 0;
    await startReadingCurrentSentence();
  }
}

function shuttlePlayback(direction) {
  if (!store.isReadingBook) return;
  if (shuttleBookStream(direction, 10)) {
    setStatusBadge(
      direction > 0 ? "Forward 10 seconds • Playing at 2× briefly" : "Back 10 seconds • Playing at 2× briefly",
      "reading"
    );
  }
}

async function seekParagraph(index) {
  if (store.isDoubtFlowActive || store.isDocumentLoading) return;
  const paras = store.serverData.paragraphs || [];
  if (!paras.length) return;
  const nextIdx = Math.max(0, Math.min(paras.length - 1, Number(index)));
  pauseBookStream(0);
  cancelPendingAssistantSpeech();
  store.currentParagraphIdx = nextIdx;
  store.currentSentenceIdx = 0;
  await startReadingCurrentSentence();
}

function bindUIEvents() {
  document.getElementById("btnInterruptMic")?.addEventListener("click", handleSpacebarInterruptOrSend);
  document.getElementById("btnToggleRead")?.addEventListener("click", toggleManualPauseResume);
  document.getElementById("btnPrevChunk")?.addEventListener("click", () => navigateParagraph(-1));
  document.getElementById("btnNextChunk")?.addEventListener("click", () => navigateParagraph(1));
  document.getElementById("voiceSelect")?.addEventListener("change", (event) => {
    if (store.isDoubtFlowActive || store.isDocumentLoading) return;
    readerPlaybackRequest++;
    pauseBookStream(0);
    cancelPendingAssistantSpeech();
    store.isReadingBook = false;
    store.isPlayingWelcome = false;
    store.isBookPausedForDoubt = false;
    renderReaderView(false);
    setStatusBadge(`Voice set to ${event.target.selectedOptions[0].text} • Paused; press S to read`, "idle");
  });
  document.getElementById("sectionSeek")?.addEventListener("change", (event) => {
    seekParagraph(event.target.value);
  });

  document.getElementById("bookAudioPlayer")?.addEventListener("play", (event) => {
    if (store.isDoubtFlowActive || store.isDocumentLoading) {
      event.currentTarget.pause();
      return;
    }
    const assistant = document.getElementById("assistantAudioPlayer");
    if (assistant && !assistant.paused) cancelPendingAssistantSpeech();
    store.isPlayingWelcome = false;
    store.isReadingBook = true;
    renderReaderView(false);
  });
  document.getElementById("assistantAudioPlayer")?.addEventListener("play", () => {
    if (!store.isReadingBook) return;
    readerPlaybackRequest++;
    pauseBookStream(0);
    store.isReadingBook = false;
    renderReaderView(false);
  });

  const fileInput = document.getElementById("pdfFileInput");
  document.getElementById("btnUploadPdf")?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", handlePdfSelection);
}

function bindKeyboardController() {
  window.addEventListener("keydown", async (event) => {
    const activeTag = document.activeElement?.tagName?.toLowerCase();
    if (activeTag === "select" || activeTag === "input" || activeTag === "textarea" || document.activeElement?.isContentEditable) return;

    if (!store.appInitialized) {
      return;
    }

    if (event.repeat) return;

    if (event.code === "Space") {
      event.preventDefault();
      await handleSpacebarInterruptOrSend();
      return;
    }

    if (store.isDoubtFlowActive || store.isDocumentLoading) return;

    if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
      event.preventDefault();
      shuttlePlayback(event.code === "ArrowRight" ? 1 : -1);
      return;
    }

    const key = event.key.toLowerCase();
    if (key === "a") {
      event.preventDefault();
      await navigateParagraph(-1);
    } else if (key === "d") {
      event.preventDefault();
      await navigateParagraph(1);
    } else if (key === "s") {
      event.preventDefault();
      await toggleManualPauseResume();
    } else if (key === "f") {
      event.preventDefault();
      await cycleLanguage(1);
    } else if (key === "h") {
      event.preventDefault();
      await replayWelcomeGuide();
    } else if (key === "u") {
      event.preventDefault();
      document.getElementById("pdfFileInput")?.click();
    }
  });
}
