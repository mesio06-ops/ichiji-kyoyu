import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendSyncLog, getSyncLogPath } from "./sync-auto-log.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(root, "sync-targets.json");
const IDLE_MS = 3 * 60 * 1000;
const IGNORE_PATH_RE =
  /(?:^|[\\/])\.git(?:[\\/]|$)|(?:^|[\\/])node_modules(?:[\\/]|$)|~$|\.tmp$|\.swp$/i;

let idleTimer = null;
let pushing = false;
let pendingAfterPush = false;

function loadConfig() {
  if (!existsSync(configPath)) {
    throw new Error(`設定ファイルが見つかりません: ${configPath}`);
  }
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function normalizePath(path) {
  return path.replace(/\\/g, "/");
}

function resolveWatchTargets(paths) {
  const targets = [];
  for (const target of paths) {
    const absolute = resolve(root, target);
    if (!existsSync(absolute)) {
      continue;
    }
    targets.push(absolute);
  }
  return targets;
}

function isUnderWatchTarget(filePath, watchTargets) {
  const normalized = normalizePath(resolve(filePath));
  return watchTargets.some((target) => {
    const normalizedTarget = normalizePath(target);
    if (normalized === normalizedTarget) {
      return true;
    }
    const prefix = normalizedTarget.endsWith("/")
      ? normalizedTarget
      : `${normalizedTarget}/`;
    return normalized.startsWith(prefix);
  });
}

function shouldIgnorePath(filePath) {
  const relativePath = normalizePath(relative(root, filePath));
  return IGNORE_PATH_RE.test(relativePath);
}

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdlePush() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    runAutoPush("idle");
  }, IDLE_MS);
}

function onFileEvent(eventType, filePath, watchTargets) {
  if (!filePath || shouldIgnorePath(filePath)) {
    return;
  }
  if (!isUnderWatchTarget(filePath, watchTargets)) {
    return;
  }

  const label = normalizePath(relative(root, filePath));
  appendSyncLog(`変更を検知 (${eventType}): ${label}`);
  scheduleIdlePush();
}

function runAutoPush(reason) {
  if (pushing) {
    pendingAfterPush = true;
    appendSyncLog(`送信中のため待機 (${reason})`);
    return;
  }

  pushing = true;
  pendingAfterPush = false;
  appendSyncLog(`自動送るを実行 (${reason})`);

  const child = spawn(process.execPath, ["scripts/sync-push.mjs", "--auto"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      appendSyncLog(text);
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      appendSyncLog(`[stderr] ${text}`);
    }
  });

  child.on("close", (code) => {
    pushing = false;
    if (code === 0) {
      appendSyncLog("自動送るが完了しました");
    } else {
      appendSyncLog(`自動送るが失敗しました (exit ${code})`);
    }

    if (pendingAfterPush) {
      pendingAfterPush = false;
      scheduleIdlePush();
    }
  });
}

function startWatchers(watchTargets) {
  const watchers = [];

  for (const target of watchTargets) {
    const recursive = statSync(target).isDirectory();
    try {
      const watcher = watch(
        target,
        recursive ? { recursive: true } : undefined,
        (eventType, fileName) => {
          const filePath = fileName ? join(target, fileName) : target;
          onFileEvent(eventType, filePath, watchTargets);
        },
      );
      watcher.on("error", (error) => {
        appendSyncLog(`監視エラー: ${error.message}`);
      });
      watchers.push(watcher);
    } catch (error) {
      appendSyncLog(`監視開始に失敗: ${normalizePath(relative(root, target))} (${error.message})`);
    }
  }

  return watchers;
}

function main() {
  const config = loadConfig();
  const watchTargets = resolveWatchTargets(config.paths);

  if (watchTargets.length === 0) {
    throw new Error("監視対象が見つかりません。sync-targets.json を確認してください。");
  }

  appendSyncLog("自動送る監視を開始しました");
  appendSyncLog(`待機時間: ${IDLE_MS / 1000} 秒`);
  appendSyncLog(`ログ: ${getSyncLogPath()}`);

  console.log("========================================");
  console.log("  自動送る（常駐）");
  console.log("========================================");
  console.log("");
  console.log(`編集が止まって ${IDLE_MS / 1000} 秒後に自動で送ります`);
  console.log(`ログ: ${getSyncLogPath()}`);
  console.log("");
  console.log("監視対象:");
  for (const target of watchTargets) {
    console.log(`  - ${normalizePath(relative(root, target))}`);
  }
  console.log("");
  console.log("このウィンドウを閉じると自動送るは止まります。");
  console.log("");

  startWatchers(watchTargets);
}

main();
