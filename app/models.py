from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from typing import Literal

from pydantic import BaseModel, Field, field_validator


@dataclass
class Paper:
    openalex_id: str
    title: str
    abstract: str = ""
    year: int | None = None
    doi: str = ""
    url: str = ""
    cited_by_count: int = 0
    authors: list[dict[str, str]] = field(default_factory=list)
    concepts: list[str] = field(default_factory=list)
    methods: list[str] = field(default_factory=list)
    limitations: list[str] = field(default_factory=list)
    source_name: str = "OpenAlex"
    referenced_works: list[str] = field(default_factory=list)
    embedding: list[float] = field(default_factory=list)
    related: list[dict[str, Any]] = field(default_factory=list)
    graph_id: str = ""
    publication_date: str = ""
    work_type: str = ""
    language: str = ""
    journal: str = ""
    pdf_url: str = ""
    is_oa: bool = False
    fwci: float | None = None
    institutions: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    counts_by_year: list[dict[str, Any]] = field(default_factory=list)
    references_count: int = 0
    related_count: int = 0

    def text_for_embedding(self) -> str:
        return " ".join(
            [
                self.title,
                self.abstract,
                " ".join(self.concepts),
                " ".join(self.methods),
                " ".join(self.limitations),
            ]
        ).strip()

    def as_source(self, citation: str | None = None) -> dict[str, Any]:
        source = {
            "citation": citation,
            "openalex_id": self.openalex_id,
            "title": self.title,
            "abstract": self.abstract,
            "year": self.year,
            "doi": self.doi,
            "url": self.url,
            "authors": [author.get("name", "") for author in self.authors],
            "concepts": self.concepts,
            "methods": self.methods,
            "limitations": self.limitations,
            "cited_by_count": self.cited_by_count,
            "publication_date": self.publication_date,
            "type": self.work_type,
            "language": self.language,
            "journal": self.journal,
            "pdf_url": self.pdf_url,
            "is_oa": self.is_oa,
            "fwci": self.fwci,
            "institutions": self.institutions,
            "keywords": self.keywords,
            "counts_by_year": self.counts_by_year,
            "references_count": self.references_count,
            "related_count": self.related_count,
        }
        if self.graph_id:
            source["graph_id"] = self.graph_id
        return source


class DiscoverRequest(BaseModel):
    topic: str = Field(min_length=2, max_length=240)
    limit: int = Field(default=8, ge=1, le=20)


class AskRequest(BaseModel):
    question: str = Field(min_length=5, max_length=1200)


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=6000)


class PaperChatRequest(BaseModel):
    question: str = Field(min_length=3, max_length=1200)
    history: list[ChatTurn] = Field(default_factory=list, max_length=10)


class EvidenceRequest(BaseModel):
    locator: str = Field(min_length=2, max_length=120, description="For example: page 6, Table 2")
    text: str = Field(min_length=30, max_length=16000)

    @field_validator("locator", "text")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Evidence must contain text")
        return value.strip()


class CompareRequest(BaseModel):
    openalex_ids: list[str] = Field(min_length=2, max_length=4)
    question: str = Field(
        default="Compare the approaches, evidence, limitations, and what each paper enables next.",
        min_length=5,
        max_length=1200,
    )

    @field_validator("openalex_ids")
    @classmethod
    def distinct_papers(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values):
            raise ValueError("Choose distinct papers for comparison")
        return values


class HealthResponse(BaseModel):
    status: str
    neo4j: bool
    llm: bool
    connection_message: str = ""
    query_api: bool = False
