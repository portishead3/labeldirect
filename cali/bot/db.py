import sqlite3
from contextlib import contextmanager
from typing import Any

from bot.config import DB_PATH

SHIPMENT_FIELDS = {
    "status",
    "tracking_number",
    "carrier",
    "service",
    "packaging",
    "ship_date",
    "summary_json",
    "expected_json",
    "source_text",
    "report_message_id",
}


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def db():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS shipments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                public_id TEXT NOT NULL UNIQUE,
                chat_id INTEGER NOT NULL,
                request_message_id INTEGER NOT NULL,
                created_by INTEGER NOT NULL,
                created_by_name TEXT,
                source_text TEXT NOT NULL DEFAULT '',
                expected_json TEXT,
                status TEXT NOT NULL DEFAULT 'waiting_label',
                tracking_number TEXT,
                carrier TEXT NOT NULL DEFAULT 'FedEx',
                service TEXT,
                packaging TEXT,
                ship_date TEXT,
                summary_json TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                shipment_id INTEGER NOT NULL REFERENCES shipments(id),
                kind TEXT NOT NULL,
                message_id INTEGER NOT NULL,
                from_user_id INTEGER NOT NULL,
                file_path TEXT NOT NULL,
                extracted_json TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(shipment_id, kind)
            );

            CREATE TABLE IF NOT EXISTS comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                shipment_id INTEGER NOT NULL REFERENCES shipments(id),
                message_id INTEGER NOT NULL,
                from_user_id INTEGER NOT NULL,
                from_user_name TEXT,
                text TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS shipment_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                shipment_id INTEGER NOT NULL REFERENCES shipments(id),
                tracking_number TEXT,
                status TEXT,
                summary_json TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS message_index (
                chat_id INTEGER NOT NULL,
                message_id INTEGER NOT NULL,
                shipment_id INTEGER NOT NULL REFERENCES shipments(id),
                PRIMARY KEY (chat_id, message_id)
            );
            """
        )
        columns = {row[1] for row in conn.execute("PRAGMA table_info(shipments)")}
        if "report_message_id" not in columns:
            conn.execute("ALTER TABLE shipments ADD COLUMN report_message_id INTEGER")


def create_shipment(
    *,
    chat_id: int,
    request_message_id: int,
    created_by: int,
    created_by_name: str,
    source_text: str,
    expected_json: str,
) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM shipments").fetchone()
        public_id = f"CALI-{row['n']:04d}"
        cur = conn.execute(
            """
            INSERT INTO shipments (
                public_id, chat_id, request_message_id, created_by, created_by_name,
                source_text, expected_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                public_id,
                chat_id,
                request_message_id,
                created_by,
                created_by_name,
                source_text,
                expected_json,
            ),
        )
        shipment_id = cur.lastrowid
        conn.execute(
            "INSERT OR IGNORE INTO message_index (chat_id, message_id, shipment_id) VALUES (?, ?, ?)",
            (chat_id, request_message_id, shipment_id),
        )
        return dict(conn.execute("SELECT * FROM shipments WHERE id = ?", (shipment_id,)).fetchone())


def find_shipment_by_message(chat_id: int, message_id: int) -> dict[str, Any] | None:
    with db() as conn:
        row = conn.execute(
            """
            SELECT s.*
            FROM message_index m
            JOIN shipments s ON s.id = m.shipment_id
            WHERE m.chat_id = ? AND m.message_id = ?
            """,
            (chat_id, message_id),
        ).fetchone()
        return dict(row) if row else None


def get_shipment(shipment_id: int) -> dict[str, Any] | None:
    with db() as conn:
        row = conn.execute("SELECT * FROM shipments WHERE id = ?", (shipment_id,)).fetchone()
        return dict(row) if row else None


def index_message(chat_id: int, message_id: int, shipment_id: int) -> None:
    with db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO message_index (chat_id, message_id, shipment_id) VALUES (?, ?, ?)",
            (chat_id, message_id, shipment_id),
        )


def upsert_document(
    *,
    shipment_id: int,
    kind: str,
    message_id: int,
    from_user_id: int,
    file_path: str,
    extracted_json: str,
) -> None:
    with db() as conn:
        conn.execute(
            """
            INSERT INTO documents (shipment_id, kind, message_id, from_user_id, file_path, extracted_json)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(shipment_id, kind) DO UPDATE SET
                message_id = excluded.message_id,
                from_user_id = excluded.from_user_id,
                file_path = excluded.file_path,
                extracted_json = excluded.extracted_json,
                created_at = datetime('now')
            """,
            (shipment_id, kind, message_id, from_user_id, file_path, extracted_json),
        )


def delete_document(shipment_id: int, kind: str) -> None:
    with db() as conn:
        conn.execute("DELETE FROM documents WHERE shipment_id = ? AND kind = ?", (shipment_id, kind))


def add_history(shipment_id: int, tracking_number: str | None, status: str, summary_json: str) -> None:
    with db() as conn:
        conn.execute(
            """
            INSERT INTO shipment_history (shipment_id, tracking_number, status, summary_json)
            VALUES (?, ?, ?, ?)
            """,
            (shipment_id, tracking_number, status, summary_json),
        )


def list_documents(shipment_id: int) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM documents WHERE shipment_id = ? ORDER BY id", (shipment_id,)
        ).fetchall()
        return [dict(row) for row in rows]


def add_comment(
    *,
    shipment_id: int,
    message_id: int,
    from_user_id: int,
    from_user_name: str,
    text: str,
) -> None:
    with db() as conn:
        conn.execute(
            """
            INSERT INTO comments (shipment_id, message_id, from_user_id, from_user_name, text)
            VALUES (?, ?, ?, ?, ?)
            """,
            (shipment_id, message_id, from_user_id, from_user_name, text),
        )


def update_shipment(shipment_id: int, **fields: Any) -> None:
    unknown = set(fields) - SHIPMENT_FIELDS
    if unknown:
        raise ValueError(f"Unknown shipment fields: {sorted(unknown)}")
    if not fields:
        return
    assignments = ", ".join(f"{name} = ?" for name in fields)
    with db() as conn:
        conn.execute(
            f"UPDATE shipments SET {assignments}, updated_at = datetime('now') WHERE id = ?",
            [*fields.values(), shipment_id],
        )
