# Vani

Vani is an accessible, voice-first PDF reader and multilingual study tutor.
It reads a text-based PDF sentence by sentence, accepts spoken questions
mid-reading, explains the interrupted passage, and resumes from that sentence.

## Stack

- **Backend:** Python, FastAPI, Uvicorn, Pydantic Settings, `pypdf`
- **Frontend:** HTML, CSS, vanilla JavaScript ES modules, Web Audio API
- **Speech:** Gnani Vachana STT and Timbre TTS
- **Reasoning:** OpenAI-compatible chat-completions API (Groq by default)
- **Storage:** In-memory session state and local TTS cache in
  `assets/audio_cache/`

## Models and providers

| Purpose | Default |
| --- | --- |
| Speech-to-text | Gnani Vachana |
| Text-to-speech | Gnani Timbre `timbre-v2.5` |
| Explanation generation | `openai/gpt-oss-120b` on Groq |

Supported doubt languages are English (`en-IN`), Hindi (`hi-IN`), Marathi
(`mr-IN`), Tamil (`ta-IN`), Telugu (`te-IN`), and Kannada (`kn-IN`).
Available voices are `Nalini` and `Mohan`.

## User flow

1. Start Vani and activate the welcome guide.
2. Upload a text-based PDF with `U`, or use the built-in sample chapter.
3. Listen to sentence-by-sentence reading.
4. Press `Space` to pause and record a doubt; press it again to submit.
5. Vani transcribes the question, explains it in the selected language, speaks
   the answer, and restarts the interrupted sentence.

Shortcuts: `P` pause/resume, `Up`/`Down` change language, `Left`/`Right` change
paragraph, and `U` upload a PDF.

## Technical flow

```text
PDF -> pypdf -> sentence/paragraph chunks -> TTS -> browser playback

Microphone WAV -> Gnani STT -> contextual LLM explanation
               -> Gnani TTS -> browser playback -> resume sentence
```

The API is provided by `backend/main.py`:

- `GET /api/state` — current document and welcome text
- `GET /api/llm-status` — reasoning-provider health check
- `POST /api/tts` — synthesize text as base64 WAV
- `POST /api/upload-pdf` — extract and structure a PDF
- `POST /api/study/doubt` — transcribe, explain, and speak a doubt

Only PDFs with an extractable text layer are supported. Session data is
process-local and is cleared when the server restarts.

## Setup

### Windows PowerShell

```powershell
py -3 -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
python -m uvicorn backend.main:app --reload
```

### macOS/Linux

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m uvicorn backend.main:app --reload
```

Open <http://127.0.0.1:8000>. Allow microphone access when prompted.

## Environment

Copy `.env.example` to `.env` and set:

```dotenv
GNANI_API_KEY=your_gnani_key
GNANI_EVON_URL=https://api.groq.com/openai/v1/chat/completions
GROQ_API_KEY=your_groq_key
LLM_MODEL=openai/gpt-oss-120b
TTS_MODEL=timbre-v2.5
DEFAULT_LANGUAGE=en-IN
DEFAULT_VOICE=Nalini
```

For another OpenAI-compatible provider, use its endpoint and set
`LLM_API_KEY` (or `GEMINI_API_KEY` for a Google Generative Language endpoint).
Never commit `.env` or real API keys.
