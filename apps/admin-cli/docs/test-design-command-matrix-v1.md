# agenzo-admin-cli 测试设计文档（Test Design）

> 本文档为 `agenzo-admin-cli` 的测试设计，对齐 spec（`requirements.md` / `design.md` / `tasks.md`）与 `doc/architecture-upgrade/v1/cli-design.md` §2（命令字段级规范）。
> 范围 = 本迭代锁定的 **19 条命令矩阵（含 `accounts get`）** + 6 项横切一致性约束（输出格式 / 退出码 / 错误信封 / 密钥脱敏 / 幂等键转发 / 拆分保真）。
> 权威顺序：cli-standard.md > cli-design.md > design.md。
> 仓库：本仓库（`agenzo-token-cli/`，拆分后产物 binary 为 `agenzo-admin-cli`），TypeScript + commander@14 + vitest + tsup。

---

## 1. 测试目标与范围

### 1.1 目标

1. 验证 19 条命令的输入/输出/HTTP 行为与 cli-design §2 字段级规范一致（拆分保真，Req 7）。
2. 验证 4 项一致性改造（noun-verb 分组、中央渲染器、退出码映射、错误信封）符合 cli-standard（Req 1/4/5）。
3. 验证 `--idempotency-key` 在 7 条服务端写命令上**必传**（缺失→`PARAM_IDEMPOTENCY_KEY_REQUIRED`/exit 1）且正确转发、本地写命令拒绝该 flag（Req 4.3 / cli-design §1 "所有服务端写必须幂等"）。
4. 验证密钥（Bearer token、一次性 api_key）不泄漏到 stdout（Req 6）。
5. 验证本地状态文件落盘到 `~/.agenzo-admin-cli/`（Req 2.4）。
6. 验证 `developers create` 的 `--billing-mode` 本地枚举校验（默认 `pay_per_call`，非法值→`PARAM_INVALID`/exit 1）与 `accounts get` 的查询/无账户/跨 Org 行为（cli-design §2.4.10 / §2.4.19）。
7. 验证 **json 模式下 stderr 完全静默状态行**：`--format json` 时所有命令（不止 7 条写命令）的成功/info/进度状态行（`✓`/`ℹ`、spinner、`Magic link sent` 等）一律不输出（连 stderr 都不打），供其它 Agent 无干扰解析；table 模式下这些状态行照常走 stderr（Req 4.1/4.4）。

### 1.2 范围内（In Scope）

- 19 条命令：`auth login/logout`、`config set-host/show/reset-host`、`orgs get/update/list/switch`、`developers create/list/get/update`、`keys create/list/get/rotate/disable`、`accounts get`。
- `developers create` 的 `--billing-mode` flag（`pay_per_call` | `monthly_settlement`，默认 `pay_per_call`，本地校验）与 `Developer.billing_mode` 透传/展示。
- `keys create` 的 `--scope` flag（`token` / `merchant` / `payment` 子集，默认全三个，本地校验）；scope 由后端持久化（`ap_api_keys.scope`）并在 create/list/get/rotate 响应回传；legacy 无 scope 文档由后端回退全三个。
- 中央渲染器 `resolveFormat` / `render`、退出码映射 `exitCodeFor`、错误目录 `errorCodeFor` / `toErrorEnvelope`。
- 本地枚举校验器 `resolveBillingMode`（`developers/billing-mode.ts`）、`parseScopeFlag` / `resolveScopes`（`keys/scope.ts`）。
- `--format`（`json | table`，默认 `table`）、`AGENZO_FORMAT` 环境变量。
- `--idempotency-key` 透传。

### 1.3 范围外（Out of Scope）

- 后端 settlement account 建账户（仅 monthly_settlement）/ 回滚一致性的服务端逻辑（属 `agenzo` 后端测试，见 `tests/agent_pay/test_account_service.py` / `test_developer_service.py`）；CLI 侧仅验证 `accounts get` 的请求与渲染。
- API Key scope 的**鉴权落地**（`KEY_SCOPE_DENIED`，调用不在 scope 内的运行面 CLI 时拒绝）——属后端 BACK-034，本迭代后端只持久化 + 回显 scope，不据此鉴权；CLI 侧不验证鉴权拒绝。
- `billing_mode` 切换流程（线下 admin 操作，CLI 不提供 update）。
- 后端幂等去重落地（BACK-090）—— 仅验证 CLI 侧 header 转发（Property 6），不验证服务端去重。
- profile 模型、OS keychain、`--help --format json` 能力发现。
- 后端 numeric ↔ enum 错误码全量映射（仅验证域前缀 SCREAMING_SNAKE 码）。
- 旧 `~/.agenzo-token-cli/` 目录迁移。

---

## 2. 测试分层策略

| 层级 | 工具 | 是否需网络 | 覆盖对象 | 优先级 |
| --- | --- | --- | --- | --- |
| L1 单元测试（Unit） | vitest，纯函数 | 否 | `resolveFormat` / `render` / `exitCodeFor` / `errorCodeFor` / `toErrorEnvelope` | P0（必做） |
| L2 属性测试（PBT） | vitest + fast-check | 否 | 退出码 / 错误码映射的全域不变量 | P2（可选，task 9.5 带 `*`） |
| L3 命令集成 / 冒烟（CLI E2E） | 编译产物 `agenzo-admin-cli` + 真实 testing host | 部分 | 18 条命令端到端输入/输出/退出码 | P1（手动，README 记录） |
| L4 拆分保真核对（Diff Review） | 代码走查 + git diff | 否 | 迁移命令的 HTTP method/path/body/读字段与拆分前一致 | P1 |

> 说明：单元测试是本迭代唯一新增的自动化测试（tasks 9.1–9.5）。命令级测试以**手动可执行步骤**形式给出（本文档 §4/§5），供研发与 QA 按步骤复现；不强制写成 vitest 集成用例（依赖真实后端）。

---

## 3. 测试环境与前置准备

### 3.1 构建

```bash
npm install
npm run build          # tsup 产出 dist/index.js，bin = agenzo-admin-cli
npm link               # 或 node dist/index.js 直接调用
agenzo-admin-cli --version
```

### 3.2 后端环境

- testing host：`https://agent-test.everonet.com`（或本地 `http://localhost:8000`）。
- API path：`/api/v3/agent-pay`（默认）。
- 至少一个可收件的邮箱用于 magic-link 登录（参考既有约定，绑卡/登录测试邮箱使用团队约定邮箱）。

### 3.3 本地状态目录

- 所有命令的本地状态落盘 `~/.agenzo-admin-cli/`：
  - `config.json`（`active_org` / `api_host` / `api_path`）
  - `credentials/<org_id>.json`（含 token，**永不进 stdout**）
  - `keys.json`（一次性 api_key 缓存）
- 每个测试套件开始前，建议备份并清空该目录以保证可复现：

```bash
mv ~/.agenzo-admin-cli ~/.agenzo-admin-cli.bak.$(date +%s) 2>/dev/null || true
```

### 3.4 通用断言工具

- JSON 形态校验：`agenzo-admin-cli <cmd> --format json | jq .` 必须成功解析（stdout 是单一合法 JSON）。
- 退出码校验：命令后立即 `echo $?`。
- stdout/stderr 分离校验：`agenzo-admin-cli <cmd> --format json 1>out.txt 2>err.txt`，断言 `out.txt` 仅含 payload、日志/提示全在 `err.txt`。
- **json 模式 stderr 静默校验**：`agenzo-admin-cli <cmd> --format json 1>/dev/null 2>err.txt`，断言 `err.txt` 不含任何状态图标（`✓`/`ℹ`/`⚠`）或人读状态文案；对照 `table` 模式同命令 `err.txt` 应含这些状态行。
- 密钥泄漏校验：`grep -E "access_token|refresh_token" out.txt` 必须无匹配。

