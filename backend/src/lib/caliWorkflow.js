import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

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

function clean(value) {
  let text = String(value || "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function firstValue(sources, keys) {
  for (const source of sources) {
    for (const key of keys) {
      const value = clean(source && source[key]);
      if (value) return value;
    }
  }
  return "";
}

// Logged once per process so a bad token can be recognised without revealing it.
let credentialsLogged = false;
function logCredentials(token, groupId) {
  if (credentialsLogged) return;
  credentialsLogged = true;
  const fingerprint = token
    ? crypto.createHash("sha256").update(token).digest("hex").slice(0, 12)
    : "";
  console.log(
    "CALI credentials: " +
      JSON.stringify({
        tokenLength: token.length,
        tokenFingerprint: fingerprint,
        tokenShape: /^\d+:[A-Za-z0-9_-]{30,}$/.test(token),
        groupLength: groupId.length,
        groupShape: /^-?\d+$/.test(groupId),
      })
  );
}

export function caliCredentials(caliRoot) {
  const fileEnv = {
    ...readEnvFile(path.join(caliRoot, ".env")),
    ...readEnvFile(path.join(caliRoot, "..", "backend", ".env")),
  };
  const sources = [process.env, fileEnv];
  const token = firstValue(sources, ["CALI_BOT_TOKEN", "TELEGRAM_TOKEN", "Telegram_Token"]);
  const groupId = firstValue(sources, ["CALI_GROUP_CHAT_ID", "TELEGRAM_GROUPCHAT_ID", "Telegram_groupchat_ID"]);
  logCredentials(token, groupId);
  return { token, groupId };
}

function ensureCaliDeps(python, caliRoot) {
  const deps = path.join(caliRoot, ".pydeps");
  const env = { ...process.env, PYTHONPATH: deps };
  const check = spawnSync(python, ["-c", "import aiogram, fitz, dotenv"], {
    cwd: caliRoot,
    env,
    encoding: "utf8",
  });
  if (check.status === 0) return deps;
  console.log("Installing CALI Python packages");
  const install = spawnSync(
    python,
    ["-m", "pip", "install", "--disable-pip-version-check", "--target", deps, "-r", "requirements.txt"],
    { cwd: caliRoot, env, encoding: "utf8", timeout: 180000 }
  );
  const detail = ((install.stderr || "") + (install.stdout || "")).trim().slice(-1500);
  if (install.status !== 0) console.error("CALI package install failed:", detail || install.error || "unknown error");
  return deps;
}

function pipeCali(stream) {
  let pending = "";
  stream.on("data", (chunk) => {
    pending += chunk.toString();
    let breakAt = pending.indexOf("\n");
    while (breakAt >= 0) {
      console.log("CALI: " + pending.slice(0, breakAt));
      pending = pending.slice(breakAt + 1);
      breakAt = pending.indexOf("\n");
    }
  });
}

export function startCaliWorkflow(caliRoot) {
  if (String(process.env.CALI_POLLING || "true").toLowerCase() === "false") {
    console.warn("CALI workflow skipped: CALI_POLLING=false.");
    return null;
  }
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
  const deps = ensureCaliDeps(python, caliRoot);
  caliProcess = spawn(python, ["-m", "bot.main"], {
    cwd: caliRoot,
    env: {
      ...process.env,
      PYTHONPATH: deps + path.delimiter + (process.env.PYTHONPATH || ""),
      CALI_BOT_TOKEN: token,
      CALI_GROUP_CHAT_ID: groupId,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  pipeCali(caliProcess.stdout);
  pipeCali(caliProcess.stderr);
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
