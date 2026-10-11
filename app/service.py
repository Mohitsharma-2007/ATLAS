from __future__ import annotations

import asyncio
import hashlib
import json
import re
from typing import Any

from app.embeddings import cosine_similarity, embed_text
from app.documents import chunk_rows, extract_document
from app.graph import Neo4jGraph
from app.llm import LLMClient
from app.models import Paper
from app.openalex import OpenAlexClient


METHOD_PATTERNS = [
    "retrieval-augmented generation",
    "retrieval augmented generation",
    "vector database",
    "knowledge graph",
    "episodic memory",
    "semantic memory",
    "working memory",
    "long-term memory",
    "reflection",
    "experience replay",
    "reinforcement learning",
    "self-supervised learning",
    "chain-of-thought",
    "tool use",
    "multi-agent",
    "attention mechanism",
]


def fallback_enrichment(paper: Paper) -> None:
    text = f"{paper.title}. {paper.abstract}".lower()
    paper.methods = [term for term in METHOD_PATTERNS if term in text][:5]

    limitation_sentences: list[str] = []
    for sentence in re.split(r"(?<=[.!?])\s+", paper.abstract):
        normalized = sentence.strip()
        if len(normalized) < 30:
            continue
        if re.search(r"\b(limit|limitation|however|challenge|drawback|lack|future work|cannot|fails?)\w*\b", normalized, re.I):
            limitation_sentences.append(normalized[:320])
    paper.limitations = limitation_sentences[:4]


def paper_from_record(record: dict[str, Any]) -> Paper:
    raw_authors = record.get("authors") or []
    authors = [author if isinstance(author, dict) else {"name": author} for author in raw_authors]
    related = record.get("related") or [
        {"title": title} for title in (record.get("related_titles") or [])
    ]
    counts_by_year = record.get("counts_by_year") or []
    if isinstance(counts_by_year, str):
        try:
            counts_by_year = json.loads(counts_by_year)
        except json.JSONDecodeError:
            counts_by_year = []
    return Paper(
        openalex_id=record["openalex_id"],
        title=record.get("title") or "Untitled paper",
        abstract=record.get("abstract") or "",
        year=record.get("year"),
        doi=record.get("doi") or "",
        url=record.get("url") or "",
        cited_by_count=int(record.get("cited_by_count") or 0),
        authors=authors,
        concepts=record.get("concepts") or [],
        methods=record.get("methods") or [],
        limitations=record.get("limitations") or [],
        embedding=record.get("embedding") or [],
        related=related,
        graph_id=record.get("graph_id") or "",
        publication_date=record.get("publication_date") or "",
        work_type=record.get("work_type") or record.get("type") or "",
        language=record.get("language") or "",
        journal=record.get("journal") or "",
        pdf_url=record.get("pdf_url") or "",
        is_oa=bool(record.get("is_oa")),
        fwci=float(record["fwci"]) if record.get("fwci") is not None else None,
        institutions=record.get("institutions") or [],
        keywords=record.get("keywords") or [],
        counts_by_year=counts_by_year,
        references_count=int(record.get("references_count") or 0),
        related_count=int(record.get("related_count") or 0),
    )