### 3.5 全局 flag 约定

- `--format <json|table>`：覆盖默认 `table`。
- `--yes`：关闭交互式 prompt（供 CI / Agent）。
- `--verbose`：详细日志（→ stderr）。
- `--idempotency-key <key>`：仅 7 条服务端写命令接受。

---

## 4. L1 单元测试用例（横切一致性，自动化 / vitest）

> 这些是本迭代必须落地的自动化测试（tasks 9.1–9.4，PBT 9.5 可选）。文件位于 `tests/**/*.test.ts`。每个用例标注：用例编号、对应需求/属性、输入、步骤、预期。

### 4.1 `resolveFormat` —— 输出格式解析（Property 2 / Req 4.2）

文件：`tests/output-format.test.ts`

| 用例 | 输入（flag, env） | 步骤 | 预期输出 |
| --- | --- | --- | --- |
| UT-FMT-01 | flag=`json`, env=`table` | 调 `resolveFormat('json', 'table')` | 返回 `'json'`（flag 优先于 env） |
| UT-FMT-02 | flag=`table`, env=`json` | 调 `resolveFormat('table', 'json')` | 返回 `'table'` |
| UT-FMT-03 | flag=undefined, env=`json` | 调 `resolveFormat(undefined, 'json')` | 返回 `'json'`（env 次优先） |
| UT-FMT-04 | flag=undefined, env=undefined | 调 `resolveFormat(undefined, undefined)` | 返回 `'table'`（默认值，刻意偏离 cli-standard §5.1） |
| UT-FMT-05 | flag=`xml`（非法） | 调 `resolveFormat('xml')` | 返回 `'table'`（非法值回退默认） |
| UT-FMT-06 | env=`yaml`（非法）, flag=undefined | 调 `resolveFormat(undefined, 'yaml')` | 返回 `'table'`（非法 env 回退默认） |
| UT-FMT-07 | flag=`JSON`（大小写） | 调 `resolveFormat('JSON')` | 按实现约定：大小写不匹配视为非法 → `'table'`（断言实现确定的行为，记录于用例） |
| UT-FMT-08 | 任意输入 | 遍历上述 | 返回值恒 ∈ `{'json','table'}` |

测试步骤模板：

```typescript
import { describe, it, expect } from 'vitest';
import { resolveFormat } from '../src/utils/output';

describe('resolveFormat', () => {
  it('flag wins over env', () => {
    expect(resolveFormat('json', 'table')).toBe('json');
  });
  it('falls back to table on invalid', () => {
    expect(resolveFormat('xml')).toBe('table');
  });
  // ... UT-FMT-01..08
});
```

### 4.2 `render` —— 中央渲染器（Property 1 & 5 / Req 4.1, 6.1）

文件：`tests/output-render.test.ts`

| 用例 | 输入 | 步骤 | 预期 |
| --- | --- | --- | --- |
| UT-RND-01 | `result.data = {a:1,b:'x'}`, format=`json` | 捕获 stdout 调 `render(result,{format:'json'})` | stdout 经 `JSON.parse` 往返后 deep-equal `result.data` |
| UT-RND-02 | 同上 | 断言 stdout 不含 `result.text()` 的人读文本（无 `✓`/key-value 表头） | stdout 仅含 JSON |
| UT-RND-03 | `format=table` | 捕获 stdout 调 `render` | stdout === `result.text()` 的返回值 |
| UT-RND-04 | `result.data` 含 `api_key: 'agz_live_sk_xxx'`（keys create） | format=json | stdout 含 `api_key`（调用方需要），但不含 `access_token`/`refresh_token` |
| UT-RND-05 | `result.data` 为带 `access_token` 的对象（构造异常输入） | format=json | 渲染器只输出 `data`，断言不向 stdout 写任何 token 字段名（验证 data 构造时已剔除 token） |
| UT-RND-06 | `result.note='Signed in'` | format=json | `note` **不**出现在 stdout（note 仅供 stderr 成功提示） |
| UT-RND-07 | `data` 为数组（orgs list / developers list） | format=json | stdout 是合法 JSON 数组，元素字段与 data 一致 |

> 捕获 stdout 用 `vi.spyOn(process.stdout, 'write')`；断言 stderr 隔离用 `vi.spyOn(process.stderr, 'write')`。

### 4.3 `exitCodeFor` —— 退出码映射（Property 3 / Req 5.1）

文件：`tests/exit.test.ts`（每行对应 design「错误类→退出码矩阵」一行）

| 用例 | 输入（throw 的实例） | 预期退出码 |
| --- | --- | --- |
| UT-EXIT-01 | `UpgradeRequiredError` | 2 |
| UT-EXIT-02 | `AuthError`（not signed in） | 3 |
| UT-EXIT-03 | `AuthError`（session/refresh） | 3 |
| UT-EXIT-04 | `AuthError`（magic-link timeout） | 3 |
| UT-EXIT-05 | `ApiBusinessError` statusCode=401 | 3 |
| UT-EXIT-06 | `ApiBusinessError` statusCode=403 | 3 |
| UT-EXIT-07 | `ApiBusinessError` statusCode=404 | 1 |
| UT-EXIT-08 | `ApiBusinessError` statusCode=409 | 1 |
| UT-EXIT-09 | `ApiBusinessError` statusCode=429 | 1 |
| UT-EXIT-10 | `ApiBusinessError` statusCode=422（其它 4xx） | 1 |
| UT-EXIT-11 | `ApiBusinessError` statusCode=500（5xx） | 4 |
| UT-EXIT-12 | `ValidationError` | 1 |
| UT-EXIT-13 | `ConfigError` | 1 |
| UT-EXIT-14 | `NetworkError` | 4 |
| UT-EXIT-15 | `UserCancelError`（SIGINT） | 5 |
| UT-EXIT-16 | `new Error('boom')`（未知 throwable） | 1 |
| UT-EXIT-17 | `'string error'` / `null` / `undefined` | 1（非 Error 输入兜底） |
| UT-EXIT-18 | 任意输入 | 返回值恒 ∈ `{1,2,3,4,5}`，绝不为 0 / undefined |

### 4.4 `errorCodeFor` / `toErrorEnvelope` —— 错误目录（Property 4 / Req 5.2）

文件：`tests/errors.test.ts`

