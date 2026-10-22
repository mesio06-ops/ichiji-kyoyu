import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function readOwner(path) {
  const text = readFileSync(path, 'utf8').trim();
  try {
    const owner = JSON.parse(text);
    if (typeof owner === 'object' && owner && Number.isInteger(owner.pid)) return owner;
  } catch {}
  const pid = /^\d+$/.test(text) ? Number(text) : null;
  return { pid, token: text };
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function gitRunning() {
  if (process.platform === 'win32') {
    const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq git.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (result.error || result.status !== 0) throw new Error('Gitの実行状況を確認できません。古いロックは保持しました。通常のWindowsユーザーで「送る」を実行してください。');
    return /^"git\.exe",/im.test(result.stdout || '');
  }
  const result = spawnSync('pgrep', ['-x', 'git'], { encoding: 'utf8', timeout: 5000 });
  if (result.error || ![0, 1].includes(result.status)) throw new Error('Gitの実行状況を確認できません。古いロックは保持しました。');
  return result.status === 0;
}

function archive(root, path, expected) {
  if (!existsSync(path)) return false;
  const current = statSync(path);
  if (expected && (current.ino !== expected.ino || current.mtimeMs !== expected.mtimeMs || current.size !== expected.size)) return false;
  const directory = join(root, '_sync-auto', 'lock-backups');
  mkdirSync(directory, { recursive: true });
  const filename = `${Date.now()}-${randomUUID()}-${path.endsWith('index.lock') ? 'index' : 'sync-push'}.lock.bak`;
  try {
    renameSync(path, join(directory, filename));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error(`ロックをバックアップへ移せませんでした (${error.code})。待機を停止しました: ${path}`);
  }
}

/** 古いGitロックを確認し、動作中のGitがない場合だけバックアップへ移します。 */
export async function waitForGitIndex(root, options = {}) {
  const { onProgress = () => {}, maxWaitMs = 3 * 60 * 1000, pollMs = 1000, staleMs = 2 * 60 * 1000, probeGit = gitRunning } = options;
  const path = join(root, '.git', 'index.lock');
  const deadline = Date.now() + maxWaitMs;
  let nextMessage = 0;
  while (existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('Gitの処理が終わらないため同期を停止しました。実行中のGitやソース管理の状態を確認してください。');
    const snapshot = statSync(path);
    if (Date.now() >= nextMessage) {
      onProgress('Gitのロックを確認しています。処理中の場合は終了を待ちます。');
      nextMessage = Date.now() + 15000;
    }
    if (Date.now() - snapshot.mtimeMs >= staleMs && !probeGit() && archive(root, path, snapshot)) {
      onProgress('古いGitロックをバックアップへ移しました。');
      return;
    }
    await sleep(pollMs);
  }
}

/** 手動送信・自動送信を順番に実行し、所有したロックを必ず後片づけします。 */
export async function withSyncPushLock(root, fn, options = {}) {
  const { onProgress = () => {}, maxWaitMs = 15 * 60 * 1000, pollMs = 1000, probePid = isPidAlive } = options;
  const directory = join(root, '_sync-auto');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'sync-push.lock');
  const owner = { pid: process.pid, token: randomUUID() };
  const deadline = Date.now() + maxWaitMs;
  let nextMessage = 0;
  while (Date.now() < deadline) {
    let acquired = false;
    let fd;
    try {
      fd = openSync(path, 'wx');
      writeFileSync(fd, JSON.stringify(owner), 'utf8');
      acquired = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (acquired) {
      try {
        return await fn();
      } finally {
        if (existsSync(path) && readOwner(path).token === owner.token) archive(root, path);
      }
    }
    if (!existsSync(path)) continue;
    const snapshot = statSync(path);
    const previous = readOwner(path);
    if (!Number.isInteger(previous.pid) || previous.pid <= 0) throw new Error(`同期ロックの記録を読み取れません。バックアップと照合してください: ${path}`);
    if (!probePid(previous.pid)) {
      if (archive(root, path, snapshot)) onProgress('終了済みの同期ロックをバックアップへ移しました。');
      continue;
    }
    if (Date.now() >= nextMessage) {
      onProgress(`別の同期処理の終了を待っています（処理番号 ${previous.pid}）。`);
      nextMessage = Date.now() + 15000;
    }
    await sleep(pollMs);
  }
  throw new Error('別の同期処理が終わらないため停止しました。複数の「送る」や「作業開始」が開いていないか確認してください。');
}

export function isGitIndexLockError(message) {
  return /index\.lock/i.test(message || '');
}
