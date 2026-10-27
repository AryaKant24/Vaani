import io
import re
from typing import Any, Dict, List
from pypdf import PdfReader


def extract_text_from_pdf(pdf_bytes: bytes) -> str:
    """Extracts readable text from all pages of an uploaded PDF."""
    reader = PdfReader(io.BytesIO(pdf_bytes))
    pages_text: List[str] = []
    for page in reader.pages:
        extracted = page.extract_text()
        if extracted:
            cleaned_page = re.sub(r"-\s*\n\s*", "", extracted)
            pages_text.append(cleaned_page.strip())
    return "\n\n".join(pages_text)


def split_into_sentences(text: str) -> List[str]:
    """Splits text into clean, individual sentences for sentence-level resume."""
    cleaned = re.sub(r"\s+", " ", text).strip()
    if not cleaned:
        return []

    raw_parts = re.split(r"(?<=[.!?।])\s+", cleaned)
    sentences: List[str] = []
    buffer = ""

    for part in raw_parts:
        part = part.strip()
        if not part:
            continue
        candidate = f"{buffer} {part}".strip() if buffer else part
        if len(candidate) < 35:
            buffer = candidate
        else:
            sentences.append(candidate)
            buffer = ""

    if buffer:
        if sentences:
            sentences[-1] = f"{sentences[-1]} {buffer}".strip()
        else:
            sentences.append(buffer)

    return sentences


def build_structured_paragraphs(
    raw_text: str, max_sentences_per_para: int = 3
) -> List[Dict[str, Any]]:
    """Groups sentences into paragraphs while preserving sentence arrays."""
    all_sentences = split_into_sentences(raw_text)
    paragraphs: List[Dict[str, Any]] = []

    for i in range(0, len(all_sentences), max_sentences_per_para):
        group = all_sentences[i : i + max_sentences_per_para]
        paragraphs.append(
            {
                "paragraph_index": len(paragraphs),
                "full_text": " ".join(group),
                "sentences": group,
            }
        )

    return paragraphs