| 用例 | 输入 | 预期 `code` | 预期 `http` |
| --- | --- | --- | --- |
| UT-ERR-01 | `UpgradeRequiredError` | `UPGRADE_REQUIRED` | 省略或对应值 |
| UT-ERR-02 | `AuthError`（not signed in） | `AUTH_NOT_SIGNED_IN` | 省略（本地） |
| UT-ERR-03 | `AuthError`（session expired） | `AUTH_SESSION_EXPIRED` | 省略 |
| UT-ERR-04 | `AuthError`（timeout） | `AUTH_TIMEOUT` | 省略 |
| UT-ERR-05 | `ApiBusinessError` 401 | `AUTH_INVALID_API_KEY` 或 `AUTH_FAILED` | 401 |
| UT-ERR-06 | `ApiBusinessError` 403 | `KEY_SCOPE_DENIED` 或 `AUTH_FAILED` | 403 |
| UT-ERR-07 | `ApiBusinessError` 404（orgs noun 上下文） | `ORG_NOT_FOUND` | 404 |
| UT-ERR-08 | `ApiBusinessError` 404（keys noun 上下文） | `KEY_NOT_FOUND` | 404 |
| UT-ERR-09 | `ApiBusinessError` 409 | `ORG_CONFLICT` | 409 |
| UT-ERR-10 | `ApiBusinessError` 429 | `RATE_LIMITED` | 429 |
| UT-ERR-11 | `ApiBusinessError` 其它 4xx | `PARAM_INVALID` | 对应 4xx |
| UT-ERR-12 | `ApiBusinessError` 5xx | `UPSTREAM_UNAVAILABLE` | 5xx |
| UT-ERR-13 | `ValidationError` | `PARAM_INVALID` | 省略 |
| UT-ERR-14 | `ConfigError` | `INTERNAL_ERROR` | 省略 |
| UT-ERR-15 | `NetworkError` | `UPSTREAM_UNAVAILABLE` | 省略（本地无 HTTP status） |
| UT-ERR-16 | `UserCancelError` | `USER_CANCELLED` | 省略 |
| UT-ERR-17 | 未知 throwable | `INTERNAL_ERROR` | 省略 |
| UT-ERR-18 | 任意输入 | `code` ∈ `ErrorCode` union 且非空；`message` 非空 | — |
| UT-ERR-19 | `toErrorEnvelope` 输出结构 | `{ error: { code, message, http? } }`，`http` 仅 HTTP 来源时存在 | — |

### 4.5 PBT 属性测试（可选，task 9.5）

文件：`tests/mappers.pbt.test.ts`（fast-check）

| 用例 | 生成器 | 不变量 |
| --- | --- | --- |
| PBT-01 | 随机 `statusCode`（100–599）+ 随机 error 类 | `exitCodeFor(e)` 恒 ∈ `{1,2,3,4,5}` |
| PBT-02 | 任意 throwable（string/number/object/Error 子类） | `errorCodeFor(e)` 恒返回 `ErrorCode` union 成员 |
| PBT-03 | 任意 throwable | `toErrorEnvelope(e).error.code` 非空且 `message` 非空 |

```typescript
import fc from 'fast-check';
it('exitCodeFor always in 1..5', () => {
  fc.assert(fc.property(fc.anything(), (e) => {
    const c = exitCodeFor(e);
    return [1, 2, 3, 4, 5].includes(c);
  }));
});
```

### 4.6 服务端写命令必传 `--idempotency-key`（Property 6 / Req 4.3）

文件：`tests/idempotency-required.test.ts`

7 条服务端写命令（`auth login` / `orgs update` / `developers create` / `developers update` / `keys create` / `keys rotate` / `keys disable`）均**必传** `--idempotency-key`，缺失时在任何网络调用前抛 `IdempotencyKeyRequiredError`（→ `PARAM_IDEMPOTENCY_KEY_REQUIRED` / exit 1）。本测试覆盖之前只做"可选转发"、现已补齐为必传的 3 条（login / rotate / disable）。

| 用例 | 输入 | 预期 |
| --- | --- | --- |
| UT-IDEM-01 | `login --email a@b.com`（无 --idempotency-key） | 抛 `IdempotencyKeyRequiredError`；`authService.login` 未被调用 |
| UT-IDEM-02 | `rotate key_x`（无 --idempotency-key） | 抛 `IdempotencyKeyRequiredError`；`apiClient` 未被调用 |
| UT-IDEM-03 | `disable key_x`（无 --idempotency-key） | 抛 `IdempotencyKeyRequiredError`；`apiClient` 未被调用 |
| UT-IDEM-04 | `new IdempotencyKeyRequiredError('keys rotate')` | message 含命令名 + `--idempotency-key` 提示 |

> 用 commander `root.exitOverride()` + stub deps，断言 handler 在缺键时抛错且不触达网络层。orgs update / developers create/update / keys create 的必传校验沿用同一 `IdempotencyKeyRequiredError` 模式（已随实现落地）。

### 4.7 `resolveBillingMode` —— --billing-mode 本地校验（Req 5.3 / cli-design §2.4.10）

文件：`tests/billing-mode.test.ts`

`developers create` 的 `--billing-mode` 在本地校验：缺省默认 `pay_per_call`，大小写/空白归一化，非法值抛 `ValidationError`（→ `PARAM_INVALID` / exit 1），与 `keys --scope` 的本地校验模式一致。

| 用例 | 输入 | 步骤 | 预期 |
| --- | --- | --- | --- |
| UT-BILL-01 | flag=undefined | `resolveBillingMode(undefined)` | 返回 `'pay_per_call'`（默认）；`DEFAULT_BILLING_MODE==='pay_per_call'` |
| UT-BILL-02 | flag=`pay_per_call` | `resolveBillingMode('pay_per_call')` | 返回 `'pay_per_call'` |
| UT-BILL-03 | flag=`monthly_settlement` | `resolveBillingMode('monthly_settlement')` | 返回 `'monthly_settlement'` |
| UT-BILL-04 | flag=`  Monthly_Settlement ` | `resolveBillingMode('  Monthly_Settlement ')` | 归一化大小写+裁剪空白 → `'monthly_settlement'` |
| UT-BILL-05 | flag=`weekly`（非法） | `resolveBillingMode('weekly')` | 抛 `ValidationError`（→ PARAM_INVALID / exit 1） |

```typescript
import { describe, it, expect } from 'vitest';
import { resolveBillingMode, DEFAULT_BILLING_MODE } from '../src/developers/billing-mode';
import { ValidationError } from '../src/utils/errors';

describe('resolveBillingMode', () => {
  it('defaults to pay_per_call', () => {
    expect(resolveBillingMode(undefined)).toBe('pay_per_call');
  });
  it('throws on unknown value', () => {
    expect(() => resolveBillingMode('weekly')).toThrow(ValidationError);
  });
  // ... UT-BILL-01..05
});
```

### 4.8 `config set-host` / `reset-host` 输出不重复（回归 GAPA-049 / Req 4.1, 4.4, 4.5）

文件：`tests/config-output.test.ts`

历史 bug：`applyHost` 同时用 `notify()`(stderr) 和 `CommandResult.text()`(stdout) 输出同样的状态行，table 模式下每行打两遍。修复后 `text()` 只返回 payload 投影，状态行仅由 `notify` 走 stderr。

| 用例 | 输入 | 预期 |
| --- | --- | --- |
| TC-CFG-SET-DEDUP-01 | `set-host`（无匹配凭证，table） | stdout 含 `API Host`/`Active Org`，不含任何状态图标（✓/ℹ/⚠/✗）与状态文案 |
| TC-CFG-SET-DEDUP-02 | 同上 | stderr 中 `API host set to` 恰好出现 1 次（不重复） |
| TC-CFG-SET-DEDUP-03 | `set-host`（命中凭证） | stdout 含 active_org 值、不含 `Switched to organization`；stderr 的 Switched 行只 1 次 |
| TC-CFG-SET-DEDUP-04 | `set-host` + `AGENZO_FORMAT=json` | stdout 是合法 JSON（`{api_host, active_org}`）；json 模式 notify 静默 |
| TC-CFG-RST-DEDUP-05 | `reset-host`（table） | 与 set-host 一致：stdout 无状态图标、stderr 状态行只 1 次 |

> 捕获手段：`vi.spyOn(process.stdout,'write')` + `vi.spyOn(console,'error')` 分别收集两条流；stub `configManager`/`credentialStore` 不依赖真实文件。

### 4.9 json 模式 stderr 静默（横切，Req 4.1/4.4）

文件：`tests/json-quiet.test.ts`（或并入各命令 handler 测试）

