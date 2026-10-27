export async function fetchSessionState() {
  const response = await fetch("/api/state");
  if (!response.ok) throw new Error("Failed to fetch session state.");
  return await response.json();
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

export async function submitInterruptedDoubt(
  paragraphIndex,
  sentenceIndex,
  language,
  voice,
  wavBlob
) {
  const formData = new FormData();
  formData.append("paragraph_index", paragraphIndex);
  formData.append("sentence_index", sentenceIndex);
  formData.append("language", language);
  formData.append("voice", voice);
  formData.append("audio", wavBlob, "doubt.wav");

  const response = await fetch("/api/study/doubt", {
    method: "POST",
    body: formData
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || "Doubt resolution failed.");
  return data;
}