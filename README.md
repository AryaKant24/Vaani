# Vani

Vani is an accessible, voice-first PDF reader and multilingual study tutor.
It reads a text-based PDF sentence by sentence, accepts spoken questions
mid-reading, explains the interrupted passage, and resumes from that sentence.

## Stack

- **Backend:** Python, FastAPI, Uvicorn, Pydantic Settings, `pypdf`
- **Frontend:** HTML, CSS, vanilla JavaScript ES modules, Web Audio API
- **Speech:** Gnani Vachana STT and Timbre TTS
- **Reasoning:** OpenAI-compatible chat-completions API (Groq by default)
- **Storage:** PostgreSQL book library and reading progress; local TTS cache in
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

1. Let the three-second ripple splash play, then listen to Vani’s spoken introduction.
2. Sign in or create an account; your books and reading progress belong to that account.
3. Upload a text-based PDF with `U`, or open **My Library** to continue a saved book.
4. Press `S` to start sentence-by-sentence reading.
5. Press `Space` to pause and record a doubt; press it again to submit.
6. Vani transcribes the question, explains it in the selected language, speaks
   the answer, and restarts the interrupted sentence.

Vani opens with a short three-second water sound and ripple animation, then plays
the spoken introduction. Skipping the introduction leaves reading paused; press `S` to start. Shortcuts: `A`/`D`
move to the previous or next paragraph, `S` pause/resume, `F` cycle the doubt
language, `H` replay the spoken guide, `L` open My Library, and `U` upload a PDF. In
the library, use `↑`/`↓` to cycle through books; Vani speaks the focused title,
`Enter` opens that book, and `U` starts an upload. Changing the language
leaves reading paused; press `S` when you are ready to continue. Use the paragraph
slider to jump directly to a paragraph. `←`/`→` jump back or forward 10 seconds
and briefly play at 2×. `Space` pauses reading to ask or send a doubt.

## Technical flow

```text
PDF -> pypdf -> sentence/paragraph chunks -> TTS -> browser playback

Microphone WAV -> Gnani STT -> contextual LLM explanation
               -> Gnani TTS -> browser playback -> resume sentence
```

The API is provided by `backend/main.py`:

- `GET /api/state` — current reader's last book, saved position, and welcome text
- `GET /api/llm-status` — reasoning-provider health check
- `POST /api/tts` — synthesize text as base64 WAV
- `POST /api/upload-pdf` — extract and structure a PDF
- `GET /api/books` — list the signed-in account's library and saved positions
- `GET /api/books/{book_id}` — load an owned book and its saved page/sentence
- `POST /api/study/doubt` — transcribe, explain, and speak a doubt
- `PUT /api/books/{book_id}/progress` — save page, paragraph, and sentence position
- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout` — account access
- `GET /api/auth/me`, `GET/PATCH /api/profile` — signed-in account and student profile

Only PDFs with an extractable text layer are supported. Uploaded books and
their extracted paragraphs are stored in PostgreSQL. Reading progress is stored per
book and signed-in account, including the original one-based PDF page number.
Passwords are stored as Argon2 hashes, and each account receives a profile
record with display name, region, education board, grade, academic year, and
reading preferences.

## Setup

### Windows PowerShell

1. Install PostgreSQL using the official [Windows installer](https://www.postgresql.org/download/windows/). Keep port `5432`, install pgAdmin, and remember the password you set for the `postgres` administrator.
2. Open **SQL Shell (psql)** from the Start menu. Accept the defaults for server (`localhost`), database (`postgres`), port (`5432`), and username (`postgres`), then enter the administrator password.
3. Create an app role and database by running these SQL statements in psql. Replace the example with a strong local password:

```sql
CREATE ROLE vani_app WITH LOGIN PASSWORD 'choose_a_password';
CREATE DATABASE vani OWNER vani_app;
```

4. After copying `.env.example`, edit `.env` and set `DATABASE_URL` to `postgresql://vani_app:choose_a_password@127.0.0.1:5432/vani`. URL-encode special characters in the password, if any. Set `SESSION_SECRET` to the output of `python -c "import secrets; print(secrets.token_urlsafe(32))"`.

```powershell
py -3 -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
if (!(Test-Path .env)) { Copy-Item .env.example .env }
python -m uvicorn backend.main:app --reload
```

The first server start creates Vani's tables. Existing prototype books are not
automatically assigned to an account; create an account and upload PDFs again.

### macOS/Linux

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Set DATABASE_URL in .env to the PostgreSQL connection URL above.
python -m uvicorn backend.main:app --reload
```

Open <http://127.0.0.1:8000>. Allow microphone access when prompted.

## Environment

Copy `.env.example` to `.env` and set:

```dotenv
DATABASE_URL=postgresql://vani_app:choose_a_password@127.0.0.1:5432/vani
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