本迭代将「json 模式只输出 JSON、连 stderr 的状态行也静默」收敛到中央 helper `notify(format, type, message)`：`json` 模式直接 return（不写 stderr），`table` 模式才 `console.error(Formatter.status(...))`。登录流程的 spinner（走 stdout）在 quiet 模式被禁用。错误信封仍由顶层 `reportError` 输出（不经 notify），不受影响。

| 用例 | 输入 | 预期 |
| --- | --- | --- |
| TC-QUIET-01 | `notify('json','success','x')` | 不写 stderr（spy 断言 0 次调用） |
| TC-QUIET-02 | `notify('table','success','x')` | 写 stderr 1 次，含 `✓ x` |
| TC-QUIET-03 | 任一成功命令 `--format json` 实跑 | stderr 不含 `✓`/`ℹ`/`⚠` 状态图标；stdout 是合法 JSON |
| TC-QUIET-04 | 同命令 `table` 模式实跑 | stderr 含对应状态行 |
| TC-QUIET-05 | `auth login --format json` | spinner（`Waiting for email verification`）与 `Magic link sent` 均不出现（quiet 禁用 spinner + notify 静默） |
| TC-QUIET-06 | json 模式失败（如未登录 `orgs get --format json`） | stdout 为空（无半个 payload）；stderr 仅 `{"error":{...}}` 信封；退出码按矩阵 |

### 4.10 服务端写命令幂等键缺失：交互补输 vs --yes 抛错（Req 4.3）

文件：`tests/idempotency-required.test.ts`（与 §4.6 同文件）

策略已从「缺失直接失败」调整为：**交互模式缺失 → prompt 补输**（带非空校验）；**`--yes` 非交互模式缺失 → 抛 `IdempotencyKeyRequiredError`**（prompt 会挂起，故必须抛错）。CLI 永不自动生成 key。

| 用例 | 输入 | 预期 |
| --- | --- | --- |
| TC-IDEM-YES-01 | `auth login --email e --yes`（无 key） | 抛 `IdempotencyKeyRequiredError`；不触达 authService；exit 1 |
| TC-IDEM-YES-02 | `keys rotate id --yes`（无 key） | 抛 `IdempotencyKeyRequiredError`；不触达 apiClient；exit 1 |
| TC-IDEM-YES-03 | `keys disable id --yes`（无 key） | 同上 |
| TC-IDEM-INT-01 | 交互模式（非 --yes）缺 key | 弹 prompt `Idempotency key (unique per write, for safe retry):`；空输入触发非空校验；输入后继续 |

> 测试用 `root.option('--yes')` 镜像全局 flag + `optsWithGlobals().yes` 触发抛错路径；交互 prompt 路径不在自动化里走真实 stdin（会挂起），由 §5 手动用例覆盖。

---

## 5. L3 命令级测试用例（每条命令逐个，手动可执行）

> 每条命令一节，结构统一：**用例表**（正/负/边界）+ **执行步骤**（可复制命令）+ **预期断言**。
> 约定变量：`$EMAIL`、`$ORG_ID`、`$DEV_ID`、`$KEY_ID`、`$API_KEY` 在前序步骤中产生并复用。
> 退出码语义：`0` 成功 · `1` 业务/参数(4xx) · `2` 需升级 · `3` 认证失败/无效 key · `4` 网络/5xx · `5` 用户取消。

### 5.1 `auth login`（W，magic-link，服务端写，[idem]）

对应：Req 1.2, 2.1, 2.2, 2.5, 4.1, 4.3, 6.1；cli-design §2.4.1。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-AUTH-LOGIN-01 | 新邮箱注册分支 | `auth login --email <新邮箱>`，交互输入 Org name | `POST /auth/login`→1007→`POST /auth/register`→轮询 status；CONSUMED 后凭证落盘 `~/.agenzo-admin-cli/credentials/<org_id>.json`；退出 0 |
| TC-AUTH-LOGIN-02 | 已注册邮箱登录 | `auth login --email <已注册>` | 轮询 CONSUMED → 落盘；stdout(json) data=`{org_id,org_name,email,is_new_registration:false}`；退出 0 |
| TC-AUTH-LOGIN-03 | 注册需邀请码 | 新邮箱 + 后端返回 1103 | 交互提示 `Invitation code:`，输入后重试 register；成功→0 |
| TC-AUTH-LOGIN-04 | 邀请码无效 | 输入错误邀请码（后端 1104） | 错误信封对应码；退出 1 |
| TC-AUTH-LOGIN-05 | magic-link 超时 | 不点击链接，等待 >10min（或 mock 缩短） | `AuthError` timeout；`code=AUTH_TIMEOUT`；退出 3 |
| TC-AUTH-LOGIN-06 | 密钥脱敏 | `auth login ... --format json 1>out 2>err` | `out` 不含 `access_token`/`refresh_token`；token 仅在凭证文件中 |
| TC-AUTH-LOGIN-07 | 幂等键必传+转发 | `auth login --email e --idempotency-key k1 --verbose` | 请求头 `Idempotency-Key: k1`（POST /auth/login，注册分支同键）；never auto-gen |
| TC-AUTH-LOGIN-11 | 缺幂等键（--yes） | `auth login --email e --yes`（不带 --idempotency-key） | 本地拦截 `code=PARAM_IDEMPOTENCY_KEY_REQUIRED`；退出 1（不发起任何请求） |
| TC-AUTH-LOGIN-12 | 缺幂等键（交互） | `auth login --email e`（非 --yes，不带 --idempotency-key） | 交互提示 `Idempotency key (unique per write, for safe retry):`，输入后继续；空输入触发非空校验；退出 0 |
| TC-AUTH-LOGIN-08 | json 模式 stderr 静默 | `auth login ... --format json 1>out 2>err` | `Magic link sent` 等进度行 + spinner **不**出现在 stderr（json 静默）；stdout 仅 payload。对照 table 模式 stderr 应含 `Magic link sent` |
| TC-AUTH-LOGIN-09 | binary 标识 | 抓包 | `User-Agent: agenzo-admin-cli/<v>`；登录提示串为 `agenzo-admin-cli auth login` |
| TC-AUTH-LOGIN-10 | `--yes` 缺 email | `auth login --yes`（不带 --email） | 报参数缺失 `PARAM_*`；退出 1（--yes 下必填） |

执行步骤：

```bash
# TC-AUTH-LOGIN-02 已注册登录 + 脱敏 + 格式
agenzo-admin-cli auth login --email "$EMAIL" --format json 1>out.json 2>err.log
echo "exit=$?"
jq . out.json                                  # 必须是合法 JSON
grep -E "access_token|refresh_token" out.json  # 必须无匹配（脱敏）
test -f ~/.agenzo-admin-cli/credentials/*.json # 凭证已落盘

# TC-AUTH-LOGIN-07 幂等键
agenzo-admin-cli auth login --email "$EMAIL" --idempotency-key login-key-1 --verbose 2>&1 | grep -i "Idempotency-Key"
```

预期断言：`exit=0`；`jq` 成功；grep 脱敏无匹配；凭证文件存在；verbose 日志显示透传的 `Idempotency-Key`。

---

### 5.2 `auth logout`（W，本地，不接受 idem）

