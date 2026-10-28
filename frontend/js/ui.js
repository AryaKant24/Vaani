import { store, getCurrentLanguage, getCurrentParagraph } from "./state.js";

export function animateIn(element) {
  if (!element) return;
  element.classList.remove("animate-in");
  // Trigger reflow so the animation replays cleanly
  void element.offsetWidth;
  element.classList.add("animate-in");
}

export function hideWelcomeOverlay() {
  const overlay = document.getElementById("welcomeOverlay");
  if (!overlay || overlay.classList.contains("hidden")) return;

  overlay.classList.add("fading-out");

  const finalizeHide = () => {
    overlay.classList.add("hidden");
    overlay.classList.remove("fading-out");
    document.getElementById("btnInterruptMic")?.focus();
  };

  overlay.addEventListener("transitionend", finalizeHide, { once: true });
  // Fail-safe timeout in case prefers-reduced-motion disables CSS transitions
  setTimeout(finalizeHide, 550);
}

export function setStatusBadge(text, mode = "idle") {
  const badge = document.getElementById("statusBadge");
  if (!badge) return;

  badge.classList.add("fade-flicker");
  setTimeout(() => {
    badge.textContent = text;
    badge.classList.remove(
      "state-idle",
      "state-reading",
      "state-recording",
      "state-error",
      "fade-flicker"
    );

    if (mode === true || mode === "recording") {
      badge.classList.add("state-recording");
    } else if (mode === "reading") {
      badge.classList.add("state-reading");
    } else if (mode === "error") {
      badge.classList.add("state-error");
    } else {
      badge.classList.add("state-idle");
    }
  }, 90);
}

export function updateLanguageDisplay(flashGlow = false) {
  const langObj = getCurrentLanguage();
  const display = document.getElementById("activeLangDisplay");
  const miniBadge = document.getElementById("doubtLangBadge");
  const card = document.getElementById("langIndicatorCard");

  if (display) display.textContent = langObj.label;
  if (miniBadge) miniBadge.textContent = langObj.code;

  if (flashGlow && card) {
    card.classList.add("lang-glow-flash");
    setTimeout(() => card.classList.remove("lang-glow-flash"), 600);
  }
}

export function renderReaderView(pingActiveSentence = true) {
  updateLanguageDisplay(false);

  const paragraphs = store.serverData.paragraphs || [];
  const totalParas = paragraphs.length || 1;
  if (store.currentParagraphIdx >= totalParas) store.currentParagraphIdx = 0;

  const currentPara = getCurrentParagraph();
  const sentences = currentPara.sentences || [];
  const totalSents = sentences.length || 1;
  if (store.currentSentenceIdx >= totalSents) store.currentSentenceIdx = 0;

  const titleEl = document.getElementById("pdfTitleDisplay");
  const pdfTitle = store.serverData.pdf_title || "Uploaded Study Document";
  if (titleEl) {
    titleEl.textContent = pdfTitle;
    titleEl.setAttribute("title", pdfTitle);
  }

  const sourcePage = currentPara.page_number;
  document.getElementById("itemCounter").textContent =
      `Page ${sourcePage || 1} · Paragraph ${store.currentParagraphIdx + 1} of ${totalParas} · Sentence ${store.currentSentenceIdx + 1} of ${totalSents}`;

  const chunkContainer = document.getElementById("activeChunkText");
  chunkContainer.innerHTML = "";
  const wrapper = document.createElement("p");

  sentences.forEach((sentenceText, idx) => {
    const span = document.createElement("span");
    if (idx === store.currentSentenceIdx) {
      span.setAttribute("aria-current", "true");
      span.className = pingActiveSentence
        ? "sentence-span active-sentence sentence-ping"
        : "sentence-span active-sentence";
    } else {
      span.className = "sentence-span";
    }
    span.textContent = sentenceText + " ";
    wrapper.appendChild(span);
  });
  chunkContainer.appendChild(wrapper);

  const pct = Math.round(((store.currentParagraphIdx + 1) / totalParas) * 100);
  const progressBar = document.getElementById("chunkProgressBar");
  progressBar.style.width = `${pct}%`;
  progressBar.parentElement?.setAttribute("aria-valuenow", String(pct));
  progressBar.parentElement?.setAttribute("aria-valuemin", "0");
  progressBar.parentElement?.setAttribute("aria-valuemax", "100");

  const bookCard = document.getElementById("bookCard");
  const posBadge = document.getElementById("readingPositionBadge");
  const playIcon = document.getElementById("playPauseIcon");
  const playText = document.getElementById("playPauseText");

  if (store.isReadingBook) {
    bookCard.classList.add("reading-active");
    bookCard.classList.remove("interrupted-paused");
    posBadge.textContent = `Echoing Sentence ${store.currentSentenceIdx + 1}`;
    if (playIcon) playIcon.textContent = "⏸";
    if (playText) playText.textContent = "Pause Reading (S)";
  } else if (store.isBookPausedForDoubt) {
    bookCard.classList.remove("reading-active");
    bookCard.classList.add("interrupted-paused");
    posBadge.textContent = `Paused • Will Restart Sentence ${store.currentSentenceIdx + 1}`;
    if (playIcon) playIcon.textContent = "▶";
    if (playText) playText.textContent = "Resume Sentence (S)";
  } else {
    bookCard.classList.remove("reading-active", "interrupted-paused");
    posBadge.textContent = "Paused / Ready";
    if (playIcon) playIcon.textContent = "▶";
    if (playText) playText.textContent = "Start Reading (S)";
  }

  const sectionSeek = document.getElementById("sectionSeek");
  const sectionSeekValue = document.getElementById("sectionSeekValue");
  if (sectionSeek) {
    sectionSeek.max = String(Math.max(0, totalParas - 1));
    sectionSeek.value = String(store.currentParagraphIdx);
    sectionSeek.disabled = totalParas < 2;
  }
  if (sectionSeekValue) sectionSeekValue.textContent = String(store.currentParagraphIdx + 1);
}

export function updateBookTimestamp(seconds) {
  const el = document.getElementById("bookTimeDisplay");
  if (el) el.textContent = `${seconds.toFixed(1)}s`;
}

export function setMicButtonState(
  isRecording,
  timerText = "Ask in your language"
) {
  const btn = document.getElementById("btnInterruptMic");
  const stage = btn?.closest(".sonar-stage");
  const label = document.getElementById("micBtnLabel");
  const timer = document.getElementById("micTimer");

  if (isRecording) {
    btn?.classList.add("recording");
    stage?.classList.add("active-sonar");
    if (label) label.textContent = "ASK YOUR DOUBT • PRESS SPACE TO SEND";
    if (timer) timer.textContent = timerText;
  } else {
    btn?.classList.remove("recording");
    stage?.classList.remove("active-sonar");
    if (label) label.textContent = "PRESS SPACE TO INTERRUPT";
    if (timer) timer.textContent = timerText;
  }
}

export function renderDoubtAnswer(data) {
  const rawBox = document.getElementById("rawTranscriptBox");
  const formattedBox = document.getElementById("formattedOutputBox");
  const langBadge = document.getElementById("doubtLangBadge");

  if (rawBox) rawBox.textContent = data.student_question;
  if (formattedBox) formattedBox.textContent = data.explanation;
  if (langBadge) langBadge.textContent = data.language;

  animateIn(document.getElementById("transcriptContainer"));
  animateIn(document.getElementById("answerContainer"));
}
