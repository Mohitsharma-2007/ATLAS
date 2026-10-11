from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any

import httpx
from neo4j import AsyncGraphDatabase

from app.models import Paper


class Neo4jGraph:
    def __init__(
        self,
        uri: str,
        username: str,
        password: str,
        database: str,
        dimensions: int,
        connection_timeout: float = 5,
        query_api_url: str = "",
    ) -> None:
        self.uri = uri
        self.username = username
        self.password = password
        self.database = database
        self.dimensions = dimensions
        self.connection_timeout = connection_timeout
        self.query_api_url = query_api_url
        self.driver = None
        self.connected = False
        self.query_api_available = False
        self.connection_message = "Neo4j has not connected yet."

    async def connect(self) -> bool:
        if not self.password or "YOUR_AURA_INSTANCE" in self.uri:
            self.connection_message = "Copy the connection URI from your Aura instance into NEO4J_URI in .env."
            return False
        try:
            self.driver = AsyncGraphDatabase.driver(
                self.uri,
                auth=(self.username, self.password),
                connection_timeout=self.connection_timeout,
            )
            await asyncio.wait_for(self.driver.verify_connectivity(), timeout=12)
            # Connectivity alone doesn't verify the configured database exists.
            async with self.driver.session(database=self.database) as session:
                result = await session.run("RETURN 1 AS connected")
                await result.consume()
            self.query_api_available = await self._verify_query_api()
            await self.ensure_schema()
            self.connected = True
            self.connection_message = "Connected to Aura via Bolt and Query API v2." if self.query_api_available else "Connected to the configured Aura database via Bolt."
            return True
        except Exception as error:
            code = getattr(error, "code", "")
            if "Unauthorized" in code:
                self.connection_message = "Aura rejected the database username/password. Check the Aura credentials file."
            elif "DatabaseNotFound" in code:
                self.connection_message = "The configured database does not exist. Aura normally uses NEO4J_DATABASE=neo4j."
            else:
                self.connection_message = "Could not connect to Aura. Check its URI, running status and network access."
            await self.close()
            return False

    async def _verify_query_api(self) -> bool:
        if not self.query_api_url:
            return False
        try:
            async with httpx.AsyncClient(timeout=self.connection_timeout) as client:
                response = await client.post(
                    self.query_api_url,
                    auth=(self.username, self.password),
                    json={"statement": "RETURN 1 AS connected", "parameters": {}},
                )
                response.raise_for_status()
            return True
        except httpx.HTTPError:
            return False

    async def close(self) -> None:
        if self.driver:
            await self.driver.close()
        self.driver = None
        self.connected = False
        self.query_api_available = False

    async def ensure_schema(self) -> None:
        if not self.driver:
            return
        constraints = [
            "CREATE CONSTRAINT paper_openalex_id IF NOT EXISTS FOR (p:Paper) REQUIRE p.openalex_id IS UNIQUE",
            "CREATE CONSTRAINT author_openalex_id IF NOT EXISTS FOR (a:Author) REQUIRE a.openalex_id IS UNIQUE",
            "CREATE CONSTRAINT concept_name IF NOT EXISTS FOR (c:Concept) REQUIRE c.name IS UNIQUE",
            "CREATE CONSTRAINT method_name IF NOT EXISTS FOR (m:Method) REQUIRE m.name IS UNIQUE",
            "CREATE CONSTRAINT limitation_statement IF NOT EXISTS FOR (l:Limitation) REQUIRE l.statement IS UNIQUE",
            "CREATE CONSTRAINT source_name IF NOT EXISTS FOR (s:Source) REQUIRE s.name IS UNIQUE",
            "CREATE CONSTRAINT excerpt_id IF NOT EXISTS FOR (e:Excerpt) REQUIRE e.id IS UNIQUE",
            "CREATE CONSTRAINT document_id IF NOT EXISTS FOR (d:Document) REQUIRE d.id IS UNIQUE",
            "CREATE CONSTRAINT chunk_id IF NOT EXISTS FOR (c:Chunk) REQUIRE c.id IS UNIQUE",
        ]
        async with self.driver.session(database=self.database) as session:
            for query in constraints:
                try:
                    result = await session.run(query)
                    await result.consume()
                except Exception:
                    # A pre-existing constraint or an older Neo4j syntax should not
                    # prevent the remaining schema from being attempted.
                    continue
            try:
                result = await session.run(
                    f"""
                    CREATE VECTOR INDEX paper_embedding IF NOT EXISTS
                    FOR (p:Paper) ON (p.embedding)
                    OPTIONS {{indexConfig: {{
                        `vector.dimensions`: {self.dimensions},
                        `vector.similarity_function`: 'cosine'
                    }}}}
                    """
                )
                await result.consume()
            except Exception:
                # Older Neo4j versions can still store and retrieve the vector.
                pass

    async def upsert_papers(self, papers: list[Paper]) -> None:
        if not self.driver or not papers:
            return
        rows = [
            {
                "openalex_id": paper.openalex_id,
                "title": paper.title,
                "abstract": paper.abstract,
                "year": paper.year,
                "doi": paper.doi,
                "url": paper.url,
                "cited_by_count": paper.cited_by_count,
                "publication_date": paper.publication_date,
                "work_type": paper.work_type,
                "language": paper.language,
                "journal": paper.journal,
                "pdf_url": paper.pdf_url,
                "is_oa": paper.is_oa,
                "fwci": paper.fwci,
                "institutions": paper.institutions,
                "keywords": paper.keywords,
                "counts_by_year": json.dumps(paper.counts_by_year),
                "references_count": paper.references_count,
                "related_count": paper.related_count,
                "embedding": paper.embedding,
                "authors": paper.authors,
                "concepts": paper.concepts,
                "methods": paper.methods,
                "limitations": paper.limitations,
                "source_name": paper.source_name,
            }
            for paper in papers
        ]
        query = """
        UNWIND $rows AS row
        MERGE (p:Paper {openalex_id: row.openalex_id})
        SET p.title = row.title,
            p.abstract = row.abstract,
            p.year = row.year,
            p.doi = row.doi,
            p.url = row.url,
            p.cited_by_count = row.cited_by_count,
            p.publication_date = row.publication_date,
            p.work_type = row.work_type,
            p.language = row.language,
            p.journal = row.journal,
            p.pdf_url = row.pdf_url,
            p.is_oa = row.is_oa,
            p.fwci = row.fwci,
            p.institutions = row.institutions,
            p.keywords = row.keywords,
            p.counts_by_year = row.counts_by_year,
            p.references_count = row.references_count,
            p.related_count = row.related_count,
            p.embedding = row.embedding,
            p.updated_at = datetime()
        MERGE (s:Source {name: row.source_name})
        MERGE (p)-[:FROM_SOURCE]->(s)
        FOREACH (author IN row.authors |
            MERGE (a:Author {openalex_id: author.openalex_id})
            SET a.name = author.name
            MERGE (p)-[:AUTHORED_BY]->(a)
        )
        FOREACH (concept IN row.concepts |
            MERGE (c:Concept {name: concept})
            MERGE (p)-[:ABOUT]->(c)
        )
        FOREACH (method IN row.methods |
            MERGE (m:Method {name: method})
            MERGE (p)-[:USES_METHOD]->(m)
        )
        FOREACH (limitation IN row.limitations |
            MERGE (l:Limitation {statement: limitation})
            MERGE (p)-[:HAS_LIMITATION]->(l)
        )
        """
        async with self.driver.session(database=self.database) as session:
            result = await session.run(query, rows=rows)
            await result.consume()

        references = [
            {"source": paper.openalex_id, "target": reference}
            for paper in papers
            for reference in paper.referenced_works
        ]
        if references:
            async with self.driver.session(database=self.database) as session:
                result = await session.run(
                    """
                    UNWIND $references AS item
                    MATCH (source:Paper {openalex_id: item.source})
                    MATCH (target:Paper {openalex_id: item.target})
                    MERGE (source)-[:CITES]->(target)
                    """,
                    references=references,
                )
                await result.consume()

    async def link_related(self, links: list[dict[str, Any]]) -> None:
        if not self.driver or not links:
            return
        async with self.driver.session(database=self.database) as session:
            result = await session.run(
                """
                UNWIND $links AS item
                MATCH (left:Paper {openalex_id: item.left})
                MATCH (right:Paper {openalex_id: item.right})
                MERGE (left)-[relation:RELATED_TO]->(right)
                SET relation.score = item.score
                """,
                links=links,
            )
            await result.consume()

    async def all_papers(self) -> list[dict[str, Any]]:
        if not self.driver:
            return []
        query = """
        MATCH (p:Paper)
        RETURN p.openalex_id AS openalex_id, p.title AS title, p.abstract AS abstract,
               p.year AS year, p.doi AS doi, p.url AS url,
               p.cited_by_count AS cited_by_count, p.embedding AS embedding,
               p.publication_date AS publication_date, p.work_type AS work_type,
               p.language AS language, p.journal AS journal, p.pdf_url AS pdf_url,
               p.is_oa AS is_oa, p.fwci AS fwci, p.institutions AS institutions,
               p.keywords AS keywords, p.counts_by_year AS counts_by_year,
               p.references_count AS references_count, p.related_count AS related_count,
               elementId(p) AS graph_id,
               [(p)-[:AUTHORED_BY]->(a:Author) | a.name] AS authors,
               [(p)-[:ABOUT]->(c:Concept) | c.name] AS concepts,
               [(p)-[:USES_METHOD]->(m:Method) | m.name] AS methods,
               [(p)-[:HAS_LIMITATION]->(l:Limitation) | l.statement] AS limitations,
               [(p)-[:RELATED_TO]-(related:Paper) | related.title] AS related_titles
        ORDER BY p.cited_by_count DESC
        """
        async with self.driver.session(database=self.database) as session:
            result = await session.run(query)
            return await result.data()

    async def paper_detail(self, openalex_id: str) -> dict[str, Any] | None:
        """Load one paper with its connected research evidence."""
        if not self.driver:
            return None
        query = """
        MATCH (p:Paper {openalex_id: $openalex_id})
        RETURN elementId(p) AS graph_id,
               p.openalex_id AS openalex_id, p.title AS title, p.abstract AS abstract,
               p.year AS year, p.doi AS doi, p.url AS url,
               p.cited_by_count AS cited_by_count,
               p.publication_date AS publication_date, p.work_type AS work_type,
               p.language AS language, p.journal AS journal, p.pdf_url AS pdf_url,
               p.is_oa AS is_oa, p.fwci AS fwci, p.institutions AS institutions,
               p.keywords AS keywords, p.counts_by_year AS counts_by_year,
               p.references_count AS references_count, p.related_count AS related_count,
               [(p)-[:AUTHORED_BY]->(a:Author) | {name: a.name, openalex_id: a.openalex_id}] AS authors,
               [(p)-[:ABOUT]->(c:Concept) | c.name] AS concepts,
               [(p)-[:USES_METHOD]->(m:Method) | m.name] AS methods,
               [(p)-[:HAS_LIMITATION]->(l:Limitation) | l.statement] AS limitations,
               [(p)-[:CITES]->(cited:Paper) | {openalex_id: cited.openalex_id, title: cited.title, year: cited.year}] AS citations,
               [(p)<-[:CITES]-(cited_by:Paper) | {openalex_id: cited_by.openalex_id, title: cited_by.title, year: cited_by.year}] AS cited_by,
                [(p)-[related:RELATED_TO]-(related_paper:Paper) | {openalex_id: related_paper.openalex_id, title: related_paper.title, score: related.score}] AS related,
                [(p)-[:HAS_EVIDENCE]->(e:Excerpt) | {id: e.id, locator: e.locator, text: e.text, provenance: e.provenance}] AS excerpts,
                [(p)<-[:ABOUT_PAPER]-(d:Document)-[:HAS_CHUNK]->(chunk:Chunk) | {id: chunk.id, locator: chunk.locator, text: chunk.text, provenance: d.provenance}] AS document_chunks
        """
        async with self.driver.session(database=self.database) as session:
            result = await session.run(query, openalex_id=openalex_id)
            records = await result.data()
        return records[0] if records else None

    async def add_excerpt(self, openalex_id: str, locator: str, text: str) -> dict[str, Any]:
        from app.embeddings import embed_text

        excerpt_id = hashlib.sha256(f"{openalex_id}:{locator}:{text}".encode()).hexdigest()[:24]
        async with self.driver.session(database=self.database) as session:
            result = await session.run(
                """
                MATCH (p:Paper {openalex_id: $paper_id})
                MERGE (e:Excerpt {id: $id})
                SET e.locator = $locator, e.text = $text, e.embedding = $embedding,
                    e.provenance = 'user-provided excerpt'
                MERGE (p)-[:HAS_EVIDENCE]->(e)
                RETURN e.id AS id, e.locator AS locator, e.text AS text
                """,
                paper_id=openalex_id, id=excerpt_id, locator=locator, text=text,
                embedding=embed_text(text, self.dimensions),
            )
            record = await result.single()
        if not record:
            raise LookupError("Paper not found")
        return dict(record)

    async def store_document(
        self,
        document_id: str,
        filename: str,
        mime_type: str,
        chunks: list[dict[str, Any]],
        paper_id: str = "",
    ) -> dict[str, Any]:
        from app.embeddings import embed_text

        if not self.driver:
            raise RuntimeError("Neo4j is not connected.")
        rows = [{**chunk, "embedding": embed_text(chunk["text"], self.dimensions)} for chunk in chunks]
        async with self.driver.session(database=self.database) as session:
            result = await session.run(
                """
                MERGE (d:Document {id: $document_id})
                SET d.filename = $filename, d.mime_type = $mime_type,
                    d.chunk_count = size($chunks), d.updated_at = datetime(),
                    d.provenance = 'user-uploaded research paper'
                WITH d
                UNWIND $chunks AS chunk
                MERGE (c:Chunk {id: chunk.id})
                SET c.locator = chunk.locator, c.text = chunk.text,
                    c.embedding = chunk.embedding, c.document_id = $document_id
                MERGE (d)-[:HAS_CHUNK]->(c)
                RETURN d.id AS document_id, d.filename AS filename, count(c) AS chunks
                """,
                document_id=document_id,
                filename=filename,
                mime_type=mime_type or "application/octet-stream",
                chunks=rows,
            )
            record = await result.single()
            if paper_id:
                link = await session.run(
                    """
                    MATCH (d:Document {id: $document_id})
                    MATCH (p:Paper {openalex_id: $paper_id})
                    MERGE (d)-[:ABOUT_PAPER]->(p)
                    RETURN p.openalex_id AS paper_id
                    """,
                    document_id=document_id,
                    paper_id=paper_id,
                )
                linked = await link.single()
                if not linked:
                    raise LookupError("The selected paper was not found in Neo4j.")
        return dict(record) if record else {"document_id": document_id, "filename": filename, "chunks": len(rows)}

    async def connected_papers(self, openalex_id: str) -> list[dict[str, Any]]:
        """Bounded two-hop traversal, with actual paths for provenance."""
        async with self.driver.session(database=self.database) as session:
            result = await session.run(
                """
                MATCH (p:Paper {openalex_id: $paper_id})
                MATCH path=(p)-[:CITES|RELATED_TO|ABOUT|USES_METHOD|AUTHORED_BY|HAS_LIMITATION*1..2]-(q:Paper)
                WHERE q <> p
                WITH q, min(length(path)) AS hops, collect(DISTINCT
                    [r IN relationships(path) | type(r)])[0..3] AS paths
                RETURN q.openalex_id AS openalex_id, q.title AS title, hops, paths
                ORDER BY hops, q.cited_by_count DESC LIMIT 4
                """, paper_id=openalex_id,
            )
            return await result.data()

    async def library(self) -> list[dict[str, Any]]:
        if not self.driver:
            return []
        async with self.driver.session(database=self.database) as session:
            result = await session.run(
                """
                MATCH (p:Paper) RETURN p.openalex_id AS openalex_id, p.title AS title,
                  p.year AS year, p.url AS url, p.doi AS doi, p.cited_by_count AS cited_by_count,
                  [(p)-[:AUTHORED_BY]->(a:Author) | a.name] AS authors
                ORDER BY p.updated_at DESC LIMIT 100
                """
            )
            return await result.data()

    @staticmethod
    def _node_payload(node_id: str, labels: list[str], properties: dict[str, Any]) -> dict[str, Any]:
        """Convert Neo4j's node values into a small, browser-safe graph payload."""
        node_type = next((label for label in labels if label != "Entity"), labels[0] if labels else "Entity")
        fields = (
            "openalex_id",
            "title",
            "name",
            "statement",
            "year",
            "doi",
            "url",
            "cited_by_count",
            "abstract",
            "publication_date",
            "work_type",
            "language",
            "journal",
            "pdf_url",
            "is_oa",
            "fwci",
            "institutions",
            "keywords",
            "counts_by_year",
            "references_count",
            "related_count",
            "locator",
            "text",
        )
        safe_properties = {field: properties.get(field) for field in fields if properties.get(field) is not None}
        display = (
            safe_properties.get("title")
            or safe_properties.get("locator")
            or safe_properties.get("name")
            or safe_properties.get("statement")
            or safe_properties.get("openalex_id")
            or node_type
        )
        return {
            "id": node_id,
            "type": node_type,
            "label": str(display),
            "external_id": safe_properties.get("openalex_id"),
            "properties": safe_properties,
        }

    async def graph_overview(self, limit: int = 24) -> dict[str, Any]:
        """Return the paper-centered graph for the visual explorer."""
        if not self.driver:
            return {"nodes": [], "edges": [], "center": None}
        query = """
        MATCH (p:Paper)
        WITH p ORDER BY p.cited_by_count DESC, p.year DESC LIMIT $limit
        OPTIONAL MATCH (p)-[r]-(neighbor)
        RETURN elementId(p) AS paper_id, labels(p) AS paper_labels, properties(p) AS paper_properties,
               elementId(neighbor) AS neighbor_id, labels(neighbor) AS neighbor_labels,
               properties(neighbor) AS neighbor_properties, elementId(r) AS relationship_id,
               type(r) AS relationship_type, coalesce(r.score, 0.0) AS relationship_score,
               elementId(startNode(r)) AS edge_source, elementId(endNode(r)) AS edge_target
        """
        nodes: dict[str, dict[str, Any]] = {}
        edges: dict[str, dict[str, Any]] = {}
        async with self.driver.session(database=self.database) as session:
            result = await session.run(query, limit=max(1, min(limit, 60)))
            records = await result.data()
        for record in records:
            paper_id = record["paper_id"]
            nodes[paper_id] = self._node_payload(paper_id, record["paper_labels"], record["paper_properties"])
            neighbor_id = record.get("neighbor_id")
            if not neighbor_id:
                continue
            nodes[neighbor_id] = self._node_payload(
                neighbor_id,
                record["neighbor_labels"],
                record["neighbor_properties"],
            )
            relationship_id = record.get("relationship_id")
            if relationship_id:
                edges[relationship_id] = {
                    "id": relationship_id,
                    "source": record["edge_source"],
                    "target": record["edge_target"],
                    "type": record["relationship_type"],
                    "score": record["relationship_score"],
                }
        first_paper = next((node["id"] for node in nodes.values() if node["type"] == "Paper"), None)
        return {"nodes": list(nodes.values()), "edges": list(edges.values()), "center": first_paper}

    async def expand_node(self, node_id: str) -> dict[str, Any]:
        """Return one-hop neighbors for a node selected in the graph UI."""
        if not self.driver:
            return {"nodes": [], "edges": [], "center": None}
        query = """
        MATCH (center)
        WHERE elementId(center) = $node_id
        OPTIONAL MATCH (center)-[r]-(neighbor)
        RETURN elementId(center) AS center_id, labels(center) AS center_labels,
               properties(center) AS center_properties, elementId(neighbor) AS neighbor_id,
               labels(neighbor) AS neighbor_labels, properties(neighbor) AS neighbor_properties,
               elementId(r) AS relationship_id, type(r) AS relationship_type,
               coalesce(r.score, 0.0) AS relationship_score,
               elementId(startNode(r)) AS edge_source, elementId(endNode(r)) AS edge_target
        """
        async with self.driver.session(database=self.database) as session:
            result = await session.run(query, node_id=node_id)
            records = await result.data()
        if not records:
            return {"nodes": [], "edges": [], "center": None}
        nodes: dict[str, dict[str, Any]] = {}
        edges: dict[str, dict[str, Any]] = {}
        for record in records:
            center_id = record["center_id"]
            nodes[center_id] = self._node_payload(center_id, record["center_labels"], record["center_properties"])
            neighbor_id = record.get("neighbor_id")
            relationship_id = record.get("relationship_id")
            if neighbor_id:
                nodes[neighbor_id] = self._node_payload(
                    neighbor_id,
                    record["neighbor_labels"],
                    record["neighbor_properties"],
                )
            if relationship_id and neighbor_id:
                edges[relationship_id] = {
                    "id": relationship_id,
                    "source": record["edge_source"],
                    "target": record["edge_target"],
                    "type": record["relationship_type"],
                    "score": record["relationship_score"],
                }
        return {"nodes": list(nodes.values()), "edges": list(edges.values()), "center": node_id}

    async def stats(self) -> dict[str, int]:
        if not self.driver:
            return {
                "papers": 0,
                "authors": 0,
                "concepts": 0,
                "methods": 0,
                "limitations": 0,
                "citations": 0,
                "related": 0,
            }
        query = """
        CALL { MATCH (p:Paper) RETURN count(p) AS papers }
        CALL { MATCH (a:Author) RETURN count(a) AS authors }
        CALL { MATCH (c:Concept) RETURN count(c) AS concepts }
        CALL { MATCH (m:Method) RETURN count(m) AS methods }
        CALL { MATCH (l:Limitation) RETURN count(l) AS limitations }
        CALL { MATCH ()-[r:CITES]->() RETURN count(r) AS citations }
        CALL { MATCH ()-[r:RELATED_TO]->() RETURN count(r) AS related }
        RETURN papers, authors, concepts, methods, limitations, citations, related
        """
        async with self.driver.session(database=self.database) as session:
            result = await session.run(query)
            records = await result.data()
        return records[0] if records else {
            "papers": 0,
            "authors": 0,
            "concepts": 0,
            "methods": 0,
            "limitations": 0,
            "citations": 0,
            "related": 0,
        }