对应：Req 1.2, 4.4；cli-design §2.4.2。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-AUTH-LOGOUT-01 | 正常注销 | 已登录态执行 `auth logout` | best-effort `POST /auth/logout`；删除 `credentials/<active_org>.json`；data=`{signed_out:true}`；退出 0 |
| TC-AUTH-LOGOUT-02 | 未登录注销 | 清空 active_org 后执行 | 抛 `AuthError(Not signed in)`；`code=AUTH_NOT_SIGNED_IN`；退出 3 |
| TC-AUTH-LOGOUT-03 | 服务端失败静默 | mock `/auth/logout` 5xx | 网络/服务端错误被吞，本地凭证仍删除；退出 0 |
| TC-AUTH-LOGOUT-04 | 拒绝 idem flag | `auth logout --idempotency-key k` | commander 报未知选项/拒绝；非 0 退出（本地写不接受该 flag） |

执行步骤：

```bash
agenzo-admin-cli auth logout --format json; echo "exit=$?"
ls ~/.agenzo-admin-cli/credentials/   # 当前 org 凭证应已删除
# TC-AUTH-LOGOUT-04
agenzo-admin-cli auth logout --idempotency-key k 2>&1; echo "exit=$?"  # 期望非 0
```

---

### 5.3 `config set-host`（W，纯本地，不接受 idem）

对应：Req 3.1；cli-design §2.4.3。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-CFG-SET-01 | host 命中已有凭证 | `config set-host https://agent.everonet.com`（已有该 host 凭证） | 写 `api_host`；自动 `setActiveOrg(match)`；data=`{api_host,active_org}`；退出 0 |
| TC-CFG-SET-02 | host 无匹配凭证 | `config set-host https://agent-test.everonet.com`（无凭证） | 写 host；清空 `active_org`；stderr 提示 `Please run login.`；退出 0 |
| TC-CFG-SET-03 | 缺 host 位置参数 | `config set-host` | 参数缺失 → `PARAM_*`；退出 1 |
| TC-CFG-SET-04 | 无 scheme | `config set-host agent.everonet.com` | 校验失败；退出 1；不写配置 |
| TC-CFG-SET-05 | 无 API 调用 | 抓包 | 该命令不发起任何 HTTP 请求 |
| TC-CFG-SET-06 | 拒绝 idem flag | `config set-host <h> --idempotency-key k` | 拒绝；非 0 |
| TC-CFG-SET-07 | 输出不重复（回归 GAPA-049） | `config set-host <h>`（table） | 状态行（✓/ℹ）只在 stderr 各一次；stdout 仅 payload 投影（API Host/Active Org），不含状态图标 |
| TC-CFG-SET-08 | 拒绝公网 HTTP | `config set-host http://example.com` | 校验失败；退出 1；不写配置（仅 `http://localhost` / `http://127.0.0.1` 允许本地联调） |

```bash
agenzo-admin-cli config set-host https://agent-test.everonet.com --format json; echo "exit=$?"
jq .api_host ~/.agenzo-admin-cli/config.json   # 应为新 host
```

---

### 5.4 `config show`（R，纯本地）

对应：Req 3.3；cli-design §2.4.4。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-CFG-SHOW-01 | 已登录 | `config show` | data=`{api_host,api_path,active_org}`；`active_org` 为当前值；退出 0 |
| TC-CFG-SHOW-02 | 未登录 | 清 active_org 后 `config show` | `active_org` 为 `null`（json）/ `(none)`（table）；退出 0 |
| TC-CFG-SHOW-03 | 无 API 调用 | 抓包 | 不发起 HTTP |
| TC-CFG-SHOW-04 | JSON 干净 | `config show --format json` 管道 `jq .` | 解析成功；stdout 仅 payload |
| TC-CFG-SHOW-05 | table 投影一致 | 对比 json 与 table | table 不含 json 之外字段，反之亦然（Req 4.5） |

```bash
agenzo-admin-cli config show --format json | jq .
agenzo-admin-cli config show   # table 默认
```

---

### 5.5 `config reset-host`（W，纯本地）

对应：Req 3.2；cli-design §2.4.5。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-CFG-RST-01 | 重置且命中凭证 | 当前为 test host，有 default host 凭证，执行 `config reset-host` | host 写回 `https://agent.everonet.com`；切到匹配 org；退出 0 |
| TC-CFG-RST-02 | 重置无匹配 | 无 default host 凭证 | host 写回默认；清空 active_org；提示 login；退出 0 |
| TC-CFG-RST-03 | 等价 set-host | 对比 `reset-host` 与 `set-host <default>` 行为 | 完全一致 |
| TC-CFG-RST-04 | 拒绝 idem flag | `config reset-host --idempotency-key k` | 拒绝；非 0 |
| TC-CFG-RST-05 | 输出不重复（回归 GAPA-049） | `config reset-host`（table） | 与 set-host 一致：状态行只在 stderr 各一次，stdout 仅 payload |

```bash
agenzo-admin-cli config reset-host --format json; echo "exit=$?"
jq .api_host ~/.agenzo-admin-cli/config.json   # == https://agent.everonet.com
```

---

### 5.6 `orgs get`（R，`GET /organizations/me`）

对应：Req 1.3, 7.1, 7.2；cli-design §2.4.6。注意 verb 由源码 `me` 改名为 `get`，HTTP 行为不变。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-ORG-GET-01 | 正常查询 | 已登录 `orgs get` | `GET /organizations/me`；data=`Organization`（id/name/email/status/created_at/updated_at）；退出 0 |
| TC-ORG-GET-02 | Bearer 失效 | token 过期且 refresh 失败 | `code=AUTH_SESSION_EXPIRED`；退出 3 |
| TC-ORG-GET-03 | 命令名 | `orgs get`（旧 `orgs me` 应不存在） | `orgs me` 报未知命令；`orgs get` 正常 |
| TC-ORG-GET-04 | JSON 字段保真 | `--format json` | 字段名为后端 snake_case，与 cli-design §2.4.6 一致 |
| TC-ORG-GET-05 | 透明 refresh | token 距过期 <300s | 自动 `/auth/refresh` 后成功；退出 0 |

```bash
agenzo-admin-cli orgs get --format json | jq '{id,name,email,status}'
agenzo-admin-cli orgs me 2>&1; echo "exit=$?"   # 期望未知命令 / 非 0
```

---

### 5.7 `orgs update`（W，`POST /organizations/me/update`，[idem]）

对应：Req 4.3, 5.3；cli-design §2.4.7。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-ORG-UPD-01 | 仅改 name | `orgs update --name "Acme Inc." --idempotency-key k` | body 仅含 name；后端返回 `Organization` 实体；data=`Organization`(最新)；同步本地凭证 org_name；退出 0 |
| TC-ORG-UPD-02 | 改 email（走验证） | `orgs update --email ops@acme.com --idempotency-key k` | 后端**不**内联改 email，返回 magic-link 待验证载荷 `{magic_link_token, expires_at}`；CLI 渲染为 `Status: PENDING_EMAIL_VERIFICATION` + token + 过期时间，**不**渲染成 Organization（否则字段全 undefined）；stderr 提示 `Verification email sent to the new address`；退出 0 |
| TC-ORG-UPD-03 | name+email 同传 | 同时传 `--name` 和 `--email` | 后端 name 先更新，但因带了新 email → 整体走邮箱变更分支，返回 magic-link 载荷而非 Organization；CLI 按 PENDING_EMAIL_VERIFICATION 渲染（与 TC-02 同）；退出 0 |
| TC-ORG-UPD-04 | email 冲突 | 已被占用的 email | `code=ORG_CONFLICT`（409）；退出 1 |
| TC-ORG-UPD-05 | 非法 email/name | 越界/格式错 | `code=PARAM_INVALID`（422）；退出 1 |
| TC-ORG-UPD-06 | 幂等键必传+转发 | `orgs update --name X --idempotency-key k1` | 请求头 `Idempotency-Key: k1`；never auto-gen |
| TC-ORG-UPD-07 | 缺幂等键 | `orgs update --name X --yes`（不带 --idempotency-key） | 本地拦截 `code=PARAM_IDEMPOTENCY_KEY_REQUIRED`；退出 1（不发起请求） |
| TC-ORG-UPD-08 | 响应分流断言 | `--email ... --format json` | stdout JSON 含 `magic_link_token`，**不含** `id`/`status` 等 Organization 字段；仅改 name 时反之（含 Organization 字段、无 magic_link_token） |

