#!/usr/bin/env node
// 交互式发布脚本：选择并发布 agenzo-cli workspace 下的 npm 包。
//
// 用法（在仓库根目录）：
//   npm run release            # 交互式挑选要发布的包
//   node scripts/publish-packages.mjs
//
// 能力：
//   - 自动发现所有非 private 的 workspace 包（packages/* + apps/*），读取本地版本；
//   - 查询每个包在 npm registry 上的已发布版本，标注状态：
//       NEW（从未发布） / 可发布（本地版本未占用） / 已存在（本地版本已在 registry，需要先 bump）；
//   - 多选（编号 / a=全部可发布 / q 退出）→ 确认 → 可选 build → 可选 dry-run；
//   - 逐个 `npm publish -w <dir> --access public [--otp=...]`；OTP 过期/需要时自动重新询问；
//   - 结尾用 `npm view` 校验，打印汇总。
//
// 零外部依赖：仅用 Node 内置模块（readline/promises + child_process）。
// 说明：本脚本不改版本号（发版前请先在各包 package.json bump 好），只负责“选择 + 发布”。

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPM = 'npm';
// Node 22 在 Windows 上禁止用 shell:false 直接 spawn .cmd/.bat（CVE-2024-27980），
// 故 Windows 下走 shell:true（由 cmd.exe 解析到 npm.cmd）；POSIX 保持 shell:false。
const USE_SHELL = process.platform === 'win32';

// ── 小工具 ────────────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const color = (name, s) => `${c[name]}${s}${c.reset}`;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 捕获式执行（拿 stdout/stderr + code），不继承 TTY。 */
function shCapture(args, opts = {}) {
  const r = spawnSync(NPM, args, { cwd: REPO_ROOT, encoding: 'utf8', shell: USE_SHELL, ...opts });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

/** 继承式执行（实时输出，用于 build / publish 让用户看到进度）。 */
function shInherit(args, opts = {}) {
  const r = spawnSync(NPM, args, { cwd: REPO_ROOT, stdio: 'inherit', shell: USE_SHELL, ...opts });
  return r.status ?? 1;
}

// ── 发现 workspace 包 ─────────────────────────────────────────────────────────
function discoverPackages() {
  const rootPkg = readJson(join(REPO_ROOT, 'package.json')) || {};
  const globs = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];
  const dirs = new Set();
  for (const g of globs) {
    if (g.endsWith('/*')) {
      const base = join(REPO_ROOT, g.slice(0, -2));
      if (existsSync(base)) {
        for (const name of readdirSync(base)) {
          const d = join(base, name);
          if (statSync(d).isDirectory() && existsSync(join(d, 'package.json'))) dirs.add(d);
        }
      }
    } else {
      const d = join(REPO_ROOT, g);
      if (existsSync(join(d, 'package.json'))) dirs.add(d);
    }
  }
  const pkgs = [];
  for (const dir of dirs) {
    const pkg = readJson(join(dir, 'package.json'));
    if (!pkg || !pkg.name) continue;
    pkgs.push({
      name: pkg.name,
      version: pkg.version || '0.0.0',
      private: Boolean(pkg.private),
      relDir: dir.slice(REPO_ROOT.length + 1).replaceAll('\\', '/'),
    });
  }
  return pkgs.sort((a, b) => a.name.localeCompare(b.name));
}

/** 查询 registry 上该包的已发布版本列表（不存在返回 []，网络/其它错误返回 null=未知）。 */
function fetchPublishedVersions(name) {
  const { code, out } = shCapture(['view', name, 'versions', '--json']);
  if (code !== 0) {
    if (/E404|404 Not Found|is not in this registry/i.test(out)) return [];
    return null; // 未知（网络/权限），不阻断，仅提示
  }
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    return null;
  }
}

function statusOf(pkg) {
  if (pkg.private) return { key: 'private', label: color('dim', 'private（跳过，不发布）'), publishable: false };
  const versions = fetchPublishedVersions(pkg.name);
  if (versions === null) return { key: 'unknown', label: color('yellow', '无法查询 registry（网络/权限？）'), publishable: true };
  if (versions.length === 0) return { key: 'new', label: color('cyan', 'NEW（首次发布）'), publishable: true };
  const latest = versions[versions.length - 1];
  if (versions.includes(pkg.version)) {
    return { key: 'exists', label: color('red', `已存在 v${pkg.version}（需先 bump；registry latest=${latest}）`), publishable: false };
  }
  return { key: 'publishable', label: color('green', `可发布（registry latest=${latest}）`), publishable: true };
}

