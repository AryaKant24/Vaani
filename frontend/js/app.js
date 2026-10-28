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
  submitInterruptedDoubt,
  saveReadingProgress,
  fetchLibraryBooks,
  fetchBook,
  deleteBook,
  registerAccount,
  loginAccount,
  updateProfile,
  logoutAccount
} from "./api.js";
import {
  adjustBookPlaybackRate,
  playEarcon,
  playPageTurnSound,
  playBootWaterSound,
  stopAssistantAudio,
  pauseBookStream,
  shuttleBookStream,
  playBookChunkBase64,
  playAssistantBase64,
  startMicCapture,
  stopMicCapture,
  prepareMicCapture,
  releaseMicCapture
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
let librarySpeechRequest = 0;
let pendingLibraryDeletion = null;
const PARAGRAPHS_PER_PAGE_TURN = 3;
const VOICE_PREFERENCE_KEY = "vani.selectedVoice";

window.addEventListener("pagehide", () => {
  void releaseMicCapture();
});

async function playPageTurnIfCrossing(fromParagraph, toParagraph) {
  const fromPage = Math.floor(fromParagraph / PARAGRAPHS_PER_PAGE_TURN);
  const toPage = Math.floor(toParagraph / PARAGRAPHS_PER_PAGE_TURN);
  if (fromPage === toPage) return;
  const played = await playPageTurnSound();
  if (played) await new Promise((resolve) => window.setTimeout(resolve, 620));
}

window.addEventListener("DOMContentLoaded", async () => {
  bindUIEvents();
  syncInteractionControls();
  bindKeyboardController();
  void runBootSequence();

  // 2. Load session state and verify LLM connection
  try {
    store.serverData = await fetchSessionState();
    store.isAuthenticated = true;
    syncInteractionControls();
    document.getElementById("profileButtonLabel").textContent =
      store.serverData.profile?.display_name || "Profile";
    warmMicrophone();
    store.currentBookId = store.serverData.book_id || null;
    store.currentParagraphIdx = store.serverData.current_paragraph_index || 0;
    store.currentSentenceIdx = store.serverData.current_sentence_index || 0;
    renderReaderView(false);
    maybePlayOpeningGuide();

    try {
      const llmCheck = await checkLlmConnection();
      if (!llmCheck.connected && !store.isPlayingWelcome) {
        setStatusBadge("Voice assistance is temporarily unavailable. You can continue reading.", "error");
      } else if (llmCheck.connected && !store.isPlayingWelcome) {
        setStatusBadge(`System Ready • LLM Connected (${llmCheck.model})`, "idle");
      }
    } catch (_) {
      if (!store.isPlayingWelcome) {
        setStatusBadge("Voice assistance is temporarily unavailable. You can continue reading.", "error");
      }
    }
  } catch (err) {
    if (err.status === 401) {
      hideWelcomeOverlay();
      showAuthDialog();
      setStatusBadge("Sign in or create an account to open your library.", "idle");
    } else {
      setStatusBadge("VANI could not connect to the reading service. Please refresh to try again.", "error");
    }
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
  return document.getElementById("voiceSelect")?.value || "Shlok";
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
  if (!store.isAuthenticated) {
    showAuthDialog();
    return;
  }
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
  void saveReadingProgress(store.currentBookId, store.currentParagraphIdx, store.currentSentenceIdx).catch(() => {});

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
          const previousParagraph = store.currentParagraphIdx;
          store.currentParagraphIdx++;
          store.currentSentenceIdx = 0;
          await playPageTurnIfCrossing(previousParagraph, store.currentParagraphIdx);
          if (!store.isReadingBook) return;
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
    if (err.status === 401) {
      store.isAuthenticated = false;
      showAuthDialog();
      setStatusBadge("Your session expired. Please sign in again.", "error");
      return;
    }
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
  const confirmation = `Language changed to ${langObj.spokenName}. Reading is paused. Press S to resume.`;
  setStatusBadge(confirmation, "idle");
  await speakSystemAnnouncement(confirmation);
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
  const requiresAccount = !store.isAuthenticated;
  ["btnToggleRead", "btnPrevChunk", "btnNextChunk", "sectionSeek", "btnUploadPdf", "voiceSelect"]
    .forEach((id) => {
      const control = document.getElementById(id);
      if (control) control.disabled = locked || requiresAccount;
    });
  const micButton = document.getElementById("btnInterruptMic");
  if (micButton) {
    micButton.disabled = requiresAccount || store.isDocumentLoading ||
      (store.isDoubtFlowActive && !store.isRecordingDoubt);
  }
  const profileButton = document.getElementById("btnProfile");
  if (profileButton) profileButton.disabled = requiresAccount || locked;
  const libraryButton = document.getElementById("btnLibrary");
  if (libraryButton) libraryButton.disabled = requiresAccount || locked;
  const bookPlayer = document.getElementById("bookAudioPlayer");
  if (bookPlayer) bookPlayer.controls = !locked && !requiresAccount;
  const assistantPlayer = document.getElementById("assistantAudioPlayer");
  if (assistantPlayer) {
    assistantPlayer.controls = !requiresAccount && !store.isDocumentLoading &&
      (!store.isDoubtFlowActive || store.isPlayingDoubtAnswer);
  }
}

async function handleSpacebarInterruptOrSend() {
  if (!store.appInitialized || store.isDocumentLoading) return;
  if (!store.isAuthenticated) {
    showAuthDialog();
    return;
  }

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
        wavBlob,
        store.currentBookId
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
      if (err.status === 401) {
        store.isAuthenticated = false;
        showAuthDialog();
        setStatusBadge("Your session expired. Please sign in again.", "error");
        return;
      }
      if (err.status === 422) {
        document.getElementById("formattedOutputBox").textContent = err.message;
        setStatusBadge(err.message, "error");
        return;
      }
      setStatusBadge("Voice assistance is temporarily unavailable. You can continue reading.", "error");
    }
    return;
  }

  // Space skips the spoken introduction; reading starts only when the user presses S.
  if (store.isPlayingWelcome) {
    readerPlaybackRequest++;
    store.isPlayingWelcome = false;
    cancelPendingAssistantSpeech();
    store.isReadingBook = false;
    store.isBookPausedForDoubt = false;
    renderReaderView(false);
    setStatusBadge("Introduction skipped • Press S to start reading", "idle");
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
    const micNote = document.getElementById("micReadinessNote");
    if (micNote) micNote.textContent = "Microphone is unavailable. Allow it in your browser's site permissions, then press Space to retry.";
    setStatusBadge("Mic Error: " + err.message, "error");
  }
}

async function handlePdfSelection(event) {
  if (!store.isAuthenticated) {
    showAuthDialog();
    return;
  }
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
    store.currentBookId = data.book_id;
    store.currentParagraphIdx = 0;
    store.currentSentenceIdx = 0;
    void saveReadingProgress(store.currentBookId, 0, 0).catch(() => {});
    store.sentenceAudioCache.clear();
    renderReaderView(true);
    setDocumentLoading(false);

    setStatusBadge(`Added to My Library • Page 1 • Press S to start reading`, "idle");
  } catch (err) {
    setDocumentLoading(false);
    if (err.status === 401) {
      store.isAuthenticated = false;
      showAuthDialog();
      setStatusBadge("Your session expired. Please sign in again.", "error");
      return;
    }
    setStatusBadge("PDF Upload Error: " + err.message, "error");
  }
}