```bash
agenzo-admin-cli orgs update --name "Acme Inc." --idempotency-key org-upd-1 --format json | jq '{id,name,status}'
echo "exit=$?"
```

---

### 5.8 `orgs list`（R，纯本地，host 过滤）

对应：Req 3.4；cli-design §2.4.8。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-ORG-LIST-01 | 多 org 列出 | 本机有 ≥2 个当前 host 下凭证 | data=`Array<{org_id,org_name,email,active}>`；当前 active 标 `active:true`/`*`；退出 0 |
| TC-ORG-LIST-02 | host 过滤 | 存在不同 host 凭证 | 仅列出 `credential.api_host==当前 host` 的；跨环境凭证被过滤 |
| TC-ORG-LIST-03 | 无凭证 | 清空凭证目录 | stderr `No signed-in organizations`；data=`[]`；退出 0 |
| TC-ORG-LIST-04 | 无 API 调用 | 抓包 | 不发起 HTTP |
| TC-ORG-LIST-05 | JSON 数组 | `--format json` 管道 `jq 'type'` | 输出 `"array"` |

```bash
agenzo-admin-cli orgs list --format json | jq '.[] | {org_id, active}'
```

---

### 5.9 `orgs switch`（W，纯本地，跨环境守卫）

对应：Req 3.5, 3.6；cli-design §2.4.9。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-ORG-SW-01 | 切换有效 org | `orgs switch <已登录同 host org_id>` | 设 `active_org`；data=`{active_org}`；退出 0 |
| TC-ORG-SW-02 | 目标未登录 | `orgs switch <不存在 org>` | 抛错，提示 `agenzo-admin-cli auth login`；退出 1（或对应 CLIENT 码） |
| TC-ORG-SW-03 | 跨环境拒绝 | 切到 `api_host` 不同的 org | 拒绝（cross-environment error）；`active_org` 不变；退出 1 |
| TC-ORG-SW-04 | 无 API 调用 | 抓包 | 不发起 HTTP |
| TC-ORG-SW-05 | 拒绝 idem flag | `orgs switch <id> --idempotency-key k` | 拒绝；非 0 |

```bash
agenzo-admin-cli orgs switch "$ORG_ID" --format json; echo "exit=$?"
jq .active_org ~/.agenzo-admin-cli/config.json
```

---

### 5.10 `developers create`（W，`POST /developers/create`，[idem]）

对应：Req 4.3, 5.3, 7.1；cli-design §2.4.10。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-DEV-CRT-01 | 正常创建 | `developers create --developer-name shopping-bot --developer-email oncall@acme.com` | `POST /developers/create` body=`{name,email}`；data=`Developer`；退出 0；记录 `$DEV_ID` |
| TC-DEV-CRT-02 | 交互补全 | 不传字段（非 --yes） | 交互询问 name/email；成功 0 |
| TC-DEV-CRT-03 | --yes 缺字段 | `developers create --yes`（缺 name） | 参数缺失 `PARAM_*`；退出 1 |
| TC-DEV-CRT-04 | name 重复 | 同 Org 内重名 | `code=ORG_CONFLICT`（409，按设计 409→ORG_CONFLICT）；退出 1 |
| TC-DEV-CRT-05 | email 非法 | 格式错 | `code=PARAM_INVALID`（422）；退出 1 |
| TC-DEV-CRT-06 | 幂等键转发 | `--idempotency-key dev-crt-1` | 请求头透传；同键重试不重复创建（CLI 侧仅验证 header；后端去重 BACK-090 不验） |
| TC-DEV-CRT-07 | Bearer 失效 | token 过期 | `code=AUTH_SESSION_EXPIRED`；退出 3 |
| TC-DEV-CRT-08 | billing_mode 默认 | 不传 `--billing-mode` | body `billing_mode=pay_per_call`；data.billing_mode=`pay_per_call`；输出含 `Billing Mode` 行；退出 0 |
| TC-DEV-CRT-09 | billing_mode 月结 | `--billing-mode monthly_settlement` | body `billing_mode=monthly_settlement`；data 回显一致；退出 0 |
| TC-DEV-CRT-10 | billing_mode 非法 | `--billing-mode weekly` | 本地 `resolveBillingMode` 抛 `ValidationError`→`code=PARAM_INVALID`；退出 1（不发起请求） |
| TC-DEV-CRT-11 | billing_mode 归一化 | `--billing-mode Monthly_Settlement` | 大小写归一化为 `monthly_settlement`；退出 0 |

> 副作用提示：后端**仅当** `billing_mode=monthly_settlement` 时为新 developer 建一条 settlement account（balance=0/USD/active）；`pay_per_call`（默认）**不建**账户。CLI 不直接断言该副作用，由 §5.19 `accounts get` 间接覆盖（月结 developer 有账户、pay_per_call developer 返回 `data:null`）。

```bash
agenzo-admin-cli developers create \
  --developer-name shopping-bot --developer-email oncall@acme.com \
  --billing-mode monthly_settlement \
  --idempotency-key dev-crt-1 --format json 1>dev.json 2>err.log
echo "exit=$?"; DEV_ID=$(jq -r '.id // .developer_id' dev.json); echo "$DEV_ID"
jq -r '.billing_mode' dev.json   # == monthly_settlement
# TC-DEV-CRT-10 非法 billing_mode 本地拦截
agenzo-admin-cli developers create --developer-name x --developer-email x@e.com \
  --billing-mode weekly --idempotency-key dev-crt-2 2>&1; echo "exit=$?"   # 期望 1
```

---

### 5.11 `developers list`（R，`GET /developers`）

对应：Req 7.1；cli-design §2.4.11。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-DEV-LST-01 | 有数据 | `developers list` | data=`Developer[]`；字段 id/name/email/status；退出 0 |
| TC-DEV-LST-02 | 无数据 | 新 Org | stderr `No developers found`；data=`[]`；退出 0 |
| TC-DEV-LST-03 | Bearer 失效 | token 过期 | `AUTH_SESSION_EXPIRED`；退出 3 |
| TC-DEV-LST-04 | JSON 数组 | `--format json` 管道 `jq 'type'` | `"array"` |

```bash
agenzo-admin-cli developers list --format json | jq '.[] | {id,name,status}'
```

---

### 5.12 `developers get`（R，`GET /developers/{id}`）

对应：Req 7.1；cli-design §2.4.12。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-DEV-GET-01 | 正常 | `developers get $DEV_ID` | data=`Developer`(含 created_at/updated_at + `billing_mode`)；输出含 `Billing Mode` 行；退出 0 |
| TC-DEV-GET-02 | 不存在 | `developers get dev_notexist` | 404 noun 映射；退出 1（注意：design 矩阵 404→1） |
| TC-DEV-GET-03 | 缺位置参数 | `developers get` | 参数缺失；退出 1 |

```bash
agenzo-admin-cli developers get "$DEV_ID" --format json | jq '{id,name,status,billing_mode,created_at}'
agenzo-admin-cli developers get dev_notexist 2>&1; echo "exit=$?"   # 期望 1
```

