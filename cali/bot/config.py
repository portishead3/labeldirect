import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
load_dotenv(ROOT.parent / "backend" / ".env")


def _env(*names: str) -> str:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


TOKEN = _env("CALI_BOT_TOKEN", "TELEGRAM_TOKEN", "Telegram_Token")
GROUP_CHAT_ID_RAW = _env("CALI_GROUP_CHAT_ID", "TELEGRAM_GROUPCHAT_ID", "Telegram_groupchat_ID")

if not TOKEN:
    raise RuntimeError("CALI_BOT_TOKEN is missing (Telegram_Token is also accepted)")
if not GROUP_CHAT_ID_RAW:
    raise RuntimeError("CALI_GROUP_CHAT_ID is missing (Telegram_groupchat_ID is also accepted)")

GROUP_CHAT_ID = int(GROUP_CHAT_ID_RAW)

DATA_DIR = ROOT / "data"
FILES_DIR = DATA_DIR / "files"
DB_PATH = DATA_DIR / "cali.db"

DATA_DIR.mkdir(exist_ok=True)
FILES_DIR.mkdir(exist_ok=True)
