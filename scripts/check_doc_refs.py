#!/usr/bin/env python3
"""文档交叉引用检查：章节号引用（§N.M）与相对路径链接是否指向真实存在的目标。

起因：harness 文档六次结构性改动（补内容 / 移风险表 / 抽术语 / 拆 notes / 重排章节），
每次都留下指向已不存在章节的 §引用。人工核对失败六次，所以改成机械检查。

用法：
    .venv/bin/python scripts/check_doc_refs.py            # 检查默认范围
    .venv/bin/python scripts/check_doc_refs.py 某文件.md   # 只检查指定文件

退出码：
    0  无失效引用
    1  发现失效引用
    2  第三态 —— 检查本身无法进行（范围内没有文件、文件读不了）
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# 默认受检范围。
#
# 台账、`docs/harness/version-boundaries.md` 是为第四条检查（裸编号）加的 ——
# 105 处违规里有 50 处在台账里。
#
# `AGENTS.md` / `CLAUDE.md` / `.opencodereview/` 是 AI Review 在 MR !61 报出来
# 才补的（MAJOR）：这三处也会被 GitLab 当 markdown 渲染，同样有裸编号（实测 6 处），
# **而 `AGENTS.md` 本次就在改动清单里，钩子跑过却没吭声。**
# 「检查写好了但照不到」与「没有检查」在结果上是一样的。
# `docs`（整棵树，含 ledger 自己的业务文档）是 2026-08-07 才加的。
# **在此之前护栏只查自己的文档,不查被它保护的那个项目的文档** ——
# 第一次照进去就报出 54 处：约 20 处指向已 Sunset 的 agenzo 主仓,
# 其余是章节引用解析不出目标文档(见下面 DOC_BY_ID 的补充)。
# 「护栏文档被查得严严实实,业务文档一处不查」本身就是个盲区。
#
# **这份清单是本仓专用的，所以可以被 `harness/doc-targets.json` 覆盖。**
# 装到别的仓库时文档布局不一样（不一定有 `.opencodereview/`、
# steering 文件名也不同），而机制本身是通用的 —— 硬编码在这里会让
# 「搬过去」变成「搬过去再改源码」。
#
# 覆盖文件的格式：`{"目标": ["docs", "README.md", ...]}`
# 格式错 / `目标` 为空 → **退出码 2**（第三态），不许静默回落到本仓默认值：
# 那样在别的仓库里会查着 ledger 的目录跑绿。
_FALLBACK_TARGETS = [
    "docs",
    ".kiro/steering/harness-execution.md",
    ".kiro/hooks",
    "AGENTS.md",
    "CLAUDE.md",
    ".opencodereview",
    "README.md",
]
_TARGETS_FILE = REPO / "harness/doc-targets.json"


class DocTargetsError(RuntimeError):
    """受检目标清单本身坏了 → 退出码 2。"""


def load_targets() -> list[str]:
    """读受检目标。没有覆盖文件就用本仓默认值；有但坏了 → 抛错（退 2）。"""
    if not _TARGETS_FILE.exists():
        return list(_FALLBACK_TARGETS)
    try:
        data = json.loads(_TARGETS_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise DocTargetsError(f"{_TARGETS_FILE} 读不出来：{exc}") from exc
    targets = data.get("目标")
    if not isinstance(targets, list) or not targets:
        raise DocTargetsError(
            f"{_TARGETS_FILE} 里 `目标` 缺失或为空。\n"
            "  空清单会让这道检查扫 0 个文件并打印「通过」—— 那是最坏的失败方式。"
        )
    return [str(t) for t in targets]


# 兼容既有调用方（测试与 check_facts.py 都在 import 这个名字）
DEFAULT_TARGETS = _FALLBACK_TARGETS

# 章节标题里的编号：「## 6.11 已接入」→ 6.11，「### 5.4.5 Evals」→ 5.4.5
HEADING_RE = re.compile(r"^#{2,4}\s+(\d+(?:\.\d+)*)\.?\s")
# 章节引用：§10.3。中文编号（§一、§三）不参与，那是另一套体系
SECTION_REF_RE = re.compile(r"§(\d+(?:\.\d+)*)")
# markdown 相对链接：](xxx.md) / ](../y.md#anchor)
LINK_RE = re.compile(r"\]\((?!https?://|#)([^)\s]+)\)")
# 行数声明：「（581 行）」或表格末列「| 581 |」。同一行必须有指向某 md 的链接才算
LINECOUNT_RE = re.compile(r"（(\d{2,5}) 行）|\|\s*(\d{2,5})\s*\|\s*$")
# 行数上限：声明是给文档设的收缩信号——超了退 1，意味着先删再加。
# 初始上限按当前行数向上取整到 50 的倍数。
# 行内代码：里面的内容是示例或占位，不当引用看（例：`![](图片路径)`）
INLINE_CODE_RE = re.compile(r"`[^`]*`")
# 裸写的本仓编号。起因 `INC-023`：本项目开着 Jira 集成，GitLab 把任何「字母-数字」
# 自动转成 Jira issue 链接，而我们的编号格式正好撞上 —— 每处裸写都是死链。
# ai_review_report.py 里的 _shield_incident_refs() 只管报告，人写的 markdown
# 一直没人管，实测积了 105 处。所以这条要机械检查。
#
# **前缀要全列**：第一版只认 `INC`，而本仓还有 `VB-\d{3}`（版本边界清单），
# 形态一样、死链一样，`docs/version-boundaries.md` 三个小节标题全是裸写的。
# 这是 AI Review 在 MR !61 报出来的（MAJOR）—— 只覆盖一半的检查会给出
# 「跑绿了」这个错误结论。**加新前缀的编号时要回来加一行。**
ID_PREFIXES = ("INC", "VB")
# 前面不许有 / 是为了放过 URL 里的编号（那本来就是链接）
BARE_ID_RE = re.compile(rf"(?<![`\w/-])(?:{'|'.join(ID_PREFIXES)})-\d{{3}}(?![`\w-])")
# 行内代码里的仓库内路径：`` `docs/harness/incidents.md` ``。
# 必须带 `/`（否则 `README.md` 这种会误判成指某个具体目录下的文件），
# 且以下列后缀结尾（避免把 `a/b` 这类占位当路径）。
_PATH_SUFFIX = r"(?:md|py|json|jsonl|ya?ml|ts|js|vue|toml|cjs|hook|sh)"
# 页内锚点：`](#被拦)`。LINK_RE 刻意排除了 `#` 开头的目标（那不是文件路径），
# 所以要单独匹配一遍，目标文件就是本文。
SAME_PAGE_LINK_RE = re.compile(r"\]\(#([^)\s]+)\)")
# 文档里常用的稳定锚点写法：`<a id="被拦"></a>`。标题一改字锚点就变，所以本仓用它
EXPLICIT_ANCHOR_RE = re.compile(r'<a\s+id="([^"]+)"')
INLINE_PATH_RE = re.compile(rf"`([\w.\-/]+/[\w.\-]+\.{_PATH_SUFFIX})`")
# 只有这些顶层目录下的路径才查，理由见 main() 里那段注释
CHECKED_PATH_ROOTS = (
    "docs/",
    "scripts/",
    "tests/",
    "harness/",
    ".kiro/",
    ".opencodereview/",
    "web/",
)
FENCE_RE = re.compile(r"^\s*```")

# 文档编号 → 实际路径。引用里写「02 §3.1」或「02-how-it-runs.md §3.1」都要认。
#
# 2026-08-04 重构：主文档从 6154 行压到 855 行，长文档移进 archive/。
# 编号语义因此变了 —— 老的 01=why、02=实施方案、04=实测记录，
# 新的 01=概览、02=怎么跑的、03=规则、04=现状。
# **archive/ 里的旧文档仍在用老编号互相引用**，所以两套都要能解析：
# 裸编号（01~04）指主文档，文件名指具体文件。
DOC_BY_ID = {
    # `00` 指 harness 文档入口。裸编号分支放开到 0[0-8] 之后没有这个键，
    # 「见 00 §1」会命中正则再静默退回「本文」—— AI Review 在 MR !69 报出（MINOR）。
    "00": REPO / "docs/harness/README.md",
    "01": REPO / "docs/harness/01-overview.md",
    "02": REPO / "docs/harness/02-how-it-runs.md",
    "03": REPO / "docs/harness/03-standards.md",
    "04": REPO / "docs/harness/04-status.md",
    "05": REPO / "docs/harness/05-setup.md",
    "06": REPO / "docs/harness/06-devices.md",
    "07": REPO / "docs/harness/07-howto.md",
    "08": REPO / "docs/harness/08-flow.md",
    "harness-execution.md": REPO / ".kiro/steering/harness-execution.md",
    # ledger 自己的业务文档。**原来只有 01-design.md 一份在表里**，于是
    # 「规范见 [00-roadmap.md §8.5](…)」这类引用解析不出目标文档，退回「本文」，
    # 报出一堆「§8.5 在本文里不存在」—— 而 00-roadmap.md 里那一节明明存在。
    # 假报比漏报更糟：它会让人以为检查在乱叫，然后不再看它的输出。
    # harness 主文档 05~08。**原来只登记到 04**，裸编号分支也只认 `0[0-4]`，
    # 于是「见 06 §3」会静默退回「本文」。由 AI Review 在 MR !69 报出（MAJOR）——
    # 当时全仓还没有这种引用，是空缺不是已发生的错误，但 03-standards.md
    # 已经在用「[04 现在到哪了](04-status.md) §6bis」这种写法，写到 06 上只是时间问题。
    "05-setup.md": REPO / "docs/harness/05-setup.md",
    "06-devices.md": REPO / "docs/harness/06-devices.md",
    "07-howto.md": REPO / "docs/harness/07-howto.md",
    "08-flow.md": REPO / "docs/harness/08-flow.md",
    "00-roadmap.md": REPO / "docs/ledger/00-roadmap.md",
    "01-design.md": REPO / "docs/ledger/01-design.md",
    "02-api-contract.md": REPO / "docs/ledger/02-api-contract.md",
    "03-alerts-and-runbook.md": REPO / "docs/ledger/03-alerts-and-runbook.md",
    "04-checklist.md": REPO / "docs/ledger/04-checklist.md",
    "05-onboarding-guide.md": REPO / "docs/ledger/05-onboarding-guide.md",
    "06-feishu-approval-setup.md": REPO / "docs/ledger/06-feishu-approval-setup.md",
    "step-01-mongo-replica-set.md": REPO / "docs/ledger/steps/step-01-mongo-replica-set.md",
    "step-02-alerts.md": REPO / "docs/ledger/steps/step-02-alerts.md",
    "step-03-double-entry-core.md": REPO / "docs/ledger/steps/step-03-double-entry-core.md",
    "step-04-reconciliation.md": REPO / "docs/ledger/steps/step-04-reconciliation.md",
    # archive/ 里的长文档。旧文档之间的 §引用靠文件名解析。
    "validation-log.md": REPO / "docs/harness/archive/validation-log.md",
    "implementation-plan.md": REPO / "docs/harness/archive/implementation-plan.md",
    "requirements-tracking.md": REPO / "docs/harness/archive/requirements-tracking.md",
    "decisions.md": REPO / "docs/harness/archive/decisions.md",
    # 旧文件名 → 新位置。archive/ 内部与外部脚本注释里还留着这些名字。
    "02-implementation-plan.md": REPO / "docs/harness/archive/implementation-plan.md",
    "03-requirements-tracking.md": REPO / "docs/harness/archive/requirements-tracking.md",
    "04-validation-log.md": REPO / "docs/harness/archive/validation-log.md",
}

# archive/ 里的引用**一律不查**（§ 引用、链接、行内路径三样都跳过）：
# 那些文档是历史档案，会引用已删的文件、已重排的章节、搬走前的路径 ——
# 「当时台账在 docs/incidents.md」是一句关于过去的真话，
# 改成现在的路径等于篡改记录。
#
# 曾经有一张 ARCHIVE_DOC_BY_ID 老编号表（archive 里「02 §10.1」指老的实施方案），
# 但既然整棵 archive 都跳过了，那张表与它的合并分支永远不会执行。
# **AI Review 在 MR !69 报出这件事（MINOR）**：两处注释写得像那张表在起作用，
# 读的人会以为 archive 的 §引用是按老编号校验过的。已删掉，只留这条说明。
ARCHIVE_DIR = REPO / "docs/harness/archive"
for _num, _p in list(DOC_BY_ID.items()):
    DOC_BY_ID.setdefault(_p.name, _p)
# 正文里常直接称「契约 §0」而不写文件名。只在紧贴 § 时才算标识 ——
# 否则「执行契约里每处含糊…（§10.3）」这种远距离共现会被误判成指向契约
DOC_BY_ID["契约"] = REPO / ".kiro/steering/harness-execution.md"

# 省掉 `.md` 的简称。业务文档里大量写成「详见 03-alerts §2」——
# **而那些引用同时带着正确的锚点链接**，说明写的人知道自己指哪，
# 只是没写后缀。逼所有人写全名是让工具绑架文档，所以这里认简称。
#
# 与 `契约` 同规则：**只在紧贴 § 时才算标识**，否则
# 「05-onboarding-guide 里提过…（§3）」这种远距离共现会被误判。
_BARE_ALIASES = {
    "00-roadmap": REPO / "docs/ledger/00-roadmap.md",
    "01-design": REPO / "docs/ledger/01-design.md",
    "02-api-contract": REPO / "docs/ledger/02-api-contract.md",
    "03-alerts": REPO / "docs/ledger/03-alerts-and-runbook.md",
    "03-alerts-and-runbook": REPO / "docs/ledger/03-alerts-and-runbook.md",
    "04-checklist": REPO / "docs/ledger/04-checklist.md",
    "05-onboarding-guide": REPO / "docs/ledger/05-onboarding-guide.md",
    "06-feishu-approval-setup": REPO / "docs/ledger/06-feishu-approval-setup.md",
}
DOC_BY_ID.update(_BARE_ALIASES)

# 文档标识：完整文件名优先，其次裸编号，最后是紧邻别名
# 裸编号两侧都不许有 `-`：
#   `01-design.md` 的 01 不算（后跟 -），日期 `2026-08-03` 的 03 也不算（前有 -）。
#   后者是实际踩到的 —— 「2026-08-03 定为方案 A，见 §10.2」被判成指向 03 号文档。
_FILES = [k for k in sorted(DOC_BY_ID, key=len, reverse=True) if k.endswith(".md")]
# 简称按长度倒序，`03-alerts-and-runbook` 要排在 `03-alerts` 前面
_ALIAS_ALT = "|".join(
    re.escape(k) + r"(?=\s*§)" for k in sorted(_BARE_ALIASES, key=len, reverse=True)
)
DOC_ID_RE = re.compile(
    "("
    + "|".join(re.escape(k) for k in _FILES)
    + r"|(?<!-)\b0[0-8]\b(?!-)"
    + r"|契约(?=\s*§)"
    + "|"
    + _ALIAS_ALT
    + ")"
)


def collect_files(targets: list[str]) -> tuple[list[Path], list[str]]:
    """展开受检范围为具体文件列表。

    Returns:
        （文件列表, 既不是目录也不是文件的目标）

    **缺失的目标必须报出来。** 原来它是静默跳过的，只有「全部目标都产不出文件」
    才退 2 —— 于是任一目标被改名或移位时，剩下的目标仍能凑出文件列表，
    命令打印「引用检查通过」退 0，**受检范围已经缩小却没有任何迹象**。

    这条是 AI Review 在 MR !61 第二轮报出来的（MAJOR），而它指的正是
    本文件第四条检查这次要修的那个形态 —— 注释里写着
    「检查写好了但照不到与没有检查在结果上一样」，新扩的三个目标却没有断言守着。
    """
    files: list[Path] = []
    missing: list[str] = []
    # 受检的非 markdown 扩展名。hook 文件是 JSON 但内含 markdown prompt；
    # .json 规则文件（如 .opencodereview/rule.json）也可能含路径引用。
    EXTRA_EXTS = {".hook", ".json"}
    for t in targets:
        p = (REPO / t) if not Path(t).is_absolute() else Path(t)
        if p.is_dir():
            files.extend(sorted(p.rglob("*.md")))
            for ext in EXTRA_EXTS:
                files.extend(sorted(p.rglob(f"*{ext}")))
        elif p.is_file():
            files.append(p)
        else:
            missing.append(t)
    return files, missing


def anchors_of(path: Path) -> set[str]:
    """一个文件里所有标题生成的锚点，按 GitLab 的规则算。

    GitLab 的规则（与 GitHub 基本一致）：标题文本转小写 → 去掉除
    连字符/下划线/空格/CJK/字母数字之外的字符 → 空格转 `-`。
    形如「## 2. 账本通用告警规则清单（14 条）」→ `2-账本通用告警规则清单14-条`。

    另外认显式 `<a id="xxx"></a>` 锚点 —— 本仓文档大量用它做稳定锚点，
    正是因为标题一改字锚点就变。
    """
    found: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if m := EXPLICIT_ANCHOR_RE.search(line):
            found.add(m.group(1))
        if m := re.match(r"^#{1,6}\s+(.*?)\s*$", line):
            text = m.group(1)
            # 去掉行内代码反引号与 markdown 强调符，GitLab 用的是渲染后的纯文本
            # **不要去掉下划线。** 它在标题里绝大多数是标识符的一部分
            # （`ledger_entries`），GitLab 原样保留在锚点里。
            # 第一版把 `_` 当强调符去掉，`ledger_entries` 变成 `ledgerentries`，
            # 两处正确的锚点被判失效。
            text = re.sub(r"[`*~]", "", text)
            slug = re.sub(r"[^\w\s\u4e00-\u9fff-]", "", text.lower())
            # **逐个空格换连字符，不折叠连续空白。** GitLab 就是这么做的：
            # 「对比 + 选模式」去掉 `+` 之后剩两个空格，锚点里是 `对比--选模式`。
            # 第一版用 `\s+` 折成一个连字符，8 处正确的锚点全被判失效 ——
            # 假报比漏报更糟，这条差点让整个锚点检查变成噪声。
            found.add(re.sub(r"\s", "-", slug.strip()))
    return found


def headings_of(path: Path) -> set[str]:
    """一个文件里所有可被 §引用 的章节编号。"""
    found = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        m = HEADING_RE.match(line)
        if m:
            found.add(m.group(1))
    return found


def resolve_target_doc(line: str, ref_pos: int, current: Path) -> Path:
    """判断这条 §引用 指的是哪个文档。

    取 § 之前 60 字符窗口里最后出现的文档标识；没有标识就是本文件内引用。
    """
    start = max(0, ref_pos - 60)
    # 窗口起点不能落在 token 中间：定长切割会把 `2026-08-03` 切成 `03`，
    # 于是「不许前面有连字符」这条规则失效，日期被当成文档编号。往前对齐到空白处。
    while start > 0 and not line[start - 1].isspace():
        start -= 1
    # 末尾补回 § —— 别名分支靠 lookahead 判断「是否紧贴引用」，窗口切掉了它
    window = line[start:ref_pos] + "§"
    ids = DOC_ID_RE.findall(window)
    if not ids:
        return current
    return DOC_BY_ID.get(ids[-1], current)


def main() -> int:
    if sys.argv[1:]:
        targets = sys.argv[1:]
    else:
        try:
            targets = load_targets()
        except DocTargetsError as exc:
            print(f"✗ [第三态] {exc}", file=sys.stderr)
            return 2
    files, missing = collect_files(targets)
    if missing:
        print(f"[第三态] 受检目标不存在：{'、'.join(missing)}", file=sys.stderr)
        print(
            "  这不是「没有失效引用」—— 受检范围缩小了。\n"
            "  文件被改名或移位时要同步改 DEFAULT_TARGETS；不再需要就从清单里删掉。",
            file=sys.stderr,
        )
        return 2
    if not files:
        print(f"[第三态] 受检范围内没有文件：{targets}", file=sys.stderr)
        return 2

    try:
        heading_cache = {f: headings_of(f) for f in files if f.suffix == ".md"}
    except OSError as e:
        print(f"[第三态] 文件读取失败：{e}", file=sys.stderr)
        return 2

    anchor_cache: dict[Path, set[str]] = {}
    problems: list[str] = []

    for f in files:
        rel = f.relative_to(REPO)

        # 非 markdown 文件（.kiro.hook / .json）：从 JSON 字符串值里提取路径引用
        if f.suffix != ".md":
            try:
                text = f.read_text(encoding="utf-8")
                data = json.loads(text)
            except (OSError, json.JSONDecodeError):
                continue  # 格式错误不是本检查的问题
            # 递归提取所有字符串值
            strings: list[str] = []

            def _extract_strings(obj: object) -> None:
                if isinstance(obj, str):
                    strings.append(obj)
                elif isinstance(obj, dict):
                    for v in obj.values():
                        _extract_strings(v)
                elif isinstance(obj, list):
                    for v in obj:
                        _extract_strings(v)

            _extract_strings(data)
            # 在提取的字符串里查找相对路径引用
            # 路径模式：以字母或 . 开头，含 /，以已知扩展名结尾
            _PATH_IN_JSON = re.compile(
                r"(?<!\w)([a-zA-Z_.][a-zA-Z0-9_./-]*\.(?:md|json|py|yaml|yml|toml))\b"
            )
            for s in strings:
                for lineno, sline in enumerate(s.splitlines(), 1):
                    for m in _PATH_IN_JSON.finditer(sline):
                        path_ref = m.group(1)
                        # 跳过明显不是本仓路径的（如 review-prompt.md 等临时文件）
                        if "/" not in path_ref:
                            continue
                        # **和 markdown 分支同一套防误报限制。**
                        # 原来这里只判「有 /」和「仓库根存在」，既没有顶层目录
                        # 白名单，也没有「相对本文件解析」这条兜底 ——
                        # 而 markdown 分支为此报出过 84 处误报才收窄的。
                        # `doc-refs` 现在是拦合并的 CI job，一次误报直接卡住合并。
                        # 由 AI Review 在 MR !69 报出（MINOR）。
                        path_ref = path_ref.removeprefix("ledger-service/")
                        if not path_ref.startswith(CHECKED_PATH_ROOTS):
                            continue
                        if (f.parent / path_ref).exists():
                            continue
                        dest = (REPO / path_ref).resolve()
                        if not dest.exists():
                            # 带上字符串内的行号：hook 文件是内嵌整段 prompt 的
                            # JSON，不给位置的话被拦住的人无从下手。
                            problems.append(
                                f"{rel}（prompt 第 {lineno} 行）"
                                f"  路径引用失效：{path_ref}"
                            )
            continue

        in_fence = False
        for lineno, raw in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            # 抹掉行内代码但保持长度，位置窗口才不会错位
            line = INLINE_CODE_RE.sub(lambda m: " " * len(m.group(0)), raw)

            # 四、裸写的编号。围栏代码块里不算 —— GitLab 不在代码块里做 Jira 转换，
            # 而 `INC-023` 那一节正是靠代码块展示「裸写会变成什么」
            if FENCE_RE.match(raw):
                in_fence = not in_fence
            elif not in_fence:
                for m in BARE_ID_RE.finditer(line):
                    problems.append(
                        f"{rel}:{lineno}  编号裸写：{m.group(0)} —— "
                        "要包反引号，否则 GitLab 会渲染成 Jira 死链（见 `INC-023`）"
                    )

            # 一、章节引用。用 raw 定位目标文档 —— 文件名常写在反引号里
            for m in SECTION_REF_RE.finditer(raw):
                # archive 里的§引用可能指向已删文件，全部跳过
                if f.is_relative_to(ARCHIVE_DIR):
                    continue
                target = resolve_target_doc(raw, m.start(), f)
                if target not in heading_cache:
                    if not target.exists():
                        # 这里不用再判 archive —— 上面已经把 archive 下的文件
                        # 整体跳过了，能走到这一行的 f 一定不在 archive 里。
                        # 原来留着一个恒为真的 `if not f.is_relative_to(...)`，
                        # 代价不是性能而是误导：读的人会以为这条路还需要特殊对待。
                        # 由 AI Review 在 MR !69 报出（MINOR），
                        # 与 ARCHIVE_DOC_BY_ID 那张死表是同一形态。
                        problems.append(
                            f"{rel}:{lineno}  §{m.group(1)} 指向的文档不存在：{target.name}"
                        )
                        continue
                    heading_cache[target] = headings_of(target)
                if m.group(1) not in heading_cache[target]:
                    where = "本文" if target == f else target.name
                    problems.append(f"{rel}:{lineno}  §{m.group(1)} 在 {where} 里不存在")

            # 一点五、行内代码里的仓库内路径。**这是本检查踩过的第三个盲区。**
            #
            # 前两个：围栏代码块里的数字（`check_facts.py` 那边）、
            # `.kiro/hooks/*.kiro.hook` 不在受检范围。这一个是：
            # 正文里写 `` `docs/incidents.md` `` 而不是 markdown 链接时，
            # 上面那行 INLINE_CODE_RE 会先把它抹掉，于是路径腐化没人看得见。
            #
            # 实测代价：台账搬进 `docs/harness/` 之后 11 处旧路径没改，
            # **其中 2 处在 agent 契约里** —— 每次会话都加载，
            # agent 会被告知台账在一个已经不存在的位置。
            #
            # 只查「看起来像仓库内路径」的：带 `/` 且以已知后缀结尾。
            # 不带 `/` 的（`README.md`）不查 —— 那可能指任意目录下的同名文件。
            if not in_fence:
                for m in INLINE_PATH_RE.finditer(raw):
                    cand = m.group(1)
                    # 从工作区根看本仓时会写 `ledger-service/xxx`，剥掉再判
                    cand = cand.removeprefix("ledger-service/")
                    # **只查本仓顶层目录开头的路径。** 第一版没有这个限制，
                    # 一次报出 84 处，其中大多是别的仓的路径：
                    # `app/agent_pay/…`（agenzo 主仓）、`agenzo-platform/deploy/…`、
                    # `doc/business/agenzo/…`（已 Sunset），还有 `app/.../alerts.py`
                    # 这种占位写法。**一个大部分在乱叫的检查会被人关掉**，
                    # 所以宁可窄一点。`app/` 刻意不在名单里 —— 本仓和 agenzo 主仓
                    # 都有 `app/`，分不清指哪个。
                    if not cand.startswith(CHECKED_PATH_ROOTS):
                        continue
                    # archive/ 是历史档案。「当时台账在 `docs/incidents.md`」
                    # 是一句关于过去的真话，改成现在的路径等于篡改记录。
                    # § 引用与链接检查也都为 archive/ 做了同样的跳过，
                    # 见 ARCHIVE_DIR 上方的说明。
                    if f.is_relative_to(ARCHIVE_DIR):
                        continue
                    # 两种解析都试：仓库根相对（契约里那种）与本文件相对
                    # （`docs/README.md` 里写 `harness/incidents.md` 是对的）
                    if (REPO / cand).exists() or (f.parent / cand).exists():
                        continue
                    problems.append(
                        f"{rel}:{lineno}  行内代码里的路径不存在：{cand} —— "
                        "文件移动后正文里的路径同样会腐化，只是不报错"
                    )

            # 二、相对路径链接（含 `#锚点`）
            linked_md: list[Path] = []
            for m in LINK_RE.finditer(line):
                raw_dest, _, frag = m.group(1).partition("#")
                dest = (f.parent / raw_dest).resolve()
                if not dest.exists():
                    # archive 里的文件可能引用已打 tag 删除的文件，不报
                    if f.is_relative_to(ARCHIVE_DIR):
                        continue
                    problems.append(f"{rel}:{lineno}  链接失效：{m.group(1)}")
                    continue
                if dest.suffix != ".md":
                    continue
                linked_md.append(dest)
                # 锚点也要验。**只验文件存在是不够的** —— 标题改了字
                # （「（13 条）」→「（14 条）」）锚点就变，而链接照样指向
                # 一个存在的文件，点进去只落到文件顶部。
                # 「看起来合法、点进去是错的」正是本仓一直在防的形态
                # （`INC-023` 的 Jira 死链是同一类）。
                # 由 AI Review 报出（MR !69，MAJOR）：扩大受检范围之后
                # 仍有 3 处这样的死锚点报绿，因为原来 `split("#")[0]`
                # 把 fragment 直接丢掉了。
                if not frag or f.is_relative_to(ARCHIVE_DIR):
                    continue
                if dest not in anchor_cache:
                    anchor_cache[dest] = anchors_of(dest)
                if frag not in anchor_cache[dest]:
                    problems.append(
                        f"{rel}:{lineno}  锚点失效：#{frag} 在 {dest.name} 里没有对应标题"
                    )

            # 二点五、页内锚点 `](#xxx)`。**LINK_RE 用 `(?!https?://|#)`
            # 把它们整条排除了**，所以上面那段一条都见不到。
            # 而这类恰恰最容易腐化：删掉一节时 `<a id="…">` 跟着消失，
            # 导航表里的链接还在，点进去落到文件顶部。
            # 本仓页内锚点不少（07-howto 的导航表 11 条、06-devices 17 条）。
            # 由 AI Review 在 MR !69 报出（MINOR）—— 当时实测没有失效的，
            # 是空缺不是已发生的错误。
            if not f.is_relative_to(ARCHIVE_DIR):
                for m in SAME_PAGE_LINK_RE.finditer(line):
                    frag = m.group(1)
                    if f not in anchor_cache:
                        anchor_cache[f] = anchors_of(f)
                    if frag not in anchor_cache[f]:
                        problems.append(
                            f"{rel}:{lineno}  页内锚点失效：#{frag} 本文里没有对应标题"
                        )

            # 三、行数声明是否还对得上。导航表里的行数是给读者的承诺，会随改动过期
            if len(linked_md) == 1:
                m = LINECOUNT_RE.search(line)
                if m:
                    claimed = int(m.group(1) or m.group(2))
                    actual = len(linked_md[0].read_text(encoding="utf-8").splitlines())
                    if actual > claimed:
                        problems.append(
                            f"{rel}:{lineno}  行数超上限：上限 {claimed}，"
                            f"{linked_md[0].name} 实际 {actual}（先删再加，不要调上限）"
                        )

    # 第七条：代码围栏配平。**写完必须接上** —— 本仓已经六次「装了但没接通」。
    problems += _check_fences(files)

    if problems:
        print(f"发现 {len(problems)} 处失效引用：\n")
        for p in problems:
            print(f"  {p}")
        print("\n章节重排或移动文件后必须跑这个检查。")
        return 1

    print(f"引用检查通过：{len(files)} 个文件，无失效引用。")
    return 0


def _check_fences(files: list[Path]) -> list[str]:
    """第七条检查：markdown 的代码围栏必须配平。

    **一个未闭合的 ``` 会把后面整段正文包进代码块** —— 渲染出来是一片灰底，
    而 markdown 本身不报错，git diff 里也看不出来。

    实测代价：`harness/INSTALL.md` 有过一个孤立的 ```（27 个，奇数），
    把「反向验证」那一节之后的整段吞掉了。**是一个无上下文的 agent
    照着装的时候读出来的** —— 那份文档当时不在受检范围里，
    正是它自己在讲的那个形态（见 `INC-031` 补记）。

    只数行首的围栏。行内的 ``code`` 与缩进代码块不参与。
    """
    problems: list[str] = []
    for f in files:
        if f.suffix != ".md":
            continue
        count = sum(
            1 for line in f.read_text(encoding="utf-8").splitlines()
            if line.startswith("```")
        )
        if count % 2:
            problems.append(
                f"{f.relative_to(REPO)}  代码围栏不配平：行首 ``` 共 {count} 个（奇数）"
                " —— 有一个没闭合，它会把后面整段正文吞进代码块"
            )
    return problems

    print(f"引用检查通过：{len(files)} 个文件，无失效引用。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
