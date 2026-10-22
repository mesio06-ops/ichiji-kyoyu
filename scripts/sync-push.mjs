import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  isGitIndexLockError,
  waitForGitIndex,
  withSyncPushLock,
} from "./git-sync-lock.mjs";
import { appendSyncLog } from "./sync-auto-log.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(root, "sync-targets.json");
const MAX_LIST = 20;
const GIT_MAX_BUFFER = 128 * 1024 * 1024;
const GITHUB_REPO_URL = "https://github.com/mesio06-ops/ichiji-kyoyu";

function parseArgs(argv) {
  let auto = false;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--auto") {
      auto = true;
    }
  }
  return { auto };
}

const GIT_LOCK_RETRIES = 8;
const GIT_LOCK_RETRY_MS = 750;

function runGitOnce(args, { allowFail = false } = {}) {
  const argv = Array.isArray(args) ? args : args.split(" ");
  const result = spawnSync("git", argv, {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: GIT_MAX_BUFFER,
  });

  if (result.error) {
    if (allowFail) {
      return { ok: false, error: result.error, retryable: false };
    }
    throw result.error;
  }

  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "").trim();
    const retryable = isGitIndexLockError(message);
    if (retryable) {
      return { ok: false, message, retryable: true };
    }
    if (allowFail) {
      return { ok: false, message, retryable: false };
    }
    throw new Error(message || `git ${argv.join(" ")} failed`);
  }

  return { ok: true, stdout: (result.stdout || "").trim() };
}