---

### 5.13 `developers update`（W，`POST /developers/{id}/update`，[idem]）

对应：Req 4.3, 5.3, 7.1；cli-design §2.4.13。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-DEV-UPD-01 | 改 name | `developers update $DEV_ID --name shopping-bot-prod` | data=`Developer`(最新)；退出 0 |
| TC-DEV-UPD-02 | 改 email | `--email ops@acme.com` | 退出 0 |
| TC-DEV-UPD-03 | 不存在 | 错误 id | 404→退出 1 |
| TC-DEV-UPD-04 | name 重复 | 409 | `ORG_CONFLICT`；退出 1 |
| TC-DEV-UPD-05 | email 非法 | 422 | `PARAM_INVALID`；退出 1 |
| TC-DEV-UPD-06 | 幂等键转发 | `--idempotency-key dev-upd-1` | header 透传 |

```bash
agenzo-admin-cli developers update "$DEV_ID" --name shopping-bot-prod \
  --idempotency-key dev-upd-1 --format json | jq '{id,name}'
echo "exit=$?"
```

---

### 5.14 `keys create`（W，`POST /keys/create`，[idem]，一次性明文）

对应：Req 4.3, 5.3, 6.2；cli-design §2.4.14。

> scope 现状：**后端已落地**——create 时 `scope` 存入 `ap_api_keys.scope`，create/list/get/rotate 响应均回传；省略 `--scope` 时后端授予全三个；scope 经规范化（去重 + 按 `token,merchant,payment` 排序）。CLI 仍保留"响应无 scope 时回填请求值"的防御兜底（仅对旧服务端生效）。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-KEY-CRT-01 | 正常签发 | `keys create --developer-id $DEV_ID --key-name "Production Key" --scope token,merchant,payment` | data=`ApiKey`(含一次性 `api_key` + `scope`)；后端持久化 scope；落盘 `keys.json`；退出 0 |
| TC-KEY-CRT-02 | 默认 scope | 不传 --scope | 后端授予并回传 `["token","merchant","payment"]` |
| TC-KEY-CRT-03 | 部分 scope | `--scope token` | data.scope=`["token"]`（后端持久化该子集） |
| TC-KEY-CRT-04 | developer 不存在 | 错误 id | 404→`KEY_NOT_FOUND`/`ORG_NOT_FOUND`；退出 1 |
| TC-KEY-CRT-05 | name 重复 | 409 | `ORG_CONFLICT`；退出 1 |
| TC-KEY-CRT-06 | 一次性明文 + 警告 | table 模式 | stderr 出现 `shown only once` 警告；api_key 在 stdout(json) data 中 |
| TC-KEY-CRT-07 | Bearer 脱敏 | `--format json 1>out` | out 不含 `access_token`/`refresh_token`（api_key 允许出现） |
| TC-KEY-CRT-08 | 幂等键转发 | `--idempotency-key key-crt-1` | header 透传 |
| TC-KEY-CRT-09 | scope 乱序/重复归一化 | `--scope payment,token,token` | 后端回传规范化为 `["token","payment"]`（去重 + 顺序固定） |
| TC-KEY-CRT-10 | scope 非法值 | `--scope token,weekly` | CLI 本地 `parseScopeFlag` 抛 `ValidationError`→`PARAM_INVALID`；退出 1（不发起请求） |

```bash
agenzo-admin-cli keys create --developer-id "$DEV_ID" --key-name "Production Key" \
  --scope token,merchant,payment --idempotency-key key-crt-1 --format json 1>key.json 2>err.log
echo "exit=$?"
KEY_ID=$(jq -r '.id' key.json); API_KEY=$(jq -r '.api_key' key.json)
grep -E "access_token|refresh_token" key.json   # 必须无匹配（Bearer 脱敏）
jq -e '.api_key' key.json                        # api_key 必须存在
jq -e '.scope == ["token","merchant","payment"]' key.json   # 后端回传 scope
```

---

### 5.15 `keys list`（R，`GET /keys?developer_id=...`，无明文）

对应：Req 6.3；cli-design §2.4.15。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-KEY-LST-01 | 有数据 | `keys list --developer-id $DEV_ID` | data=`ApiKey[]`；每项含 `scope`；**无 `api_key` 字段**；Scope 列有值；退出 0 |
| TC-KEY-LST-02 | 无数据 | 无 key 的 developer | stderr `No API Keys found`；data=`[]`；退出 0 |
| TC-KEY-LST-03 | 明文脱敏 | `--format json` | 任何元素都无 `api_key`；只含 `key_prefix` / `scope` 等元数据 |
| TC-KEY-LST-04 | developer 不存在 | 错误 id | 404→退出 1 |
| TC-KEY-LST-05 | legacy key scope 兜底 | 查 scope 落地前创建的旧 key | 后端对无 `scope` 字段的文档回退 `["token","merchant","payment"]`，Scope 列显示全三个（兜底默认，**非创建时真实值**）；退出 0 |

```bash
agenzo-admin-cli keys list --developer-id "$DEV_ID" --format json 1>keys.json
jq -e 'all(.[]; has("api_key") | not)' keys.json   # 断言无任何 api_key
jq -e 'all(.[]; .scope | length > 0)' keys.json    # 每项 scope 非空（含 legacy 兜底）
```

---

### 5.16 `keys get`（R，`GET /keys/{id}`，无明文）

对应：Req 6.3；cli-design §2.4.16。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-KEY-GET-01 | 正常 | `keys get $KEY_ID` | data=`ApiKey` 元数据（含 `scope`，无 `api_key`）；Scope 行有值；退出 0 |
| TC-KEY-GET-02 | 不存在 | 错误 key_id | 404→`KEY_NOT_FOUND`；退出 1 |
| TC-KEY-GET-03 | 明文脱敏 | `--format json` | 无 `api_key` 字段 |
| TC-KEY-GET-04 | legacy key scope 兜底 | scope 落地前的旧 key | 回退 `["token","merchant","payment"]`（兜底默认，非真实值）；退出 0 |

```bash
agenzo-admin-cli keys get "$KEY_ID" --format json 1>kget.json
jq -e 'has("api_key") | not' kget.json   # 断言无 api_key
jq -e '.scope | length > 0' kget.json    # scope 非空
```

---

### 5.17 `keys rotate`（W，`POST /keys/{id}/rotate`，[idem]，新明文）

对应：Req 4.3, 6.2；cli-design §2.4.17。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-KEY-ROT-01 | 正常轮换 | `keys rotate $KEY_ID` | data=`ApiKey`(含**新** `api_key`)；KeyStore 明文被覆盖；退出 0 |
| TC-KEY-ROT-02 | 不存在 | 错误 id | 404→退出 1 |
| TC-KEY-ROT-03 | 已禁用不可轮换 | 先 disable 再 rotate | `code=ORG_CONFLICT`（409 状态冲突）；退出 1 |
| TC-KEY-ROT-04 | 新明文 + 警告 | table 模式 | stderr `shown only once`；新 api_key 在 stdout(json) |
| TC-KEY-ROT-05 | key_id 不变 | 对比 rotate 前后 | `id` 不变，仅 `api_key` 滚动 |
| TC-KEY-ROT-06 | 幂等键必传+转发 | `--idempotency-key key-rot-1` | header 透传；never auto-gen |
| TC-KEY-ROT-07 | 缺幂等键 | `keys rotate $KEY_ID`（不带 --idempotency-key） | 本地拦截 `code=PARAM_IDEMPOTENCY_KEY_REQUIRED`；退出 1（不发起请求） |
| TC-KEY-ROT-08 | scope 保持 | rotate 前后对比 scope | rotate 不改 scope，响应回传与原 key 相同的 `scope` |