class ResearchService:
    def __init__(self, openalex: OpenAlexClient, graph: Neo4jGraph, llm: LLMClient, dimensions: int) -> None:
        self.openalex = openalex
        self.graph = graph
        self.llm = llm
        self.dimensions = dimensions
        self.insight_cache: dict[str, dict[str, Any]] = {}

    async def discover_and_ingest(self, topic: str, limit: int = 8) -> dict[str, Any]:
        papers = await self.openalex.search(topic, limit)
        extracted = await self.llm.extract_many(papers)
        for paper in papers:
            enrichment = extracted.get(paper.openalex_id, {})
            paper.methods = enrichment.get("methods", [])
            paper.limitations = enrichment.get("limitations", [])
            if not paper.methods and not paper.limitations:
                fallback_enrichment(paper)
            paper.embedding = embed_text(paper.text_for_embedding(), self.dimensions)
        if not self.graph.connected:
            return {
                "topic": topic,
                "count": len(papers),
                "papers": [paper.as_source() for paper in papers],
                "stats": await self.graph.stats(),
                "stored": False,
                "storage_message": self.graph.connection_message,
            }
        await self.graph.upsert_papers(papers)
        await self._link_similar(papers)
        return {
            "topic": topic,
            "count": len(papers),
            "papers": [paper.as_source() for paper in papers],
            "stats": await self.graph.stats(),
            "stored": True,
            "storage_message": "Papers and relationships stored in Neo4j Aura.",
        }

    async def _link_similar(self, new_papers: list[Paper]) -> None:
        if len(new_papers) < 2:
            return
        links: list[dict[str, Any]] = []
        for index, left in enumerate(new_papers):
            scored = sorted(
                (
                    (cosine_similarity(left.embedding, right.embedding), right)
                    for right_index, right in enumerate(new_papers)
                    if right_index != index
                ),
                key=lambda pair: pair[0],
                reverse=True,
            )
            for score, right in scored[:2]:
                if score > 0.1:
                    links.append({"left": left.openalex_id, "right": right.openalex_id, "score": round(score, 4)})
        await self.graph.link_related(links)

    async def answer(self, question: str) -> dict[str, Any]:
        if not self.graph.connected:
            raise RuntimeError(self.graph.connection_message)
        records = await self.graph.all_papers()
        query_embedding = embed_text(question, self.dimensions)
        ranked: list[tuple[float, Paper]] = []
        for record in records:
            paper = paper_from_record(record)
            score = cosine_similarity(query_embedding, paper.embedding)
            ranked.append((score, paper))
        ranked.sort(key=lambda item: (item[0], item[1].cited_by_count), reverse=True)
        selected = ranked[:8]
        evidence_parts: list[str] = []
        sources: list[dict[str, Any]] = []
        for position, (score, paper) in enumerate(selected, start=1):
            citation = f"P{position}"
            sources.append(paper.as_source(citation))
            evidence_parts.append(
                "\n".join(
                    [
                        f"[{citation}] {paper.title} ({paper.year or 'year unknown'}); retrieval score={score:.3f}",
                        f"Authors: {', '.join(author.get('name', '') for author in paper.authors) or 'not listed'}",
                        f"Concepts: {', '.join(paper.concepts) or 'not listed'}",
                        f"Methods: {', '.join(paper.methods) or 'not explicitly extracted'}",
                        f"Limitations: {' | '.join(paper.limitations) or 'not explicitly identified in the abstract'}",
                        f"Abstract: {paper.abstract[:1200] or 'No abstract available.'}",
                        f"Related papers in graph: {', '.join(item['title'] for item in paper.related) or 'none'}",
                    ]
                )
            )
        evidence = "\n\n".join(evidence_parts)
        answer = await self.llm.synthesize(question, evidence) if evidence else None
        used_llm = bool(answer)
        if not answer:
            answer = self._fallback_answer(question, selected)
        return {"question": question, "answer": answer, "sources": sources, "used_llm": used_llm}

    @staticmethod
    def _paper_evidence(paper: Paper, citation: str = "P1") -> str:
        return "\n".join(
            [
                f"[{citation}] {paper.title} ({paper.year or 'year unknown'})",
                f"Authors: {', '.join(author.get('name', '') for author in paper.authors) or 'not listed'}",
                f"Concepts: {', '.join(paper.concepts) or 'not listed'}",
                f"Methods: {', '.join(paper.methods) or 'not explicitly extracted'}",
                f"Limitations: {' | '.join(paper.limitations) or 'not explicitly identified in the abstract'}",
                f"Citation count: {paper.cited_by_count}",
                f"Abstract: {paper.abstract[:9000] or 'No abstract available.'}",
            ]
        )

    def _record_evidence(self, record: dict[str, Any], label: str) -> tuple[str, list[dict]]:
        paper = paper_from_record(record)
        source = paper.as_source(label)
        source.update({"locator": "OpenAlex abstract / metadata", "excerpt": paper.abstract[:9000]})
        sources = [source]
        sections = [self._paper_evidence(paper, label)]
        # Deterministic IDs, stable reference order, and a bounded evidence budget.
        excerpts = sorted(record.get("excerpts") or [], key=lambda item: item["id"])[:4]
        for index, excerpt in enumerate(excerpts, 1):
            citation = f"{label}-E{index}"
            text = excerpt["text"][:8000]
            sections.append(f"[{citation}] User-provided excerpt, {excerpt['locator']}:\n{text}")
            sources.append({**paper.as_source(citation), "locator": excerpt["locator"],
                            "excerpt": text, "evidence_id": excerpt["id"],
                            "provenance": "user-provided excerpt"})
        document_chunks = sorted(record.get("document_chunks") or [], key=lambda item: item["id"])[:8]
        offset = len(excerpts)
        for index, chunk in enumerate(document_chunks, 1):
            citation = f"{label}-E{offset + index}"
            text = chunk["text"][:8000]
            sections.append(f"[{citation}] Uploaded document excerpt, {chunk['locator']}:\n{text}")
            sources.append({**paper.as_source(citation), "locator": chunk["locator"],
                            "excerpt": text, "evidence_id": chunk["id"],
                            "provenance": chunk.get("provenance", "uploaded document")})
        return "\n\n".join(sections), sources

    async def _paper_context(self, record: dict[str, Any]) -> tuple[str, list[dict], list[dict]]:
        evidence, sources = self._record_evidence(record, "P1")
        paths = await self.graph.connected_papers(record["openalex_id"])
        neighbors = await asyncio.gather(*(self.graph.paper_detail(path["openalex_id"]) for path in paths))
        for index, (path, neighbor) in enumerate(zip(paths, neighbors), 1):
            if not neighbor:
                continue
            context, related_sources = self._record_evidence(neighbor, f"R{index}")
            evidence += f"\n\nGraph path(s): {path['paths']}\n{context}"
            sources.extend(related_sources)
        return evidence, sources, paths

    @staticmethod
    def _sanitize_citations(text: str, sources: list[dict]) -> str:
        """Sanitize citation tags to match loaded sources without discarding valid model responses."""
        if not text:
            return ""
        allowed = {s["citation"] for s in sources if isinstance(s, dict) and "citation" in s}
        if not allowed:
            return text
        found = set(re.findall(r"\[((?:P|R)\d+(?:-E\d+)?)\]", text))
        invalid = found - allowed
        if invalid:
            # Remove or clean tags that do not belong to the allowed sources
            return re.sub(
                r"\[((?:P|R)\d+(?:-E\d+)?)\]",
                lambda m: m.group(0) if m.group(1) in allowed else "",
                text,
            )
        return text

    async def list_papers(self, limit: int = 50) -> list[dict[str, Any]]:
        if not self.graph.connected:
            return []
        records = await self.graph.all_papers()
        papers = [paper_from_record(record) for record in records[:limit]]
        return [paper.as_source() for paper in papers]

    async def paper_insights(self, openalex_id: str) -> dict[str, Any]:
        if not self.graph.connected:
            raise RuntimeError(self.graph.connection_message)
        record = await self.graph.paper_detail(openalex_id)
        if not record:
            raise LookupError("That paper is not in the graph yet. Discover its topic first.")
        paper = paper_from_record(record)
        evidence, sources, paths = await self._paper_context(record)
        cache_key = hashlib.sha256(evidence.encode()).hexdigest()
        if cache_key in self.insight_cache:
            return self.insight_cache[cache_key]
        insights = await self.llm.analyze_paper(paper, evidence)
        used_llm = bool(insights and insights.get("summary"))
        if not insights or not insights.get("summary"):
            insights = self._fallback_insights(paper)
        result = {
            "paper": paper.as_source(),
            "graph_id": record.get("graph_id"),
            "citations": record.get("citations") or [],
            "cited_by": record.get("cited_by") or [],
            "related": record.get("related") or [],
            "insights": insights,
            "sources": sources,
            "paths": paths,
            "used_llm": used_llm,
            "evidence_scope": "Abstracts and explicitly attached excerpts; full PDFs have not been ingested.",
        }
        if used_llm:
            if len(self.insight_cache) >= 64:
                self.insight_cache.pop(next(iter(self.insight_cache)))
            self.insight_cache[cache_key] = result
        return result

    async def paper_chat(self, openalex_id: str, question: str, history: list[dict] | None = None) -> dict[str, Any]:
        if not self.graph.connected:
            raise RuntimeError(self.graph.connection_message)
        record = await self.graph.paper_detail(openalex_id)
        if not record:
            raise LookupError("That paper is not in the graph yet. Discover its topic first.")
        paper = paper_from_record(record)
        evidence, sources, paths = await self._paper_context(record)
        response = await self.llm.paper_chat(question, evidence, history)
        if response:
            response = self._sanitize_citations(response, sources)
        used_llm = bool(response)
        if not response:
            response = self._fallback_paper_chat(paper, question)
        return {
            "paper": paper.as_source("P1"),
            "question": question,
            "answer": response,
            "sources": sources,
            "paths": paths,
            "used_llm": used_llm,
        }

    async def add_evidence(self, openalex_id: str, locator: str, text: str) -> dict:
        if not self.graph.connected:
            raise RuntimeError(self.graph.connection_message)
        record = await self.graph.paper_detail(openalex_id)
        if not record:
            raise LookupError("Paper not found")
        excerpt_id = hashlib.sha256(f"{openalex_id}:{locator}:{text}".encode()).hexdigest()[:24]
        if len(record.get("excerpts") or []) >= 4 and not any(
            item["id"] == excerpt_id for item in record["excerpts"]
        ):
            raise ValueError("A paper can contain up to four evidence excerpts. Use focused methods/results sections.")
        result = await self.graph.add_excerpt(openalex_id, locator, text)
        self.insight_cache.clear()
        return result

    async def ingest_document(
        self,
        data: bytes,
        filename: str,
        content_type: str = "",
        paper_id: str = "",
    ) -> dict[str, Any]:
        if not self.graph.connected:
            raise RuntimeError(self.graph.connection_message)
        document_id, chunks = extract_document(data, filename, content_type)
        rows = chunk_rows(document_id, chunks)
        result = await self.graph.store_document(document_id, filename, content_type, rows, paper_id)
        self.insight_cache.clear()
        return {
            **result,
            "paper_id": paper_id,
            "evidence_scope": "Uploaded, page-aware text chunks stored in Neo4j Aura.",
        }

    async def compare_papers(self, openalex_ids: list[str], question: str) -> dict[str, Any]:
        if not self.graph.connected:
            raise RuntimeError(self.graph.connection_message)
        records = await asyncio.gather(*(self.graph.paper_detail(openalex_id) for openalex_id in openalex_ids))
        if any(record is None for record in records) or len(set(openalex_ids)) < 2:
            raise LookupError("Every selected paper must be present in the graph; choose at least two distinct papers.")
        papers = [paper_from_record(record) for record in records]
        contexts = [self._record_evidence(record, f"P{index}") for index, record in enumerate(records, 1)]
        evidence = "\n\n".join(context for context, _ in contexts)
        sources = [source for _, items in contexts for source in items]
        prompt = (
            f"{question}\n\n"
            "Provide an exhaustive, in-depth, and rigorous research comparison across these papers in rich GitHub-flavored Markdown. "
            "Do not provide a brief summary; provide a comprehensive comparative analysis structured as follows:\n\n"
            "## 1. Executive Summary & Comparative Takeaways\n"
            "- Core problem each paper addresses\n"
            "- The conceptual divergence in their technical approaches\n"
            "- High-level takeaway for researchers and practitioners\n\n"
            "## 2. Comprehensive Systematic Comparison Table\n"
            "Provide a complete Markdown table comparing:\n"
            "| Evaluation Dimension | " + " | ".join(f"[P{i}] {paper.title[:30]}..." for i, paper in enumerate(papers, 1)) + " | Key Differentiator |\n"
            "Include rows for:\n"
            "- Primary Problem & Objective\n"
            "- Core Architecture & Algorithms\n"
            "- Memory Hierarchy / Strategy (e.g., episodic, working, graph, zero-token)\n"
            "- Evaluation Datasets & Benchmarks\n"
            "- Reported Performance & Empirical Gains\n"
            "- Scalability & Compute Overhead\n"
            "- Concrete Limitations & Vulnerabilities\n"
            "- Community Adoption & Citations\n\n"
            "## 3. In-Depth Per-Paper Technical Breakdown\n"
            "For each paper ([P1], [P2], etc.), detail:\n"
            "- Technical Architecture & Mechanism\n"
            "- Concrete Methods Used\n"
            "- Empirical Findings & Setup\n"
            "- Specific Limitations Reported by Authors or Inherent to Design\n\n"
            "## 4. Architectural & Algorithmic Trade-offs\n"
            "- Efficiency vs Adaptability trade-offs\n"
            "- Implementation complexity and token/time costs\n"
            "- Generalization across domains\n\n"
            "## 5. Synthesis, Open Challenges & Future Hypotheses\n"
            "- Unresolved bottlenecks in the literature\n"
            "- Actionable hypotheses and suggested experiments (labeled clearly as proposals)\n\n"
            "Cite every claim with [P1], [P2], [P1-E1], etc."
        )
        response = await self.llm.synthesize(prompt, evidence) if self.llm.available else None
        if response:
            response = self._sanitize_citations(response, sources)
        used_llm = bool(response)
        if not response:
            response = self._fallback_comparison(papers)
        return {
            "question": question,
            "answer": response,
            "papers": [paper.as_source(f"P{index}") for index, paper in enumerate(papers, start=1)],
            "sources": sources,
            "used_llm": used_llm,
        }

    @staticmethod
    def _fallback_insights(paper: Paper) -> dict[str, Any]:
        abstract_sentence = re.split(r"(?<=[.!?])\s+", paper.abstract.strip())[0] if paper.abstract else "The abstract is not available in the graph."
        methods = paper.methods
        limitations = paper.limitations or ["No explicit limitation was identified in the available abstract."]
        return {
            "summary": f"Abstract excerpt (AI guide unavailable): {abstract_sentence} [P1]",
            "why_it_matters": f"Indexed concepts: {', '.join(paper.concepts[:4]) or 'not provided'} [P1]",
            "problem": "A reliable problem explanation requires a successful AI response or more paper evidence.",
            "what_was_done": [f"Extracted method candidate: {method} [P1]" for method in methods]
                or ["Not established from the available metadata."],
            "how_it_works": ["Read the available abstract below; a detailed method explanation is unavailable."],
            "limitations": [f"{item} [P1]" for item in limitations],
            "what_is_left": ["Author-reported future work has not been established from the available evidence."],
            "what_you_can_do": ["Suggested experiment (not an author claim): reproduce the original setup before testing a new domain."],
            "improvement_ideas": ["Suggested experiment (not an author claim): design an ablation to isolate the method's contribution."],
            "hard_terms": [],
        }

    @staticmethod
    def _fallback_paper_chat(paper: Paper, question: str) -> str:
        return (
            f"[P1] {paper.title} is the selected paper. Based on the available abstract, "
            f"the most relevant evidence for your question is: {paper.abstract[:900] or 'No abstract is available.'}\n\n"
            f"The extracted methods are {', '.join(paper.methods) or 'not explicit'}, and the recorded limitations are "
            f"{'; '.join(paper.limitations) or 'not explicit in the abstract'}. For a stronger answer to “{question}”, "
            "open the full paper and add its experiments or tables to the graph evidence."
        )

    @staticmethod
    def _fallback_comparison(papers: list[Paper]) -> str:
        sections = [
            "# Systematic Comparative Analysis of Selected Literature",
            "",
            "## 1. Executive Summary & Overview",
            f"This comparative evaluation examines {len(papers)} research papers grounded in metadata, extracted approaches, and indexed relationships stored in Neo4j Aura.",
            "",
            "## 2. Systematic Comparison Matrix",
            "",
        ]

        # Build comprehensive markdown table
        headers = ["Dimension"] + [f"[P{i}] {p.title[:28]}..." for i, p in enumerate(papers, 1)] + ["Differentiator"]
        sections.append("| " + " | ".join(headers) + " |")
        sections.append("| " + " | ".join(["---"] * len(headers)) + " |")

        # Table rows
        dimensions = [
            ("Core Focus", lambda p: ", ".join(p.concepts[:3]) or "General AI"),
            ("Year & Venue", lambda p: f"{p.year or 'N/A'} ({p.journal or 'Preprint/ArXiv'})"),
            ("Extracted Methods", lambda p: ", ".join(p.methods[:3]) or "Heuristic / Standard"),
            ("Primary Limitations", lambda p: short_str(p.limitations[0] if p.limitations else "Abstract limitation unstated", 45)),
            ("Citation Count", lambda p: f"{p.cited_by_count} citations"),
            ("Open Access", lambda p: "Yes (Open Access)" if p.is_oa else "Restricted / Proprietary"),
        ]

        def short_str(s, length):
            return s if len(s) <= length else s[:length-3] + "..."

        for dim_name, accessor in dimensions:
            row = [dim_name]
            for p in papers:
                row.append(accessor(p).replace("|", "/"))
            # Differentiator column
            row.append(f"Distinct approaches to {dim_name.lower()}")
            sections.append("| " + " | ".join(row) + " |")

        sections.extend([
            "",
            "## 3. In-Depth Per-Paper Evidence Breakdown",
            "",
        ])

        for index, paper in enumerate(papers, start=1):
            methods_str = ", ".join(paper.methods) if paper.methods else "Methods were not explicitly isolated in the abstract."
            limits_str = "; ".join(paper.limitations) if paper.limitations else "No explicit limitation was reported in the available abstract."
            authors_str = ", ".join((a.get("name", "") if isinstance(a, dict) else str(a)) for a in paper.authors[:4]) or "Authors unlisted"
            concepts_str = ", ".join(paper.concepts[:6]) or "Uncategorized"

            sections.extend([
                f"### [P{index}] {paper.title} ({paper.year or 'Year unknown'})",
                f"- **Authors:** {authors_str} [P{index}]",
                f"- **Venue / Source:** {paper.journal or 'Research Repository'} | **Citations:** {paper.cited_by_count} [P{index}]",
                f"- **Core Concepts:** {concepts_str} [P{index}]",
                f"- **Key Approaches & Methods:** {methods_str} [P{index}]",
                f"- **Documented Limitations & Gaps:** {limits_str} [P{index}]",
                f"- **Abstract Context:** {paper.abstract[:800]}... [P{index}]" if paper.abstract else f"- **Abstract Context:** Abstract not available. [P{index}]",
                "",
            ])

        sections.extend([
            "## 4. Architectural Trade-offs & Open Research Gaps",
            "- **Memory Persistence vs Compute Cost:** Approaches integrating persistent graph databases or structured indexing face trade-offs between dynamic contextual updating and runtime latency.",
            "- **Evaluation Standard:** Numerical performance comparisons require identical benchmarks, splits, and metrics. Because abstracts report differing setups, full-paper experimental tables should be attached to ground numeric claims.",
            "- **Suggested Next Steps (Hypothesis):** A unified hybrid system combining the dynamic indexing of [P1] with the token-efficiency techniques of [P2] presents a compelling avenue for ablation testing.",
        ])

        return "\n".join(sections)

    @staticmethod
    def _fallback_answer(question: str, ranked: list[tuple[float, Paper]]) -> str:
        if not ranked:
            return "No papers have been ingested yet. Discover a topic first."
        lines = [
            f"I found {len(ranked)} relevant papers for: {question}",
            "",
            "Approaches and evidence:",
        ]
        for position, (_, paper) in enumerate(ranked, start=1):
            methods = ", ".join(paper.methods) if paper.methods else "methods were not explicit in the available metadata"
            limitations = "; ".join(paper.limitations) if paper.limitations else "no explicit limitation was identified in the abstract"
            lines.append(f"- [P{position}] {paper.title}: approaches include {methods}. Limitations: {limitations}.")
        lines.extend(["", "The linked papers, authors, concepts, methods, and limitations are available in the source cards below."])
        return "\n".join(lines)