function sleepSync(ms) {
  if (process.platform === "win32") {
    spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Start-Sleep -Milliseconds ${ms}`],
      { stdio: "ignore", windowsHide: true },
    );
    return;
  }
  spawnSync("sleep", [String(Math.max(1, Math.ceil(ms / 1000)))], {
    stdio: "ignore",
  });
}

function runGit(args, options = {}) {
  for (let attempt = 0; attempt < GIT_LOCK_RETRIES; attempt += 1) {
    const result = runGitOnce(args, options);
    if (result.ok) {
      return result.stdout;
    }
    if (result.error) {
      throw result.error;
    }
    if (!result.retryable || attempt === GIT_LOCK_RETRIES - 1) {
      if (options.allowFail) {
        return null;
      }
      throw new Error(result.message || `git failed`);
    }
    sleepSync(GIT_LOCK_RETRY_MS * (attempt + 1));
  }
  return null;
}

function loadConfig() {
  if (!existsSync(configPath)) {
    console.error(`[エラー] 設定ファイルが見つかりません: ${configPath}`);
    throw new Error("同期処理を停止しました。上の表示を確認してください。");
  }
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function saveConfig(config) {
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function normalizePath(path) {
  return path.replace(/\\/g, "/");
}

function topLevelName(path) {
  const normalized = normalizePath(path).replace(/\/$/, "");
  return normalized.split("/")[0];
}

function isTargetedTopLevel(dirName, paths) {
  return paths.some((path) => topLevelName(path) === dirName);
}

function listTopLevelDirs() {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

function findNewFolders(config) {
  const syncAll = config.paths?.some((path) => normalizePath(path) === ".");
  if (syncAll) {
    return [];
  }
  const excluded = new Set(config.excludedTopLevel ?? []);
  return listTopLevelDirs().filter(
    (dirName) => !excluded.has(dirName) && !isTargetedTopLevel(dirName, config.paths),
  );
}

function listNamesFromGit(args) {
  const out = runGit(args, { allowFail: true });
  if (!out) return [];
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

function addNamesForTarget(set, gitArgs, targetPath) {
  const scoped = normalizePath(targetPath);
  const names = listNamesFromGit([...gitArgs, "--", scoped]);
  for (const name of names) {
    set.add(name);
  }
}

function collectUncommittedInTargets(paths) {
  const pending = new Set();
  for (const target of paths) {
    addNamesForTarget(pending, ["diff", "--name-only"], target);
    addNamesForTarget(pending, ["diff", "--cached", "--name-only"], target);
    addNamesForTarget(pending, ["ls-files", "-o", "--exclude-standard"], target);
  }
  return [...pending].sort();
}

function collectLeftBehindInTargets(paths) {
  const pending = new Set();
  for (const target of paths) {
    addNamesForTarget(pending, ["diff", "--name-only"], target);
    addNamesForTarget(pending, ["ls-files", "-o", "--exclude-standard"], target);
  }
  return [...pending].sort();
}

function getPushSummary() {
  const log = runGit(["log", "origin/main..HEAD", "--oneline"], { allowFail: true });
  const shortstat = runGit(["diff", "--shortstat", "origin/main..HEAD"], { allowFail: true });
  const commits = log ? log.split("\n").filter(Boolean) : [];
  const fileMatch = shortstat?.match(/(\d+) files? changed/);
  return {
    commits,
    shortstat: shortstat?.trim() ?? "",
    fileCount: fileMatch ? Number(fileMatch[1]) : 0,
  };
}

function getLastCommitFileCount() {
  const shortstat = runGit(["show", "--shortstat", "--format=format:", "HEAD"], { allowFail: true });
  const match = shortstat?.match(/(\d+) files? changed/);
  return match ? Number(match[1]) : 0;
}

function printPathList(title, paths) {
  if (paths.length === 0) return;
  console.log(title);
  const shown = paths.slice(0, MAX_LIST);
  for (const path of shown) {
    console.log(`  - ${path}`);
  }
  if (paths.length > MAX_LIST) {
    console.log(`  … 他 ${paths.length - MAX_LIST} 件`);
  }
  console.log("");
}

function failSync(message, details = [], { auto = false } = {}) {
  if (auto) {
    appendSyncLog(`[エラー] ${message}`);
    for (const path of details) {
      appendSyncLog(`  - ${path}`);
    }
    throw new Error("同期処理を停止しました。上の表示を確認してください。");
  }

  console.error("");
  console.error("========================================");
  console.error("  [エラー] 同期は完了していません");
  console.error("========================================");
  console.error("");
  console.error(message);
  if (details.length > 0) {
    console.error("");
    printPathList("  該当ファイル:", details);
  }
  console.error("GitHub を開かなくても、この画面で止まっている＝送れていません。");
  throw new Error("同期処理を停止しました。上の表示を確認してください。");
}

async function askYesNo(rl, question) {
  while (true) {
    const answer = (await rl.question(question)).trim().toLowerCase();
    if (answer === "y" || answer === "yes" || answer === "はい") {
      return true;
    }
    if (answer === "n" || answer === "no" || answer === "いいえ") {
      return false;
    }
    console.log("  y（はい）または n（いいえ）で答えてください。");
  }
}

async function promptForNewFolders(config) {
  const pending = findNewFolders(config);
  if (pending.length === 0) {
    return config;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("");
  console.log("新しいフォルダが見つかりました。同期対象に入れるか確認します。");
  console.log("");

  let changed = false;
  for (const dirName of pending) {
    const include = await askYesNo(
      rl,
      `「${dirName}」を同期対象に入れますか？ [y/n]: `,
    );
    if (include) {
      if (!config.paths.includes(`${dirName}/`)) {
        config.paths.push(`${dirName}/`);
      }
      changed = true;
      console.log(`  → 同期対象に追加しました: ${dirName}/`);
    } else {
      if (!config.excludedTopLevel) {
        config.excludedTopLevel = [];
      }
      if (!config.excludedTopLevel.includes(dirName)) {
        config.excludedTopLevel.push(dirName);
      }
      changed = true;
      console.log(`  → 同期対象外にしました（次回から確認しません）: ${dirName}/`);
    }
  }

  rl.close();

  if (changed) {
    saveConfig(config);
    console.log("");
    console.log("sync-targets.json を更新しました。");
  }

  return config;
}

function printHeader() {
  console.log("========================================");
  console.log("  送る（一時共有）");
  console.log("========================================");
  console.log("");
  console.log("※ このフォルダの内容を GitHub と同期します");
  console.log("  YouTube フォルダとは別リポジトリです");
  console.log("");
  console.log("終了後: ブラウザで GitHub を開き、目視で確認してください");
  console.log("");
}

function openGitHubRepo() {
  console.log("");
  console.log("  GitHub を開きます:");
  console.log(`  ${GITHUB_REPO_URL}`);
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "", GITHUB_REPO_URL], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [GITHUB_REPO_URL], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [GITHUB_REPO_URL], { detached: true, stdio: "ignore" }).unref();
}

function printTargets(config) {
  const labels = config.paths.map((path) => normalizePath(path));
  console.log("現在の同期対象:");
  for (const label of labels) {
    console.log(`  - ${label}`);
  }
  console.log("");
}

function ensureGitReady() {
  if (!existsSync(join(root, ".git"))) {
    console.error("[エラー] このスクリプトは「一時共有」フォルダ直下で実行してください。");
    throw new Error("同期処理を停止しました。上の表示を確認してください。");
  }

  try {
    runGit(["--version"]);
  } catch {
    console.error("[エラー] Git が見つかりません。");
    throw new Error("同期処理を停止しました。上の表示を確認してください。");
  }

  const email = runGit(["config", "user.email"], { allowFail: true });
  if (!email) {
    console.error("[エラー] Git の名前が未設定です。");
    console.error("先に「git-setup.bat」を1回だけ実行してください。");
    throw new Error("同期処理を停止しました。上の表示を確認してください。");
  }
}

function gitAddTargets(paths) {
  for (const path of paths) {
    runGit(["add", "--", normalizePath(path)]);
  }
}

function verifyRemoteMain({ auto = false } = {}) {
  runGit(["fetch", "origin", "main"], { allowFail: false });
  const localHead = runGit(["rev-parse", "HEAD"]);
  const remoteMain = runGit(["rev-parse", "origin/main"], { allowFail: true });
  if (!remoteMain) {
    failSync("GitHub 上の main ブランチを確認できませんでした。", [], { auto });
  }
  if (localHead !== remoteMain) {
    failSync("送信後もローカルと GitHub の内容が一致しません。", [
      `local:  ${localHead}`,
      `remote: ${remoteMain}`,
    ], { auto });
  }
}

function hasSyncWork(config) {
  const uncommitted = collectUncommittedInTargets(config.paths);
  if (uncommitted.length > 0) {
    return true;
  }
  const pendingLog = runGit(["log", "origin/main..HEAD", "--oneline"], {
    allowFail: true,
  });
  return Boolean(pendingLog);
}

function logStep(auto, message) {
  if (auto) {
    appendSyncLog(message);
    return;
  }
  console.log(message);
}

function printSuccessSummary({
  auto,
  pushed,
  pushSummary,
  hadNewChanges,
  doneHint,
}) {
  if (auto) {
    if (pushed && pushSummary && pushSummary.commits.length > 0) {
      appendSyncLog(`送信完了 (${pushSummary.commits.length} commit)`);
      for (const line of pushSummary.commits) {
        appendSyncLog(`  ${line}`);
      }
    } else if (!hadNewChanges) {
      appendSyncLog("送る変更はありませんでした");
    } else {
      appendSyncLog("送信完了");
    }
    return;
  }

  console.log("");
  console.log("========================================");
  if (pushed && pushSummary && pushSummary.commits.length > 0) {
    console.log("  同期成功 — GitHub で確認してください");
    console.log("========================================");
    console.log("");
    for (const line of pushSummary.commits) {
      console.log(`  ${line}`);
    }
  } else if (!hadNewChanges) {
    console.log("  送る変更はありませんでした");
    console.log("========================================");
    console.log("");
    console.log("  GitHub は既に最新の可能性があります。");
    console.log("  ブラウザで念のため確認してください。");
  } else {
    console.log("  同期成功 — GitHub で確認してください");
    console.log("========================================");
  }

  openGitHubRepo();

  console.log("");
  console.log(`  次: ${doneHint}`);
  console.log("========================================");
}

function mainSteps(config, { auto = false } = {}) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const commitPrefix = "同期送信";
  const doneHint = "もう一方のPCで「一時共有」フォルダの「作業開始.bat」を実行してください";
  const fail = (message, details = []) => failSync(message, details, { auto });

  const pendingBeforeAdd = collectUncommittedInTargets(config.paths);

  logStep(auto, "[1/6] 同期対象の変更を集めています...");
  gitAddTargets(config.paths);

  const leftBehindAfterAdd = collectLeftBehindInTargets(config.paths);
  if (leftBehindAfterAdd.length > 0) {
    fail(
      "同期対象のファイルに、Git に載せられなかった変更が残っています。",
      leftBehindAfterAdd,
    );
  }

  if (!auto) {
    console.log("");
  }
  logStep(auto, "[2/6] 変更を保存しています...");
  const hasStaged = runGit(["diff", "--cached", "--quiet"], { allowFail: true });
  let committed = false;
  let committedFileCount = 0;
  if (hasStaged === null) {
    runGit(["commit", "-m", `${commitPrefix} ${timestamp}`]);
    committed = true;
    committedFileCount = getLastCommitFileCount();
    logStep(auto, `保存しました。（${committedFileCount} ファイル）`);
  } else {
    logStep(auto, "保存する変更はありませんでした。");
    if (pendingBeforeAdd.length > 0) {
      fail(
        "同期対象に変更がありましたが、保存（commit）されませんでした。",
        pendingBeforeAdd,
      );
    }
  }

  if (!auto) {
    console.log("");
  }
  logStep(auto, "[3/6] GitHub から最新を取得しています...");
  try {
    runGit(["pull", "--rebase", "--autostash"]);
  } catch {
    fail("GitHub からの取得に失敗しました。競合の可能性があります。");
  }

  if (!auto) {
    console.log("");
  }
  logStep(auto, "[4/6] 送る内容を確認しています...");
  const pendingLog = runGit(["log", "origin/main..HEAD", "--oneline"], {
    allowFail: true,
  });
  const hadUnpushedCommits = Boolean(pendingLog);
  const pushSummary = hadUnpushedCommits ? getPushSummary() : null;
  let pushed = false;

  if (!hadUnpushedCommits) {
    logStep(auto, "送る commit はありません。");
  } else {
    if (auto) {
      logStep(auto, pendingLog);
      if (pushSummary?.shortstat) {
        logStep(auto, `  → 合計: ${pushSummary.shortstat}`);
      }
    } else {
      console.log(pendingLog);
      if (pushSummary?.shortstat) {
        console.log(`  → 合計: ${pushSummary.shortstat}`);
      }
    }
    if (!auto) {
      console.log("");
    }
    logStep(auto, "[5/6] GitHub に送信中...");
    try {
      runGit(["push"]);
      pushed = true;
      logStep(auto, "送信しました。");
    } catch {
      fail("GitHub への送信に失敗しました。ログイン状態を確認してください。");
    }

    if (!auto) {
      console.log("");
    }
    logStep(auto, "[6/6] 送信結果を確認しています...");
    verifyRemoteMain({ auto });
  }

  const remainingInTargets = collectLeftBehindInTargets(config.paths);
  if (remainingInTargets.length > 0) {
    fail("送信後も同期対象に未送信の変更が残っています。", remainingInTargets);
  }

  printSuccessSummary({
    auto,
    pushed,
    pushSummary,
    hadNewChanges: committed || hadUnpushedCommits,
    doneHint,
  });
}

async function main() {
  const options = parseArgs(process.argv);
  const { auto } = options;
  const onProgress = (message) => (auto ? appendSyncLog(message) : console.log(message));
  if (!auto) printHeader();
  onProgress("同期を開始します。ロックの状態を確認しています…");

  await withSyncPushLock(root, async () => {
    await waitForGitIndex(root, { onProgress });
    ensureGitReady();

    let config = loadConfig();
    if (auto) {
      if (!hasSyncWork(config)) {
        return;
      }
      appendSyncLog("自動送るを開始します");
    } else {
      config = await promptForNewFolders(config);
      printTargets(config);
    }

    mainSteps(config, options);
  }, { onProgress });
}

const cliOptions = parseArgs(process.argv);

main().catch((error) => {
  const message = error.message ?? String(error);
  if (cliOptions.auto) {
    appendSyncLog(`[エラー] ${message}`);
  } else {
    console.error("[エラー]", message);
  }
  process.exitCode = 1;
});
