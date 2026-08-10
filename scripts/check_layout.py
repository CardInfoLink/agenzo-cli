#!/usr/bin/env python3
"""文件归属检查：每个文件都能归入某一类，归不进去就退 1。

## 为什么

15 处散落，而没有任何东西在问「这个新文件属于哪一类」。
加新文件时必须先回答「它属于哪」，回答不了说明这个文件的定位本身没想清楚。

## 用法

    .venv/bin/python scripts/check_layout.py            # 检查
    .venv/bin/python scripts/check_layout.py --init     # 列出未归类文件
    .venv/bin/python scripts/check_layout.py --json     # 机器可读

## 退出码

    0  全部文件都有归属（或 --init 模式）
    1  有文件归不进去 / 该提交的被忽略了 / 不该提交的被跟踪了
    2  第三态 —— layout.json 缺失或格式错 / git 命令不可用

## 检查内容

1. 每个文件都能匹配到一条规则（归不进去 → 退 1）
2. 分类声明「该提交」的文件不应被 gitignore（被忽略 → 退 1）
3. 分类声明「不该提交」的文件不应被 git 跟踪（被跟踪 → 退 1）
4. 分类「工具强制」的路径必须存在（缺失 → 退 2）
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LAYOUT_FILE = Path(os.environ.get("LAYOUT_FILE") or REPO / "harness/layout.json")

EXIT_OK = 0
EXIT_ISSUES = 1
EXIT_BROKEN = 2


class LayoutError(RuntimeError):
    """layout.json 不可用 → 退出码 2。"""


def _load_layout() -> dict:
    if not LAYOUT_FILE.exists():
        raise LayoutError(f"layout.json 不存在：{LAYOUT_FILE}")
    try:
        data = json.loads(LAYOUT_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise LayoutError(f"layout.json 格式错误：{e}") from e
    if "分类" not in data or "规则" not in data:
        raise LayoutError("layout.json 缺少 '分类' 或 '规则' 字段")
    return data


def _git(*args: str) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["git", *args],
            cwd=REPO,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        raise LayoutError(f"git 命令不可用：{e}") from e


def _list_files() -> list[str]:
    """列出所有应管辖的文件：已跟踪 + 未跟踪未忽略。"""
    tracked = _git("ls-files")
    if tracked.returncode != 0:
        raise LayoutError(f"git ls-files 失败：{tracked.stderr}")
    untracked = _git("ls-files", "--others", "--exclude-standard")
    if untracked.returncode != 0:
        raise LayoutError(f"git ls-files --others 失败：{untracked.stderr}")
    files = tracked.stdout.strip().splitlines() + untracked.stdout.strip().splitlines()
    return [f for f in files if f]


def _match_file(filepath: str, rules: list[dict]) -> str | None:
    """返回文件匹配到的分类，None 表示没有匹配。规则按顺序匹配，第一条命中为准。"""
    for rule in rules:
        pattern = rule["模式"]
        if fnmatch.fnmatch(filepath, pattern):
            return rule["分类"]
    return None


def _check_ignore(filepath: str) -> bool:
    """检查文件是否被 gitignore。返回 True 表示被忽略。"""
    r = _git("check-ignore", "-q", filepath)
    return r.returncode == 0


def _is_tracked(filepath: str) -> bool:
    """检查文件是否被 git 跟踪。"""
    r = _git("ls-files", filepath)
    return bool(r.stdout.strip())


def main() -> int:
    ap = argparse.ArgumentParser(description="文件归属检查")
    ap.add_argument("--init", action="store_true", help="列出未归类文件（引导模式，退 0）")
    ap.add_argument(
        "--warn-only",
        action="store_true",
        help="发现问题时也返回 0（观察期用），但检查本身坏了仍返回 2",
    )
    ap.add_argument("--json", action="store_true", help="JSON 输出")
    args = ap.parse_args()

    try:
        layout = _load_layout()
    except LayoutError as e:
        print(f"✗ [第三态] {e}", file=sys.stderr)
        return EXIT_BROKEN

    categories = layout["分类"]
    rules = layout["规则"]

    try:
        files = _list_files()
    except LayoutError as e:
        print(f"✗ [第三态] {e}", file=sys.stderr)
        return EXIT_BROKEN

    # --init 模式：只列出未归类文件
    if args.init:
        unmatched: dict[str, list[str]] = {}
        for f in files:
            cat = _match_file(f, rules)
            if cat is None:
                dirname = str(Path(f).parent) if "/" in f else "(根目录)"
                unmatched.setdefault(dirname, []).append(f)
        if not unmatched:
            print("✓ 所有文件都已归类。")
        else:
            print(f"有 {sum(len(v) for v in unmatched.values())} 个文件未归类：\n")
            for d in sorted(unmatched):
                print(f"  {d}/")
                for f in sorted(unmatched[d]):
                    print(f"    {f}")
        return EXIT_OK

    # 正式检查
    problems: list[dict] = []

    # 检查 1：每个文件都能归入
    for f in files:
        cat = _match_file(f, rules)
        if cat is None:
            problems.append({
                "type": "unclassified",
                "file": f,
                "message": "未归类：先在 harness/layout.json 里声明它属于哪一类",
            })

    # 检查 2：「该提交」的文件不应被忽略
    for f in files:
        cat = _match_file(f, rules)
        if cat is None:
            continue
        spec = categories.get(cat, {})
        if spec.get("该提交") and _check_ignore(f):
            problems.append({
                "type": "should_commit_but_ignored",
                "file": f,
                "category": cat,
                "message": f"分类「{cat}」声明该提交，但被 gitignore 忽略了",
            })

    # 检查 3：「不该提交」的文件不应被跟踪
    for f in files:
        cat = _match_file(f, rules)
        if cat is None:
            continue
        spec = categories.get(cat, {})
        if not spec.get("该提交") and _is_tracked(f):
            problems.append({
                "type": "should_not_commit_but_tracked",
                "file": f,
                "category": cat,
                "message": f"分类「{cat}」声明不该提交，但被 git 跟踪了",
            })

    # 检查 4：声明「位置由工具决定」的那些路径必须真实存在。
    #
    # **原来这里按分类名字面等于「工具强制」来筛** —— 一个硬编码的魔法名字。
    # 别的仓库把这个分类叫「工具约定」，这条检查就**整条静默失效**，
    # 而输出一样是绿的。而分类名本来就是每个仓库自己的语言（layout.json 的
    # 全部意义就在这里），所以按名字匹配是错的轴。
    #
    # 改成由数据声明：分类里写 `"位置由工具决定": true`。
    # 兼容老写法（名字叫「工具强制」）—— 本仓与已装好的仓库不用改文件。
    # 由一次无上下文安装演练报出（`INC-031`）：那个 agent 差点给这个分类
    # 起了别的名字。
    tool_forced_cats = {
        name
        for name, spec in categories.items()
        if (isinstance(spec, dict) and spec.get("位置由工具决定")) or name == "工具强制"
    }
    tool_forced_patterns = [r["模式"] for r in rules if r["分类"] in tool_forced_cats]
    for pattern in tool_forced_patterns:
        # 只检查不含通配符的具体路径
        if "*" in pattern or "?" in pattern:
            continue
        path = REPO / pattern
        if not path.exists():
            problems.append({
                "type": "tool_forced_missing",
                "file": pattern,
                "message": f"工具强制路径不存在：{pattern}",
            })

    if args.json:
        print(json.dumps({"problems": problems, "total_files": len(files)}, ensure_ascii=False, indent=2))
        if args.warn_only:
            print("（观察期：只警告，不拦提交。检查本身坏了仍会退 2。）")
            return EXIT_OK
        return EXIT_ISSUES if problems else EXIT_OK

    if not problems:
        print(f"✓ 文件归属检查通过：{len(files)} 个文件全部归类，无违规。")
        return EXIT_OK

    print(f"发现 {len(problems)} 个问题：\n")
    for p in problems:
        print(f"  [{p['type']}] {p['file']}")
        print(f"    {p['message']}")
    if args.warn_only:
        print("（观察期：只警告，不拦提交。检查本身坏了仍会退 2。）")
        return EXIT_OK
    return EXIT_ISSUES


if __name__ == "__main__":
    sys.exit(main())