async function navigateParagraph(delta) {
  if (store.isDoubtFlowActive || store.isDocumentLoading) return;
  const paras = store.serverData.paragraphs || [];
  const nextIdx = store.currentParagraphIdx + delta;
  if (nextIdx >= 0 && nextIdx < paras.length) {
    const wasReading = store.isReadingBook;
    const playbackRequest = readerPlaybackRequest;
    const previousParagraph = store.currentParagraphIdx;
    pauseBookStream(0);
    store.currentParagraphIdx = nextIdx;
    store.currentSentenceIdx = 0;
    await playPageTurnIfCrossing(previousParagraph, nextIdx);
    if (wasReading && (readerPlaybackRequest !== playbackRequest || !store.isReadingBook)) return;
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
  const wasReading = store.isReadingBook;
  const playbackRequest = readerPlaybackRequest;
  const previousParagraph = store.currentParagraphIdx;
  pauseBookStream(0);
  cancelPendingAssistantSpeech();
  store.currentParagraphIdx = nextIdx;
  store.currentSentenceIdx = 0;
  await playPageTurnIfCrossing(previousParagraph, nextIdx);
  if (wasReading && (readerPlaybackRequest !== playbackRequest || !store.isReadingBook)) return;
  await startReadingCurrentSentence();
}

function bindUIEvents() {
  setupProfileDialog();
  document.getElementById("btnInterruptMic")?.addEventListener("click", handleSpacebarInterruptOrSend);
  document.getElementById("btnToggleRead")?.addEventListener("click", toggleManualPauseResume);
  document.getElementById("btnPrevChunk")?.addEventListener("click", () => navigateParagraph(-1));
  document.getElementById("btnNextChunk")?.addEventListener("click", () => navigateParagraph(1));
  const voiceSelect = document.getElementById("voiceSelect");
  if (voiceSelect) {
    try {
      const savedVoice = localStorage.getItem(VOICE_PREFERENCE_KEY);
      const savedOption = [...voiceSelect.options].find((option) => option.value === savedVoice);
      if (savedOption) voiceSelect.value = savedOption.value;
      else if (savedVoice?.toLowerCase() === "mohan") voiceSelect.value = "Shlok";
    } catch (_) {
      // The dropdown still works when browser storage is disabled.
    }
  }
  voiceSelect?.addEventListener("change", (event) => {
    try {
      localStorage.setItem(VOICE_PREFERENCE_KEY, event.target.value);
    } catch (_) {
      // The current selection still applies for this page session.
    }
    if (store.isDoubtFlowActive || store.isDocumentLoading) return;
    readerPlaybackRequest++;
    pauseBookStream(0);
    cancelPendingAssistantSpeech();
    store.isReadingBook = false;
    store.isPlayingWelcome = false;
    store.isBookPausedForDoubt = false;
    renderReaderView(false);
    const confirmation = `Voice changed to ${event.target.selectedOptions[0].text}. Reading is paused. Press S to continue.`;
    setStatusBadge(confirmation, "idle");
    void speakSystemAnnouncement(confirmation);
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
  document.getElementById("btnUploadPdf")?.addEventListener("click", () => {
    if (!store.isAuthenticated) {
      showAuthDialog();
      return;
    }
    fileInput?.click();
  });
  fileInput?.addEventListener("change", handlePdfSelection);
}

function setupProfileDialog() {
  const dialog = document.getElementById("profileDialog");
  const nameInput = document.getElementById("profileDisplayName");
  const label = document.getElementById("profileButtonLabel");
  document.getElementById("btnProfile")?.addEventListener("click", () => {
    const profile = store.serverData.profile || {};
    if (nameInput) nameInput.value = profile.display_name || "";
    document.getElementById("profileRegion").value = profile.country_or_region || "";
    document.getElementById("profileBoard").value = profile.education_board || "";
    document.getElementById("profileGrade").value = profile.grade_or_standard || "";
    document.getElementById("profileYear").value = profile.academic_year || "";
    dialog?.showModal();
  });
  document.getElementById("btnSaveProfile")?.addEventListener("click", () => {
    updateProfile({
      display_name: nameInput?.value.trim() || "",
      country_or_region: document.getElementById("profileRegion").value.trim(),
      education_board: document.getElementById("profileBoard").value.trim(),
      grade_or_standard: document.getElementById("profileGrade").value.trim(),
      academic_year: document.getElementById("profileYear").value.trim()
    }).then((profile) => {
      store.serverData.profile = profile;
      if (label) label.textContent = profile.display_name;
      document.getElementById("profileSaveStatus").textContent = "Profile saved to your account.";
    }).catch((err) => {
      document.getElementById("profileSaveStatus").textContent = err.message;
    });
  });
  document.getElementById("btnLogout")?.addEventListener("click", async () => {
    const logoutButton = document.getElementById("btnLogout");
    const status = document.getElementById("profileSaveStatus");
    if (logoutButton) logoutButton.disabled = true;
    readerPlaybackRequest++;
    pauseBookStream(0);
    cancelPendingAssistantSpeech();
    librarySpeechRequest++;
    store.isReadingBook = false;
    store.isPlayingWelcome = false;
    store.isBookPausedForDoubt = false;
    store.isRecordingDoubt = false;
    setDoubtFlowActive(false);
    setMicButtonState(false);
    store.sentenceAudioCache.clear();
    renderReaderView(false);
    try {
      await releaseMicCapture();
      await logoutAccount();
      store.isAuthenticated = false;
      document.getElementById("btnLibrary").disabled = true;
      store.currentBookId = null;
      store.serverData = { welcome_script: "", pdf_title: "Sign in to open your library", paragraphs: [], doubt_history: [] };
      store.currentParagraphIdx = 0;
      store.currentSentenceIdx = 0;
      renderReaderView(false);
      dialog?.close();
      showAuthDialog();
      document.getElementById("micReadinessNote").textContent = "Sign in to prepare the microphone for faster doubts.";
      setStatusBadge("You are signed out.", "idle");
    } catch (err) {
      if (status) status.textContent = `Sign out failed: ${err.message}`;
    } finally {
      if (logoutButton) logoutButton.disabled = false;
    }
  });

  const libraryDialog = document.getElementById("libraryDialog");
  libraryDialog?.addEventListener("close", () => {
    librarySpeechRequest++;
    pendingLibraryDeletion = null;
    const closeButton = document.getElementById("btnCloseLibrary");
    if (closeButton) closeButton.disabled = false;
    const actionStatus = document.getElementById("libraryActionStatus");
    if (actionStatus) actionStatus.textContent = "";
    stopAssistantAudio();
  });
  document.getElementById("btnLibrary")?.addEventListener("click", () => {
    void openLibrary();
  });
  document.getElementById("btnCloseLibrary")?.addEventListener("click", () => libraryDialog?.close());

  let isRegisterMode = false;
  document.getElementById("btnAuthMode")?.addEventListener("click", () => {
    isRegisterMode = !isRegisterMode;
    document.getElementById("authTitle").textContent = isRegisterMode ? "Create your account" : "Sign in to Vani";
    document.getElementById("btnAuthSubmit").textContent = isRegisterMode ? "Create account" : "Sign in";
    document.getElementById("btnAuthMode").textContent = isRegisterMode ? "I already have an account" : "Create an account";
    document.getElementById("authPassword").autocomplete = isRegisterMode ? "new-password" : "current-password";
    document.getElementById("authDisplayName").classList.toggle("hidden", !isRegisterMode);
    document.getElementById("authNameLabel").classList.toggle("hidden", !isRegisterMode);
    document.getElementById("authDisplayName").required = isRegisterMode;
    document.getElementById("btnForgotPassword").classList.toggle("hidden", isRegisterMode);
    document.getElementById("authStatus").textContent = "";
  });
  document.getElementById("authForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = document.getElementById("authStatus");
    const submitButton = document.getElementById("btnAuthSubmit");
    const authDialog = document.getElementById("authDialog");
    if (submitButton) submitButton.disabled = true;
    status.textContent = "Please wait…";
    try {
      if (isRegisterMode) {
        await registerAccount(
          document.getElementById("authEmail").value,
          document.getElementById("authPassword").value,
          document.getElementById("authDisplayName").value
        );
      } else {
        await loginAccount(
          document.getElementById("authEmail").value,
          document.getElementById("authPassword").value
        );
      }
      document.getElementById("authDialog").close();
      await loadSignedInReader();
    } catch (err) {
      if (authDialog && !authDialog.open) showAuthDialog();
      status.textContent = err.message;
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  });
}

function showAuthDialog() {
  readerPlaybackRequest++;
  pauseBookStream(0);
  cancelPendingAssistantSpeech();
  librarySpeechRequest++;
  store.isReadingBook = false;
  store.isPlayingWelcome = false;
  store.isBookPausedForDoubt = false;
  store.isRecordingDoubt = false;
  store.sentenceAudioCache.clear();
  setDoubtFlowActive(false);
  setMicButtonState(false);
  store.currentBookId = null;
  store.currentParagraphIdx = 0;
  store.currentSentenceIdx = 0;
  store.serverData = {
    welcome_script: "",
    pdf_title: "Sign in to open your library",
    paragraphs: [],
    doubt_history: []
  };
  renderReaderView(false);
  void releaseMicCapture().catch(() => {});
  store.isAuthenticated = false;
  syncInteractionControls();
  const dialog = document.getElementById("authDialog");
  if (dialog && !dialog.open) dialog.showModal();
}

async function loadSignedInReader() {
  store.serverData = await fetchSessionState();
  store.isAuthenticated = true;
  syncInteractionControls();
  store.currentBookId = store.serverData.book_id || null;
  store.currentParagraphIdx = store.serverData.current_paragraph_index || 0;
  store.currentSentenceIdx = store.serverData.current_sentence_index || 0;
  const label = document.getElementById("profileButtonLabel");
  if (label) label.textContent = store.serverData.profile?.display_name || "Profile";
  warmMicrophone();
  renderReaderView(false);
  setStatusBadge("Signed in • Press S to start reading", "idle");
  maybePlayOpeningGuide();
}

function warmMicrophone() {
  const note = document.getElementById("micReadinessNote");
  if (note) note.textContent = "Preparing the microphone for faster doubts…";
  prepareMicCapture().then(() => {
    if (note) note.textContent = "Microphone is muted and ready for faster doubts. Your browser may show its microphone-use indicator while you’re signed in.";
  }).catch(() => {
    if (note) note.textContent = "Microphone is not ready yet. Press Space and allow microphone access when prompted.";
  });
}

async function openLibrary() {
  const dialog = document.getElementById("libraryDialog");
  const list = document.getElementById("libraryBookList");
  if (!dialog || !list) return;
  if (store.isReadingBook) {
    readerPlaybackRequest++;
    pauseBookStream(0);
    store.isReadingBook = false;
    void saveReadingProgress(store.currentBookId, store.currentParagraphIdx, store.currentSentenceIdx).catch(() => {});
    renderReaderView(false);
  }
  cancelPendingAssistantSpeech();
  librarySpeechRequest++;
  dialog.showModal();
  list.textContent = "Loading your books…";
  try {
    const books = await fetchLibraryBooks();
    list.replaceChildren();
    if (!books.length) {
      const empty = document.createElement("p");
      empty.className = "library-empty";
      empty.textContent = "Your library is empty. Upload a text-based PDF to add your first book.";
      list.appendChild(empty);
      document.getElementById("libraryActionStatus").textContent = "";
      return;
    }
    books.forEach((book) => {
      const item = document.createElement("article");
      item.className = "library-book-item";
      item.dataset.bookId = book.id;
      const info = document.createElement("div");
      info.className = "library-book-info";
      const title = document.createElement("h3");
      title.className = "library-book-title";
      title.textContent = book.title;
      const meta = document.createElement("p");
      meta.className = "library-book-meta";
      meta.textContent = `Page ${book.page_pointer} of ${book.page_count} · Saved ${new Date(book.updated_at).toLocaleString()}`;
      const button = document.createElement("button");
      button.className = "library-continue-button";
      button.type = "button";
      button.textContent = "Continue reading";
      button.setAttribute("aria-label", `Continue ${book.title} from page ${book.page_pointer}`);
      button.addEventListener("focus", () => {
        item.classList.add("library-book-selected");
        speakLibraryBookTitle(book.title);
      });
      button.addEventListener("blur", () => {
        item.classList.remove("library-book-selected");
      });
      button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "Opening…";
        try {
          const data = await fetchBook(book.id);
          store.serverData.pdf_title = data.pdf_title;
          store.serverData.paragraphs = data.paragraphs;
          store.currentBookId = data.book_id;
          store.currentParagraphIdx = data.current_paragraph_index || 0;
          store.currentSentenceIdx = data.current_sentence_index || 0;
          store.sentenceAudioCache.clear();
          dialog.close();
          renderReaderView(false);
          setStatusBadge(`Resumed ${data.pdf_title} • Page ${data.current_page} • Press S to read`, "idle");
        } catch (err) {
          button.disabled = false;
          button.textContent = "Continue reading";
          if (err.status === 401) {
            dialog.close();
            store.isAuthenticated = false;
            showAuthDialog();
            setStatusBadge("Your session expired. Please sign in again.", "error");
            return;
          }
          meta.textContent = err.message;
        }
      });
      info.append(title, meta);
      item.append(info, button);
      list.appendChild(item);
    });
    list.querySelector(".library-continue-button")?.focus();
  } catch (err) {
    if (err.status === 401) {
      dialog.close();
      store.isAuthenticated = false;
      showAuthDialog();
      setStatusBadge("Your session expired. Please sign in again.", "error");
      return;
    }
    list.textContent = err.message;
  }
}

function selectedLibraryBook(dialog) {
  const focused = document.activeElement?.closest?.(".library-book-item");
  const selected = focused || dialog.querySelector(".library-book-item.library-book-selected")
    || dialog.querySelector(".library-book-item");
  if (!selected?.dataset.bookId) return null;
  return {
    id: selected.dataset.bookId,
    title: selected.querySelector(".library-book-title")?.textContent || "this book",
  };
}

async function speakLibraryMessage(message) {
  const requestId = ++librarySpeechRequest;
  stopAssistantAudio();
  try {
    const audio = await requestTTS(message, "en-IN", getSelectedVoice());
    if (requestId !== librarySpeechRequest || !document.getElementById("libraryDialog")?.open) return;
    playAssistantBase64(audio);
  } catch {
    if (requestId !== librarySpeechRequest || !document.getElementById("libraryDialog")?.open) return;
    if ("speechSynthesis" in window) {
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(message));
    }
  }
}

