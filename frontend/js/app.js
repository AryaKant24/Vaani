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
  registerAccount,
  loginAccount,
  updateProfile,
  logoutAccount
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
let librarySpeechRequest = 0;

window.addEventListener("DOMContentLoaded", async () => {
  bindUIEvents();
  bindKeyboardController();
  void runBootSequence();

  // 2. Load session state and verify LLM connection
  try {
    store.serverData = await fetchSessionState();
    store.isAuthenticated = true;
    document.getElementById("btnProfile").disabled = false;
    document.getElementById("btnLibrary").disabled = false;
    document.getElementById("profileButtonLabel").textContent =
      store.serverData.profile?.display_name || "Profile";
    store.currentBookId = store.serverData.book_id || null;
    store.currentParagraphIdx = store.serverData.current_paragraph_index || 0;
    store.currentSentenceIdx = store.serverData.current_sentence_index || 0;
    renderReaderView(false);
    maybePlayOpeningGuide();

    const llmCheck = await checkLlmConnection();
    if (!llmCheck.connected && !store.isPlayingWelcome) {
      setStatusBadge("Voice assistance is temporarily unavailable. You can continue reading.", "error");
    } else if (llmCheck.connected && !store.isPlayingWelcome) {
      setStatusBadge(`System Ready • LLM Connected (${llmCheck.model})`, "idle");
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
  setupProfileDialog();
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
    setStatusBadge("You are signed out.", "idle");
  });

  const libraryDialog = document.getElementById("libraryDialog");
  libraryDialog?.addEventListener("close", () => {
    librarySpeechRequest++;
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
      status.textContent = err.message;
    }
  });
}

function showAuthDialog() {
  store.isAuthenticated = false;
  const profileButton = document.getElementById("btnProfile");
  if (profileButton) profileButton.disabled = true;
  document.getElementById("btnLibrary").disabled = true;
  const dialog = document.getElementById("authDialog");
  if (dialog && !dialog.open) dialog.showModal();
}

async function loadSignedInReader() {
  store.serverData = await fetchSessionState();
  store.isAuthenticated = true;
  const profileButton = document.getElementById("btnProfile");
  if (profileButton) profileButton.disabled = false;
  document.getElementById("btnLibrary").disabled = false;
  store.currentBookId = store.serverData.book_id || null;
  store.currentParagraphIdx = store.serverData.current_paragraph_index || 0;
  store.currentSentenceIdx = store.serverData.current_sentence_index || 0;
  const label = document.getElementById("profileButtonLabel");
  if (label) label.textContent = store.serverData.profile?.display_name || "Profile";
  renderReaderView(false);
  setStatusBadge("Signed in • Press S to start reading", "idle");
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
      return;
    }
    books.forEach((book) => {
      const item = document.createElement("article");
      item.className = "library-book-item";
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
          meta.textContent = err.message;
        }
      });
      info.append(title, meta);
      item.append(info, button);
      list.appendChild(item);
    });
    list.querySelector(".library-continue-button")?.focus();
  } catch (err) {
    list.textContent = err.message;
  }
}

async function speakLibraryBookTitle(title) {
  const requestId = ++librarySpeechRequest;
  stopAssistantAudio();
  try {
    const audio = await requestTTS(title, "en-IN", getSelectedVoice());
    if (requestId !== librarySpeechRequest || !document.getElementById("libraryDialog")?.open) return;
    playAssistantBase64(audio);
  } catch {
    // Book navigation remains usable if title speech is temporarily unavailable.
  }
}

function bindKeyboardController() {
  window.addEventListener("keydown", async (event) => {
    const libraryDialog = document.getElementById("libraryDialog");
    if (libraryDialog?.open) {
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
      document.getElementById("pdfFileInput")?.click();
    }
  });
}
