import base64
import logging
import re
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from psycopg.errors import UniqueViolation
from pypdf.errors import PdfReadError
from starlette.middleware.sessions import SessionMiddleware

from backend.agents import study_agent
from backend.config import BASE_DIR, settings
from backend.document_utils import build_structured_paragraphs, extract_pages_and_paragraphs
from backend import database
from backend.services import (
    InvalidUpstreamCredentialsError,
    InvalidTTSRequestError,
    gnani_service,
)

logger = logging.getLogger("vani.main")
password_hasher = PasswordHasher()

@asynccontextmanager
async def lifespan(_: FastAPI):
    session_secret = settings.SESSION_SECRET.strip()
    if len(session_secret) < 32 or session_secret.startswith("replace_with_"):
        raise RuntimeError(
            "Set SESSION_SECRET to a newly generated random value of at least 32 characters in .env; "
            "do not leave the example placeholder."
        )
    try:
        database.initialize_database()
    except Exception as exc:
        logger.exception("Database initialization failed")
        raise RuntimeError(
            "Could not initialize PostgreSQL. Check DATABASE_URL, confirm the server is running, "
            "and verify that the configured role can create and update Vani's tables."
        ) from exc
    try:
        yield
    finally:
        await gnani_service.close()


app = FastAPI(
    title="Vani",
    description="Voice-First PDF Reader & Multilingual Doubt Tutor powered by Gnani.ai",
    version="3.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8000", "http://localhost:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.SESSION_SECRET or "startup-requires-configured-session-secret",
    session_cookie="vani_session",
    same_site="lax",
    https_only=settings.SESSION_HTTPS_ONLY,
    max_age=60 * 60 * 24 * 14,
)

FRONTEND_DIR = BASE_DIR / "frontend"
(FRONTEND_DIR / "css").mkdir(parents=True, exist_ok=True)
(FRONTEND_DIR / "js").mkdir(parents=True, exist_ok=True)

app.mount("/css", StaticFiles(directory=str(FRONTEND_DIR / "css")), name="css")
app.mount("/js", StaticFiles(directory=str(FRONTEND_DIR / "js")), name="js")

WELCOME_SCRIPT = (
    "Welcome to Vani. Hope you are having a great day!"
    "Press Spacebar to skip this introduction. Press S when you are ready to start reading. "
    "Use A and D to move between paragraphs, and the Up and Down arrow keys to change reading speed and the Left and Right arrow keys to fast forward or go behind."
    "Press F to change the language used for doubt answers, and L to open your library. Press U to upload books in the library. "
    "While Vani is reading, press Spacebar to pause and ask a doubt. "
    "After answering in your chosen language, Vani resumes from the sentence where it left off."
    "Press H to hear this introduction again."
)

SAMPLE_TEXT = (
    "Photosynthesis is the biochemical process by which green plants transform light energy into chemical energy. "
    "Light energy is captured by chlorophyll inside plant cells. "
    "This energy is used to convert water and carbon dioxide into oxygen and energy-rich glucose molecules. "
    "In cellular respiration, living cells break down glucose in the presence of oxygen to release stored energy as Adenosine Triphosphate, or ATP. "
    "While photosynthesis stores energy in glucose molecules, cellular respiration releases that energy for cellular work. "
    "The Reserve Bank of India serves as the apex central banking institution in India. "
    "It regulates monetary policy, manages foreign exchange reserves, and supervises commercial banks to maintain economic stability."
)

SESSION_STATE: Dict[str, Any] = {
    "welcome_script": WELCOME_SCRIPT,
    "pdf_title": "Sample Chapter: Biology & Indian Financial Systems",
    "paragraphs": build_structured_paragraphs(SAMPLE_TEXT, max_sentences_per_para=3),
    "doubt_history": [],
}


class TTSRequest(BaseModel):
    text: str
    language: Optional[str] = "en-IN"
    voice: Optional[str] = "Shlok"


class RegisterRequest(BaseModel):
    email: str
    password: str
    display_name: str


