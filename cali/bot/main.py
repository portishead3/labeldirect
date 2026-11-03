import asyncio
import logging

from aiogram import Bot, Dispatcher, Router
from aiogram.types import Message

from bot.config import GROUP_CHAT_ID, TOKEN
from bot.db import init_db
from bot.handlers import router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("cali")


async def main() -> None:
    init_db()
    bot = Bot(TOKEN)
    dp = Dispatcher()
    dp.include_router(router)

    fallback = Router()

    @fallback.message()
    async def log_unhandled(message: Message) -> None:
        log.warning(
            "Unhandled message in chat %s (%s), expected %s",
            message.chat.id,
            message.chat.title,
            GROUP_CHAT_ID,
        )

    dp.include_router(fallback)

    me = await bot.get_me()
    log.info("Bot @%s starting for group %s", me.username, GROUP_CHAT_ID)
    try:
        chat = await bot.get_chat(GROUP_CHAT_ID)
        log.info("Group ok: %s", chat.title or chat.id)
    except Exception as exc:
        log.warning(
            "Cannot read group %s (%s). Add the bot to the group and disable privacy in BotFather.",
            GROUP_CHAT_ID,
            exc,
        )

    # Keep updates that arrived while the process was down, including PDF replies.
    await bot.delete_webhook(drop_pending_updates=False)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
