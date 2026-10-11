from __future__ import annotations

import hashlib
import io
import re
from typing import Any


MAX_DOCUMENT_BYTES = 20 * 1024 * 1024
MAX_PAGES = 200
MAX_CHUNK_CHARS = 6500


def _chunks_from_text(text: str, locator: str) -> list[dict[str, str]]:
    normalized = re.sub(r"\s+", " ", text).strip()
    if not normalized:
        return []
    chunks = []
    for offset in range(0, len(normalized), MAX_CHUNK_CHARS):
        part = normalized[offset : offset + MAX_CHUNK_CHARS].strip()
        if part:
            suffix = f" {offset // MAX_CHUNK_CHARS + 1}" if len(normalized) > MAX_CHUNK_CHARS else ""
            chunks.append({"locator": f"{locator}{suffix}", "text": part})
    return chunks


def extract_document(data: bytes, filename: str, content_type: str = "") -> tuple[str, list[dict[str, str]]]:
    """Extract page-aware text without running a local AI model."""
    if len(data) > MAX_DOCUMENT_BYTES:
        raise ValueError("Document is larger than the 20 MB upload limit.")
    lower_name = filename.lower()
    if lower_name.endswith(".pdf") or content_type == "application/pdf":
        try:
            from pypdf import PdfReader
        except ImportError as error:
            raise RuntimeError("Install pypdf from requirements.txt to upload PDFs.") from error
        reader = PdfReader(io.BytesIO(data))
        if len(reader.pages) > MAX_PAGES:
            raise ValueError(f"PDF has more than the {MAX_PAGES}-page limit.")
        chunks = []
        for page_number, page in enumerate(reader.pages, start=1):
            chunks.extend(_chunks_from_text(page.extract_text() or "", f"page {page_number}"))
    else:
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError("Only PDF or UTF-8 text documents are supported.") from error
        chunks = _chunks_from_text(text, "text")
    if not chunks:
        raise ValueError("No readable text was found in this document.")
    return hashlib.sha256(data).hexdigest()[:32], chunks


def chunk_rows(document_id: str, chunks: list[dict[str, str]]) -> list[dict[str, Any]]:
    return [
        {
            "id": hashlib.sha256(f"{document_id}:{index}:{chunk['locator']}".encode()).hexdigest()[:32],
            "locator": chunk["locator"],
            "text": chunk["text"],
        }
        for index, chunk in enumerate(chunks)
    ]
