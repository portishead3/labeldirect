"""Read FedEx PDFs: shipping label, commercial invoice, transaction record."""

import re
import statistics
from dataclasses import asdict, dataclass, field
from itertools import cycle
from pathlib import Path

import fitz

from bot.textnorm import to_kg

GROUPED_TRK_RE = re.compile(r"(?<!\d)(\d{4}) (\d{4}) (\d{4})(?!\d)")
DIGIT_RUN_RE = re.compile(r"(?<!\d)(\d{12}|\d{15}|\d{20}|\d{22})(?!\d)")
LABEL_WEIGHT_RE = re.compile(r"ACT(?:UAL)?\s*WGT\s*[:#]?\s*(\d+(?:[.,]\d+)?)\s*(LBS?|KGS?)", re.I)
LABEL_DATE_RE = re.compile(r"SHIP\s*DATE\s*:\s*(\d{1,2}[A-Z]{3}\d{2})", re.I)
RECORD_DATE_RE = re.compile(r"\b([A-Z][a-z]{2} \d{1,2}, \d{4})\b")
RECORD_WEIGHT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(lbs?|kgs?)\b", re.I)
COUNTRY_LINE_RE = re.compile(r"^\(?([A-Z]{2})\)?$")


@dataclass
class DocExtract:
    kind: str = "unknown"  # label | invoice | record | unknown
    text: str = ""
    tracking_candidates: list[str] = field(default_factory=list)
    weight_kg: float | None = None
    weight_text: str | None = None
    ship_date: str | None = None
    recipient_lines: list[str] = field(default_factory=list)
    recipient_country: str | None = None
    sender_lines: list[str] = field(default_factory=list)
    service: str | None = None
    packaging: str | None = None

    @property
    def recipient_text(self) -> str:
        return "\n".join(self.recipient_lines)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "DocExtract":
        return cls(**data)


def fedex12_valid(number: str) -> bool:
    """FedEx Express check digit: weights 3,1,7 repeating, mod 11, then mod 10."""
    if len(number) != 12 or not number.isdigit():
        return False
    total = sum(int(digit) * weight for digit, weight in zip(number[:11], cycle((3, 1, 7))))
    return (total % 11) % 10 == int(number[11])


def classify(text: str, filename: str | None) -> str:
    low = text.lower()
    if "transaction record" in low:
        return "record"
    if "commercial invoice" in low or ("invoice" in low and "description of goods" in low):
        return "invoice"
    if "trk#" in low or "actwgt" in low or "origin id" in low:
        return "label"
    name = (filename or "").lower()
    for hint, kind in (("transaction", "record"), ("invoice", "invoice"), ("label", "label")):
        if hint in name:
            return kind
    return "unknown"


def _page_lines(page) -> list[tuple[str, float, float, float, float]]:
    out = []
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            text = "".join(span["text"] for span in line["spans"]).strip()
            if not text:
                continue
            size = max(span["size"] for span in line["spans"])
            x0, y0, _x1, y1 = line["bbox"]
            out.append((text, size, x0, y0, y1))
    return out


def _label_layout(page) -> dict:
    """Recipient is the block of large type on the left, above the TRK# line."""
    lines = _page_lines(page)
    if not lines:
        return {}
    width = page.rect.width
    trk_y = next((y0 for text, _s, _x, y0, _y1 in lines if text.upper().startswith("TRK#")), None)
    limit = trk_y if trk_y is not None else page.rect.height * 0.4
    top = [line for line in lines if line[3] < limit]
    if not top:
        return {}

    median = statistics.median(size for _t, size, *_ in top)
    left = width * 0.3
    big = sorted(
        (line for line in top if line[1] >= 1.4 * median and line[2] < left),
        key=lambda line: line[3],
    )
    if not big:
        return {}

    # Keep only the contiguous address block; routing codes and the tracking
    # number are also large type but sit well below it.
    cluster = [big[0]]
    for line in big[1:]:
        if line[3] - cluster[-1][4] > 25:
            break
        cluster.append(line)
    big = cluster

    recipient = [line[0] for line in big]
    last_y1 = max(line[4] for line in big)
    for text, size, x0, y0, _y1 in top:
        if size < 1.4 * median and x0 < left and last_y1 - 12 <= y0 <= last_y1 + 15:
            if re.fullmatch(r"[+\d\s()\-]{7,}", text):
                recipient.append(text)

    first_big_y = big[0][3]
    sender = [
        text
        for text, size, x0, y0, _y1 in sorted(top, key=lambda line: (line[3], line[2]))
        if x0 < left and y0 < first_big_y and not text.upper().startswith("ORIGIN ID")
    ]

    country = None
    for text, _size, _x0, _y0, _y1 in top:
        match = re.fullmatch(r"\(([A-Z]{2})\)", text.strip())
        if match:
            country = match.group(1)
    return {"recipient": recipient, "sender": sender, "country": country}


def _label_fallback(lines: list[str]) -> list[str]:
    """When layout fails: the recipient follows the 'BILL SENDER/RECIPIENT' line."""
    for index, line in enumerate(lines):
        if re.match(r"BILL\s+(SENDER|RECIPIENT|THIRD PARTY)", line.strip(), re.I):
            block = []
            for follow in lines[index + 1 : index + 8]:
                if re.match(r"(FC\s|\d{4} \d{4}|TRK#|REF:)", follow.strip()):
                    break
                block.append(follow.strip())
            return block
    return []


