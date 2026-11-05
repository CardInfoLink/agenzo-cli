// package-lock.json 与各 workspace package.json 的版本一致性检查。
//
// 背景（2026-11-05）：lock 里 apps/merchant-cli 的版本停在 0.10.1，而 package.json 已经
// 走到 0.10.3 —— 0.10.2 与 0.10.3 两次发版都只改了 package.json。原因是顺序：改版本号本身
// 不碰 lock，真正同步 lock 的是之后的 npm install / publish，而那发生在提交之后。
//
// 本测试锁三件事：① 本仓当下没有漂移；② 检查器真的在对账（不是空转）；③ 它能抓到漂移、
// 并忽略 node_modules/* 条目。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs repo tooling module, no type declarations.
import {
  checkLockfileVersions,
  formatReport,
  workspaceKeys,
} from '../../../scripts/check-lockfile-versions.mjs';

/** 在临时目录里搭一个最小仓：lock + 若干 workspace 包。 */
function scaffold(lockPackages: Record<string, unknown>, manifests: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'lockcheck-'));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: lockPackages }), 'utf8');
  for (const [dir, version] of Object.entries(manifests)) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(
      join(root, dir, 'package.json'),
      JSON.stringify({ name: dir.replace(/\//g, '-'), version }),
      'utf8',
    );
  }
  return root;
}

describe('lockfile version contract', () => {
  it('本仓的 lock 与所有 workspace 包的 package.json 一致', () => {
    const result = checkLockfileVersions();
    expect(result.unreadable, `读不到 ${result.lockPath}`).toBe(false);
    const report = result.drifts
      .map((d: { dir: string; lock: string; actual: string }) => `${d.dir}: lock=${d.lock} actual=${d.actual}`)
      .join('; ');
    expect(report, `lock 落后：${report}`).toBe('');
    expect(result.ok).toBe(true);
  });

  it('真的在对账，不是空转（本仓有 5 个 workspace 包）', () => {
    // 若 checked 退化成 0，上一条断言会变成永真 —— 这里把它钉住。
    const result = checkLockfileVersions();
    expect(result.checked).toBeGreaterThanOrEqual(5);
  });

  it('抓得到漂移，并报出两边的版本', () => {
    const root = scaffold(
      { 'apps/demo': { version: '1.0.0' }, 'packages/kit': { version: '2.0.0' } },
      { 'apps/demo': '1.0.2', 'packages/kit': '2.0.0' },
    );
    try {
      const result = checkLockfileVersions({ repoRoot: root });
      expect(result.ok).toBe(false);
      expect(result.checked).toBe(2);
      expect(result.drifts).toEqual([{ dir: 'apps/demo', lock: '1.0.0', actual: '1.0.2' }]);
      expect(formatReport(result)).toContain('apps/demo');
      expect(formatReport(result)).toContain('--package-lock-only');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('只看 apps/* 与 packages/*，不理 node_modules/* 条目', () => {
    expect(
      workspaceKeys({
        packages: {
          '': { name: 'root' },
          'apps/demo': { version: '1.0.0' },
          'packages/kit': { version: '2.0.0' },
          'node_modules/commander': { version: '14.0.3' },
          'node_modules/@agenzo/cli-core': { resolved: 'packages/cli-core', link: true },
        },
      }),
    ).toEqual(['apps/demo', 'packages/kit']);
  });

  it('lock 缺失或非法 JSON 时报 unreadable，而不是误判成「一致」', () => {
    const root = mkdtempSync(join(tmpdir(), 'lockcheck-missing-'));
    try {
      const result = checkLockfileVersions({ repoRoot: root });
      expect(result.unreadable).toBe(true);
      expect(result.ok).toBe(false);
      expect(formatReport(result)).toContain('无法读取');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lock 里有、磁盘上没有的包不算漂移（交给 npm 自己报）', () => {
    const root = scaffold(
      { 'apps/demo': { version: '1.0.0' }, 'apps/ghost': { version: '3.0.0' } },
      { 'apps/demo': '1.0.0' },
    );
    try {
      const result = checkLockfileVersions({ repoRoot: root });
      expect(result.ok).toBe(true);
      expect(result.checked).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
