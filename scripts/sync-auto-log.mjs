import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const logDir = join(dirname(fileURLToPath(import.meta.url)), "..", "_sync-auto");
const logPath = join(logDir, "sync-auto.log");

function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function appendSyncLog(message) {
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  appendFileSync(logPath, `[${formatTimestamp()}] ${message}\n`, "utf8");
}

export function getSyncLogPath() {
  return logPath;
}