// ── 交互 ──────────────────────────────────────────────────────────────────────
async function main() {
  const dryRunFlag = process.argv.includes('--dry-run');

  console.log(color('bold', '\nagenzo-cli 发布助手\n'));
  console.log(color('dim', `仓库根：${REPO_ROOT}\n查询 registry 中…\n`));

  const pkgs = discoverPackages();
  if (pkgs.length === 0) {
    console.log(color('red', '未发现任何 workspace 包。'));
    process.exit(1);
  }

  const rows = pkgs.map((p) => ({ ...p, status: statusOf(p) }));

  console.log(color('bold', '可选包：'));
  rows.forEach((r, i) => {
    const idx = r.status.publishable ? color('bold', String(i + 1).padStart(2)) : color('dim', String(i + 1).padStart(2));
    console.log(`  ${idx}. ${r.name.padEnd(24)} ${color('dim', 'v' + r.version)}  ${r.status.label}`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, def = '') => rl.question(def ? `${q} ${color('dim', `(${def})`)} ` : `${q} `).then((a) => a.trim() || def);

  const publishableIdx = rows.map((r, i) => (r.status.publishable ? i + 1 : null)).filter(Boolean);
  console.log(
    color('dim', `\n选择要发布的编号（逗号/空格分隔），或 a=全部可发布[${publishableIdx.join(',')}]，q=退出`),
  );
  const sel = await ask('>', 'q');
  if (sel.toLowerCase() === 'q') { await rl.close(); console.log('已退出。'); return; }

  let chosen;
  if (sel.toLowerCase() === 'a') {
    chosen = rows.filter((r) => r.status.publishable);
  } else {
    const nums = sel.split(/[\s,]+/).map((x) => parseInt(x, 10)).filter((n) => n >= 1 && n <= rows.length);
    chosen = [...new Set(nums)].map((n) => rows[n - 1]);
  }
  // 过滤掉 private / 已存在版本（选了也发不了）。
  const skipped = chosen.filter((r) => !r.status.publishable);
  chosen = chosen.filter((r) => r.status.publishable);
  for (const s of skipped) console.log(color('yellow', `  跳过 ${s.name}：${s.status.label}`));

  if (chosen.length === 0) { await rl.close(); console.log(color('yellow', '没有可发布的包，退出。')); return; }

  console.log(color('bold', '\n即将发布：'));
  chosen.forEach((r) => console.log(`  - ${r.name}@${r.version}  ${color('dim', r.relDir)}`));

  const confirm = (await ask(color('bold', '\n确认发布以上包？'), 'y/N')).toLowerCase();
  if (confirm !== 'y' && confirm !== 'yes') { await rl.close(); console.log('已取消。'); return; }

  // 先 build（默认 Y），确保 dist/ 与当前源码一致。
  const doBuild = (await ask('先执行 npm run build 重新构建？', 'Y/n')).toLowerCase();
  if (doBuild !== 'n' && doBuild !== 'no') {
    console.log(color('cyan', '\n> npm run build\n'));
    const code = shInherit(['run', 'build']);
    if (code !== 0) {
      const cont = (await ask(color('red', 'build 失败，仍继续发布？'), 'y/N')).toLowerCase();
      if (cont !== 'y' && cont !== 'yes') { await rl.close(); console.log('已中止。'); return; }
    }
  }

  // 可选 dry-run（先预览不上传）。
  let dryRun = dryRunFlag;
  if (!dryRun) {
    const d = (await ask('先跑一次 dry-run 预览（不真正发布）？', 'y/N')).toLowerCase();
    dryRun = d === 'y' || d === 'yes';
  }
  if (dryRun) {
    console.log(color('cyan', '\n=== DRY RUN（不会上传）===\n'));
    for (const r of chosen) {
      console.log(color('bold', `\n--- ${r.name} ---`));
      shInherit(['publish', '-w', r.relDir, '--access', 'public', '--dry-run']);
    }
    const proceed = (await ask(color('bold', '\ndry-run 完成，继续真正发布？'), 'y/N')).toLowerCase();
    if (proceed !== 'y' && proceed !== 'yes') { await rl.close(); console.log('仅 dry-run，未发布。'); return; }
  }

  // OTP（2FA）。可留空（若账号未开启发布 2FA）；失败会再问。
  let otp = await ask('输入 npm 一次性验证码 OTP（无 2FA 可留空）：', '');

  const results = { ok: [], failed: [] };
  for (const r of chosen) {
    console.log(color('bold', `\n=== 发布 ${r.name}@${r.version} ===`));
    let attempts = 0;
    while (true) {
      attempts += 1;
      const args = ['publish', '-w', r.relDir, '--access', 'public'];
      if (otp) args.push(`--otp=${otp}`);
      const { code, out } = shCapture(args);
      process.stdout.write(out.endsWith('\n') ? out : out + '\n');
      if (code === 0) { results.ok.push(r); break; }
      // OTP 相关错误 → 重新询问后重试（最多 3 次）。
      if (/EOTP|one-time password|otp/i.test(out) && attempts < 3) {
        otp = await ask(color('yellow', 'OTP 过期/无效，请输入新的 OTP：'), '');
        continue;
      }
      if (/cannot publish over|EPUBLISHCONFLICT|previously published/i.test(out)) {
        console.log(color('yellow', `  ${r.name}：该版本已存在，跳过（请先 bump 版本）。`));
      }
      results.failed.push(r);
      break;
    }
  }

  await rl.close();

  // 汇总 + 校验。
  console.log(color('bold', '\n==================== 汇总 ===================='));
  for (const r of results.ok) {
    const { out } = shCapture(['view', r.name, 'version']);
    const latest = out.trim().split('\n').pop();
    console.log(color('green', `  ✓ ${r.name}  registry latest=${latest}`));
  }
  for (const r of results.failed) console.log(color('red', `  ✗ ${r.name}  发布失败（见上方输出）`));
  console.log(color('bold', '==============================================\n'));
  if (results.failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(color('red', `脚本异常：${err?.stack || err}`));
  process.exit(1);
});
