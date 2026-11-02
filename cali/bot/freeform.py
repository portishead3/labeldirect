"""Read a free-form shipment request message.

Requests look like either of these, with no fixed format:

    Adam yafid
    3 southwark street se11rq
    1lb
    Envelope
    Malaga
    yasinpico@atomicmail.io

or a long labelled block (INVOICE NUMBER: ..., TOTAL GROSS WEIGHT: ..., Sender: ...).
Only fields that are actually present get checked later.
"""

import re
from dataclasses import asdict, dataclass, field

from bot.textnorm import (
    COUNTRY_ALIASES,
    UK_POSTCODE_RE,
    WEIGHT_RE,
    normalize_country,
    to_kg,
)

LABELLED_RE = re.compile(r"^([A-Za-z][A-Za-z0-9 /&#.\-]{0,40}?)\s*[:=]\s*(\S.*)$")
SEPARATOR_RE = re.compile(r"^[\W_]+$")
EMAIL_RE = re.compile(r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}", re.I)
SENDER_RE = re.compile(r"^(sender|shipper|from)\b\s*[:\-]?", re.I)
ITEM_RE = re.compile(r"^(goods description|item\s*\d+)\b", re.I)
PHONE_LINE_RE = re.compile(r"^\+?[\d \t().\-]{7,}$")
INCOTERMS = {"EXW", "FCA", "CPT", "CIP", "DAP", "DPU", "DDP", "FAS", "FOB", "CFR", "CIF"}
AMOUNT_RE = re.compile(r"\d[\d,]*\.\d{2}")
IGNORED_EXTRAS = {"fedex", "ups", "dhl", "urgent", "thanks", "thank you"}

# Words that show a leftover line is a heading or an instruction, not a detail
# such as a package type ("Envelope") or a sender city ("Malaga").
EXTRA_STOPWORDS = {
    "look", "above", "below", "see", "with", "please", "this", "that", "the", "and",
    "thanks", "thank", "you", "one", "same", "as", "per", "note", "attached", "only",
    "commercial", "invoice", "details", "description", "shipment", "document",
    "documents", "number", "code", "box", "weight", "value", "total",
}
MAX_EXTRAS = 4

NAME_STOPWORDS = {
    "the", "with", "and", "this", "one", "please", "send", "ship", "to", "for", "of",
    "if", "possible", "kit", "envelope", "document", "documents", "package", "box",
    "pak", "tube", "fedex", "sender", "invoice", "number", "from",
}


@dataclass
class Expected:
    raw: str = ""
    name: str | None = None
    address_lines: list[str] = field(default_factory=list)
    city: str | None = None
    postal: str | None = None
    country: str | None = None
    weight_kg: float | None = None
    weight_text: str | None = None
    emails: list[str] = field(default_factory=list)
    phones: list[str] = field(default_factory=list)
    invoice_no: str | None = None
    incoterms: str | None = None
    declared_value: str | None = None
    extras: list[str] = field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        return not any(
            [
                self.name,
                self.address_lines,
                self.postal,
                self.weight_kg,
                self.emails,
                self.phones,
                self.invoice_no,
            ]
        )

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "Expected":
        return cls(**data)


def _clean(line: str) -> str:
    line = re.sub(r"^[\s\-–—•*·]+", "", line)
    line = re.sub(r"[\s\-–—•*·]+$", "", line)
    return line.strip()


def _classify_key(key: str) -> str | None:
    k = " ".join(re.sub(r"[^a-z ]", " ", key.lower()).split())
    if "origin" in k:
        return None
    if "incoterm" in k:
        return "incoterms"
    if "invoice" in k:
        return "invoice_no"
    if "declared value" in k or k in {"total value", "value"}:
        return "declared"
    if "weight" in k:
        if "net" in k or "packaging" in k:
            return None
        return "weight"
    if "email" in k or "e mail" in k:
        return "email"
    if any(word in k for word in ("phone", "tel", "mobile")):
        return "phone"
    if "postal" in k or "postcode" in k or "zip" in k:
        return "postal"
    if "country" in k:
        return "country"
    if k in {"city", "town"}:
        return "city"
    if "address" in k or k in {"street", "addr"}:
        return "address"
    if k in {"name", "recipient", "receiver", "consignee", "ship to", "to", "contact"}:
        return "name"
    return None


def _looks_like_name(line: str) -> bool:
    if line.endswith(":"):
        return False
    words = line.split()
    if not 2 <= len(words) <= 4:
        return False
    for word in words:
        if not re.fullmatch(r"[^\W\d_]{2,}(?:['’\-][^\W\d_]+)*\.?", word):
            return False
        if word.lower().strip(".") in NAME_STOPWORDS:
            return False
    return True


