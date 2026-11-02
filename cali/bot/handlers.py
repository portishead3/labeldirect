from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from pathlib import Path

from aiogram import Bot, F, Router
from aiogram.filters import Command
from aiogram.exceptions import TelegramForbiddenError
from aiogram.types import FSInputFile, Message, ReactionTypeEmoji

from bot import db
from bot.config import FILES_DIR, GROUP_CHAT_ID, _env
from bot.fedex import DocExtract, extract_document, pick_tracking, same_label_details, stale_kinds
from bot.freeform import Expected, parse_request
from bot.publish import (
    announce_completion,
    customer_caption,
    customer_files,
    mark_order_edited,
    named_order_reference,
    order_row,
    plan_delivery,
    publish_customer_pdfs,
    replaced_kinds,
    requester_telegram_id,
    save_order_details,
    saved_customer_kinds,
    website_reference,
)
from bot.verify import build_report

router = Router()
log = logging.getLogger("cali")

REPORT_DELAY_SECONDS = 3.0
_pending: dict[int, asyncio.Task] = {}
_replacement_notes: dict[int, list[str]] = {}


def _display_name(message: Message) -> str:
    user = message.from_user
    return user.full_name if user else "unknown"


def _user_id(message: Message) -> int:
    return message.from_user.id if message.from_user else 0


def _message_text(message: Message) -> str:
    return (message.text or message.caption or "").strip()


def _is_pdf(message: Message) -> bool:
    document = message.document
    if not document:
        return False
    name = (document.file_name or "").lower()
    mime = (document.mime_type or "").lower()
    return name.endswith(".pdf") or "pdf" in mime


def _file_label(message: Message) -> str:
    document = message.document
    if not document:
        return "file"
    return f"{document.file_name or 'unnamed'} ({document.mime_type or 'unknown type'})"


def _log_message(message: Message) -> None:
    document = message.document
    kind = "text"
    if document:
        kind = f"document:{document.file_name}:{document.mime_type}"
    elif message.photo:
        kind = "photo"
    elif message.video:
        kind = "video"
    elif message.sticker:
        kind = "sticker"
    elif message.voice:
        kind = "voice"
    log.info(
        "chat=%s msg=%s reply_to=%s kind=%s text=%r",
        message.chat.id,
        message.message_id,
        message.reply_to_message.message_id if message.reply_to_message else None,
        kind,
        (message.text or message.caption or "")[:120],
    )


async def _react(bot: Bot, message: Message, emoji: str) -> None:
    try:
        await bot.set_message_reaction(
            chat_id=message.chat.id,
            message_id=message.message_id,
            reaction=[ReactionTypeEmoji(emoji=emoji)],
        )
    except Exception:
        pass


def _resolve_shipment(message: Message) -> dict | None:
    reply = message.reply_to_message
    if not reply:
        return None
    return db.find_shipment_by_message(message.chat.id, reply.message_id)


def _shipment_from_parent(parent: Message, chat_id: int) -> dict:
    """The message a PDF replies to is the request. Create the shipment from it once."""
    existing = db.find_shipment_by_message(chat_id, parent.message_id)
    text = _message_text(parent)
    if existing:
        # Replying to a PDF stays on that order. Its caption is not a new set of details.
        if parent.document:
            return existing
        if text and text != (existing.get("source_text") or ""):
            expected = parse_request(text)
            expected_json = json.dumps(expected.to_dict(), ensure_ascii=False)
            db.update_shipment(existing["id"], source_text=text, expected_json=expected_json)
            existing["source_text"] = text
            existing["expected_json"] = expected_json
        return existing

    author = parent.from_user
    expected = parse_request(text)
    return db.create_shipment(
        chat_id=chat_id,
        request_message_id=parent.message_id,
        created_by=author.id if author else 0,
        created_by_name=author.full_name if author else "unknown",
        source_text=text,
        expected_json=json.dumps(expected.to_dict(), ensure_ascii=False),
    )


@router.message(Command("start"), F.chat.id == GROUP_CHAT_ID)
@router.message(Command("help"), F.chat.id == GROUP_CHAT_ID)
async def help_cmd(message: Message) -> None:
    await message.reply(
        "Post the shipment details as a normal message, in any format, for example:\n\n"
        "Adam Yafid\n"
        "3 Southwark Street SE1 1RQ\n"
        "1lb\n"
        "yasin@example.com\n\n"
        "Then reply to that message with the FedEx PDFs (label, invoice, transaction record).\n"
        "I check them against the message and store the tracking number.\n"
        "Any other reply is saved as a comment."
    )


