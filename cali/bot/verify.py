"""Compare what was asked for (the request message) with what the PDFs say."""

import re
from dataclasses import dataclass, field

from bot.fedex import DocExtract, pick_tracking
from bot.freeform import Expected
from bot.textnorm import (
    UK_POSTCODE_RE,
    norm_alnum,
    norm_postal,
    normalize_country,
    phone_numbers,
    same_phone,
    tokens,
)

DOC_ORDER = ("label", "record", "invoice")
DOC_NAMES = {"label": "label", "record": "record", "invoice": "invoice"}
WEIGHT_TOLERANCE_KG = 0.15


@dataclass
class Check:
    key: str
    label: str
    status: str  # ok | fail | warn | info
    expected: str
    found: str
    sources: list[str] = field(default_factory=list)
    hard: bool = False


@dataclass
class Report:
    verdict: str
    tracking: str | None
    checks: list[Check]
    docs: dict[str, bool]
    notes: list[str] = field(default_factory=list)
    service: str | None = None
    packaging: str | None = None
    ship_date: str | None = None
    weight_text: str | None = None

    def summary(self) -> dict:
        return {
            "verdict": self.verdict,
            "tracking": self.tracking,
            "service": self.service,
            "packaging": self.packaging,
            "ship_date": self.ship_date,
            "weight": self.weight_text,
            "docs": self.docs,
            "checks": [
                {
                    "key": c.key,
                    "status": c.status,
                    "expected": c.expected,
                    "found": c.found,
                    "sources": c.sources,
                }
                for c in self.checks
            ],
            "notes": self.notes,
        }

    def text(self, public_id: str) -> str:
        titles = {
            "verified": "✅ VERIFIED",
            "mismatch": "❌ MISMATCH",
            "needs_review": "⚠️ NEEDS REVIEW",
            "waiting_label": "⏳ WAITING FOR LABEL",
        }
        lines = [f"{public_id} · {titles.get(self.verdict, self.verdict)}"]
        if self.tracking:
            lines.append(f"FedEx tracking: {self.tracking}")
        details = [d for d in (self.service, self.packaging, self.weight_text, self.ship_date) if d]
        if details:
            lines.append(" · ".join(details))
        lines.append("")

        icons = {"ok": "✅", "fail": "❌", "warn": "⚠️", "info": "ℹ️"}
        for check in self.checks:
            sources = f"  [{', '.join(check.sources)}]" if check.sources else ""
            if check.status == "ok":
                lines.append(f"{icons['ok']} {check.label}: {check.expected}{sources}")
            elif check.status == "info":
                lines.append(f"{icons['info']} {check.label}: {check.expected}{sources}")
            else:
                found = check.found if check.found.startswith(("not ", "no ")) else f"found {check.found}"
                lines.append(f"{icons[check.status]} {check.label}: asked {check.expected} · {found}")

        if self.checks:
            lines.append("")
        lines.append(
            "Docs: "
            + "  ".join(f"{DOC_NAMES[k]} {'✅' if self.docs.get(k) else '➖'}" for k in DOC_ORDER)
        )
        lines.extend(self.notes)
        return "\n".join(lines)


def _found_postal(text: str) -> str | None:
    match = UK_POSTCODE_RE.search(text)
    if match:
        return f"{match.group(1)} {match.group(2)}".upper()
    match = re.search(r"(?<!\d)\d{5}(?:-\d{4})?(?!\d)", text)
    return match.group(0) if match else None


