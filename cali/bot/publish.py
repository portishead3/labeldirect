"""Give the website the label and invoice for an order that came from it.

The transaction record is never uploaded. Website orders are recognised by the
"Order: …" line the site puts at the top of the group message.
"""
from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.request
from pathlib import Path

from bot.config import _env

log = logging.getLogger("cali")

ORDER_RE = re.compile(r"Order:\s*(LD-[A-Z0-9]{6}|order-[a-z0-9]{6,})\b")
NAMED_RE = re.compile(r"(LD-[A-Z0-9]{6}|order-[a-z0-9]{6,})")
CUSTOMER_KINDS = ("label", "invoice")
BUCKET = "label-orders"


def customer_caption(expected_json: str | None, source_text: str | None = "") -> str | None:
    """The name shown with the PDF. The receiver's name, or the order number if it is missing."""
    name = ""
    try:
        data = json.loads(expected_json or "{}")
        name = str(data.get("name") or "").strip()
    except json.JSONDecodeError:
        name = ""
    if not name:
        name = website_reference(source_text or "") or ""
    name = " ".join(name.split())
    return name[:200] or None


def website_reference(source_text: str) -> str | None:
    match = ORDER_RE.search(source_text or "")
    return match.group(1) if match else None


def named_order_reference(filename: str) -> str | None:
    """An order number written into a file name, such as a download of another order."""
    match = NAMED_RE.search(filename or "")
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


def replaced_kinds(notes) -> set[str]:
    found = set()
    for note in notes or []:
        for kind in CUSTOMER_KINDS:
            if f"Replaced the previous {kind}." in note:
                found.add(kind)
    return found


def plan_delivery(files: dict, notes, already: set[str]) -> tuple[dict, bool]:
    """Which label and invoice files to give the customer.

    already is what they have already received. A replaced label is an edit.
    The transaction record is never included.
    """
    files = {kind: path for kind, path in files.items() if kind in CUSTOMER_KINDS}
    replaced = replaced_kinds(notes)
    chosen = {}
    for kind in CUSTOMER_KINDS:
        if kind in files and (kind in replaced or kind not in already):
            chosen[kind] = files[kind]
    # A second file in the first batch is not an edit of an earlier order.
    # Edited means this same order was already delivered and its label changed.
    return chosen, "label" in replaced and "label" in already


def announce_completion(chosen: dict, already: set[str]) -> bool:
    """The first time the label goes back to the customer."""
    return "label" in chosen and "label" not in already


def _supabase() -> tuple[str, str]:
    url = _env("SUPABASE_URL").rstrip("/")
    key = _env("SUPABASE_SERVICE_ROLE_KEY")
    return url, key


def order_row(reference: str) -> dict | None:
    url, key = _supabase()
    if not url or not key:
        return None
    request = urllib.request.Request(
        f"{url}/rest/v1/label_orders?reference=eq.{reference}&select=telegram_user_id,label_path,invoice_path,customer_message_id,origin",
        headers={"Authorization": "Bearer " + key, "apikey": key},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        rows = json.loads(response.read().decode() or "[]")
    return rows[0] if rows else None


def saved_customer_kinds(reference: str | None) -> set[str] | None:
    """Kinds already stored for a website order. None when this is not a website order."""
    if not reference:
        return None
    row = order_row(reference)
    if not row:
        return set()
    kinds = set()
    if row.get("label_path"):
        kinds.add("label")
    if row.get("invoice_path"):
        kinds.add("invoice")
    return kinds


def pending_message_id(reference: str | None) -> int | None:
    """The customer's 'received, pending' message, so the PDFs can reply to it."""
    if not reference:
        return None
    row = order_row(reference)
    message_id = row.get("customer_message_id") if row else None
    return int(message_id) if message_id else None


def requester_telegram_id(reference: str) -> int | None:
    row = order_row(reference)
    if not row or not row.get("telegram_user_id"):
        return None
    return int(row["telegram_user_id"])


def order_detail_patch(tracking: str | None, recipient_name: str | None) -> dict[str, str]:
    """Fields worth keeping on the website order. Empty values are left alone."""
    fields: dict[str, str] = {}
    number = " ".join(str(tracking or "").split())[:80]
    name = " ".join(str(recipient_name or "").split())[:200]
    if number:
        fields["tracking_number"] = number
    if name:
        fields["recipient_name"] = name
    return fields


def save_order_details(reference: str | None, tracking: str | None, recipient_name: str | None) -> None:
    """Remember the tracking number and receiver for the admin Labels page."""
    if not reference:
        return
    fields = order_detail_patch(tracking, recipient_name)
    if not fields:
        return
    url, key = _supabase()
    if not url or not key:
        log.warning("Order details not saved: Supabase is not configured")
        return
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


def mark_order_edited(reference: str) -> None:
    url, key = _supabase()
    if not url or not key:
        return
    request = urllib.request.Request(
        f"{url}/rest/v1/label_orders?reference=eq.{reference}",
        data=json.dumps({"edited": True}).encode(),
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
