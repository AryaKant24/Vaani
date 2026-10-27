import asyncio
import hashlib
import logging
import time
from pathlib import Path
from typing import Optional

import aiofiles
import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from backend.config import AUDIO_CACHE_DIR, settings

try:
    from gnani.stt import GnaniSTTClient
    HAS_GNANI_SDK = True
except ImportError:
    HAS_GNANI_SDK = False

logger = logging.getLogger("vani.services")
logging.basicConfig(level=logging.INFO)
logging.getLogger("gnani").propagate = False


class RateLimitExceededError(Exception):
    """Raised when an API returns HTTP 429 Too Many Requests."""
    pass


class RetryableUpstreamError(Exception):
    """An upstream failure that is safe to retry once or twice."""


class InvalidUpstreamCredentialsError(Exception):
    """The configured provider rejected its credential; retries cannot fix it."""


class GnaniService:
    """
    Unified asynchronous wrapper for:
    - Gnani Prisma v2.5 (Speech-to-Text)
    - Gnani Timbre v2.5 (Text-to-Speech with local MD5 WAV cache)
    - External OpenAI-Compatible LLM (Groq / Gemini / Evon)
    """

    def __init__(self) -> None:
        self.api_key = settings.GNANI_API_KEY.strip()
        self._rate_locks = {name: asyncio.Lock() for name in ("stt", "tts", "llm")}
        self._last_call_ts = {name: 0.0 for name in self._rate_locks}
        self._min_interval: float = 1.05
        self._http_client: Optional[httpx.AsyncClient] = None
        self._http_client_lock = asyncio.Lock()
        self._cache_locks: dict[str, asyncio.Lock] = {}

        if HAS_GNANI_SDK and self.api_key:
            self.stt_client = GnaniSTTClient(api_key=self.api_key)
        else:
            self.stt_client = None

    async def _throttle(self, service: str) -> None:
        """Rate-limit each upstream independently instead of blocking all services."""
        async with self._rate_locks[service]:
            now = time.monotonic()
            elapsed = now - self._last_call_ts[service]
            if elapsed < self._min_interval:
                await asyncio.sleep(self._min_interval - elapsed)
            self._last_call_ts[service] = time.monotonic()

    async def _client(self) -> httpx.AsyncClient:
        if self._http_client is None or self._http_client.is_closed:
            async with self._http_client_lock:
                if self._http_client is None or self._http_client.is_closed:
                    self._http_client = httpx.AsyncClient(
                        timeout=httpx.Timeout(45.0, connect=5.0, write=15.0, pool=5.0),
                        limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
                    )
        return self._http_client

    async def close(self) -> None:
        if self._http_client is not None and not self._http_client.is_closed:
            await self._http_client.aclose()

    @staticmethod
    def get_tts_cache_path(text: str, language: str, voice: str) -> Path:
        """Generates a deterministic filename for caching TTS audio."""
        normalized = f"{text.strip()}|{language.strip()}|{voice.strip()}"
        digest = hashlib.md5(normalized.encode("utf-8")).hexdigest()
        return AUDIO_CACHE_DIR / f"{digest}.wav"

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=2, min=2, max=10),
        retry=retry_if_exception_type((RateLimitExceededError, RetryableUpstreamError, httpx.TransportError)),
        reraise=True,
    )
    async def generate_evon_response(
        self,
        system_prompt: str,
        user_text: str,
        temperature: float = 0.25,
        max_tokens: int = 1024,
    ) -> str:
        await self._throttle("llm")

        live_cfg = settings
        llm_url = live_cfg.GNANI_EVON_URL.strip()
        key_candidates = live_cfg.get_llm_key_candidates()
        llm_model = live_cfg.LLM_MODEL.strip()

        # Auto-correct model name if user switched URL to Groq but left model as "evon3.3"
        if "groq.com" in llm_url and llm_model == "evon3.3":
            llm_model = "llama-3.3-70b-versatile"

        if not key_candidates:
            raise InvalidUpstreamCredentialsError("No API key is configured for the selected reasoning provider.")

        logger.info("LLM request started | provider=%s | model=%s", _provider_name(llm_url), llm_model)
        payload = {
            "model": llm_model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_text},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        client = await self._client()
        last_auth_error = None
        for llm_key in key_candidates:
            headers = {"Authorization": f"Bearer {llm_key}", "Content-Type": "application/json"}
            response = await client.post(llm_url, headers=headers, json=payload)
            if response.status_code == 401:
                logger.warning("Reasoning provider rejected configured credential | provider=%s", _provider_name(llm_url))
                last_auth_error = InvalidUpstreamCredentialsError(
                    "The reasoning provider rejected the configured API key. Verify or replace that provider key."
                )
                continue
            if response.status_code == 429:
                raise RateLimitExceededError("Reasoning provider rate limited the request.")
            if response.status_code >= 500:
                raise RetryableUpstreamError(f"Reasoning provider returned HTTP {response.status_code}.")
            if response.is_error:
                logger.warning("Reasoning provider returned HTTP %s", response.status_code)
                raise RuntimeError(f"Reasoning provider returned HTTP {response.status_code}.")
            try:
                content = response.json()["choices"][0]["message"]["content"].strip()
            except (KeyError, IndexError, TypeError, ValueError) as exc:
                raise RuntimeError("Reasoning provider returned an unexpected response format.") from exc
            if not content:
                raise RuntimeError("Reasoning provider returned an empty answer.")
            return content

        raise last_auth_error or InvalidUpstreamCredentialsError("No reasoning provider credential was accepted.")

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=2, min=2, max=10),
        retry=retry_if_exception_type((RateLimitExceededError, RetryableUpstreamError, httpx.TransportError)),
        reraise=True,
    )
    async def text_to_speech(
        self,
        text: str,
        language: Optional[str] = None,
        voice: Optional[str] = None,
    ) -> bytes:
        live_cfg = settings
        lang = (language or live_cfg.DEFAULT_LANGUAGE).strip()
        spk_voice = (voice or live_cfg.DEFAULT_VOICE).strip()

        cache_path = self.get_tts_cache_path(text, lang, spk_voice)
        cache_key = str(cache_path)
        cache_lock = self._cache_locks.setdefault(cache_key, asyncio.Lock())
        async with cache_lock:
            if cache_path.exists() and cache_path.stat().st_size > 0:
                logger.info("TTS cache hit")
                async with aiofiles.open(cache_path, "rb") as f:
                    return await f.read()

            logger.info("TTS synthesis started | voice=%s | language=%s", spk_voice, lang)
            await self._throttle("tts")
            url = "https://api.vachana.ai/api/v1/tts/inference"
            headers = {
                "Content-Type": "application/json",
                "X-API-Key-ID": live_cfg.GNANI_API_KEY.strip(),
            }
            payload = {
                "text": text,
                "voice": spk_voice,
                "model": live_cfg.TTS_MODEL,
                "language": lang,
                "speed": 1.0,
                "audio_config": {
                    "sample_rate": 16000,
                    "num_channels": 1,
                    "sample_width": 2,
                    "encoding": "linear_pcm",
                    "container": "wav",
                },
            }

            client = await self._client()
            response = await client.post(url, headers=headers, json=payload, timeout=30.0)
            if response.status_code in (401, 403):
                logger.warning("TTS provider rejected configured credential | status=%s", response.status_code)
                raise InvalidUpstreamCredentialsError("The speech provider rejected the configured API key.")
            if response.status_code == 429:
                raise RateLimitExceededError("Speech provider rate limited synthesis.")
            if response.status_code >= 500:
                raise RetryableUpstreamError(f"Speech provider returned HTTP {response.status_code}.")
            if response.is_error:
                logger.warning("Speech provider returned HTTP %s", response.status_code)
                raise RuntimeError(f"Speech provider returned HTTP {response.status_code}.")
            audio_bytes = response.content
            if not audio_bytes:
                raise RuntimeError("Speech provider returned an empty audio response.")

            temporary_path = cache_path.with_suffix(".tmp")
            async with aiofiles.open(temporary_path, "wb") as f:
                await f.write(audio_bytes)
            temporary_path.replace(cache_path)
            return audio_bytes

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=2, min=2, max=10),
        retry=retry_if_exception_type((RateLimitExceededError, RetryableUpstreamError, httpx.TransportError)),
        reraise=True,
    )
    async def speech_to_text(
        self,
        audio_bytes: bytes,
        filename: str = "recording.wav",
        language: Optional[str] = None,
    ) -> str:
        live_cfg = settings
        lang = (language or live_cfg.DEFAULT_LANGUAGE).strip()
        await self._throttle("stt")

        if not self.stt_client:
            raise RuntimeError(
                "Gnani STT client not initialized. Check GNANI_API_KEY and gnani-vachana installation."
            )

        def _transcribe_sync() -> str:
            result = self.stt_client.transcribe_bytes(
                audio_bytes,
                filename=filename,
                language_code=lang,
            )
            if isinstance(result, dict):
                return result.get("transcript", "").strip()
            return str(result).strip()

        transcript = await asyncio.to_thread(_transcribe_sync)
        logger.info("STT transcription complete | language=%s | characters=%d", lang, len(transcript))
        return transcript


def _provider_name(url: str) -> str:
    host = httpx.URL(url).host or "configured-endpoint"
    return host.lower()


gnani_service = GnaniService()
