import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
console.log("GitHub から最新を取得しています…");
const result = spawnSync("git", ["pull", "--rebase", "--autostash"], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error || result.status !== 0) {
  console.error("取得に失敗しました。競合やログイン状態を確認してください。");
  process.exit(1);
}
console.log("完了しました。一時共有フォルダは最新です。");