class LoginRequest(BaseModel):
    email: str
    password: str


class ProfileRequest(BaseModel):
    display_name: str
    country_or_region: str = ""
    education_board: str = ""
    grade_or_standard: str = ""
    academic_year: str = ""


def require_user(request: Request) -> str:
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Please sign in to continue.")
    return user_id


def public_profile(user_id: str) -> dict[str, Any]:
    profile = database.get_user_profile(user_id)
    if not profile:
        raise HTTPException(status_code=401, detail="Your session has expired. Please sign in again.")
    return {**profile, "id": str(profile["id"])}


def _encode_audio_b64(audio_bytes: bytes) -> str:
    return base64.b64encode(audio_bytes).decode("utf-8")


@app.get("/", response_class=HTMLResponse)
async def serve_frontend() -> HTMLResponse:
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        return HTMLResponse("<h1>Frontend index.html not found.</h1>", status_code=404)
    return HTMLResponse(index_path.read_text(encoding="utf-8"))


@app.get("/favicon.svg", include_in_schema=False)
async def serve_favicon() -> FileResponse:
    favicon_path = FRONTEND_DIR / "favicon.svg"
    if not favicon_path.exists():
        raise HTTPException(status_code=404, detail="Favicon not found.")
    return FileResponse(favicon_path, media_type="image/svg+xml")


@app.get("/api/state")
async def get_session_state(request: Request) -> Dict[str, Any]:
    user_id = require_user(request)
    book = database.get_last_book(user_id)
    if not book:
        return {**SESSION_STATE, "book_id": None, "current_page": 1,
                "current_paragraph_index": 0, "current_sentence_index": 0,
                "profile": public_profile(user_id)}
    return {
        "welcome_script": WELCOME_SCRIPT,
        "pdf_title": book["title"],
        "paragraphs": book["paragraphs"],
        "doubt_history": [],
        "book_id": book["id"],
        "current_page": book["page_pointer"],
        "current_paragraph_index": book["paragraph_index"],
        "current_sentence_index": book["sentence_index"],
        "profile": public_profile(user_id),
    }


@app.get("/api/books")
async def list_user_books(request: Request) -> List[Dict[str, Any]]:
    return database.list_books(require_user(request))


