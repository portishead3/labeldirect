import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

let caliProcess = null;

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function firstValue(sources, keys) {
  for (const source of sources) {
    for (const key of keys) {
      const value = String((source && source[key]) || "").trim();
      if (value) return value;
    }
  }
  return "";
}

export function caliCredentials(caliRoot) {
  const fileEnv = {
    ...readEnvFile(path.join(caliRoot, ".env")),
    ...readEnvFile(path.join(caliRoot, "..", "backend", ".env")),
  };
  const sources = [process.env, fileEnv];
  return {
    token: firstValue(sources, ["CALI_BOT_TOKEN", "Telegram_Token"]),
    groupId: firstValue(sources, ["CALI_GROUP_CHAT_ID", "Telegram_groupchat_ID"]),
  };
}

export function startCaliWorkflow(caliRoot) {
  const { token, groupId } = caliCredentials(caliRoot);
  if (!token || !groupId) {
    console.warn("CALI workflow skipped: CALI_BOT_TOKEN or CALI_GROUP_CHAT_ID is not set.");
    return null;
  }

  const labelBot = String(process.env.BOT_TOKEN || process.env.bot_token || "").trim();
  if (labelBot && token === labelBot) {
    console.warn("CALI workflow skipped: CALI_BOT_TOKEN is the same as BOT_TOKEN. Use a separate bot.");
    return null;
  }

  const venvPython = path.join(caliRoot, ".venv", "bin", "python");
  const python = fs.existsSync(venvPython) ? venvPython : process.env.CALI_PYTHON || "python3";
  caliProcess = spawn(python, ["-m", "bot.main"], {
    cwd: caliRoot,
    env: {
      ...process.env,
      CALI_BOT_TOKEN: token,
      CALI_GROUP_CHAT_ID: groupId,
    },
    stdio: "inherit",
  });
  caliProcess.on("error", (err) => {
    console.error("CALI workflow failed to start:", err.message || err);
  });
  caliProcess.on("exit", (code, signal) => {
    if (signal) return;
    console.error("CALI workflow exited with code " + code);
  });
  console.log("CALI workflow started");
  return caliProcess;
}

export function stopCaliWorkflow() {
  if (caliProcess && !caliProcess.killed) caliProcess.kill("SIGTERM");
}