def build_report(expected: Expected, docs: dict[str, DocExtract]) -> Report:
    present = {kind: docs[kind] for kind in DOC_ORDER if kind in docs}
    tracking, tracking_conflict = pick_tracking(present)

    sources = {
        kind: (doc.recipient_text if kind != "invoice" else doc.text)
        for kind, doc in present.items()
        if (doc.recipient_text if kind != "invoice" else doc.text).strip()
    }
    primary = next((kind for kind in DOC_ORDER if kind in sources), None)
    all_text = "\n".join(doc.text for doc in present.values())
    label = present.get("label")
    record = present.get("record")

    checks: list[Check] = []
    notes: list[str] = []

    def run(key, title, asked, match, found_text, hard):
        matched = [kind for kind in DOC_ORDER if kind in sources and match(sources[kind])]
        if primary is None:
            status = "warn"
        else:
            status = "ok" if primary in matched else ("fail" if hard else "warn")
        checks.append(
            Check(key, title, status, asked, found_text if status != "ok" else asked, matched, hard)
        )

    def recipient_preview() -> str:
        for kind in DOC_ORDER:
            if kind in present and present[kind].recipient_lines:
                return ", ".join(present[kind].recipient_lines[:4])
        return "not found"

    if expected.is_empty:
        notes.append(
            "I could not read shipment details from the message you replied to, "
            "so only the tracking number was checked."
        )

    if expected.name:
        name_tokens = [t for t in tokens(expected.name) if len(t) > 1]
        run(
            "name",
            "Name",
            expected.name,
            lambda hay: set(name_tokens) <= set(tokens(hay)),
            (present[primary].recipient_lines[0] if primary in present and present[primary].recipient_lines else "not found")
            if primary
            else "no document",
            True,
        )

    if expected.postal:
        wanted = norm_postal(expected.postal)
        found_postal = None
        for kind in DOC_ORDER:
            if kind in sources:
                found_postal = _found_postal(sources[kind])
                if found_postal:
                    break
        run(
            "postal",
            "Postcode",
            expected.postal,
            lambda hay: wanted in norm_postal(hay),
            found_postal or "not found",
            True,
        )

    address_text = " ".join(expected.address_lines + ([expected.city] if expected.city else []))
    address_tokens = set(tokens(address_text))
    if expected.postal:
        address_tokens -= set(tokens(expected.postal))
    if expected.name:
        address_tokens -= set(tokens(expected.name))
    if address_tokens:
        def address_match(hay: str) -> bool:
            found = set(tokens(hay))
            return len(address_tokens & found) / len(address_tokens) >= 0.75

        run(
            "address",
            "Address",
            " ".join(expected.address_lines + ([expected.city] if expected.city else [])),
            address_match,
            recipient_preview(),
            False,
        )

    if expected.country:
        found_country = next(
            (
                normalize_country(present[k].recipient_country)
                for k in DOC_ORDER
                if k in present and present[k].recipient_country
            ),
            None,
        )
        if found_country is None:
            checks.append(Check("country", "Country", "warn", expected.country, "not found", [], True))
        else:
            ok = found_country == expected.country
            matched = [
                k
                for k in DOC_ORDER
                if k in present and normalize_country(present[k].recipient_country) == expected.country
            ]
            checks.append(
                Check(
                    "country",
                    "Country",
                    "ok" if ok else "fail",
                    expected.country,
                    found_country,
                    matched,
                    True,
                )
            )

    if expected.weight_kg is not None:
        found = [(k, present[k]) for k in ("label", "record") if k in present and present[k].weight_kg is not None]
        if not found:
            checks.append(
                Check("weight", "Weight", "warn", expected.weight_text or "", "not found", [], True)
            )
        else:
            matched = [
                k for k, d in found if abs(d.weight_kg - expected.weight_kg) <= WEIGHT_TOLERANCE_KG
            ]
            lead_kind, lead = found[0]
            ok = lead_kind in matched
            checks.append(
                Check(
                    "weight",
                    "Weight",
                    "ok" if ok else "fail",
                    expected.weight_text or f"{expected.weight_kg} kg",
                    f"{lead.weight_text} on {lead_kind}",
                    matched,
                    True,
                )
            )

    for email in expected.emails:
        wanted = email.lower()
        matched = [k for k in DOC_ORDER if k in present and wanted in present[k].text.lower()]
        checks.append(
            Check("email", "Email", "ok" if matched else "warn", email, "not found", matched, False)
        )

    for phone in expected.phones:
        matched = [
            k
            for k in DOC_ORDER
            if k in present
            and any(same_phone(phone, found) for found in phone_numbers(present[k].text))
        ]
        if matched:
            checks.append(Check("phone", "Phone", "ok", phone, phone, matched, False))
        else:
            seen = next(
                (
                    n
                    for k in DOC_ORDER
                    if k in present
                    for n in phone_numbers(present[k].recipient_text)
                ),
                "not found",
            )
            checks.append(Check("phone", "Phone", "warn", phone, seen, [], False))

    if expected.invoice_no:
        wanted = norm_alnum(expected.invoice_no)
        matched = [k for k in DOC_ORDER if k in present and wanted in norm_alnum(present[k].text)]
        checks.append(
            Check(
                "invoice_no",
                "Invoice number",
                "ok" if matched else "warn",
                expected.invoice_no,
                "not found in documents",
                matched,
                False,
            )
        )

    if expected.incoterms:
        pattern = re.compile(rf"\b{re.escape(expected.incoterms)}\b", re.I)
        matched = [k for k in DOC_ORDER if k in present and pattern.search(present[k].text)]
        checks.append(
            Check(
                "incoterms",
                "Incoterms",
                "ok" if matched else "warn",
                expected.incoterms,
                "not found in documents",
                matched,
                False,
            )
        )

    if expected.declared_value:
        matched = [
            k for k in DOC_ORDER if k in present and expected.declared_value in present[k].text.replace(",", "")
        ]
        checks.append(
            Check(
                "declared",
                "Declared value",
                "ok" if matched else "warn",
                expected.declared_value,
                "not found in documents",
                matched,
                False,
            )
        )

    lowered = all_text.lower()
    for extra in expected.extras:
        if extra.lower() in lowered:
            seen_in = [k for k in DOC_ORDER if k in present and extra.lower() in present[k].text.lower()]
            checks.append(Check("extra", extra, "info", "seen", "", seen_in, False))
        else:
            checks.append(Check("extra", extra, "info", "not seen in documents", "", [], False))

    if tracking_conflict:
        checks.append(
            Check(
                "tracking",
                "Tracking",
                "fail",
                "same number on label and record",
                f"label {', '.join(label.tracking_candidates)} vs record {', '.join(record.tracking_candidates)}",
                [],
                True,
            )
        )

    docs_present = {kind: kind in present for kind in DOC_ORDER}
    if tracking is None:
        notes.append("No FedEx tracking number found in the documents.")
    if label is not None and not label.recipient_lines:
        notes.append("I could not read the recipient block on the label (scanned image?).")

    hard_fail = any(c.status == "fail" for c in checks if c.hard)
    soft_issue = any(c.status == "warn" for c in checks)
    if label is None:
        verdict = "waiting_label" if not hard_fail else "mismatch"
    elif hard_fail:
        verdict = "mismatch"
    elif soft_issue or tracking is None or expected.is_empty:
        verdict = "needs_review"
    else:
        verdict = "verified"

    first = next((present[k] for k in DOC_ORDER if k in present and present[k].service), None)
    return Report(
        verdict=verdict,
        tracking=tracking,
        checks=checks,
        docs=docs_present,
        notes=notes,
        service=first.service if first else None,
        packaging=first.packaging if first else None,
        ship_date=next((present[k].ship_date for k in DOC_ORDER if k in present and present[k].ship_date), None),
        weight_text=(label.weight_text if label and label.weight_text else (record.weight_text if record else None)),
    )