def _parse_record(lines: list[str]) -> dict:
    out: dict = {}
    low = [line.strip().lower() for line in lines]

    start = next((i for i, line in enumerate(low) if line.startswith("to address")), None)
    end = next((i for i, line in enumerate(low) if line.startswith("package information")), None)
    if start is not None and end is not None and end > start:
        body = [line.strip() for line in lines[start + 1 : end]]
        phones = [i for i, line in enumerate(body) if line.lower().startswith("phone")]
        if len(phones) >= 2:
            from_end = phones[0] + (1 if phones[0] + 1 < len(body) and "@" in body[phones[0] + 1] else 0)
            to_end = phones[1] + (1 if phones[1] + 1 < len(body) and "@" in body[phones[1] + 1] else 0)
            out["sender"] = body[: from_end + 1]
            out["recipient"] = body[from_end + 1 : to_end + 1]
            for line in out["recipient"]:
                match = COUNTRY_LINE_RE.match(line)
                if match and len(line) <= 4:
                    out["country"] = match.group(1)

    tracking_at = next((i for i, line in enumerate(low) if "tracking no" in line), None)
    if tracking_at is not None:
        for line in lines[tracking_at + 1 : tracking_at + 8]:
            if DIGIT_RUN_RE.fullmatch(line.strip()):
                out["tracking"] = line.strip()
                break

    pickup_at = next((i for i, line in enumerate(low) if line.startswith("pickup / drop-off")), None)
    if pickup_at is not None:
        values = [line.strip() for line in lines[pickup_at + 1 : pickup_at + 3]]
        if len(values) >= 2 and all("fedex" in value.lower() for value in values):
            out["packaging"], out["service"] = values
    return out


def extract_document(path: Path, filename: str | None = None) -> DocExtract:
    doc = fitz.open(path)
    try:
        text = "\n".join(page.get_text("text") or "" for page in doc)
        kind = classify(text, filename)
        extract = DocExtract(kind=kind, text=text)
        lines = text.splitlines()

        if kind == "label":
            layout = _label_layout(doc[0]) if len(doc) else {}
            extract.recipient_lines = layout.get("recipient") or _label_fallback(lines)
            extract.sender_lines = layout.get("sender", [])
            extract.recipient_country = layout.get("country")

            candidates = ["".join(m.groups()) for m in GROUPED_TRK_RE.finditer(text)]
            candidates += [
                m.group(1)
                for m in DIGIT_RUN_RE.finditer(text)
                if len(m.group(1)) == 12 and fedex12_valid(m.group(1))
            ]
            extract.tracking_candidates = list(dict.fromkeys(candidates))

            weight = LABEL_WEIGHT_RE.search(text)
            if weight:
                extract.weight_kg = to_kg(weight.group(1), weight.group(2))
                extract.weight_text = f"{weight.group(1)} {weight.group(2).upper()}"
            date = LABEL_DATE_RE.search(text)
            extract.ship_date = date.group(1).upper() if date else None

        elif kind == "record":
            parsed = _parse_record(lines)
            extract.recipient_lines = parsed.get("recipient", [])
            extract.sender_lines = parsed.get("sender", [])
            extract.recipient_country = parsed.get("country")
            extract.service = parsed.get("service")
            extract.packaging = parsed.get("packaging")
            if parsed.get("tracking"):
                extract.tracking_candidates = [parsed["tracking"]]
            weight = RECORD_WEIGHT_RE.search(text)
            if weight:
                extract.weight_kg = to_kg(weight.group(1), weight.group(2))
                extract.weight_text = f"{weight.group(1)} {weight.group(2).lower()}"
            date = RECORD_DATE_RE.search(text)
            extract.ship_date = date.group(1) if date else None

        elif kind == "invoice":
            extract.tracking_candidates = list(
                dict.fromkeys(
                    m.group(1)
                    for m in DIGIT_RUN_RE.finditer(text)
                    if len(m.group(1)) == 12 and fedex12_valid(m.group(1))
                )
            )
        return extract
    finally:
        doc.close()


def stale_kinds(new_kind: str, new_doc: DocExtract, stored: dict[str, DocExtract]) -> list[str]:
    """Stored documents that belong to an older shipment attempt.

    When a new PDF carries a different tracking number than a stored document,
    the stored one is out of date and has to be replaced, otherwise the old
    documents would out-vote the new label.
    """
    if not new_doc.tracking_candidates:
        return []
    new_numbers = set(new_doc.tracking_candidates)
    stale = []
    for kind, doc in stored.items():
        if kind == new_kind or not doc.tracking_candidates:
            continue
        if not (new_numbers & set(doc.tracking_candidates)):
            stale.append(kind)
    return stale


def pick_tracking(docs: dict[str, DocExtract]) -> tuple[str | None, bool]:
    """Best tracking number across documents, and whether label and record disagree."""
    votes: dict[str, set[str]] = {}
    for kind, doc in docs.items():
        for number in doc.tracking_candidates:
            votes.setdefault(number, set()).add(kind)
    if not votes:
        return None, False

    best = max(
        votes.items(),
        key=lambda item: (len(item[1]), "label" in item[1], fedex12_valid(item[0])),
    )[0]

    label = set(docs["label"].tracking_candidates) if "label" in docs else set()
    record = set(docs["record"].tracking_candidates) if "record" in docs else set()
    conflict = bool(label) and bool(record) and not (label & record)
    return best, conflict