def _is_useful_extra(line: str) -> bool:
    if ":" in line or line.lower() in IGNORED_EXTRAS:
        return False
    words = line.split()
    if not 1 <= len(words) <= 2:
        return False
    if len(words) == 2 and line.isupper():  # a heading such as COMMERCIAL INVOICE
        return False
    return not any(word.lower().strip(".,") in EXTRA_STOPWORDS for word in words)


def _set_weight(expected: Expected, value: str) -> None:
    if expected.weight_kg is not None:
        return
    match = WEIGHT_RE.search(value)
    if match:
        expected.weight_kg = to_kg(match.group(1), match.group(2))
        expected.weight_text = f"{match.group(1)} {match.group(2)}"


def _apply_labelled(expected: Expected, kind: str, value: str) -> None:
    if kind == "name" and not expected.name:
        expected.name = value
    elif kind == "address":
        expected.address_lines.append(value)
    elif kind == "city":
        expected.city = value
    elif kind == "postal":
        expected.postal = value.strip()
    elif kind == "country":
        expected.country = normalize_country(value) or expected.country
    elif kind == "phone":
        expected.phones.append(value)
    elif kind == "email":
        expected.emails.extend(EMAIL_RE.findall(value))
    elif kind == "invoice_no":
        expected.invoice_no = value.strip()
    elif kind == "incoterms":
        word = value.strip().split()[0].upper() if value.strip() else ""
        expected.incoterms = word or None
    elif kind == "declared":
        amount = AMOUNT_RE.search(value)
        if amount:
            expected.declared_value = amount.group(0).replace(",", "")
    elif kind == "weight":
        _set_weight(expected, value)


def parse_request(text: str) -> Expected:
    expected = Expected(raw=text)
    section = "default"

    for raw_line in text.splitlines():
        if not raw_line.strip():
            if section == "sender":
                section = "default"
            continue
        line = _clean(raw_line)
        if not line or SEPARATOR_RE.match(line):
            section = "default"
            continue
        if ITEM_RE.match(line):
            section = "items"
            continue
        if SENDER_RE.match(line):
            section = "sender"
            continue
        if section in {"items", "sender"}:
            continue

        labelled = LABELLED_RE.match(line)
        if labelled:
            kind = _classify_key(labelled.group(1))
            if kind:
                _apply_labelled(expected, kind, labelled.group(2).strip())
            continue

        emails = EMAIL_RE.findall(line)
        if emails:
            expected.emails.extend(emails)
            continue

        weight = WEIGHT_RE.search(line)
        if weight:
            remainder = (line[: weight.start()] + " " + line[weight.end() :]).strip()
            if not remainder or "weight" in remainder.lower():
                _set_weight(expected, line)
                continue

        if PHONE_LINE_RE.match(line) and len(re.sub(r"\D", "", line)) >= 8:
            expected.phones.append(line)
            continue

        if line.upper() in INCOTERMS:
            expected.incoterms = line.upper()
            continue

        country = normalize_country(line) if line.lower() in COUNTRY_ALIASES else None
        if country:
            expected.country = country
            continue

        if UK_POSTCODE_RE.fullmatch(line):
            expected.postal = line
            continue

        if re.search(r"\d", line) and re.search(r"[A-Za-z]{3,}", line):
            expected.address_lines.append(line)
            continue

        if not expected.name and _looks_like_name(line):
            expected.name = line
            continue

        if _is_useful_extra(line):
            expected.extras.append(line)

    _resolve_postal(expected)
    if len(expected.extras) > MAX_EXTRAS:
        expected.extras = []  # a long pasted block, not a short note
    return expected


def _resolve_postal(expected: Expected) -> None:
    if expected.postal:
        match = UK_POSTCODE_RE.search(expected.postal)
        if match:
            expected.postal = f"{match.group(1)} {match.group(2)}".upper()
        expected.address_lines = [_remove(line, expected.postal) for line in expected.address_lines]
        return

    for index, line in enumerate(expected.address_lines):
        match = UK_POSTCODE_RE.search(line)
        if match:
            expected.postal = f"{match.group(1)} {match.group(2)}".upper()
            expected.address_lines[index] = (line[: match.start()] + line[match.end() :]).strip(" ,")
            break
    else:
        for index, line in enumerate(expected.address_lines):
            match = re.search(r"(?<!\d)\d{5}(?:-\d{4})?(?!\d)", line)
            if match and len(line.split()) > 1:
                expected.postal = match.group(0)
                expected.address_lines[index] = (line[: match.start()] + line[match.end() :]).strip(" ,")
                break

    expected.address_lines = [line for line in expected.address_lines if line]


def _remove(line: str, postal: str) -> str:
    compact = re.sub(r"\s+", "", postal).lower()
    words = line.split()
    kept = [word for word in words if re.sub(r"[\s,]", "", word).lower() not in {compact}]
    return " ".join(kept).strip(" ,")