@router.message(F.chat.id == GROUP_CHAT_ID, F.document)
async def document_reply(message: Message, bot: Bot) -> None:
    _log_message(message)

    if not _is_pdf(message):
        shipment = _resolve_shipment(message)
        if not shipment:
            if message.reply_to_message:
                await message.reply(
                    f"I received {_file_label(message)}, not a PDF. "
                    "Send the label or invoice as a PDF file."
                )
            return
        caption = message.caption or message.document.file_name or "non-PDF file"
        db.add_comment(
            shipment_id=shipment["id"],
            message_id=message.message_id,
            from_user_id=_user_id(message),
            from_user_name=_display_name(message),
            text=f"[file] {caption}",
        )
        db.index_message(message.chat.id, message.message_id, shipment["id"])
        await _react(bot, message, "💬")
        return

    parent = message.reply_to_message
    if not parent:
        await message.reply("Reply to the shipment message with the PDF.")
        return

    shipment = _shipment_from_parent(parent, message.chat.id)
    db.index_message(message.chat.id, message.message_id, shipment["id"])

    dest_dir = FILES_DIR / shipment["public_id"]
    dest_dir.mkdir(parents=True, exist_ok=True)
    temp_path = dest_dir / f"incoming_{message.message_id}.pdf"
    await bot.download(message.document, destination=temp_path)

    try:
        extract = extract_document(temp_path, message.document.file_name)
    except Exception:
        log.exception("Could not read PDF %s", message.document.file_name)
        temp_path.unlink(missing_ok=True)
        await message.reply(f"I could not read {message.document.file_name or 'that PDF'}.")
        return

    problems = _document_problems(message.document.file_name, extract)
    if problems:
        await message.reply(problems)

    kind = extract.kind if extract.kind != "unknown" else f"other_{message.message_id}"
    named = named_order_reference(message.document.file_name or "")
    shipment_ref = website_reference(shipment.get("source_text") or _message_text(parent))
    if named and shipment_ref and named != shipment_ref:
        temp_path.unlink(missing_ok=True)
        await message.reply(f"That file is {named}. It was left off this order.")
        return
    final_path = dest_dir / f"{kind}.pdf"

    stored = {
        row["kind"]: DocExtract.from_dict(json.loads(row["extracted_json"]))
        for row in db.list_documents(shipment["id"])
        if not row["kind"].startswith("other_")
    }
    notes = _replacement_notes.setdefault(shipment["id"], [])
    if kind == "label" and kind in stored and same_label_details(stored[kind], extract):
        temp_path.unlink(missing_ok=True)
        await message.reply(
            "This label has the same details as the one already on this order, so it was not saved as an edit."
        )
        return
    if kind in stored:
        _archive(final_path, dest_dir)
        notes.append(f"Replaced the previous {kind}.")
    for old_kind in stale_kinds(kind, extract, stored):
        _archive(dest_dir / f"{old_kind}.pdf", dest_dir)
        db.delete_document(shipment["id"], old_kind)
        notes.append(f"Removed the old {old_kind}: it had a different tracking number.")

    temp_path.replace(final_path)

    db.upsert_document(
        shipment_id=shipment["id"],
        kind=kind,
        message_id=message.message_id,
        from_user_id=_user_id(message),
        file_path=str(final_path),
        extracted_json=json.dumps(extract.to_dict(), ensure_ascii=False),
    )
    log.info("%s: stored %s (%s)", shipment["public_id"], kind, message.document.file_name)
    await _react(bot, message, "📄")
    _schedule_report(bot, shipment["id"], message.chat.id, message.message_id)


def _document_problems(filename: str | None, extract: DocExtract) -> str:
    """Why a PDF was not used, so the group can see it instead of a silent skip."""
    name = filename or "that PDF"
    lines = []
    if extract.kind == "unknown":
        lines.append(
            f"I could not tell what {name} is. "
            "It was not recognized as a label, invoice, or record, so it was not checked."
        )
    if extract.rejected_numbers:
        listed = ", ".join(extract.rejected_numbers)
        lines.append(
            f"Ignored {listed} in {name}. "
            "A 12-digit number failed the FedEx check, so it was not saved as tracking."
        )
    return "\n".join(lines)


