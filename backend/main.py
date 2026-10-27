import base64
import logging
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.agents import study_agent
from backend.config import BASE_DIR, settings
from backend.document_utils import build_structured_paragraphs, extract_text_from_pdf
from backend.services import (
    InvalidUpstreamCredentialsError,
    gnani_service,
)

logger = logging.getLogger("vani.main")

@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        yield
    finally:
        await gnani_service.close()


app = FastAPI(
    title="Vani — Deep Ocean Accessible PDF Reader",
    description="Voice-First PDF Reader & Multilingual Doubt Tutor powered by Gnani.ai",
    version="3.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = BASE_DIR / "frontend"
(FRONTEND_DIR / "css").mkdir(parents=True, exist_ok=True)
(FRONTEND_DIR / "js").mkdir(parents=True, exist_ok=True)

app.mount("/css", StaticFiles(directory=str(FRONTEND_DIR / "css")), name="css")
app.mount("/js", StaticFiles(directory=str(FRONTEND_DIR / "js")), name="js")

WELCOME_SCRIPT = (
    "Welcome to Vani Interactive Book Reader. "
    "Press Spacebar to skip this introduction and start listening to the book. "
    "Use the Up and Down arrow keys to choose your preferred language. "
    "While Vani is reading, press Spacebar at any moment to interrupt and ask a doubt. "
    "After answering your question in your chosen language, Vani will automatically restart from the exact sentence where it left off."
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
    voice: Optional[str] = "Nalini"


def _encode_audio_b64(audio_bytes: bytes) -> str:
    return base64.b64encode(audio_bytes).decode("utf-8")


@app.get("/", response_class=HTMLResponse)
async def serve_frontend() -> HTMLResponse:
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        return HTMLResponse("<h1>Frontend index.html not found.</h1>", status_code=404)
    return HTMLResponse(index_path.read_text(encoding="utf-8"))


@app.get("/api/state")
async def get_session_state() -> Dict[str, Any]:
    return SESSION_STATE


@app.get("/api/llm-status")
async def check_llm_status() -> Dict[str, Any]:
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
async def synthesize_speech(req: TTSRequest) -> Dict[str, str]:
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
    except Exception as exc:
        logger.error("TTS request failed | error_type=%s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="Speech synthesis is temporarily unavailable.") from exc


@app.post("/api/upload-pdf")
async def upload_pdf(file: UploadFile = File(...)) -> Dict[str, Any]:
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Please upload a valid .pdf file.")

    pdf_bytes = await file.read()
    raw_text = extract_text_from_pdf(pdf_bytes)
    if not raw_text.strip():
        raise HTTPException(status_code=400, detail="Could not extract readable text from PDF.")

    paragraphs = build_structured_paragraphs(raw_text, max_sentences_per_para=3)
    SESSION_STATE["pdf_title"] = file.filename
    SESSION_STATE["paragraphs"] = paragraphs
    SESSION_STATE["doubt_history"] = []

    return {
        "pdf_title": file.filename,
        "count": len(paragraphs),
        "paragraphs": paragraphs,
    }


@app.post("/api/study/doubt")
async def process_study_doubt(
    paragraph_index: int = Form(...),
    sentence_index: int = Form(...),
    language: str = Form("en-IN"),
    voice: str = Form("Nalini"),
    audio: UploadFile = File(...),
) -> Dict[str, Any]:
    paragraphs: List[Dict[str, Any]] = SESSION_STATE["paragraphs"]
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
