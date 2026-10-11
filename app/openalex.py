from __future__ import annotations

from typing import Any

import httpx

from app.models import Paper


def reconstruct_abstract(inverted_index: dict[str, list[int]] | None) -> str:
    """Turn OpenAlex's position-indexed abstract into ordinary text."""
    if not inverted_index:
        return ""
    words: list[str] = []
    for word, positions in inverted_index.items():
        for position in positions:
            while len(words) <= position:
                words.append("")
            words[position] = word
    return " ".join(word for word in words if word).strip()


def _openalex_id(value: str | None) -> str:
    if not value:
        return ""
    return value.rstrip("/").split("/")[-1]


class OpenAlexClient:
    def __init__(self, base_url: str, mailto: str = "", timeout: float = 30) -> None:
        self.base_url = base_url.rstrip("/")
        self.mailto = mailto
        self.timeout = timeout

    async def search(self, topic: str, limit: int = 8) -> list[Paper]:
        params: dict[str, Any] = {
            "search": topic,
            "per-page": limit,
            "sort": "relevance_score:desc",
            "select": (
                "id,title,publication_year,doi,primary_location,cited_by_count,"
                "publication_date,type,language,fwci,is_retracted,authorships,"
                "institutions,concepts,topics,keywords,abstract_inverted_index,"
                "referenced_works,related_works,counts_by_year,open_access,"
                "best_oa_location,locations_count"
            ),
        }
        if self.mailto:
            params["mailto"] = self.mailto
        headers = {"User-Agent": "ResearchGraphRAG/0.1 (mailto:research@example.com)"}
        async with httpx.AsyncClient(timeout=self.timeout, headers=headers) as client:
            response = await client.get(f"{self.base_url}/works", params=params)
            response.raise_for_status()
            payload = response.json()
        return [self._parse_work(item) for item in payload.get("results", [])]

    @staticmethod
    def _parse_work(item: dict[str, Any]) -> Paper:
        location = item.get("primary_location") or {}
        best_location = item.get("best_oa_location") or location or {}
        source = location.get("source") or {}
        authors = []
        for authorship in item.get("authorships") or []:
            author = authorship.get("author") or {}
            name = author.get("display_name")
            if name:
                authors.append({"openalex_id": _openalex_id(author.get("id")), "name": name})

        concepts: list[str] = []
        for concept in item.get("concepts") or []:
            name = concept.get("display_name")
            if name and name not in concepts:
                concepts.append(name)

        institutions: list[str] = []
        for authorship in item.get("authorships") or []:
            for institution in authorship.get("institutions") or []:
                name = institution.get("display_name")
                if name and name not in institutions:
                    institutions.append(name)
        keywords = [
            keyword.get("display_name")
            for keyword in (item.get("keywords") or [])
            if keyword.get("display_name")
        ]
        for topic in item.get("topics") or []:
            name = topic.get("display_name")
            if name and name not in concepts:
                concepts.append(name)

        url = location.get("landing_page_url") or item.get("doi") or ""
        pdf_url = best_location.get("pdf_url") or location.get("pdf_url") or ""
        open_access = item.get("open_access") or {}
        return Paper(
            openalex_id=_openalex_id(item.get("id")),
            title=(item.get("title") or "Untitled paper").strip(),
            abstract=reconstruct_abstract(item.get("abstract_inverted_index")),
            year=item.get("publication_year"),
            doi=item.get("doi") or "",
            url=url,
            cited_by_count=int(item.get("cited_by_count") or 0),
            authors=authors,
            concepts=concepts[:12],
            source_name=source.get("display_name") or "OpenAlex",
            referenced_works=[_openalex_id(value) for value in (item.get("referenced_works") or [])],
            publication_date=item.get("publication_date") or "",
            work_type=item.get("type") or "",
            language=item.get("language") or "",
            journal=source.get("display_name") or "",
            pdf_url=pdf_url,
            is_oa=bool(open_access.get("is_oa")),
            fwci=float(item["fwci"]) if item.get("fwci") is not None else None,
            institutions=institutions[:12],
            keywords=keywords[:12],
            counts_by_year=item.get("counts_by_year") or [],
            references_count=len(item.get("referenced_works") or []),
            related_count=len(item.get("related_works") or []),
        )
