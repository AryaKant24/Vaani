export const store = {
  appInitialized: false,
  isAuthenticated: false,
  isPlayingWelcome: false,
  isReadingBook: false,
  isBookPausedForDoubt: false,
  isRecordingDoubt: false,
  isStartingMicCapture: false,
  isDoubtFlowActive: false,
  isPlayingDoubtAnswer: false,
  isDocumentLoading: false,
  currentParagraphIdx: 0,
  currentSentenceIdx: 0,
  currentBookId: null,
  sentenceAudioCache: new Map(),
  serverData: {
    welcome_script: "",
    pdf_title: "Sample Chapter: Biology & Indian Financial Systems",
    paragraphs: [],
    doubt_history: []
  }
};

export function getCurrentParagraph() {
  const paras = store.serverData.paragraphs || [];
  return paras[store.currentParagraphIdx] || { full_text: "", sentences: [] };
}

export function getCurrentSentenceText() {
  const para = getCurrentParagraph();
  const sentences = para.sentences || [];
  return sentences[store.currentSentenceIdx] || "";
}
