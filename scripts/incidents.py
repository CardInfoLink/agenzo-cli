#!/usr/bin/env python3
"""事故台账的驱动装置 —— 让「踩过的坑有没有产出防护」可被查询。

## 为什么光有台账不够

一篇记录如果没人查，它就只是让人心安的摆设。环 4（唯一让系统自我增强的那个环）是：

    出事故 → 记下来 → **产出出口** → 同样的问题下次立刻暴露

断点几乎总在第三步：事故记了，出口没做，而且**没有任何机制提醒**。所以台账必须配一条
命令，能回答「哪些事故至今没有出口」，并且在存在未闭环项时**返回非 0** ——
返回 0 的检查等于没有检查。

## 出口只有两种

阶段一硬约束：**不新增 `arch_check` 规则**。所以出口只能是：

- **测试** —— 写一个会失败的测试
- **AGENTS.md 约定** —— 写进 agent 每次都会读到的地方

两种都没有就是 `无` + `未闭环`。**不许编一个出口让台账看起来干净。**

## 为什么校验「状态与出口自洽」

最容易出现的腐化不是漏记，而是**把状态改成「已闭环」但出口留空** ——
台账变干净了，检查也过了，而问题一点没解决。所以这两个字段互相校验，矛盾即退出码 2。

## 第三态

| 情形 | 行为 |
| --- | --- |
| 台账文件缺失 | **退出码 2** —— 不是「没有未闭环事故」 |
| 某条事故缺必填字段 | **退出码 2** 并指出编号与缺哪个字段 |
| `状态` 取值不在 enum 内 | **退出码 2** |
| 状态写「已闭环」但出口是 `无` | **退出码 2**（自相矛盾） |
| 编号重复 | **退出码 2** —— 重复编号会让 D7 的「规则附事故编号」失去唯一性 |
| 解析出 0 条事故 | **退出码 2** —— 台账存在却读不出任何条目，说明格式坏了 |
| 有未闭环事故 | **退出码 1**（`--check` 模式），这是「发现问题」不是「检查坏了」 |

## 用法

    .venv/bin/python scripts/incidents.py            # 全部列出，退出码恒 0
    .venv/bin/python scripts/incidents.py --check    # 只列未闭环，有则返回 1
    .venv/bin/python scripts/incidents.py --json     # 机器可读

**为什么不进 pre-commit**：台账里长期会有未闭环项（那是正常的，说明还有债没还），
放进 pre-commit 会永久拦住所有提交。它的位置是 CI（加 `allow_failure`，标黄提醒）
与每周复盘。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# 台账位置可被环境变量覆盖 —— 测试要能在临时目录里构造各种坏台账，
# 不能改动仓库里那份真实记录。
LEDGER = Path(os.environ.get("INCIDENTS_FILE") or REPO / "docs/harness/incidents.md")

EXIT_OK = 0
EXIT_OPEN_ITEMS = 1
EXIT_BROKEN = 2

STATUS_CLOSED = "已闭环"
STATUS_HALF = "半闭环"
STATUS_OPEN = "未闭环"
STATUSES = (STATUS_CLOSED, STATUS_HALF, STATUS_OPEN)
NO_EXIT = "无"

# ### `INC-001` · 2026-07-27 · 一句话标题
#
# 编号两侧的反引号是**必需的写法、可选的语法**：GitLab 的 Jira 集成会把裸写的
# `字母-数字` 渲染成死链（`INC-023`），所以正文与标题都要包；但这里允许不包，
# 因为 `tests/test_incidents.py` 的构造样本用的是裸写，而那些不经 GitLab 渲染。
#
# 补反引号那次实测：改完 105 处之后本脚本立刻退出码 2「一条都没解析出来」——
# 第三态起作用了。**如果当时它是静默返回 0，台账就会悄悄变成空的。**
HEADING = re.compile(
    r"^###\s+`?(INC-\d{3})`?\s+·\s+(\d{4}-\d{2}-\d{2})\s+·\s+(.+?)\s*$"
)
# ### `INC-023` 补记 · 一句话标题
#
# 补记是「同一条事故的第二面」：主线已闭环之后又发现同一形态的另一处
# （`INC-022` 的 verbose、`INC-023` 的文档侧）。它没有独立日期 —— 沿用父条目的。
#
# **为什么必须单独认它**：不认的话 `_parse()` 会走到「遇到别的 ### 就 flush」那一支，
# 把整段当注释丢掉 —— 于是补记里写的 `- **状态**：未闭环` 对 `--check` 完全不可见，
# 命令照样打印「全部 N 条都有出口」并返回 0。**返回 0 的检查等于没有检查。**
# 这条是 AI Review 在 MR !61 报出来的（MAJOR）。
SUPPLEMENT = re.compile(r"^###\s+`?(INC-\d{3})`?\s+补记\s+·\s+(.+?)\s*$")
# 补记的状态写成「已闭环（并入 `INC-023`）」—— 括号里是归属说明，不是状态值。
# 校验 enum 之前先剥掉它，否则真解析出来反而会退 2。
STATUS_SUFFIX = re.compile(r"（[^（）]*）\s*$")
# - **现象**：...
FIELD = re.compile(r"^\s*-\s+\*\*(现象|根因|出口|状态|同类扫描|升级条件)\*\*：\s*(.*)$")

REQUIRED = ("现象", "根因", "出口", "状态", "同类扫描")
# 补记只强制这两项。现象与根因往往写在正文散段里（`INC-022` 补记就是那样），
# 而 `--check` 真正需要的是「有没有出口」和「闭没闭环」。
# **刻意不放宽这两项** —— 放宽了补记就能悄悄躺在台账里没有出口。
REQUIRED_SUPPLEMENT = ("出口", "状态")

# 这些条目写在「同类扫描」字段规定之前，豁免该字段的必填校验。
# **这个集合只许变小。** 想加一条进来 = 你在给新事故开后门，
# 那正是这个字段要防的事。
_SCAN_GRANDFATHERED = frozenset({
    "INC-001", "INC-002", "INC-003", "INC-004", "INC-005",
    "INC-006", "INC-007", "INC-008", "INC-009", "INC-010",
    "INC-011", "INC-012", "INC-013", "INC-014", "INC-015",
    "INC-016", "INC-017", "INC-018", "INC-019", "INC-020",
    "INC-021", "INC-022", "INC-023", "INC-024", "INC-025",
})


class LedgerError(RuntimeError):
    """台账本身不可用 → 退出码 2。"""


@dataclass
class Incident:
    id: str
    date: str
    title: str
    symptom: str
    root_cause: str
    exit_path: str
    status: str
    scan_similar: str = ""
    upgrade_condition: str = ""
    # 补记条目的父编号。主条目为 None。
    parent: str | None = None

    @property
    def is_open(self) -> bool:
        return self.status == STATUS_OPEN

    @property
    def is_half_closed(self) -> bool:
        return self.status == STATUS_HALF


def _parse(text: str) -> list[Incident]:
    """解析台账。字段值允许跨行（续行会被拼接），因为说明往往写不完一行。"""
    incidents: list[Incident] = []
    dates: dict[str, str] = {}
    cur_head: tuple[str, str, str, str | None] | None = None
    cur_fields: dict[str, str] = {}
    cur_key: str | None = None

    def flush() -> None:
        nonlocal cur_head, cur_fields, cur_key
        if cur_head is None:
            return
        inc_id, date, title, parent = cur_head
        required = REQUIRED_SUPPLEMENT if parent else REQUIRED
        # 豁免集合内的主条目不要求「同类扫描」——它们写在此字段规定之前。
        # 补记沿用父条目的豁免状态（补记的 REQUIRED_SUPPLEMENT 本来就不含同类扫描）。
        base_id = parent if parent else inc_id
        if base_id in _SCAN_GRANDFATHERED and "同类扫描" in required:
            required = tuple(k for k in required if k != "同类扫描")
        missing = [k for k in required if not cur_fields.get(k, "").strip()]
        if missing:
            raise LedgerError(f"{inc_id} 缺必填字段：{'、'.join(missing)}")
        incidents.append(
            Incident(
                id=inc_id,
                date=date,
                title=title,
                symptom=cur_fields.get("现象", "").strip(),
                root_cause=cur_fields.get("根因", "").strip(),
                exit_path=cur_fields["出口"].strip(),
                status=cur_fields["状态"].strip(),
                scan_similar=cur_fields.get("同类扫描", "").strip(),
                upgrade_condition=cur_fields.get("升级条件", "").strip(),
                parent=parent,
            )
        )
        cur_head, cur_fields, cur_key = None, {}, None

    in_fence = False
    for line in text.splitlines():
        # 围栏代码块里的行一律跳过。**台账本来就是一份会展示自己格式的文档** ——
        # 头部「格式约定」那段在讲标题长什么样，`INC-024` 里也有 ```text 块。
        # 不认围栏的后果：有人把 `### INC-NNN · YYYY-MM-DD · 标题` 放进代码块举例，
        # 整份台账就会报「无法归属的三级标题」并退 2。
        # 这条是 AI Review 在 MR !61 第二轮报出来的（MINOR），它还指出
        # 同一个 MR 里的 `check_doc_refs.py` 正是为这件事加了 FENCE_RE ——
        # **两个脚本读同一批 markdown，口径不该不同。**
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = HEADING.match(line)
        if m:
            flush()
            dates[m.group(1)] = m.group(2)
            cur_head = (m.group(1), m.group(2), m.group(3), None)
            cur_fields, cur_key = {}, None
            continue
        sm = SUPPLEMENT.match(line)
        if sm:
            flush()
            parent = sm.group(1)
            if parent not in dates:
                raise LedgerError(
                    f"{parent} 补记 出现在父条目之前（或父条目不存在）。\n"
                    "  补记沿用父条目的日期，所以必须写在它后面。"
                )
            cur_head = (f"{parent} 补记", dates[parent], sm.group(2), parent)
            cur_fields, cur_key = {}, None
            continue
        if line.startswith("### "):
            # 既不是主条目也不是补记的三级标题 —— **不许静默跳过**。
            # 静默跳过就是「台账里写了、检查看不见」，与本脚本存在的理由相反。
            raise LedgerError(
                f"无法归属的三级标题：{line.strip()!r}\n"
                "  只允许两种形态：\n"
                "    ### `INC-NNN` · YYYY-MM-DD · 标题\n"
                "    ### `INC-NNN` 补记 · 标题\n"
                "  其他写法会被解析器丢掉，那一段里写的状态与出口就没人看得见。"
            )
        if cur_head is None:
            continue
        fm = FIELD.match(line)
        if fm:
            cur_key = fm.group(1)
            cur_fields[cur_key] = fm.group(2)
            continue
        # 续行：属于上一个字段。空行结束当前字段。
        if cur_key and line.strip() and line.startswith((" ", "\t")):
            cur_fields[cur_key] += " " + line.strip()
        elif not line.strip():
            cur_key = None
        elif line.startswith("## "):
            # `### ` 已在上面处理（认得的两种形态各自开新条目，认不得的直接退 2）
            flush()
    flush()
    return incidents


def _validate(incidents: list[Incident]) -> None:
    if not incidents:
        # **「一条都没有」有两种来源，退出码必须不同**：
        #
        #   ① 刚装好的新仓库，还没出过事故        → 合法状态，退 0
        #   ② 台账里有内容但标题格式不对，解析不出 → 格式坏了，退 2
        #
        # 原来一律退 2。代价是**一个刚装好的仓库必然是红的**：
        # `check_install.py` 说「声明与实现一致」，而 `incidents.py --check` 退 2
        # —— 安装侧认为空台账合法，驱动侧认为格式坏了，两边对同一个状态判断相反。
        #
        # 实测发现（2026-08-09）：让一个**无上下文的 agent** 只读 `INSTALL.md`
        # 把护栏装到一个空仓库，它在这里卡住了。两条路都不通 ——
        # 留空则驱动装置退 2，编一条假事故则违反「不许编一个出口让台账看起来干净」。
        # 见 `INC-031`。
        #
        # **判据看「字段行」，不看标题。**
        #
        # 第一版判「原文出现过 `### ` 或 `INC-`」—— 那是错的，而且错在最要紧的
        # 那个场景上：台账模板**自己就在正文里展示标题格式**
        # （`### INC-NNN · YYYY-MM-DD · 标题`），于是脚手架产出的空台账必然命中，
        # 新仓库照样退 2。**我以为修好了，实际一次都没生效。**
        #
        # 根因是我的测试用的是自己手写的「（还没有事故。）」，
        # **不是脚手架真的产出物**。判据与它要判的那份模板出自同一套代码，
        # 却从没被放在一起跑过 —— 由第二次无上下文安装演练报出（`INC-031` 补记）。
        #
        # 换成「有没有出现过 `- **状态**：` / `- **现象**：` 这类字段行」：
        # 展示格式的模板不会写这些，真的写了事故的人一定会写。
        # **只认行首的字段行，而且跳过引用块与代码围栏。**
        # 第二版判「原文任意位置含 `- **状态**：`」—— 模板里那句
        # 「每条必填五项：`- **现象**：` / …」又命中了。
        # 说明只要模板要**说明格式**，任何「按内容特征找」的判据都会被它自己命中；
        # 唯一稳的轴是**位置**：真正的字段行在行首，说明文字在引用块（`>`）或围栏里。
        raw = LEDGER.read_text(encoding="utf-8") if LEDGER.exists() else ""
        looks_attempted = False
        in_fence = False
        for line in raw.splitlines():
            if line.lstrip().startswith("```"):
                in_fence = not in_fence
                continue
            if in_fence or line.lstrip().startswith(">"):
                continue
            if re.match(r"\s*-\s+\*\*(现象|根因|出口|状态)\*\*", line):
                looks_attempted = True
                break
        if looks_attempted:
            raise LedgerError(
                f"{LEDGER.name} 里有像事故条目的内容，却一条都没解析出来。\n"
                "  说明标题格式不对 —— 这不是「没有事故」。\n"
                "  标题必须是 `### INC-NNN · YYYY-MM-DD · 标题`"
                "（或 `### INC-NNN 补记 · 标题`）。"
            )
        print(
            f"✓ {LEDGER.name} 里还没有事故 —— 这是**新仓库的合法状态**，不是格式坏了。\n"
            "  第一条真实事故发生时按台账里的格式记进去。"
            "**安装过程本身踩到的坑就算一条**，不要为了让它非空而编一条。"
        )
        return

    seen: dict[str, str] = {}
    for inc in incidents:
        # 「已闭环（并入 `INC-023`）」这类归属说明剥掉再比 enum，见 STATUS_SUFFIX
        inc.status = STATUS_SUFFIX.sub("", inc.status).strip()
        if inc.status not in STATUSES:
            raise LedgerError(f"{inc.id} 的状态 {inc.status!r} 不在 enum 内。允许值：{'、'.join(STATUSES)}")
        # 唯一性只对**主条目**判定。补记的 id 是 `f"{parent} 补记"` 合成出来的，
        # 一个父条目写第二条补记就会撞 —— 于是整份台账退 2 并报「编号重复」，
        # 而那句报错还引用 D7「规则附事故编号要唯一」，把读的人指去查错方向。
        # `INC-022` 补记 正文自己写着「这是主线的第三面」，出现第四面就是第二条补记,
        # 这条路径是通的。AI Review 在 MR !61 第二轮报出来（MAJOR）。
        #
        # 补记之间靠「父编号 + 标题」区分：同一父条目下两条同标题的补记仍要拦
        # （那是复制粘贴漏改，不是两件事）。
        key = inc.id if inc.parent is None else f"{inc.id}：{inc.title}"
        if key in seen:
            what = "编号" if inc.parent is None else "父编号 + 标题"
            raise LedgerError(
                f"{what} {key!r} 重复（{seen[key]!r} 与 {inc.title!r}）。\n"
                "  D7 要求新增规则必须附事故编号，编号重复会让这条追溯失去唯一性。\n"
                "  同一条事故要写第二条补记时，把标题写得不一样。"
            )
        seen[key] = inc.title
        # 状态与出口必须自洽
        if inc.status == STATUS_CLOSED and inc.exit_path == NO_EXIT:
            raise LedgerError(
                f"{inc.id} 自相矛盾：状态是「{STATUS_CLOSED}」但出口是「{NO_EXIT}」。\n"
                "  把状态改成已闭环、出口留空，是台账最容易出现的腐化方式 ——\n"
                "  台账变干净了，检查也过了，而问题一点没解决。"
            )
        if inc.status == STATUS_OPEN and inc.exit_path != NO_EXIT:
            raise LedgerError(
                f"{inc.id} 自相矛盾：状态是「{STATUS_OPEN}」但出口写了「{inc.exit_path}」。\n"
                "  有出口就该是已闭环；若出口只是计划而未落地，请写「无」并在正文说明。"
            )
        # 已闭环但出口只有约定（无测试/检查/配置） → 应改为半闭环
        # 混合出口（如「约定 + 代码」「AGENTS.md 约定 + 配置」）按非约定成分算已闭环。
        # INC-023（约定+代码）和 INC-024（约定+配置）都含机制类关键词，判为已闭环。
        if inc.status == STATUS_CLOSED and inc.exit_path != NO_EXIT:
            exit_lower = inc.exit_path.lower()
            # 出口以约定类关键词开头，且不包含机制类关键词
            starts_with_convention = any(
                exit_lower.startswith(kw) for kw in ("agents.md", "约定", "契约 ", "注释")
            )
            has_mechanism = any(
                kw in exit_lower for kw in (
                    "测试", "test", "检查", "check", "配置", "config",
                    "新增", "改", "脚本", "script", "规则", "rule",
                )
            )
            if starts_with_convention and not has_mechanism:
                raise LedgerError(
                    f"{inc.id} 出口只有约定（「{inc.exit_path}」），应标为「{STATUS_HALF}」而非「{STATUS_CLOSED}」。\n"
                    "  只有约定的出口是半闭环 —— 约定能被绕过，机制不能。"
                )
        # 半闭环必须有升级条件
        if inc.status == STATUS_HALF and not inc.upgrade_condition:
            raise LedgerError(
                f"{inc.id} 状态是「{STATUS_HALF}」但缺「升级条件」字段。\n"
                "  半闭环必须写明「什么情况下要做成机制」，否则它永远不会升级。"
            )


def _load() -> list[Incident]:
    if not LEDGER.exists():
        raise LedgerError(
            f"事故台账不存在：{LEDGER.relative_to(REPO) if LEDGER.is_relative_to(REPO) else LEDGER}\n"
            "  这不是「没有未闭环事故」—— 台账缺失本身就是问题。"
        )
    incidents = _parse(LEDGER.read_text(encoding="utf-8"))
    _validate(incidents)
    return incidents


def main() -> int:
    ap = argparse.ArgumentParser(description="事故台账查询与未闭环检查")
    ap.add_argument("--check", action="store_true", help="只列未闭环条目，存在则返回 1")
    ap.add_argument("--scan-debt", action="store_true", help="列出豁免名单里还没补「同类扫描」的条目")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args()

    try:
        incidents = _load()
    except LedgerError as exc:
        print(f"✗ {exc}", file=sys.stderr)
        print("\n  以上是第三态（台账本身坏了），不是「没有未闭环事故」。", file=sys.stderr)
        return EXIT_BROKEN

    open_items = [i for i in incidents if i.is_open]
    # 「多少条事故」按主条目算 —— 补记是同一条事故的第二面，不是新事故。
    # 但**闭环检查覆盖全部条目**，补记也要有出口。
    n_main = sum(1 for i in incidents if i.parent is None)
    n_supp = len(incidents) - n_main

    if args.scan_debt:
        # 列出豁免名单里尚未补「同类扫描」的主条目
        debt = [
            i for i in incidents
            if i.parent is None and i.id in _SCAN_GRANDFATHERED and not i.scan_similar
        ]
        if debt:
            print(f"豁免名单里还有 {len(debt)} 条没补「同类扫描」：\n")
            for i in debt:
                print(f"  {i.id} · {i.date} · {i.title}")
        else:
            print("✓ 豁免名单里的条目全部已补「同类扫描」。")
        return len(debt)

    if args.json:
        print(
            json.dumps(
                {
                    "total": len(incidents),
                    "main": n_main,
                    "supplements": n_supp,
                    "open": len(open_items),
                    "incidents": [asdict(i) for i in incidents],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return EXIT_OPEN_ITEMS if (args.check and open_items) else EXIT_OK

    if args.check:
        if not open_items:
            # 半闭环计数上限：超过 3 条 → 退 1（发现问题，不是检查坏了）
            half_closed = [i for i in incidents if i.is_half_closed]
            if len(half_closed) > 3:
                print(
                    f"⚠️ 半闭环欠账过多：{len(half_closed)} 条（上限 3）。挑一条做成机制：\n"
                )
                for i in half_closed:
                    print(f"  {i.id} · {i.title}")
                    print(f"    升级条件：{i.upgrade_condition}")
                return EXIT_OPEN_ITEMS
            n_closed = sum(1 for i in incidents if i.status == STATUS_CLOSED)
            n_half = len(half_closed)
            print(
                f"✓ {len(incidents)} 条事故：已闭环 {n_closed} · "
                f"半闭环 {n_half}（上限 3）· 未闭环 0"
            )
            return EXIT_OK
        print(f"✗ {len(open_items)} / {len(incidents)} 条记录没有出口：\n")
        for i in open_items:
            print(f"  {i.id} · {i.date} · {i.title}")
            print(f"    根因：{i.root_cause[:100]}{'…' if len(i.root_cause) > 100 else ''}")
        print("\n出口只有两种（阶段一不新增 arch_check 规则）：")
        print("  - 测试：写一个会失败的测试，让同样的问题下次立刻暴露")
        print("  - AGENTS.md 约定：写进 agent 每次都会读到的地方")
        print("\n返回非 0 是有意的 —— 「有事故但没产出防护」必须是个能被看见的信号。")
        return EXIT_OPEN_ITEMS

    print(
        f"# 事故台账（{n_main} 条事故 + {n_supp} 条补记，"
        f"其中未闭环 {len(open_items)} 条）\n"
    )
    print("| 编号 | 日期 | 标题 | 出口 | 状态 |")
    print("| --- | --- | --- | --- | --- |")
    for i in incidents:
        mark = "⚠️ " if i.is_open else ""
        exit_short = i.exit_path if len(i.exit_path) <= 40 else i.exit_path[:38] + "…"
        print(f"| {i.id} | {i.date} | {i.title} | {exit_short} | {mark}{i.status} |")
    if open_items:
        print(f"\n未闭环 {len(open_items)} 条。用 `--check` 看详情（它会返回非 0）。")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
