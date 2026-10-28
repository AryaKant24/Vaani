from pathlib import Path
from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent
ENV_FILE_PATH = BASE_DIR / ".env"
AUDIO_CACHE_DIR = BASE_DIR / "assets" / "audio_cache"
EXPORTS_DIR = BASE_DIR / "assets" / "exports"

AUDIO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
EXPORTS_DIR.mkdir(parents=True, exist_ok=True)


class Settings(BaseSettings):
    DATABASE_URL: str = ""
    SESSION_SECRET: str = ""
    SESSION_HTTPS_ONLY: bool = False
    GNANI_API_KEY: str = ""
    GNANI_EVON_URL: str = "https://api.groq.com/openai/v1/chat/completions"

    LLM_API_KEY: str = ""
    GROQ_API_KEY: str = ""
    GEMINI_API_KEY: str = ""

    LLM_MODEL: str = "llama-3.3-70b-versatile"
    DEFAULT_LANGUAGE: str = "en-IN"
    DEFAULT_VOICE: str = "Nalini"
    TTS_MODEL: str = "timbre-v2.5"

    @field_validator("*", mode="before")
    @classmethod
    def strip_whitespace(cls, v):
        if isinstance(v, str):
            return v.strip().strip('"').strip("'")
        return v

    @field_validator("GNANI_EVON_URL", mode="after")
    @classmethod
    def sanitize_llm_url(cls, url: str) -> str:
        """Automatically replaces the non-existent api.gnani.inference domain with Groq."""
        if not url or "gnani.inference" in url:
            return "https://api.groq.com/openai/v1/chat/completions"
        return url

    @model_validator(mode="after")
    def migrate_deprecated_groq_model(self):
        """Use a currently supported Groq model when an old Llama ID is configured."""
        if "groq.com" in self.GNANI_EVON_URL.lower() and self.LLM_MODEL in {
            "llama-3.3-70b-versatile",
            "llama-3.1-8b-instant",
        }:
            self.LLM_MODEL = "openai/gpt-oss-120b"
        return self

    def get_llm_key_candidates(self) -> list[str]:
        """Return deduplicated keys suitable for the configured LLM provider."""
        url = self.GNANI_EVON_URL.lower()
        if "groq.com" in url:
            candidates = (self.GROQ_API_KEY, self.LLM_API_KEY)
        elif "googleapis.com" in url or "generativelanguage" in url:
            candidates = (self.GEMINI_API_KEY, self.LLM_API_KEY)
        else:
            candidates = (self.LLM_API_KEY, self.GNANI_API_KEY)

        unique: list[str] = []
        for key in candidates:
            cleaned = key.strip()
            if cleaned and cleaned not in unique:
                unique.append(cleaned)
        return unique

    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE_PATH),
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
