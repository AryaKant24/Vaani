import logging
from typing import Dict
from backend.services import gnani_service

logger = logging.getLogger("vani.agents")

LANGUAGE_CONFIG: Dict[str, Dict[str, str]] = {
    "en-IN": {
        "name": "simple conversational Indian English",
        "script_rule": "Write in clear English.",
    },
    "hi-IN": {
        "name": "conversational Hindi",
        "script_rule": "Write strictly in Hindi using Devanagari script (हिंदी देवनागरी लिपि). Do NOT write in English.",
    },
    "mr-IN": {
        "name": "conversational Marathi",
        "script_rule": "Write strictly in Marathi using Devanagari script (मराठी देवनागरी लिपी). Do NOT write in English.",
    },
    "ta-IN": {
        "name": "conversational Tamil",
        "script_rule": "Write strictly in Tamil script (தமிழ்). Do NOT write in English.",
    },
    "te-IN": {
        "name": "conversational Telugu",
        "script_rule": "Write strictly in Telugu script (తెలుగు). Do NOT write in English.",
    },
    "kn-IN": {
        "name": "conversational Kannada",
        "script_rule": "Write strictly in Kannada script (ಕನ್ನಡ). Do NOT write in English.",
    },
}

STUDY_TUTOR_PROMPT = """You are Vani, an intelligent and empathetic audio tutor for students with visual impairments.
The student is listening to a book and interrupted at a specific sentence to ask a doubt.

STRICT INSTRUCTIONS:
1. TARGET LANGUAGE: {target_language}. {script_rule}
2. DO NOT repeat or read back the book paragraph verbatim. Actually THINK about the student's question and explain the concept using a simple analogy or clear breakdown.
3. Keep your response to 2 or 3 natural spoken sentences so the student can quickly understand and resume their book.
4. NEVER use markdown symbols (*, #, `, bullet points) because your text is sent directly to a Text-to-Speech engine."""


class VaniStudyAgent:
    """Handles multilingual contextual doubt resolution during sentence-by-sentence PDF reading."""

    async def answer_interrupted_doubt(
        self,
        paragraph_text: str,
        interrupted_sentence: str,
        student_question: str,
        language: str = "en-IN",
    ) -> str:
        lang_info = LANGUAGE_CONFIG.get(language, LANGUAGE_CONFIG["en-IN"])

        system_prompt = STUDY_TUTOR_PROMPT.format(
            target_language=lang_info["name"],
            script_rule=lang_info["script_rule"],
        )

        user_prompt = (
            f"BOOK PARAGRAPH CONTEXT:\n{paragraph_text}\n\n"
            f"SENTENCE WHERE STUDENT INTERRUPTED:\n{interrupted_sentence}\n\n"
            f"STUDENT'S SPOKEN QUESTION:\n{student_question}\n\n"
            f"Provide a clear, thoughtful explanation in {lang_info['name']} ({lang_info['script_rule']}):"
        )

        explanation = await gnani_service.generate_evon_response(
            system_prompt=system_prompt,
            user_text=user_prompt,
            temperature=0.35,
        )

        cleaned = (
            explanation.replace("*", "")
            .replace("#", "")
            .replace("`", "")
            .replace("- ", "")
            .strip()
        )
        return cleaned


study_agent = VaniStudyAgent()