function cancelLibraryDeletion() {
  if (!pendingLibraryDeletion) return;
  pendingLibraryDeletion = null;
  const closeButton = document.getElementById("btnCloseLibrary");
  if (closeButton) closeButton.disabled = false;
  const status = document.getElementById("libraryActionStatus");
  if (status) status.textContent = "Removal cancelled.";
  void speakLibraryMessage("Removal cancelled.");
}

async function confirmLibraryDeletion() {
  if (!pendingLibraryDeletion || pendingLibraryDeletion.deleting) return;
  const pending = pendingLibraryDeletion;
  pending.deleting = true;
  const status = document.getElementById("libraryActionStatus");
  const closeButton = document.getElementById("btnCloseLibrary");
  if (closeButton) closeButton.disabled = true;
  if (status) status.textContent = `Removing ${pending.title}…`;
  librarySpeechRequest++;
  stopAssistantAudio();
  try {
    await deleteBook(pending.id);
  } catch (err) {
    pendingLibraryDeletion = null;
    if (closeButton) closeButton.disabled = false;
    if (status) status.textContent = `Could not remove ${pending.title}. ${err.message}`;
    void speakLibraryMessage(`Could not remove ${pending.title}. Please try again.`);
    return;
  }

  pendingLibraryDeletion = null;
  if (closeButton) closeButton.disabled = false;
  const item = [...document.querySelectorAll("#libraryDialog .library-book-item")]
    .find((entry) => entry.dataset.bookId === pending.id);
  item?.remove();
  if (store.currentBookId === pending.id) {
    try {
      const data = await fetchSessionState();
      store.serverData = data;
      store.currentBookId = data.book_id || null;
      store.currentParagraphIdx = data.current_paragraph_index || 0;
      store.currentSentenceIdx = data.current_sentence_index || 0;
      store.sentenceAudioCache.clear();
      renderReaderView(false);
    } catch {
      store.currentBookId = null;
      setStatusBadge("The book was removed, but the reader could not refresh. Please reload the page.", "error");
    }
  }
  const list = document.getElementById("libraryBookList");
  if (list && !list.querySelector(".library-book-item")) {
    const empty = document.createElement("p");
    empty.className = "library-empty";
    empty.textContent = "Your library is empty. Upload a text-based PDF to add your first book.";
    list.replaceChildren(empty);
  }
  if (status) status.textContent = `${pending.title} was removed from your library.`;
  list?.querySelector(".library-continue-button")?.focus();
  void speakLibraryMessage(`${pending.title} has been removed from your library.`);
}

