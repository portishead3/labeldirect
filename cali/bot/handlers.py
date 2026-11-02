import asyncio
import json
import logging
from datetime import datetime
from pathlib import Path

from aiogram import Bot, F, Router
from aiogram.filters import Command
from aiogram.types import Message, ReactionTypeEmoji

from bot import db
from bot.config import FILES_DIR, GROUP_CHAT_ID
from bot.fedex import DocExtract, extract_document, pick_tracking, stale_kinds
from bot.freeform import Expected, parse_request
from bot.publish import publish_customer_pdfs
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
    if existing:
        return existing

    text = _message_text(parent)
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

    kind = extract.kind if extract.kind != "unknown" else f"other_{message.message_id}"
    final_path = dest_dir / f"{kind}.pdf"

    stored = {
        row["kind"]: DocExtract.from_dict(json.loads(row["extracted_json"]))
        for row in db.list_documents(shipment["id"])
        if not row["kind"].startswith("other_")
    }
    notes = _replacement_notes.setdefault(shipment["id"], [])
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

    sent = await bot.send_message(
        chat_id,
        report.text(shipment["public_id"]),
        reply_to_message_id=reply_to,
    )
    db.index_message(chat_id, sent.message_id, shipment_id)
    try:
        publish_customer_pdfs(shipment.get("source_text") or "", rows)
    except Exception:
        log.exception("Could not publish customer PDFs for %s", shipment["public_id"])


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
