#!/usr/bin/env bash
# 反向验证：四道装置各制造一次违规，确认它真的会失败。验完全部还原。
set -uo pipefail
fail=0

check() {
  desc="$1"; want="$2"; shift 2
  "$@" >/dev/null 2>&1
  got=$?
  if [ "${got}" = "${want}" ]; then
    echo "✓ ${desc} → 退出码 ${got}（期望 ${want}）"
  else
    echo "✗ ${desc} → 退出码 ${got}，期望 ${want}"
    fail=1
  fi
}

echo "=== 1. doc-refs：加一个失效链接 ==="
cp doc/admin-cli.md /tmp/_rev_doc.md
printf '\n见 [不存在的文件](./这个文件不存在.md)\n' >> doc/admin-cli.md
check "doc-refs 报失效引用" 1 python3 scripts/check_doc_refs.py
cp /tmp/_rev_doc.md doc/admin-cli.md && rm /tmp/_rev_doc.md

echo
echo "=== 2. layout-check：新建一个没声明分类的文件 ==="
mkdir -p tools && echo x > tools/未归类的东西.txt
check "layout-check 报未归类（不带 --warn-only）" 1 python3 scripts/check_layout.py
rm -rf tools

echo
echo "=== 3. install-check：把 doc-refs 这个钩子 id 改个名 ==="
cp .pre-commit-config.yaml /tmp/_rev_pc.yaml
sed -i '' 's/      - id: doc-refs/      - id: doc-refs-typo/' .pre-commit-config.yaml
check "install-check 报「装了但没接通」" 2 python3 scripts/check_install.py
cp /tmp/_rev_pc.yaml .pre-commit-config.yaml && rm /tmp/_rev_pc.yaml

echo
echo "=== 4a. incidents：状态与出口自相矛盾 → 第三态（退 2）==="
# 只改状态、留着出口 = 自相矛盾（有出口却说未闭环）。
# 那不是「有未闭环事故」，是**台账本身坏了** —— 所以期望 2。
# 我第一版期望 1，错的是我不是检查：这道校验存在的理由恰恰是
# 「把状态改成已闭环但出口留空」这种把台账刷干净的改法。
cp docs/harness/incidents.md /tmp/_rev_inc.md
sed -i '' 's/- \*\*状态\*\*：半闭环/- **状态**：未闭环/' docs/harness/incidents.md
check "incidents 报状态与出口矛盾" 2 python3 scripts/incidents.py --check
cp /tmp/_rev_inc.md docs/harness/incidents.md   # 只还原，备份留给 4b 复用

echo
echo "=== 4b. incidents：真的未闭环（出口为无 + 状态未闭环）→ 退 1 ==="
# 这才是「发现的问题」：确实还没做出口。
#
# **出口是多行的**，只把第一行换成「无」不够 —— 后面几行还留着，
# 于是仍被判成「有出口」（我第一版就是这么错的）。
# 要把整个出口块（从 `- **出口**：` 到下一个 `- **` 字段行之前）都去掉。
# 而且**不能碰「升级条件」** —— 整段正则替换会把它一起吃掉，
# 条目解析不出来就变成退 2 了（我第零版踩过这个）。
python3 - "$PWD/docs/harness/incidents.md" <<'PY'
import re
import sys
from pathlib import Path

p = Path(sys.argv[1])
out, skipping = [], False
for line in p.read_text(encoding="utf-8").splitlines(keepends=True):
    if line.startswith("- **出口**："):
        out.append("- **出口**：无\n")
        skipping = True                 # 吃掉出口的后续行
        continue
    if skipping:
        # 遇到下一个字段行（`- **状态**：` 等）就停止吃
        if re.match(r"- \*\*[^*]+\*\*：", line):
            skipping = False
        else:
            continue
    if line.startswith("- **状态**：半闭环"):
        out.append("- **状态**：未闭环\n")
        continue
    out.append(line)
p.write_text("".join(out), encoding="utf-8")
PY
check "incidents 报未闭环" 1 python3 scripts/incidents.py --check
cp /tmp/_rev_inc.md docs/harness/incidents.md && rm /tmp/_rev_inc.md

echo
echo "=== 还原后四道都应该是绿的 ==="
for s in check_install check_doc_refs check_layout; do
  check "${s} 还原后" 0 python3 "scripts/${s}.py"
done
check "incidents 还原后" 0 python3 scripts/incidents.py --check

echo
if [ "${fail}" -eq 0 ]; then echo "全部通过。"; else echo "有失败项。"; fi
exit "${fail}"