async function speakLibraryBookTitle(title) {
  await speakLibraryMessage(title);
}

function bindKeyboardController() {
  window.addEventListener("keydown", async (event) => {
    const libraryDialog = document.getElementById("libraryDialog");
    if (libraryDialog?.open) {
      if (pendingLibraryDeletion) {
        if (event.key === "Escape" && !pendingLibraryDeletion.deleting) {
          event.preventDefault();
          cancelLibraryDeletion();
        } else if (event.key.toLowerCase() === "r" && !event.repeat) {
          event.preventDefault();
          await confirmLibraryDeletion();
        } else {
          event.preventDefault();
        }
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const buttons = [...libraryDialog.querySelectorAll(".library-continue-button:not(:disabled)")];
        if (!buttons.length) return;
        const current = buttons.indexOf(document.activeElement);
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = current < 0
          ? (step > 0 ? 0 : buttons.length - 1)
          : (current + step + buttons.length) % buttons.length;
        buttons[next].focus();
      } else if (event.key === "Enter" && document.activeElement?.classList.contains("library-continue-button")) {
        event.preventDefault();
        document.activeElement.click();
      } else if (event.key.toLowerCase() === "u") {
        event.preventDefault();
        librarySpeechRequest++;
        stopAssistantAudio();
        libraryDialog.close();
        document.getElementById("pdfFileInput")?.click();
      } else if (event.key.toLowerCase() === "r" && !event.repeat) {
        event.preventDefault();
        const book = selectedLibraryBook(libraryDialog);
        const status = document.getElementById("libraryActionStatus");
        if (!book) {
          if (status) status.textContent = "There is no book to remove.";
          void speakLibraryMessage("There is no book to remove.");
          return;
        }
        pendingLibraryDeletion = { ...book, deleting: false };
        const closeButton = document.getElementById("btnCloseLibrary");
        if (closeButton) closeButton.disabled = true;
        if (status) status.textContent = `Press R again to remove ${book.title}, or Escape to cancel.`;
        void speakLibraryMessage(`To remove ${book.title}, press R again. To cancel, press Escape.`);
      }
      return;
    }
    if (document.querySelector("dialog[open]")) return;
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

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const rate = adjustBookPlaybackRate(event.key === "ArrowUp" ? 1 : -1);
      const directionHint = rate >= 1.5
        ? "Maximum speed."
        : rate <= 0.8
          ? "Minimum speed."
          : "Up to speed up, Down to slow down.";
      setStatusBadge(
        `Reading speed ${rate.toFixed(1)} times. ${directionHint}`,
        store.isReadingBook ? "reading" : "idle"
      );
      return;
    }

    if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
      event.preventDefault();
      shuttlePlayback(event.code === "ArrowRight" ? 1 : -1);
      return;
    }

    const key = event.key.toLowerCase();
    if (key === "l") {
      event.preventDefault();
      await openLibrary();
    } else if (key === "a") {
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
      if (!store.isAuthenticated) {
        showAuthDialog();
        return;
      }
      document.getElementById("pdfFileInput")?.click();
    }
  });
}
