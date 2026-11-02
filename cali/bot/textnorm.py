from __future__ import annotations

import re
import unicodedata

KG_PER_LB = 0.45359237

ABBREVIATIONS = {
    "street": "st",
    "road": "rd",
    "avenue": "ave",
    "drive": "dr",
    "boulevard": "blvd",
    "apartment": "apt",
    "flat": "apt",
    "suite": "ste",
    "lane": "ln",
    "court": "ct",
    "place": "pl",
    "square": "sq",
    "terrace": "ter",
}
STOPWORDS = {"the", "and", "of", "at"}

COUNTRY_ALIASES = {
    "us": "US",
    "usa": "US",
    "united states": "US",
    "united states of america": "US",
    "gb": "GB",
    "uk": "GB",
    "united kingdom": "GB",
    "great britain": "GB",
    "england": "GB",
    "scotland": "GB",
    "wales": "GB",
    "de": "DE",
    "germany": "DE",
    "es": "ES",
    "spain": "ES",
    "ke": "KE",
    "kenya": "KE",
    "nl": "NL",
    "netherlands": "NL",
    "fr": "FR",
    "france": "FR",
    "ie": "IE",
    "ireland": "IE",
    "it": "IT",
    "italy": "IT",
    "ca": "CA",
    "canada": "CA",
    "ae": "AE",
    "united arab emirates": "AE",
}

UK_POSTCODE_RE = re.compile(r"\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b", re.I)
WEIGHT_RE = re.compile(
    r"(\d+(?:[.,]\d+)?)\s*(kgs?|kilos?|kilograms?|lbs?|pounds?)\b",
    re.I,
)
PHONE_RUN_RE = re.compile(r"\+?\d[\d \t().\-]{6,}\d")


def strip_accents(value: str) -> str:
    return "".join(
        char for char in unicodedata.normalize("NFKD", value) if not unicodedata.combining(char)
    )


def tokens(value: str) -> list[str]:
    cleaned = re.sub(r"[^a-z0-9]+", " ", strip_accents(value).lower())
    out: list[str] = []
    for token in cleaned.split():
        token = ABBREVIATIONS.get(token, token)
        if token and token not in STOPWORDS:
            out.append(token)
    return out


def norm_postal(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", strip_accents(value).upper())


def norm_alnum(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", strip_accents(value).lower())


def normalize_country(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = value.strip().lower().strip("().")
    if cleaned in COUNTRY_ALIASES:
        return COUNTRY_ALIASES[cleaned]
    if len(cleaned) == 2 and cleaned.isalpha():
        return cleaned.upper()
    return None


def to_kg(amount: str, unit: str | None) -> float:
    value = float(amount.replace(",", "."))
    unit = (unit or "kg").lower()
    if unit.startswith("lb") or unit.startswith("pound"):
        value *= KG_PER_LB
    return round(value, 3)


def phone_numbers(text: str) -> list[str]:
    numbers = []
    for match in PHONE_RUN_RE.finditer(text):
        digits = re.sub(r"\D", "", match.group(0))
        if 8 <= len(digits) <= 15:
            numbers.append(digits)
    return numbers


def same_phone(a: str, b: str) -> bool:
    a = re.sub(r"\D", "", a)
    b = re.sub(r"\D", "", b)
    size = min(10, len(a), len(b))
    return size >= 7 and a[-size:] == b[-size:]
