"""Give the website the label and invoice for an order that came from it.

The transaction record is never uploaded. Website orders are recognised by the
"Order: LD-…" line the site puts at the top of the group message.
"""

import json
import logging
import re
import urllib.error
import urllib.request
from pathlib import Path

from bot.config import _env

log = logging.getLogger("cali")

ORDER_RE = re.compile(r"Order:\s*(LD-[A-Z0-9]{6})\b")
CUSTOMER_KINDS = ("label", "invoice")
BUCKET = "label-orders"


def website_reference(source_text: str) -> str | None:
    match = ORDER_RE.search(source_text or "")
    return match.group(1) if match else None


def customer_files(documents: list[dict]) -> dict[str, Path]:
    """Label and invoice PDFs only. The record and anything else are ignored."""
    files: dict[str, Path] = {}
    for row in documents:
        kind = row.get("kind") or ""
        if kind not in CUSTOMER_KINDS:
            continue
        path = Path(row.get("file_path") or "")
        if path.is_file():
            files[kind] = path
    return files


def publish_customer_pdfs(source_text: str, documents: list[dict]) -> None:
    reference = website_reference(source_text)
    files = customer_files(documents)
    if not reference or not files:
        return

    url = _env("SUPABASE_URL").rstrip("/")
    key = _env("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        log.warning("Customer PDFs not published: Supabase is not configured")
        return

    stored: dict[str, str] = {}
    for kind, path in files.items():
        object_path = f"{reference}/{kind}.pdf"
        _upload(url, key, object_path, path.read_bytes())
        stored[kind] = object_path
        log.info("Published %s for %s", kind, reference)

    _update_order(url, key, reference, stored)


def _upload(url: str, key: str, object_path: str, data: bytes) -> None:
    request = urllib.request.Request(
        f"{url}/storage/v1/object/{BUCKET}/{object_path}",
        data=data,
        method="POST",
        headers={
            "Authorization": "Bearer " + key,
            "apikey": key,
            "Content-Type": "application/pdf",
            "x-upsert": "true",
        },
    )
    _send(request)


def _update_order(url: str, key: str, reference: str, stored: dict[str, str]) -> None:
    fields: dict[str, str] = {}
    if "label" in stored:
        fields["label_path"] = stored["label"]
        fields["status"] = "delivered"
    if "invoice" in stored:
        fields["invoice_path"] = stored["invoice"]
    request = urllib.request.Request(
        f"{url}/rest/v1/label_orders?reference=eq.{reference}",
        data=json.dumps(fields).encode(),
        method="PATCH",
        headers={
            "Authorization": "Bearer " + key,
            "apikey": key,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
    )
    _send(request)


def _send(request: urllib.request.Request) -> None:
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            response.read()
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"Supabase returned {err.code}: {detail}") from err