def _archive(path: Path, dest_dir: Path) -> None:
    """Keep replaced PDFs in a history folder instead of deleting them."""
    if not path.exists():
        return
    history = dest_dir / "history"
    history.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path.replace(history / f"{path.stem}_{stamp}.pdf")


def _schedule_report(bot: Bot, shipment_id: int, chat_id: int, reply_to: int) -> None:
    """Several PDFs usually arrive together. Wait until they stop, then report once."""
    pending = _pending.get(shipment_id)
    if pending and not pending.done():
        pending.cancel()
    _pending[shipment_id] = asyncio.create_task(_report_later(bot, shipment_id, chat_id, reply_to))


async def _report_later(bot: Bot, shipment_id: int, chat_id: int, reply_to: int) -> None:
    try:
        await asyncio.sleep(REPORT_DELAY_SECONDS)
        await _send_report(bot, shipment_id, chat_id, reply_to)
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("Report failed for shipment %s", shipment_id)
        try:
            await bot.send_message(
                chat_id,
                "Something went wrong while checking those documents. They are saved.",
                reply_to_message_id=reply_to,
            )
        except Exception:
            pass


async def _send_back_to_customer_bot(
    bot: Bot,
    shipment: dict,
    row: dict,
    chosen: dict[str, Path],
    already: set[str],
    source: str,
) -> bool:
    """Reply in the customer's chat with the customer bot, not the group bot."""
    user_id = int(row.get("telegram_user_id") or 0) or None
    if not user_id:
        log.warning("No customer to receive PDFs for %s", shipment.get("public_id"))
        return False
    token = _env("BOT_TOKEN", "bot_token")
    if not token:
        log.warning("BOT_TOKEN is missing, so the PDFs were not sent back")
        return False
    reply_to = row.get("customer_message_id")
    reply = {"reply_to_message_id": int(reply_to)} if reply_to else {}
    caption = customer_caption(shipment.get("expected_json"), source)
    customer_bot = Bot(token)
    try:
        for kind in ("label", "invoice"):
            if kind not in chosen:
                continue
            await customer_bot.send_document(user_id, FSInputFile(chosen[kind]), caption=caption, **reply)
        if announce_completion(chosen, already):
            await customer_bot.send_message(user_id, "Order completed", **reply)
        return True
    except TelegramForbiddenError:
        log.warning("Customer has not opened the bot for %s", shipment.get("public_id"))
        chat_id = shipment.get("chat_id")
        if chat_id:
            await bot.send_message(
                chat_id,
                "I could not send the PDF to the customer. They need to open this bot first.",
                reply_to_message_id=shipment.get("request_message_id"),
            )
        return False
    finally:
        await customer_bot.session.close()


async def deliver_customer_pdfs(bot: Bot, shipment: dict, rows: list[dict], notes: list[str], already: set[str] | None) -> None:
    """Send the label and invoice to the person who asked. A later reply is an edit."""
    files = customer_files(rows)
    if not files:
        return
    source = shipment.get("source_text") or ""
    reference = website_reference(source)
    if already is None:
        already = set(files) if replaced_kinds(notes) else set()
    chosen, edited = plan_delivery(files, notes, already)
    if not chosen:
        if edited and reference:
            mark_order_edited(reference)
        return

    row = None
    if reference:
        try:
            row = order_row(reference)
        except Exception:
            log.exception("Could not read order %s", reference)

    if row and row.get("origin") == "bot":
        sent = await _send_back_to_customer_bot(bot, shipment, row, chosen, already, source)
        if sent and edited and reference:
            mark_order_edited(reference)
        return

    if reference:
        user_id = requester_telegram_id(reference)
    else:
        user_id = int(shipment.get("created_by") or 0) or None
    if not user_id:
        log.warning("No customer to receive PDFs for %s", shipment.get("public_id"))
        return
    try:
        for kind in ("label", "invoice"):
            if kind not in chosen:
                continue
            caption = customer_caption(shipment.get("expected_json"), source)
            await bot.send_document(user_id, FSInputFile(chosen[kind]), caption=caption)
    except TelegramForbiddenError:
        log.warning("Customer has not opened the bot for %s", shipment.get("public_id"))
        chat_id = shipment.get("chat_id")
        if chat_id:
            await bot.send_message(
                chat_id,
                "I could not send the PDF to the customer. They need to open this bot first.",
                reply_to_message_id=shipment.get("request_message_id"),
            )
        return
    if edited and reference:
        mark_order_edited(reference)


