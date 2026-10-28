export const LANGUAGES = [
  { code: "en-IN", label: "English / Hinglish (en-IN)", spokenName: "Indian English" },
  { code: "hi-IN", label: "Hindi (hi-IN)", spokenName: "Hindi" },
  { code: "mr-IN", label: "Marathi (mr-IN)", spokenName: "Marathi" },
  { code: "ta-IN", label: "Tamil (ta-IN)", spokenName: "Tamil" },
  { code: "te-IN", label: "Telugu (te-IN)", spokenName: "Telugu" },
  { code: "kn-IN", label: "Kannada (kn-IN)", spokenName: "Kannada" }
];

export const store = {
  appInitialized: false,
  isPlayingWelcome: false,
  isReadingBook: false,
  isBookPausedForDoubt: false,
  isRecordingDoubt: false,
  isStartingMicCapture: false,
  isDoubtFlowActive: false,
  isPlayingDoubtAnswer: false,
  isDocumentLoading: false,
  currentLangIdx: 0,
  currentParagraphIdx: 0,
  currentSentenceIdx: 0,
  sentenceAudioCache: new Map(),
  serverData: {
    welcome_script: "",
    pdf_title: "Sample Chapter: Biology & Indian Financial Systems",
    paragraphs: [],
    doubt_history: []
  }
};

export function getCurrentLanguage() {
  return LANGUAGES[store.currentLangIdx];
}

export function getCurrentParagraph() {
  const paras = store.serverData.paragraphs || [];
  return paras[store.currentParagraphIdx] || { full_text: "", sentences: [] };
}

export function getCurrentSentenceText() {
  const para = getCurrentParagraph();
  const sentences = para.sentences || [];
  return sentences[store.currentSentenceIdx] || "";
}
