from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.graph import Neo4jGraph
from app.llm import LLMClient
from app.models import AskRequest, CompareRequest, DiscoverRequest, EvidenceRequest, HealthResponse, PaperChatRequest
from app.openalex import OpenAlexClient
from app.service import ResearchService


graph = Neo4jGraph(
    settings.neo4j_uri,
    settings.neo4j_username,
    settings.neo4j_password,
    settings.neo4j_database,
    settings.embedding_dimensions,
    settings.neo4j_connection_timeout_seconds,
    settings.neo4j_query_api_url,
)
service = ResearchService(
    OpenAlexClient(settings.openalex_base_url, settings.openalex_mailto, settings.request_timeout_seconds),
    graph,
    LLMClient(
        settings.llm_config,
        settings.request_timeout_seconds,
        fallbacks=settings.llm_configs[1:],
    ),
    settings.embedding_dimensions,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await graph.connect()
    yield
    await graph.close()


app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)
static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=static_dir), name="static")


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(static_dir / "index.html")


@app.get("/api/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        neo4j=graph.connected,
        llm=service.llm.available,
        connection_message=graph.connection_message,
        query_api=graph.query_api_available,
    )


@app.get("/api/stats")
async def stats() -> dict[str, int]:
    return await graph.stats()


@app.get("/api/graph")
async def graph_overview(limit: int = 24) -> dict:
    return await graph.graph_overview(limit)


@app.get("/api/papers")
async def list_papers(limit: int = 50) -> list[dict]:
    return await service.list_papers(limit)


@app.get("/api/graph/expand")
async def expand_graph_node(node_id: str) -> dict:
    return await graph.expand_node(node_id)


@app.post("/api/discover")
async def discover(request: DiscoverRequest) -> dict:
    try:
        return await service.discover_and_ingest(request.topic, request.limit)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=f"Research database unavailable: {error}") from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.post("/api/ask")
async def ask(request: AskRequest) -> dict:
    try:
        return await service.answer(request.question)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=f"Research database unavailable: {error}") from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.get("/api/papers/{openalex_id}/insights")
async def paper_insights(openalex_id: str) -> dict:
    try:
        return await service.paper_insights(openalex_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=f"Research database unavailable: {error}") from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.post("/api/papers/{openalex_id}/chat")
async def paper_chat(openalex_id: str, request: PaperChatRequest) -> dict:
    try:
        return await service.paper_chat(
            openalex_id,
            request.question,
            [turn.model_dump() for turn in request.history],
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=f"Research database unavailable: {error}") from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.post("/api/compare")
async def compare(request: CompareRequest) -> dict:
    try:
        return await service.compare_papers(request.openalex_ids, request.question)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.post("/api/papers/{openalex_id}/evidence")
async def add_paper_evidence(openalex_id: str, request: EvidenceRequest) -> dict:
    try:
        return await service.add_evidence(openalex_id, request.locator, request.text)
    except (LookupError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=f"Research database unavailable: {error}") from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.post("/api/documents")
async def upload_document(file: UploadFile = File(...), paper_id: str = "") -> dict:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Choose a PDF or UTF-8 text file.")
    try:
        return await service.ingest_document(
            await file.read(),
            file.filename,
            file.content_type or "",
            paper_id,
        )
    except (LookupError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=f"Research database unavailable: {error}") from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
