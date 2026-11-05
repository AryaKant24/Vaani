import logging
from typing import Dict
from backend.services import speech_service

logger = logging.getLogger("vani.agents")

LANGUAGE_CONFIG: Dict[str, Dict[str, str]] = {
    "en-IN": {
        "name": "simple conversational Indian English",
        "script_rule": "Write in clear English.",
    },
    "hi-IN": {
        "name": "conversational Hindi",
        "script_rule": "Use Devanagari script (हिंदी देवनागरी लिपि), retaining English words when the student code-switches into English.",
    },
    "mr-IN": {
        "name": "conversational Marathi",
        "script_rule": "Use Devanagari script (मराठी देवनागरी लिपी), retaining English words when the student code-switches into English.",
    },
    "ta-IN": {
        "name": "conversational Tamil",
        "script_rule": "Use Tamil script (தமிழ்), retaining English words when the student code-switches into English.",
    },
    "te-IN": {
        "name": "conversational Telugu",
        "script_rule": "Use Telugu script (తెలుగు), retaining English words when the student code-switches into English.",
    },
    "kn-IN": {
        "name": "conversational Kannada",
        "script_rule": "Use Kannada script (ಕನ್ನಡ), retaining English words when the student code-switches into English.",
    },
    "bn-IN": {
        "name": "conversational Bengali",
        "script_rule": "Write in Bengali script (বাংলা), retaining English words only when the student's question code-switches into English.",
    },
    "gu-IN": {
        "name": "conversational Gujarati",
        "script_rule": "Write in Gujarati script (ગુજરાતી), retaining English words only when the student's question code-switches into English.",
    },
    "ml-IN": {
        "name": "conversational Malayalam",
        "script_rule": "Write in Malayalam script (മലയാളം), retaining English words only when the student's question code-switches into English.",
    },
    "pa-IN": {
        "name": "conversational Punjabi",
        "script_rule": "Write in Gurmukhi script (ਪੰਜਾਬੀ), retaining English words only when the student's question code-switches into English.",
    },
}

STUDY_TUTOR_PROMPT = """You are Vani, an intelligent and empathetic audio tutor for students with visual impairments.
The student is listening to a book and interrupted at a specific sentence to ask a doubt.

STRICT INSTRUCTIONS:
1. TARGET LANGUAGE: Match the language and any code-switching used in the student's spoken question. The speech recognizer detected {target_language}. {script_rule}
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
        primary_language = language.split(",", 1)[0].strip()
        lang_info = LANGUAGE_CONFIG.get(primary_language, LANGUAGE_CONFIG["en-IN"])

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

        explanation = await speech_service.generate_evon_response(
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