async def _send_report(bot: Bot, shipment_id: int, chat_id: int, reply_to: int) -> None:
    shipment = db.get_shipment(shipment_id)
    if not shipment:
        return

    expected = Expected.from_dict(json.loads(shipment["expected_json"] or "{}"))
    rows = db.list_documents(shipment_id)
    docs: dict[str, DocExtract] = {}
    for row in rows:
        if row["kind"].startswith("other_"):
            continue
        docs[row["kind"]] = DocExtract.from_dict(json.loads(row["extracted_json"]))

    report = build_report(expected, docs)
    tracking, _conflict = pick_tracking(docs)

    previous = shipment["tracking_number"]
    if previous and tracking and previous != tracking:
        report.notes.append(f"Tracking number updated: {previous} → {tracking}")
    report.notes = _replacement_notes.pop(shipment_id, []) + report.notes

    db.update_shipment(
        shipment_id,
        status=report.verdict,
        tracking_number=tracking,
        service=report.service,
        packaging=report.packaging,
        ship_date=report.ship_date,
        summary_json=json.dumps(report.summary(), ensure_ascii=False),
    )
    db.add_history(
        shipment_id,
        tracking,
        report.verdict,
        json.dumps(report.summary(), ensure_ascii=False),
    )

    body = report.text(shipment["public_id"])
    label_edited = any("Replaced the previous label." in note for note in report.notes)
    previous_report = shipment.get("report_message_id")
    if label_edited and previous_report:
        try:
            await bot.edit_message_text(body, chat_id=chat_id, message_id=int(previous_report))
        except Exception:
            log.exception("Could not edit the report for %s", shipment["public_id"])
        note = await bot.send_message(
            chat_id,
            "Label edited, please check and confirm.",
            reply_to_message_id=int(previous_report),
        )
        db.index_message(chat_id, note.message_id, shipment_id)
    else:
        sent = await bot.send_message(
            chat_id,
            body,
            reply_to_message_id=reply_to,
        )
        db.index_message(chat_id, sent.message_id, shipment_id)
        db.update_shipment(shipment_id, report_message_id=sent.message_id)
    # needs_review still releases the label and invoice. The record is never sent.
    source = shipment.get("source_text") or ""
    reference = website_reference(source)
    if reference:
        try:
            save_order_details(reference, tracking, expected.name)
        except Exception:
            log.exception("Could not save tracking for %s", shipment["public_id"])
    try:
        already = saved_customer_kinds(reference)
    except Exception:
        log.exception("Could not read the existing files for %s", shipment["public_id"])
        already = None
    try:
        publish_customer_pdfs(source, rows)
    except Exception:
        log.exception("Could not publish customer PDFs for %s", shipment["public_id"])
    try:
        await deliver_customer_pdfs(bot, shipment, rows, report.notes, already)
    except Exception:
        log.exception("Could not send customer PDFs for %s", shipment["public_id"])


@router.message(F.chat.id == GROUP_CHAT_ID)
async def comment_reply(message: Message, bot: Bot) -> None:
    _log_message(message)
    if message.text and message.text.startswith("/"):
        return
    shipment = _resolve_shipment(message)
    if not shipment:
        if message.photo and message.reply_to_message:
            await message.reply(
                "That arrived as a photo. Send the label or invoice as a PDF file."
            )
        return

    parts: list[str] = []
    if message.text:
        parts.append(message.text)
    if message.caption:
        parts.append(message.caption)
    if message.photo:
        parts.append("[photo]")
    if message.voice:
        parts.append("[voice]")
    if message.sticker:
        parts.append("[sticker]")
    if not parts:
        parts.append("[message]")

    db.add_comment(
        shipment_id=shipment["id"],
        message_id=message.message_id,
        from_user_id=_user_id(message),
        from_user_name=_display_name(message),
        text="\n".join(parts),
    )
    db.index_message(message.chat.id, message.message_id, shipment["id"])
    await _react(bot, message, "💬")
