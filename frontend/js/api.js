let progressSaveQueue = Promise.resolve();

async function apiJson(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.detail || "Request failed.");
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function fetchSessionState() {
  return apiJson("/api/state");
}

export async function fetchLibraryBooks() {
  return apiJson("/api/books");
}

export async function fetchBook(bookId) {
  return apiJson(`/api/books/${encodeURIComponent(bookId)}`);
}

export async function registerAccount(email, password, displayName) {
  return apiJson("/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, display_name: displayName })
  });
}

export async function loginAccount(email, password) {
  return apiJson("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
}

export async function updateProfile(profile) {
  return apiJson("/api/profile", {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile)
  });
}

export async function logoutAccount() {
  return apiJson("/api/auth/logout", { method: "POST" });
}

export async function checkLlmConnection() {
  const response = await fetch("/api/llm-status");
  return await response.json();
}

export async function requestTTS(text, language = "en-IN", voice = "Nalini") {
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, language, voice })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || "TTS synthesis failed.");
  return data.audio_base64;
}

export async function uploadPdfDocument(file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("/api/upload-pdf", {
    method: "POST",
    body: formData
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || "PDF upload failed.");
  return data;
}

export async function saveReadingProgress(bookId, paragraphIndex, sentenceIndex) {
  if (!bookId) return;
  const save = progressSaveQueue.catch(() => {}).then(async () => {
    const response = await fetch(`/api/books/${encodeURIComponent(bookId)}/progress`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paragraph_index: paragraphIndex, sentence_index: sentenceIndex })
    });
    if (!response.ok) throw new Error("Could not save reading progress.");
    return response.json();
  });
  progressSaveQueue = save;
  return save;
}

export async function submitInterruptedDoubt(
  paragraphIndex,
  sentenceIndex,
  language,
  voice,
  wavBlob,
  bookId
) {
  const formData = new FormData();
  formData.append("paragraph_index", paragraphIndex);
  formData.append("sentence_index", sentenceIndex);
  formData.append("language", language);
  formData.append("voice", voice);
  if (bookId) formData.append("book_id", bookId);
  formData.append("audio", wavBlob, "doubt.wav");

  const response = await fetch("/api/study/doubt", {
    method: "POST",
    body: formData
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || "Doubt resolution failed.");
  return data;
}