@app.get("/api/books/{book_id}")
async def open_user_book(book_id: str, request: Request) -> Dict[str, Any]:
    user_id = require_user(request)
    book = database.get_book(user_id, book_id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found.")
    database.mark_book_opened(user_id, book_id)
    return {
        "book_id": str(book["id"]),
        "pdf_title": book["title"],
        "paragraphs": book["paragraphs"],
        "page_count": book["page_count"],
        "current_page": book["page_pointer"],
        "current_paragraph_index": book["paragraph_index"],
        "current_sentence_index": book["sentence_index"],
    }


@app.delete("/api/books/{book_id}")
async def delete_user_book(book_id: str, request: Request) -> Dict[str, bool]:
    if not database.delete_book(require_user(request), book_id):
        raise HTTPException(status_code=404, detail="Book not found.")
    return {"deleted": True}


@app.post("/api/auth/register")
async def register_account(req: RegisterRequest, request: Request) -> Dict[str, Any]:
    email = req.email.strip().lower()
    display_name = req.display_name.strip()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or len(email) > 254:
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    if len(req.password) < 10 or len(req.password) > 128:
        raise HTTPException(status_code=400, detail="Password must be between 10 and 128 characters.")
    if not display_name or len(display_name) > 80:
        raise HTTPException(status_code=400, detail="Display name must be 1 to 80 characters.")
    try:
        user = database.create_user(email, password_hasher.hash(req.password), display_name)
    except UniqueViolation as exc:
        raise HTTPException(status_code=409, detail="An account with this email already exists.") from exc
    request.session.clear()
    request.session["user_id"] = user["id"]
    return public_profile(user["id"])


@app.post("/api/auth/login")
async def login_account(req: LoginRequest, request: Request) -> Dict[str, Any]:
    user = database.get_user_by_email(req.email.strip().lower())
    if not user:
        raise HTTPException(status_code=401, detail="Email or password is incorrect.")
    try:
        password_hasher.verify(user["password_hash"], req.password)
    except VerifyMismatchError as exc:
        raise HTTPException(status_code=401, detail="Email or password is incorrect.") from exc
    request.session.clear()
    request.session["user_id"] = str(user["id"])
    return public_profile(str(user["id"]))


@app.post("/api/auth/logout")
async def logout_account(request: Request) -> Dict[str, bool]:
    request.session.clear()
    return {"logged_out": True}


@app.get("/api/auth/me")
async def current_account(request: Request) -> Dict[str, Any]:
    return public_profile(require_user(request))


@app.patch("/api/profile")
async def update_profile(req: ProfileRequest, request: Request) -> Dict[str, Any]:
    user_id = require_user(request)
    values = req.model_dump()
    for key, value in values.items():
        if len(value) > (80 if key == "display_name" else 120):
            raise HTTPException(status_code=400, detail=f"{key.replace('_', ' ').title()} is too long.")
    if not values["display_name"].strip():
        raise HTTPException(status_code=400, detail="Display name cannot be empty.")
    values["display_name"] = values["display_name"].strip()
    profile = database.update_user_profile(user_id, values)
    return {**profile, "id": str(profile["id"])}


class ProgressRequest(BaseModel):
    paragraph_index: int
    sentence_index: int


@app.put("/api/books/{book_id}/progress")
async def update_reading_progress(
    book_id: str, req: ProgressRequest, request: Request
) -> Dict[str, Any]:
    user_id = require_user(request)
    book = database.get_book(user_id, book_id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found.")
    paragraphs = book["paragraphs"]
    if not 0 <= req.paragraph_index < len(paragraphs):
        raise HTTPException(status_code=400, detail="Invalid paragraph index.")
    sentences = paragraphs[req.paragraph_index]["sentences"]
    if not 0 <= req.sentence_index < max(1, len(sentences)):
        raise HTTPException(status_code=400, detail="Invalid sentence index.")
    page_pointer = max(1, int(paragraphs[req.paragraph_index].get("page_number", 1)))
    if not database.save_progress(
        user_id, book_id, page_pointer, req.paragraph_index, req.sentence_index
    ):
        raise HTTPException(status_code=404, detail="Book progress not found.")
    return {
        "book_id": book_id,
        "page_pointer": page_pointer,
        "paragraph_index": req.paragraph_index,
        "sentence_index": req.sentence_index,
    }


@app.get("/api/llm-status")
async def check_llm_status(request: Request) -> Dict[str, Any]:
    require_user(request)
    try:
        await gnani_service.generate_evon_response(
            system_prompt="Reply with the single word OK.",
            user_text="Ping",
            max_tokens=1,
        )
        return {
            "connected": True,
            "model": settings.LLM_MODEL,
        }
    except InvalidUpstreamCredentialsError:
        logger.warning("Reasoning provider health check rejected its configured credential")
        return {"connected": False, "model": settings.LLM_MODEL, "error_code": "invalid_credentials"}
    except Exception as exc:
        logger.warning("Reasoning provider health check failed | error_type=%s", type(exc).__name__)
        return {
            "connected": False,
            "model": settings.LLM_MODEL,
            "error_code": "provider_unavailable",
        }


@app.post("/api/tts")
async def synthesize_speech(req: TTSRequest, request: Request) -> Dict[str, str]:
    require_user(request)
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty.")
    try:
        audio_bytes = await gnani_service.text_to_speech(
            text=req.text, language=req.language, voice=req.voice
        )
        return {"audio_base64": _encode_audio_b64(audio_bytes)}
    except InvalidUpstreamCredentialsError as exc:
        logger.warning("TTS request failed | reason=invalid_credentials")
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except InvalidTTSRequestError as exc:
        raise HTTPException(
            status_code=422,
            detail="The selected voice, language, or TTS model is not supported by the speech provider.",
        ) from exc
    except Exception as exc:
        logger.error("TTS request failed | error_type=%s | error=%s", type(exc).__name__, exc)
        raise HTTPException(status_code=502, detail="Speech synthesis is temporarily unavailable.") from exc


@app.post("/api/upload-pdf")
async def upload_pdf(
    request: Request, file: UploadFile = File(...)
) -> Dict[str, Any]:
    user_id = require_user(request)
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Please upload a valid .pdf file.")

    pdf_bytes = await file.read()
    try:
        paragraphs, page_count, readable_pages = extract_pages_and_paragraphs(pdf_bytes)
    except (PdfReadError, ValueError, OSError) as exc:
        raise HTTPException(
            status_code=400,
            detail="Could not read this PDF. Make sure it is valid and not password-protected.",
        ) from exc
    if not paragraphs:
        raise HTTPException(status_code=400, detail="Could not extract readable text from PDF.")
    book_id = database.save_book(user_id, file.filename, paragraphs, page_count)
    return {
        "pdf_title": file.filename,
        "book_id": book_id,
        "current_page": 1,
        "page_count": page_count,
        "readable_pages": readable_pages,
        "count": len(paragraphs),
        "paragraphs": paragraphs,
    }


@app.post("/api/study/doubt")
async def process_study_doubt(
    request: Request,
    paragraph_index: int = Form(...),
    sentence_index: int = Form(...),
    language: str = Form("en-IN"),
    voice: str = Form("Shlok"),
    book_id: Optional[str] = Form(None),
    audio: UploadFile = File(...),
) -> Dict[str, Any]:
    user_id = require_user(request)
    if book_id:
        book = database.get_book(user_id, book_id)
        if not book:
            raise HTTPException(status_code=404, detail="Book not found.")
        paragraphs: List[Dict[str, Any]] = book["paragraphs"]
    else:
        paragraphs = SESSION_STATE["paragraphs"]
    if paragraph_index < 0 or paragraph_index >= len(paragraphs):
        raise HTTPException(status_code=400, detail="Invalid paragraph index.")

    para_obj = paragraphs[paragraph_index]
    sentences: List[str] = para_obj["sentences"]
    safe_sent_idx = min(max(0, sentence_index), len(sentences) - 1)
    interrupted_sentence = sentences[safe_sent_idx]

    audio_bytes = await audio.read()

    try:
        student_question = await gnani_service.speech_to_text(
            audio_bytes=audio_bytes, filename="study_doubt.wav", language=language
        )
    except Exception as exc:
        logger.error("STT request failed | error_type=%s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="Voice transcription is temporarily unavailable.") from exc
    if not student_question:
        student_question = "Can you explain the meaning of this sentence in simple terms?"

    try:
        explanation = await study_agent.answer_interrupted_doubt(
            paragraph_text=para_obj["full_text"],
            interrupted_sentence=interrupted_sentence,
            student_question=student_question,
            language=language,
        )
    except InvalidUpstreamCredentialsError as exc:
        logger.warning("Reasoning request failed | reason=invalid_credentials")
        raise HTTPException(
            status_code=502,
            detail="The reasoning provider rejected its configured API key. Verify or replace that provider key.",
        ) from exc
    except Exception as exc:
        logger.error("Reasoning request failed | error_type=%s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="Voice explanations are temporarily unavailable.") from exc

    try:
        tts_bytes = await gnani_service.text_to_speech(
            text=explanation, language=language, voice=voice
        )
    except InvalidTTSRequestError as exc:
        raise HTTPException(
            status_code=422,
            detail="The selected voice is not available for the doubt-answer language.",
        ) from exc
    except Exception as exc:
        logger.error("Answer audio failed | error_type=%s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="Answer audio is temporarily unavailable.") from exc

    return {
        "paragraph_index": paragraph_index,
        "sentence_index": safe_sent_idx,
        "language": language,
        "student_question": student_question,
        "explanation": explanation,
        "audio_base64": _encode_audio_b64(tts_bytes),
    }