```bash
agenzo-admin-cli keys rotate "$KEY_ID" --idempotency-key key-rot-1 --format json 1>rot.json
echo "exit=$?"; jq -e '.api_key' rot.json   # 新明文存在
jq -r '.id' rot.json                        # == 原 KEY_ID
```

---

### 5.18 `keys disable`（W，`POST /keys/{id}/disable`，[idem]）

对应：Req 4.3；cli-design §2.4.18。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-KEY-DIS-01 | 正常禁用 | `keys disable $KEY_ID` | data=`DisableResult`(status=disabled)；退出 0 |
| TC-KEY-DIS-02 | 不存在 | 错误 id | 404→`KEY_NOT_FOUND`；退出 1 |
| TC-KEY-DIS-03 | 重复禁用幂等 | 对同一 key 连续 disable 两次（均带不同 key 或同 key） | 第二次仍返回 `disabled`；退出 0（状态收敛） |
| TC-KEY-DIS-04 | 幂等键必传+转发 | `--idempotency-key key-dis-1` | header 透传 |
| TC-KEY-DIS-06 | 缺幂等键 | `keys disable $KEY_ID`（不带 --idempotency-key） | 本地拦截 `code=PARAM_IDEMPOTENCY_KEY_REQUIRED`；退出 1（不发起请求） |
| TC-KEY-DIS-05 | 禁用后失效 | disable 后用该 api_key 调运行面 | 运行面返回 key 失效（跨 CLI 验证，可选） |

```bash
agenzo-admin-cli keys disable "$KEY_ID" --idempotency-key key-dis-1 --format json | jq '.status'
echo "exit=$?"
agenzo-admin-cli keys disable "$KEY_ID" --idempotency-key key-dis-2 --format json | jq '.status'   # 幂等：仍 disabled
```

---

### 5.19 `accounts get`（R，`GET /accounts?developer_id=...`）

对应：Req 7.1；cli-design §2.4.19。查询 Developer 的月结账户。账户**仅当** `billing_mode=monthly_settlement` 时在 create developer 由后端建（balance=0/USD/active）；`pay_per_call` developer 与存量 developer 均无账户，返回 `data:null` + info 提示。

| 用例 | 场景 | 输入 | 预期 |
| --- | --- | --- | --- |
| TC-ACCT-GET-01 | 正常查询 | `accounts get --developer-id $DEV_ID` | `GET /accounts?developer_id=$DEV_ID`；data=`SettlementAccount`(id/developer_id/balance/currency/status/created_at/updated_at)；退出 0 |
| TC-ACCT-GET-02 | 字段保真 | `--format json` | `balance` 为整数（最小货币单位 cent）；`currency=USD`；`status` ∈ `active/suspended/closed`；`id` 前缀 `acct_` |
| TC-ACCT-GET-03 | 无账户（存量 dev） | 对无账户的 developer 查询 | 后端返回 `data:null` + message；table 模式 stderr 出现 `No settlement account found...`；json 模式 stdout=`null`；退出 0 |
| TC-ACCT-GET-04 | developer 不存在/跨 Org | `accounts get --developer-id dev_notexist` | 后端 404/1201 → 退出 1 |
| TC-ACCT-GET-05 | 交互补全 | 不传 `--developer-id`（非 --yes） | 交互询问 `Developer ID:`；输入后查询；退出 0 |
| TC-ACCT-GET-06 | 只读无幂等 | `accounts get --developer-id $DEV_ID --idempotency-key k` | commander 拒绝未知选项（只读命令不接受 idem flag）；非 0 |
| TC-ACCT-GET-07 | JSON 干净 | `--format json` 管道 `jq .` | 解析成功；stdout 仅 payload；无 Bearer token 泄漏 |

```bash
# TC-ACCT-GET-01/02 正常查询 + 字段
agenzo-admin-cli accounts get --developer-id "$DEV_ID" --format json 1>acct.json 2>err.log
echo "exit=$?"
jq '{id,developer_id,balance,currency,status}' acct.json
jq -e '.id | startswith("acct_")' acct.json   # 账户 id 前缀
jq -e '.balance | type == "number"' acct.json # 余额为整数
grep -E "access_token|refresh_token" acct.json # 必须无匹配（脱敏）

# TC-ACCT-GET-04 不存在
agenzo-admin-cli accounts get --developer-id dev_notexist 2>&1; echo "exit=$?"   # 期望 1
```

预期断言：`exit=0`；`jq` 成功；`id` 以 `acct_` 开头；`balance` 为数字；脱敏 grep 无匹配；不存在的 developer 退出 1。

---

## 6. 覆盖矩阵（命令 × 需求/属性）

| 命令 | 主要用例 | 覆盖需求 | 覆盖属性 |
| --- | --- | --- | --- |
| auth login | TC-AUTH-LOGIN-01..10 | 1.2, 2.1, 2.2, 2.5, 4.1, 4.3, 6.1 | P1, P5, P6 |
| auth logout | TC-AUTH-LOGOUT-01..04 | 1.2, 4.4 | — |
| config set-host | TC-CFG-SET-01..08 | 3.1 | — |
| config show | TC-CFG-SHOW-01..05 | 3.3, 4.1, 4.5 | P1 |
| config reset-host | TC-CFG-RST-01..04 | 3.2 | — |
| orgs get | TC-ORG-GET-01..05 | 1.3, 7.1, 7.2 | P7 |
| orgs update | TC-ORG-UPD-01..07 | 4.3, 5.3 | P6 |
| orgs list | TC-ORG-LIST-01..05 | 3.4 | P1 |
| orgs switch | TC-ORG-SW-01..05 | 3.5, 3.6 | — |
| developers create | TC-DEV-CRT-01..11 | 4.3, 5.3, 7.1 | P6, P7 |
| developers list | TC-DEV-LST-01..04 | 7.1 | P1 |
| developers get | TC-DEV-GET-01..03 | 7.1 | P7 |
| developers update | TC-DEV-UPD-01..06 | 4.3, 5.3, 7.1 | P6 |
| keys create | TC-KEY-CRT-01..10 | 4.3, 5.3, 6.2 | P5, P6 |
| keys list | TC-KEY-LST-01..05 | 6.3 | P5 |
| keys get | TC-KEY-GET-01..04 | 6.3 | P5 |
| keys rotate | TC-KEY-ROT-01..08 | 4.3, 6.2 | P5, P6 |
| keys disable | TC-KEY-DIS-01..05 | 4.3 | P6 |
| accounts get | TC-ACCT-GET-01..07 | 7.1 | P1 |
| 横切（renderer/exit/error） | UT-FMT/RND/EXIT/ERR/PBT | 4.1, 4.2, 5.1, 5.2, 6.1 | P1–P5 |
| 横切（billing-mode 校验） | UT-BILL-01..05 | 5.3 | — |

> 属性编号 P1–P7 对应 design.md「Correctness Properties」。退出码语义见 §5 顶部。

## 7. 执行顺序与一次性走通脚本（建议）

L3 命令链建议按依赖顺序执行，便于变量复用与端到端验证：

```text
auth login → orgs get → developers create → keys create
           → accounts get
           → developers list/get/update
           → keys list/get/rotate/disable
           → orgs update/list/switch
           → config show/set-host/reset-host
           → auth logout
```

每步执行后立即 `echo $?` 校验退出码，并对写命令补一条 `--idempotency-key` 用例确认 header 透传。
