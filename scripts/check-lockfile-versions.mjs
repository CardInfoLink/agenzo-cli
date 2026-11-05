// package-lock.json 与各 workspace package.json 的版本一致性检查。
//
// 为什么需要它（2026-11-05 实测的一次漂移）：
//   lock 里 `apps/merchant-cli` 的版本停在 0.10.1，而 package.json 已经走到 0.10.3 ——
//   连漏两次（0.10.2 与 0.10.3 两次发版都只改了 package.json）。
//
//   漏的原因是顺序：改 `apps/<app>/package.json` 的版本号本身**不碰 lock**，真正把 lock
//   同步过去的是之后的 `npm install` / `npm publish` —— 而那发生在提交之后，于是 lock 的
//   改动留在工作区里没人管，下一次 `git status` 才被看见。
//
//   后果：`npm ci` 严格按 lock 装、不读 package.json，装出来的 workspace 版本号与源码对不上。
//   workspace 包是本地链接，不影响运行行为，但排障时「现在装的是哪一版」会答错。
//
// 修法（本检查报错时照做）：`npm install --package-lock-only`，然后把 lock 一起提交。
//
// Runnable: `node scripts/check-lockfile-versions.mjs`（接成 `npm run check:lockfile`）。
// 也可被导入做单测，并被 `scripts/publish-packages.mjs` 用作发布前置检查。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, '..');
export const LOCK_NAME = 'package-lock.json';

// lock 的 `packages` 里既有本仓的 workspace 条目（键是仓内相对路径，如 `apps/merchant-cli`），
// 也有全部依赖（键以 `node_modules/` 开头）。只有前者需要与 package.json 对账。
const WORKSPACE_PREFIXES = ['apps/', 'packages/'];

/** 读 JSON；文件不存在或解析失败一律返回 null（调用方区分这两种情况没有意义）。 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** lock 的 `packages` 里属于本仓 workspace 的条目键，排序后返回。 */
export function workspaceKeys(lock) {
  const packages = (lock && lock.packages) || {};
  return Object.keys(packages)
    .filter((key) => WORKSPACE_PREFIXES.some((p) => key.startsWith(p)))
    .sort();
}

/**
 * 比对 lock 记录的 workspace 版本与各包 package.json 的 version。
 *
 * 返回 `{ ok, drifts, checked, lockPath, unreadable }`：
 *   - `drifts`: `[{ dir, lock, actual }]`，lock 与 package.json 不一致的条目；
 *   - `checked`: 实际参与比对的包数（用来识别「检查空转」——见单测）；
 *   - `unreadable`: lock 读不到或没有 `packages` 段时为 true，此时 `ok` 为 false。
 */
export function checkLockfileVersions({ repoRoot = REPO_ROOT } = {}) {
  const lockPath = join(repoRoot, LOCK_NAME);
  const lock = readJson(lockPath);
  if (!lock || !lock.packages) {
    return { ok: false, drifts: [], checked: 0, lockPath, unreadable: true };
  }

  const drifts = [];
  let checked = 0;
  for (const key of workspaceKeys(lock)) {
    const manifestPath = join(repoRoot, key, 'package.json');
    if (!existsSync(manifestPath)) continue; // lock 里有、磁盘上没有：不是版本漂移，交给 npm 自己报
    const manifest = readJson(manifestPath);
    const actual = manifest && manifest.version;
    if (!actual) continue; // 没声明 version 的包（私有占位等）无从对账
    checked += 1;
    const recorded = lock.packages[key].version;
    if (recorded !== actual) {
      drifts.push({ dir: key, lock: recorded, actual });
    }
  }

  return { ok: drifts.length === 0, drifts, checked, lockPath, unreadable: false };
}

/** 把检查结果渲染成人读的多行报告（供 CLI 与发布脚本共用，保证两处口径一致）。 */
export function formatReport(result) {
  if (result.unreadable) {
    return [
      `无法读取 ${LOCK_NAME}（${result.lockPath}）——文件缺失或不是合法 JSON。`,
      '先确认仓库完整，再跑 `npm install --package-lock-only` 生成它。',
    ].join('\n');
  }
  if (result.ok) {
    return `${LOCK_NAME} 与 ${result.checked} 个 workspace 包的 package.json 版本一致。`;
  }
  const lines = [
    `${LOCK_NAME} 的版本落后于 package.json，共 ${result.drifts.length} 处：`,
    '',
    `  ${'workspace'.padEnd(26)} ${'lock'.padEnd(12)} package.json`,
  ];
  for (const d of result.drifts) {
    lines.push(`  ${d.dir.padEnd(26)} ${String(d.lock).padEnd(12)} ${d.actual}`);
  }
  lines.push(
    '',
    '修法：`npm install --package-lock-only`，然后把 package-lock.json 一起提交。',
    '（改 package.json 的版本号不会自动同步 lock —— 那是 npm install / publish 才做的事。）',
  );
  return lines.join('\n');
}

function main() {
  const result = checkLockfileVersions();
  const report = formatReport(result);
  if (result.ok) {
    console.log(`✓ ${report}`);
    return 0;
  }
  console.error(`✗ ${report}`);
  return result.unreadable ? 2 : 1;
}

// 仅在被直接执行时跑 CLI；被 import 时（单测 / 发布脚本）不执行。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
