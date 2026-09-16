import "dotenv/config";
import express from "express";
import cors from "cors";
import { publicRouter } from "./routes/public.js";
import { adminRouter } from "./routes/admin.js";
import { resumeIncompleteJobs } from "./lib/listJobs.js";
import { startTelegramBot } from "./lib/telegramBot.js";

const app = express();
const port = Number(process.env.PORT) || 3000;

const origins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isLocalDevOrigin(origin) {
  try {
    const url = new URL(origin);
    const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return localHost && (url.protocol === "http:" || url.protocol === "https:");
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || origins.includes(origin) || isLocalDevOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  })
);
app.use(express.json({ limit: "10mb" }));

app.use("/api", publicRouter);
app.use("/api/admin", adminRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(port, () => {
  console.log(`LABELDIRECT API listening on http://localhost:${port}`);
  resumeIncompleteJobs().catch((err) => {
    console.error("Could not resume list jobs", err);
  });
  startTelegramBot().catch((err) => {
    console.error("Telegram bot failed", err);
  });
});
