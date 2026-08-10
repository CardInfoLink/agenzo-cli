#!/usr/bin/env python3
"""安装完整性检查：装了哪些装置、它们要的规则文件在不在、有没有该装没装的。

## 为什么需要这一道

护栏往别的仓库搬的时候，**能搬的只有机制（脚本），规则（数据）几乎全是本仓专用的**。
`harness/portable.json` 里那一类标着「机制可搬，规则本仓专用」的装置最危险：

    搬了脚本、忘了写规则 → 检查扫 0 条 → 打印「通过」→ 退出码 0

这正是本仓反复踩的「空跑」形态（`INC-022` 只警告的钩子没声音、
`facts-match` 的正则匹配不到任何东西、`--batch` 没接通）。
**在一个仓库里踩过六次，搬到七个仓库就是四十二次。**

所以搬迁的前置条件不是「写一份 install.md」，而是**一道会因为规则缺失而失败的检查**。
文档管不住这件事 —— 本仓已经用六次事故证明了这一点。

## 三类问题

| 类 | 判据 | 退出码 |
| --- | --- | --- |
| 装了但规则缺失 | `installed.json` 声明装了 X，而 X 的必需文件不存在 / 是模板 / 格式错 | **2** |
| 装了但没接通 | 装置在 `installed.json` 里，而 `.pre-commit-config.yaml` 里没有那个 id | **2** |
| 该装没装 | 仓库里有某种语言 / 某个前置，对应装置既没装也没写「刻意不装」的理由 | 1 |

**第一二类是第三态**（安装本身坏了），第三类是发现的问题（可以先欠着，但要可见）。

## 「刻意不装」必须写理由

`installed.json` 的 `刻意不装` 是一个 `{装置: 理由}` 映射。**只要写了理由就放行** ——
目的不是逼人全装，是**逼人做出一个显式的决定**。
「忘了装」和「想清楚了不装」在文件系统上长得一样，理由那一行是唯一的区别。

## 用法

    python scripts/check_install.py            # 检查
    python scripts/check_install.py --json     # 机器可读
    python scripts/check_install.py --scaffold # 把缺失的必需文件按模板生成（带 TODO）

`--scaffold` 生成的模板里带 `TODO`，而校验规则里写着「不含 TODO」——
**所以脚手架生成完，这道检查仍然是红的，直到有人真的把 TODO 填掉。**
这是刻意的：一个能靠脚手架变绿的检查等于没有检查。

## 退出码

    0  安装完整
    1  有「该装没装」且没写理由的
    2  第三态 —— 清单缺失/格式错，或装了的装置规则缺失/没接通
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PORTABLE = REPO / "harness/portable.json"
INSTALLED = REPO / "harness/installed.json"
PRECOMMIT = REPO / ".pre-commit-config.yaml"

EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_BROKEN = 2

# 脚手架占位标记。**必须是正文里不会自然出现的字符串** ——
# 第一版直接判「含 TODO」，于是台账里一句引述模板要求的话把检查搞红了（误报）。
SCAFFOLD_MARK = "TODO<待填>"


class InstallError(RuntimeError):
    """安装本身坏了 → 退出码 2。"""


def _load(path: Path, what: str) -> dict:
    if not path.exists():
        raise InstallError(
            f"{what} 不存在：{path.relative_to(REPO)}\n"
            "  没有它无法判断这个仓库该装什么、装了什么。"
        )
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise InstallError(f"{what} 读不出来（{path.relative_to(REPO)}）：{exc}") from exc


def detect_languages() -> dict[str, str]:
    """探测这个仓库有哪些语言。返回 {语言: 依据}。

    **为什么必须探测**：可搬清单里一道 TS 检查都没有。往 `agenzo-cli`
    （纯 TypeScript）装上 `doc-refs` + `layout-check` 之后，
    `check_install.py` 会打印「安装完整」—— 而那个仓库的**代码一行都没被检查**。
    这是「假绿」升了一级：不是某个检查空跑，是整整一种语言没人管。

    探测只看**根目录的标志文件**，不递归扫源码 ——
    递归会把 `node_modules/` 里的 `*.py` 也算进来，
    而「探测错」比「没探测」更糟（它会要求一种这个仓库没有的语言）。
    """
    found: dict[str, str] = {}
    marks = [
        ("python", ["pyproject.toml", "setup.py", "requirements.txt"]),
        ("typescript", ["tsconfig.json"]),
        ("javascript", ["package.json"]),
        ("go", ["go.mod"]),
        ("rust", ["Cargo.toml"]),
    ]
    for lang, files in marks:
        for f in files:
            if (REPO / f).exists():
                found[lang] = f
                break
    # tsconfig 存在时 package.json 就不单独算一门 —— 那是同一套工具链
    if "typescript" in found:
        found.pop("javascript", None)
    # 前端框架单独标出来：它的类型检查工具与纯 TS 不同（vue-tsc vs tsc）
    if (REPO / "web").is_dir() or list(REPO.glob("*/src/**/*.vue"))[:1]:
        found["vue"] = "web/ 目录或 *.vue 文件"
    return found


# 每种语言至少要被这三类检查覆盖。**不是「有几个钩子」，是「这三件事有没有人管」。**
#
# 判据来自本仓十二道钩子的实际分工：格式/风格、类型或编译、测试。
# 缺任何一类都是真实的盲区，而盲区在「安装完整」这句话面前是看不见的。
COVERAGE_KINDS = {
    "风格": "代码风格 / lint（ruff、eslint、gofmt…）",
    "类型": "类型或编译检查（mypy、tsc、vue-tsc、go build…）",
    "测试": "测试门禁（pytest、vitest、go test…）",
}


def _precommit_ids() -> set[str]:
    """从 .pre-commit-config.yaml 取所有钩子 id。

    **不用 yaml 库**：这个脚本要能在只有标准库的环境里跑（新仓库装它的第一步，
    那时可能还没装依赖）。钩子 id 的写法是固定的 `- id: xxx`。
    """
    if not PRECOMMIT.exists():
        return set()
    ids: set[str] = set()
    for line in PRECOMMIT.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("- id:"):
            ids.add(stripped.split(":", 1)[1].strip())
    return ids


def _check_required_file(spec: dict) -> str | None:
    """检查一个「本仓必须提供」的文件。返回问题描述，没问题返回 None。"""
    rel = spec["路径"]
    path = REPO / rel
    if not path.exists():
        return f"`{rel}` 不存在 —— {spec['为什么']}"

    text = path.read_text(encoding="utf-8")
    rule = spec.get("校验", "存在")

    # **只认脚手架自己写的那个标记，不是任何 TODO。**
    #
    # 第一版判「文本里含 `TODO`」就算没填 —— 立刻在本仓误报：
    # `docs/harness/incidents.md` 的正文里引述了模板要求（"模板里没有 TODO"），
    # 那是在讲这件事，不是占位。**误报比漏报少见但同样坏**：
    # 它会让人去改一个没坏的文件，几次之后人就学会忽略这道检查。
    #
    # 所以标记必须是脚手架专用、正文里不会自然出现的。
    if "不含 TODO" in rule and SCAFFOLD_MARK in text:
        return (
            f"`{rel}` 里还有 `{SCAFFOLD_MARK}` —— 那是脚手架生成的占位，没人填过。\n"
            f"      {spec['为什么']}"
        )
    if rule == "存在":
        return None

    # 其余校验都针对 JSON
    if rel.endswith(".json"):
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            return f"`{rel}` 不是合法 JSON：{exc}"
        if "非空数组" in rule:
            # **取第一个数组值，不是第一个值。** 第一版写 `next(iter(values))`，
            # 于是文件里只要有一个 `_note` 字符串排在前面就判成「不是数组」——
            # 报的是「清单是空的」而实际清单是满的。误报比漏报少见但同样坏：
            # 它会让人去改一个没坏的文件。
            arrays = [v for v in data.values() if isinstance(v, list)] if isinstance(data, dict) else [data]
            if not arrays or not any(arrays):
                return f"`{rel}` 的清单是空的 —— 空清单会让检查扫 0 个目标并打印「通过」"
        if "非空对象" in rule and not data:
            return f"`{rel}` 是空对象 —— 等于这道检查什么都不比对"
        if "分类非空" in rule and not data.get("分类"):
            return f"`{rel}` 里 `分类` 是空的"
        for key in ("规则", "核心包", "版本", "装置"):
            if f"含 {key}" in rule and key not in data:
                return f"`{rel}` 缺 `{key}` 键"
    return None


def audit() -> dict:
    """返回 {broken: [...], findings: [...], installed: [...], skipped: {...}}。"""
    portable = _load(PORTABLE, "可搬装置清单")
    installed_cfg = _load(INSTALLED, "本仓安装清单")

    devices = portable.get("装置") or {}
    if not devices:
        raise InstallError("可搬装置清单里 `装置` 是空的")

    declared = installed_cfg.get("装置")
    if not isinstance(declared, list):
        raise InstallError("本仓安装清单里 `装置` 必须是数组")
    skipped = installed_cfg.get("刻意不装") or {}
    if not isinstance(skipped, dict):
        raise InstallError("`刻意不装` 必须是 {装置: 理由} 映射 —— 只有理由能区分「忘了」和「想清楚了」")

    # `刻意不装` 里留着脚手架占位 = 没人做过决定。
    #
    # **原来这一段没有任何机制守着**：`install.sh` 生成的占位串是「TODO：…」，
    # 而这里认的是 `SCAFFOLD_MARK`（`TODO<待填>`），两个字符串不同 ——
    # 于是六条全留占位也照样退 0。INSTALL.md 里写着「逐条写理由」，
    # 读起来像是不写就过不了，**实际上过得了**。
    # 由一次无上下文安装演练报出（`INC-031`）。
    placeholder = [n for n, why in skipped.items() if SCAFFOLD_MARK in str(why)]
    if placeholder:
        raise InstallError(
            f"`刻意不装` 里这些还是脚手架占位，没人写过理由：{placeholder}\n"
            "  「忘了装」和「想清楚了不装」在文件系统上长得一样，"
            "理由那一行是唯一的区别。"
        )

    unknown = [d for d in declared if d not in devices]
    if unknown:
        raise InstallError(
            f"安装清单里有不存在的装置：{unknown}\n"
            f"  可选：{sorted(devices)}"
        )

    hook_ids = _precommit_ids()
    broken: list[str] = []
    findings: list[str] = []

    # ---- 清单自检：**任何模板都不许生成一个直接就绿的状态** --------------
    #
    # `--scaffold` 的用途是把「该有什么文件」变成看得见的骨架，
    # **不是让检查变绿**。一个能靠脚手架变绿的检查等于没有检查。
    #
    # **实测踩过一次**（`INC-029`）：`doc-targets.json` 的第一版模板写了 3 个
    # 真实目标、不含 TODO，生成完 `check_install.py` 直接打印「安装完整」，
    # 而 `doc-refs` 的受检文件从 **44 个降到 34 个** —— 输出仍然是「引用检查通过」。
    # 我在防的形态，自己在造它的工具里踩了。
    #
    # 靠「每份模板记得写 TODO」是靠自觉。这里把它变成构造上的保证：
    # 有模板 → 模板必须含 TODO，且校验规则必须包含「不含 TODO」。
    for name, dev in devices.items():
        for spec in dev.get("本仓必须提供", []):
            if not spec.get("模板"):
                continue
            rel = spec["路径"]
            if SCAFFOLD_MARK not in spec["模板"]:
                broken.append(
                    f"清单本身有问题：`{name}` 的 `{rel}` 模板里没有 "
                    f"`{SCAFFOLD_MARK}` ——\n"
                    "      那样 --scaffold 生成完检查直接变绿，而文件内容是占位的"
                )
            if "不含 TODO" not in spec.get("校验", ""):
                broken.append(
                    f"清单本身有问题：`{name}` 的 `{rel}` 校验规则没有「不含 TODO」——\n"
                    "      模板里的 TODO 就拦不住任何东西"
                )

    for name in declared:
        dev = devices[name]
        # ① 脚本在不在
        for rel in dev.get("脚本", []):
            if not (REPO / rel).exists():
                broken.append(f"装置 `{name}`：脚本 `{rel}` 不存在")
        # ② 规则文件在不在、填了没
        for spec in dev.get("本仓必须提供", []):
            problem = _check_required_file(spec)
            if problem:
                broken.append(f"装置 `{name}`：{problem}")
        # ③ 装了但没接通 —— 这是本仓踩过六次的形态
        #    只对「有 pre-commit 钩子形态」的装置查。ai-review 只在 CI 里跑，不算。
        #    「有没有 pre-commit 钩子」是装置自己的属性，写在清单里。
        #    **不要在脚本里按名字白名单** —— 第一版那么写，加一个只在 CI 跑的
        #    装置就要回来改代码，而漏改的表现是误报（说它「没接通」）。
        hook_id = dev.get("钩子id")
        if hook_id and hook_id not in hook_ids:
            broken.append(
                f"装置 `{name}`：声明装了，但 `.pre-commit-config.yaml` 里没有 "
                f"id `{hook_id}` ——\n"
                "      这就是「装了但没接通」，本仓已经踩过六次。"
            )

    # ④ 该装没装
    for name, dev in devices.items():
        if name in declared or name in skipped:
            continue
        findings.append(
            f"装置 `{name}`（{dev['做什么']}）既没装，也没在 `刻意不装` 里写理由"
        )

    # ⑤ **语言覆盖** —— 这一条回答的是「装完了，可这个仓库的代码谁在管」。
    #
    # 可搬清单里的十道装置**没有一道在检查代码本身**（都是文档、台账、
    # 事实、归属、审查流程）。所以「安装完整」不等于「代码被检查了」。
    #
    # 往 `agenzo-cli`（纯 TypeScript）装上 doc-refs + layout-check 之后，
    # 旧版本会打印「安装完整」，而那个仓库的代码一行都没被检查 ——
    # **假绿升了一级**。
    #
    # 这里不试图**提供** TS lint（那是各仓库自己的工具链），
    # 只要求 `installed.json` 里对每种探测到的语言**声明谁在管**。
    # 与 `刻意不装` 同一个思路：不逼人装什么，逼人做一个显式的决定。
    langs = detect_languages()
    coverage = installed_cfg.get("语言覆盖")
    if coverage is None:
        coverage = {}
    if not isinstance(coverage, dict):
        raise InstallError(
            "`语言覆盖` 必须是 {语言: {风格/类型/测试: 钩子名或理由}} 映射"
        )
    for lang, why in langs.items():
        got = coverage.get(lang)
        if not isinstance(got, dict) or not got:
            broken.append(
                f"探测到 **{lang}**（依据：{why}），而 `installed.json` 的 "
                f"`语言覆盖` 里没有它 ——\n"
                f"      **可搬装置里没有一道在检查代码本身**，所以「安装完整」"
                f"不等于「{lang} 代码被检查了」。\n"
                f"      要为它写明三类各由谁管：{'、'.join(COVERAGE_KINDS)}；"
                f"确实没有就写「无：理由」。"
            )
            continue
        for kind, desc in COVERAGE_KINDS.items():
            val = str(got.get(kind, "")).strip()
            if not val:
                broken.append(
                    f"语言 **{lang}** 的「{kind}」（{desc}）没有声明谁管 —— "
                    "填钩子名，或写「无：理由」"
                )
                continue
            # 声明了一个钩子名 → 那个钩子必须真的存在（又一处「装了但没接通」）
            if not val.startswith("无") and val not in hook_ids:
                broken.append(
                    f"语言 **{lang}** 的「{kind}」声明由 `{val}` 管，"
                    f"而 `.pre-commit-config.yaml` 里没有这个 id"
                )

    return {
        "broken": broken,
        "findings": findings,
        "installed": declared,
        "skipped": skipped,
        "languages": langs,
        "coverage": coverage,
        "portable_version": portable.get("版本"),
        "installed_version": installed_cfg.get("版本"),
    }


def scaffold() -> list[str]:
    """把缺失的必需文件按模板生成。**生成物带 TODO，检查仍然是红的。**"""
    portable = _load(PORTABLE, "可搬装置清单")
    installed_cfg = _load(INSTALLED, "本仓安装清单")
    created: list[str] = []
    for name in installed_cfg.get("装置", []):
        dev = portable["装置"].get(name) or {}
        for spec in dev.get("本仓必须提供", []):
            path = REPO / spec["路径"]
            if path.exists():
                continue
            template = spec.get("模板")
            if not template:
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(template, encoding="utf-8")
            created.append(spec["路径"])
    return created


def main() -> int:
    ap = argparse.ArgumentParser(description="安装完整性检查")
    ap.add_argument("--json", action="store_true", help="JSON 输出")
    ap.add_argument(
        "--scaffold",
        action="store_true",
        help="按模板生成缺失的必需文件（带 TODO，生成后检查仍是红的）",
    )
    args = ap.parse_args()

    try:
        if args.scaffold:
            created = scaffold()
            if created:
                print("已生成模板（**里面是 TODO，填完才算装好**）：")
                for c in created:
                    print(f"  {c}")
            else:
                print("没有需要生成的文件。")
        result = audit()
    except InstallError as exc:
        print(f"✗ [第三态] {exc}", file=sys.stderr)
        print(
            "\n  以上是安装本身坏了，**不是「安装完整」**。",
            file=sys.stderr,
        )
        return EXIT_BROKEN

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return EXIT_BROKEN if result["broken"] else (
            EXIT_FINDINGS if result["findings"] else EXIT_OK
        )

    pv, iv = result["portable_version"], result["installed_version"]
    print(f"装置清单 v{pv} · 本仓安装 v{iv} · 已装 {len(result['installed'])} 个")
    if pv != iv:
        print(f"  ⚠️ 版本不一致：清单 v{pv}，本仓 v{iv} —— 可搬装置更新过，本仓没跟上")

    if result["broken"]:
        print(f"\n✗ 安装不完整（{len(result['broken'])} 处）：")
        for b in result["broken"]:
            print(f"  - {b}")
        print(
            "\n  这些是第三态：装置声明装了，实际跑不起来或什么都不比对。\n"
            "  **不要把它当成「没发现问题」** —— 一个空跑的检查比没有检查更糟，\n"
            "  因为它会打印「通过」。"
        )
        return EXIT_BROKEN

    if result["skipped"]:
        print("\n刻意不装（已写理由，放行）：")
        for name, why in result["skipped"].items():
            print(f"  - {name}：{why}")

    if result["findings"]:
        print(f"\n⚠️ {len(result['findings'])} 个装置该装没装：")
        for f in result["findings"]:
            print(f"  - {f}")
        print(
            "\n  要装就跑 install.sh；不装就在 `harness/installed.json` 的\n"
            "  `刻意不装` 里写一行理由。**「忘了装」和「想清楚了不装」\n"
            "  在文件系统上长得一样，理由那一行是唯一的区别。**"
        )
        return EXIT_FINDINGS

    # **措辞刻意收窄。** 这道检查能证明的只有「声明的东西都在、都接上了」，
    # 证明不了「规则内容是对的、是完整的」——
    # 一个仓库把 `arch-rules.json` 写成 `{"rules": []}` 就能通过。
    #
    # 原来这里打印的是「✓ 安装完整」。那句话过度声明了：读的人会以为
    # 「这个仓库的护栏齐了」，而实际含义只是「文件齐备」。
    # **一句过度声明的成功提示，和一个空跑的检查是同一类东西。**
    langs = ", ".join(f"{k}" for k in result["languages"]) or "未探测到"
    print(
        "\n✓ 声明与实现一致："
        "已装装置的规则文件都在、钩子都接上了、没有漏装未说明的，"
        f"探测到的语言（{langs}）都声明了谁在管。\n"
        "  **这不等于「规则完整」** —— 规则内容对不对、够不够，"
        "这道检查判断不了（空规则集也会通过）。\n"
        "  规则的完整性只能靠一件事长出来：出事故 → 记台账 → 从事故里长出规则。"
    )
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
