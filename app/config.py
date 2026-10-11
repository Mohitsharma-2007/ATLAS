from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


load_dotenv(Path(__file__).resolve().parent.parent / ".env")


@dataclass(frozen=True)
class Settings:
    app_name: str = os.getenv("APP_NAME", "Research GraphRAG")
    app_env: str = os.getenv("APP_ENV", "development")
    neo4j_uri: str = os.getenv("NEO4J_URI", "bolt://localhost:7687")
    neo4j_username: str = os.getenv("NEO4J_USERNAME", "neo4j")
    neo4j_password: str = os.getenv("NEO4J_PASSWORD", "")
    neo4j_database: str = os.getenv("NEO4J_DATABASE", "neo4j")
    neo4j_query_api_url: str = os.getenv("NEO4J_QUERY_API_URL", "")
    openalex_base_url: str = os.getenv("OPENALEX_BASE_URL", "https://api.openalex.org")
    openalex_mailto: str = os.getenv("OPENALEX_MAILTO", "")
    provider: str = os.getenv("LLM_PROVIDER", "openrouter").lower()
    openrouter_api_key: str = os.getenv("OPENROUTER_API_KEY", "")
    openrouter_base_url: str = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    openrouter_model: str = os.getenv(
        "OPENROUTER_MODEL", "openrouter/free"
    )
    groq_api_key: str = os.getenv("GROQ_API_KEY", "")
    groq_base_url: str = os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
    groq_model: str = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")
    nvidia_api_key: str = os.getenv("NVIDIA_API_KEY", "")
    nvidia_base_url: str = os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1")
    nvidia_model: str = os.getenv("NVIDIA_MODEL", "meta/llama-3.1-8b-instruct")
    embedding_dimensions: int = int(os.getenv("EMBEDDING_DIMENSIONS", "384"))
    request_timeout_seconds: float = float(os.getenv("REQUEST_TIMEOUT_SECONDS", "30"))
    neo4j_connection_timeout_seconds: float = float(os.getenv("NEO4J_CONNECTION_TIMEOUT_SECONDS", "5"))

    @property
    def llm_config(self) -> tuple[str, str, str] | None:
        return next(iter(self.llm_configs), None)

    @property
    def llm_configs(self) -> list[tuple[str, str, str]]:
        """Preferred provider first, followed by configured fallbacks."""
        providers = {
            "openrouter": (self.openrouter_base_url, self.openrouter_api_key, self.openrouter_model),
            "groq": (self.groq_base_url, self.groq_api_key, self.groq_model),
            "nvidia": (self.nvidia_base_url, self.nvidia_api_key, self.nvidia_model),
        }
        order = dict.fromkeys([self.provider, "openrouter", "groq", "nvidia"])
        return [providers[name] for name in order if name in providers and providers[name][1]]


settings = Settings()
