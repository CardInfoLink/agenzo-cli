# agenzo-merchant-cli 测试设计文档（Test Design）

> 本文档为 `agenzo-merchant-cli` 的测试设计，对齐 spec（`requirements.md` / `design.md` / `tasks.md`）与 `doc/architecture-upgrade/v1/cli-design.md` §4（命令字段级规范）+ §8（错误码字典）。
> 范围 = **7 条命令矩阵**（`services` 2 条 + `ride-elife` 5 条）+ 5 项横切一致性约束（输出契约 / 错误映射 / 幂等键 / NDJSON watch / 逐字对齐）。
> 权威顺序：cli-standard.md > cli-design.md §4 > design.md。
> 仓库：`agenzo-cli/apps/merchant-cli`（binary `agenzo-merchant-cli`，package `@agenzo/merchant-cli`），TypeScript + commander@14 + vitest + tsup；通用件全部 import 自 `@agenzo/cli-core`。
> 本文档是 UT 模块（tasks 6.2–6.5）的实现蓝图与覆盖核对清单：每个用例标注用例编号 + 对应需求 / design Property，§8 给出命令 × 需求/属性覆盖矩阵，§9 给出已规划自动化测试文件映射。

---

## 1. 测试目标与范围

### 1.1 目标

1. 验证 7 条命令的输入/输出/HTTP 行为与 cli-design §4.4 字段级规范 + 现有 `merchant-cli/src/` 实现**逐字一致**（noun `ride-elife`、子路径 `/ride/quote`、`/ride/book`、`/ride/<id>/status`、`/ride/<id>/cancel`、`/ride/orders`、decimal 金额单位）（Req 7.1 / Property 7）。
2. 验证 API Key 鉴权（`--api-key` → `X-Api-Key` 头）在全部 7 条联网命令上正确携带；缺省时交互索取（password prompt）。
3. 验证 `--format` 默认 `json`（D2，agent-first，刻意偏离 cli-core 的 `table` 默认）；json 模式 stdout 仅含单一合法 JSON（业务 payload + `profile`/`endpoint` 信封），stderr 完全静默；table 模式状态行/spinner 走 stderr（Req 5.1 / Property 1）。
4. 验证 `--idempotency-key` 在 2 条写命令（`ride-elife book` / `cancel`）上：`--yes` 缺键 → `PARAM_IDEMPOTENCY_KEY_REQUIRED`（exit 1）且**不发请求**；非 `--yes` 缺键 → 交互索取；键格式 `[A-Za-z0-9_-]{1,128}`，作为 `Idempotency-Key` 头发送、**不进 body**；CLI 永不自动生成（Req 5.3 / Property 3）。
5. 验证错误码归并（对外码 ∈ §8 catalog）与退出码映射（ride/`SERVICE_*`/`BILLING_*`/`ACCOUNT_*`/`PAYMENT_ORDER_*`/`PARAM_*`→1、`KEY_*`→3、`UPSTREAM_/INTERNAL_/RATE_LIMITED`→4、`CLIENT_ABORTED`→5、`UPGRADE_REQUIRED`→2）；api-key 401→`KEY_INVALID`、403→`KEY_SCOPE_DENIED`；ride 后端字符串码保真（`QUOTE_EXPIRED`/`VEHICLE_UNAVAILABLE`/`BILLING_MODE_MISMATCH`/`PAYMENT_ORDER_*`，D3）（Req 5.2/5.4 / Property 4）。
6. 验证 `ride-elife book` 的请求 body **恒不含** `payment_method_id`/卡信息，至多含可选 `payment_order_id`（pay_per_call）；funding 由后端按 `billing_mode` 决定（Req 2.2 / Property 5）。
7. 验证 `ride-elife get --watch` 的 NDJSON 轮询：每行独立合法 JSON、命中终态集合或超时即停、超时末行 `{ watch_status:'timeout', ... }`、watch 流**不套** profile/endpoint 信封（Req 3.2 / Property 2）。
8. 验证 merchant-cli 不存在本地 `api-client`/`config-manager`/`errors`/`formatter`/`output`/`prompt-engine`/`version` 副本，全部 import 自 `@agenzo/cli-core`，且不 import 任何其它 app（Req 4.1/4.3 / Property 6）。

### 1.2 范围内（In Scope）

- 7 条命令：`services list/get` + `ride-elife quote/book/get(+--watch)/cancel/list-orders`。
- 全局 flag：`--format`（json/table，**默认 json**）、`--yes`、`--verbose`、`--api-key`（program 级 + 每命令级均声明）。
- API Key 鉴权模型（`--api-key` → `X-Api-Key` header；缺省 `PromptEngine.resolveInput` password 索取）。
- 应用域逻辑（留 app 内，Req 4.4）：ride body 组装（坐标 number 化、必填校验、座椅 0–5）、NDJSON watch（`watch.ts`）、`--help --format json` verb-schema（`verb-schema.ts`）、services 内置注册表（`registry.ts`）、幂等键 resolve/normalize（`idempotency.ts`）。
- `CliError.fromApi(result, { auth:'api-key' })` 的 api-key 参数化（401→`KEY_INVALID`、403→`KEY_SCOPE_DENIED`）+ §8 字符串码保真（D3）。
- `renderWithContext`（profile/endpoint 信封，BACK-011）。

### 1.3 范围外（Out of Scope）

- admin-cli 的 auth/config/orgs/developers/keys/accounts 命令；token-cli 的 payment-methods/payment-tokens 命令；payment-cli。
- 任何 host 配置命令（无 `config` noun）：环境治理归 admin-cli（admin 的 `config set-host` 统一设定），merchant-cli 共享其配置、不治理环境。
- `ride-elife track`（D5，pending impl，后端无位置流接口）——`get --watch` 的订单状态轮询保留。
- 后端 `/services` discovery endpoint（BACK-063）/ 顶层 `billing` 块 / `page` 游标（D4，pending impl）——本期 `services list/get` 读内置 `registry.ts`。
- 后端 v3 的实际幂等去重落地（仅验证 CLI 侧 `Idempotency-Key` 头透传）。
- 后端 ride 第二阶段（payment-order-id 反查 / 月结账户扣减）的服务端逻辑（CLI 仅透传可选 `--payment-order-id`）。
- cli-core 内部实现（`ApiClient`/`exitCodeFor`/`error-catalog` 等）的单测——属 cli-core 自身测试套件。

---

## 2. 测试分层策略

| 层级 | 工具 | 是否需网络 | 覆盖对象 | 优先级 |
|---|---|---|---|---|
| L1 单元测试（Unit，纯函数） | vitest | 否 | `normalizeIdempotencyKey`/`resolveIdempotencyKey`、watch 引擎 `isTerminalStatus`/`statusOf`/`resolveSeconds`/`runWatch`、`need`/`num`/`seatCount`/`positiveInt` body 校验、`wantsJsonSchema`/`emitSchema`、registry `findService` | P0（必做） |
| L2 属性测试（PBT） | vitest + fast-check | 否 | 幂等键格式 `[A-Za-z0-9_-]{1,128}` 接受/拒绝；watch 对任意状态序列的终止性 + 超时末行不变量 | P0（必做） |
| L3 命令集成测试（CLI mock） | vitest + mock `ApiClient` | 否 | 7 条命令 happy path + 关键分支 + 横切（输出通道纯净 / 幂等必传 / 错误映射），亦给出手动可执行执行步骤 | P0（必做） |
| L4 命令级冒烟 + 逐字对齐核对（E2E + Diff Review） | 编译产物 `agenzo-merchant-cli` + 真实 v3 host；代码走查 + git diff | 是（E2E）/ 否（Diff） | 7 条命令端到端输入/输出/退出码；命令 noun/verb/flags/path/字段与 cli-design §4.4 逐字一致 | P1（手动，README 记录） |

> 说明：L1/L2 是本迭代必做的自动化测试（tasks 6.5 PBT + 6.2–6.4 内含的纯函数单测）。L3 命令集成（tasks 6.2–6.4）mock `ApiClient`、不 mock commander（真实 `parseAsync`）。L4 命令级冒烟以**手动可执行步骤**给出（§6），需真实 merchant-scope key；逐字对齐核对（§7）以代码走查形式对比 cli-design §4.4。

---

## 3. 测试环境与前置准备

### 3.1 构建

```bash
npm install
npm run build -w @agenzo/cli-core      # 必须先 build cli-core（1.1 类型 / 1.2 错误码改动）
npm run build -w @agenzo/merchant-cli  # tsup 产出 dist/index.js，bin = agenzo-merchant-cli
npm run test -w @agenzo/merchant-cli   # vitest run（全量；含 PBT，注意 LongRunningPBT）
agenzo-merchant-cli --version
```

> 关键约束（cli-monorepo-checklist）：改了 cli-core 导出后，**先 build cli-core 再** typecheck/test merchant-cli，否则 `@agenzo/cli-core` 解析旧 dist 报 TS2305。

### 3.2 后端环境（L4 手动测试用）

- testing host：`https://agent-test.everonet.com`（host 由 admin-cli `config set-host` 统一设定；merchant-cli 共享 `~/.agenzo-admin-cli/` 默认配置）。
- API path：`/api/v3/agent-pay`（v3 信封 `{ code, message, data }`，cli-core `ApiClient` 自动解包）。
- 需要一个有效的 **merchant scope** API Key（由 `agenzo-admin-cli keys create --scope merchant` 签发）。

### 3.3 通用断言工具

- JSON 校验：`agenzo-merchant-cli <cmd> --format json | jq .` 必须成功解析（stdout 是单一合法 JSON）。
- 退出码校验：命令后立即 `echo $?`。
- stdout/stderr 分离：`agenzo-merchant-cli <cmd> --format json 1>out.txt 2>err.txt`，断言 `out.txt` 仅含 payload + `profile`/`endpoint`，状态行/spinner 全在 `err.txt`。
- json 模式 stderr 静默：`err.txt` 不含任何状态图标（`✓`/`ℹ`/`⚠`/`✗`）或人读状态文案。
- watch NDJSON 校验：`agenzo-merchant-cli ride-elife get --order-id <id> --watch | while read line; do echo "$line" | jq -e . >/dev/null; done`（每行可单独 `jq` 解析）。

### 3.4 全局 flag 约定

- `--format <json|table>`：**默认 json**（D2）；亦读 `AGENZO_FORMAT`（`preAction` 钩子镜像 resolved format）。
- `--api-key <key>`：→ `X-Api-Key` 头；缺省时交互 password 索取。
- `--yes`：关闭交互式 confirm/prompt（供 CI / Agent）；写命令在 `--yes` 缺幂等键时 hard error。
- `--verbose`：详细日志（→ stderr；未知错误在 table 模式追加 raw dump）。

### 3.5 退出码语义

`0` 成功 · `1` 业务/参数（ride/`SERVICE_*`/`BILLING_*`/`ACCOUNT_*`/`PAYMENT_ORDER_*`/`PARAM_*`）· `2` 需升级（`UPGRADE_REQUIRED`）· `3` 认证失败/无效 key（`KEY_*`）· `4` 网络/5xx（`UPSTREAM_*`/`INTERNAL_*`/`RATE_LIMITED`）· `5` 用户取消（`CLIENT_ABORTED` / SIGINT）。

---

## 4. L1 / L2 单元测试与属性测试（自动化 / vitest）

> 这些是本迭代必做的自动化测试。每个用例标注：用例编号、对应需求/属性、输入、预期。纯函数直接 import 被测函数，无需 mock。

### 4.1 `normalizeIdempotencyKey` —— 幂等键格式校验（Property 3 / Req 5.3）

文件：`tests/idempotency.test.ts`（源：`src/idempotency.ts`）

| 用例 | 输入 | 预期 |
|---|---|---|
| UT-IDEM-01 | `"book-123"` | 返回 `"book-123"`（合法，原样） |
| UT-IDEM-02 | `"  book-123  "`（首尾空白） | trim 后返回 `"book-123"` |
| UT-IDEM-03 | `"A_b-9"`（全字符类） | 返回 `"A_b-9"` |
| UT-IDEM-04 | `""`（空串） | 抛 `CliError('PARAM_INVALID')`（不匹配 `{1,128}`） |
| UT-IDEM-05 | `"has space"` | 抛 `CliError('PARAM_INVALID')` |
| UT-IDEM-06 | `"bad!char"` / `"a@b"` | 抛 `CliError('PARAM_INVALID')` |
| UT-IDEM-07 | `"a".repeat(129)`（>128） | 抛 `CliError('PARAM_INVALID')` |
| UT-IDEM-08 | `"a".repeat(128)`（边界） | 返回该串（128 合法） |
| UT-IDEM-09 | 错误 message | 含原值 + `IDEMPOTENCY_KEY_RULE`（`Use 1-128 characters from [A-Za-z0-9_-].`）；`code==='PARAM_INVALID'` |

### 4.2 `resolveIdempotencyKey` —— 写命令幂等键解析分支（Property 3 / Req 5.3）

文件：`tests/idempotency.test.ts`

| 用例 | 输入（flagValue, opts） | 预期 |
|---|---|---|
| UT-IDEM-10 | flag=`"k1"`, yes=true | 返回 `"k1"`（已传则校验+归一，不论 yes） |
| UT-IDEM-11 | flag=`"  k1 "`, yes=false | 返回 `"k1"`（归一） |
| UT-IDEM-12 | flag=`"bad!"`, yes=true | 抛 `CliError('PARAM_INVALID')`（归一阶段拦截） |
| UT-IDEM-13 | flag=undefined, yes=true, commandPath=`'ride-elife book'` | 抛 `IdempotencyKeyRequiredError`（→`PARAM_IDEMPOTENCY_KEY_REQUIRED`）；message 含命令名 + `--idempotency-key`；**不调用** PromptEngine |
| UT-IDEM-14 | flag=undefined, yes=false（mock `PromptEngine.resolveInput` 返回 `"k2"`） | prompt 文案 `Idempotency key (unique per write, for safe retry):`；返回 `"k2"`；validate 对空/非法返回 `IDEMPOTENCY_KEY_RULE` |
| UT-IDEM-15 | flag=undefined, yes=false, prompt 返回非法值 | 经 `normalizeIdempotencyKey` 二次校验后抛 `PARAM_INVALID`（兜底） |

### 4.3 watch 引擎纯函数（Property 2 / Req 3.2）

文件：`tests/watch.test.ts`（源：`src/ride-elife/watch.ts`）

| 用例 | 输入 | 预期 |
|---|---|---|
| UT-WATCH-01 | `isTerminalStatus('At destination')` | `true`（终态集合成员） |
| UT-WATCH-02 | `isTerminalStatus('Cancelled')`/`'Rejected'`/`'Customer no show'`/`'Driver no show'` | 全 `true` |
| UT-WATCH-03 | `isTerminalStatus('On board')`/`'Pending'`/`'Accepted'` | 全 `false`（进行中态） |
| UT-WATCH-04 | `isTerminalStatus('at destination')`（小写） | `false`（**大小写敏感**，必须逐字匹配服务端 casing） |
| UT-WATCH-05 | `isTerminalStatus(undefined)`/`null` | `false`（缺失态永不终止，继续轮询） |
| UT-WATCH-06 | `statusOf({status:'Pending'})` | `'Pending'`；`statusOf({status:123})` → `undefined`（仅 string） |
| UT-WATCH-07 | `resolveSeconds(undefined, 5)` | `5`（默认回退） |
| UT-WATCH-08 | `resolveSeconds('10', 5)` | `10` |
| UT-WATCH-09 | `resolveSeconds('0', 5)`/`'-3'`/`'abc'` | `5`（非正/非有限回退默认） |
| UT-WATCH-10 | `TERMINAL_STATUSES` / `DEFAULT_WATCH_INTERVAL_SECONDS` / `DEFAULT_WATCH_TIMEOUT_SECONDS` | 集合恰为 5 个终态；常量分别为 `5` / `600` |

### 4.4 `runWatch` —— NDJSON 轮询引擎（假时钟，Property 2 / Req 3.2）

文件：`tests/watch.test.ts`（注入 `fetchStatus`/`writeLine`/`sleep`/`now`，假时钟）

| 用例 | 场景（注入序列） | 预期 |
|---|---|---|
| UT-WATCH-11 | 首次即终态 `['At destination']` | `writeLine` 调 1 次（该状态行）；不写 timeout 行；返回 |
| UT-WATCH-12 | `['Pending','Accepted','At destination']`，interval<timeout | `writeLine` 调 3 次（逐行）；末次为终态；无 timeout 行 |
| UT-WATCH-13 | 永不终态 `['Pending','Pending',...]`，假时钟使 `now()+interval>=deadline` | 末行恰为 `{ watch_status:'timeout', message, last_status:'Pending' }`；之前每次结果各一行 |
| UT-WATCH-14 | 永不终态且首轮即超时预算 | 至少写 1 次状态行 + timeout 末行；`last_status` 取最后一次状态 |
| UT-WATCH-15 | `fetchStatus` 抛 `CliError` | 异常向上传播（中止整个流），不吞错；已写行不回滚 |
| UT-WATCH-16 | 每条 `writeLine` 记录 | 经 `ndjsonWriteLine` 序列化为**单行紧凑 JSON** + 换行（断言无多行缩进、行尾 `\n`） |
| UT-WATCH-17 | timeout 行 `message` | 含 `${timeoutMs/1000}s` 文案；`watch_status==='timeout'` 字面量 |

### 4.5 ride body 校验助手（Req 2.1/2.2/3.1/3.4 / Property 7）

文件：`tests/ride-helpers.test.ts`（源：各命令的 `need`/`num`/`seatCount`/`positiveInt`；建议导出或经命令级断言）

| 用例 | 输入 | 预期 |
|---|---|---|
| UT-BODY-01 | `need(undefined,'pickup-lat')` | 抛 `CliError('PARAM_INVALID')`，message `Missing required --pickup-lat.` |
| UT-BODY-02 | `need('v','x')` | 返回 `'v'` |
| UT-BODY-03 | `num('37.79','pickup-lat')` | 返回 `37.79`（number 化） |
| UT-BODY-04 | `num('abc','pickup-lat')` | 抛 `PARAM_INVALID`（`must be a number`） |
| UT-BODY-05 | `num(undefined,'price-amount')` | 抛 `PARAM_INVALID`（缺失先于非数） |
| UT-BODY-06 | `seatCount('3','child-seat-count')` | 返回 `3` |
| UT-BODY-07 | `seatCount('6',...)`/`'-1'`/`'2.5'` | 抛 `PARAM_INVALID`（整数 0–5 越界） |
| UT-BODY-08 | `positiveInt('1','page')` | 返回 `'1'`（canonical 串） |
| UT-BODY-09 | `positiveInt('0',...)`/`'-2'`/`'1.5'`/`'x'` | 抛 `PARAM_INVALID`（正整数约束） |

### 4.6 verb-schema `--help --format json`（Req 7.1 / Property 7）

文件：`tests/verb-schema.test.ts`（源：`src/verb-schema.ts`）

| 用例 | 输入 | 预期 |
|---|---|---|
| UT-SCHEMA-01 | `wantsJsonSchema(['node','cli','ride-elife','quote','--help','--format','json'])` | `true` |
| UT-SCHEMA-02 | `wantsJsonSchema([...,'--format=json'])` | `true`（等号形式） |
| UT-SCHEMA-03 | `wantsJsonSchema([...,'--help'])`（裸 help） | `false`（保留文本 help，尽管 program 默认 json——默认不写入 argv） |
| UT-SCHEMA-04 | `wantsJsonSchema([...,'--help','--format','table'])` | `false` |
| UT-SCHEMA-05 | `emitSchema(quoteSchema)` 捕获 stdout | 单个 pretty JSON；`JSON.parse` 往返含 `cli/noun/verb/description/flags/response/example` |
| UT-SCHEMA-06 | 各 schema 字段对齐 | `quoteSchema.flags['pickup-lat'].required===true`；`bookSchema.flags['idempotency-key'].required===true`、`flags['price-currency'].default==='USD'`；`bookSchema.flags` **无** `payment-method-id`（Property 5）；`rideGetSchema.polling.terminal_statuses` 恰 5 个 |
| UT-SCHEMA-07 | `quote`/`list-orders` schema | 不含 `polling` 块；`get` schema 含 `polling`；`book`/`cancel` 含 `error_recovery.PARAM_IDEMPOTENCY_KEY_REQUIRED` |

### 4.7 services registry（Req 1.1/1.2）

文件：`tests/services.test.ts`（源：`src/services/registry.ts`）

| 用例 | 输入 | 预期 |
|---|---|---|
| UT-REG-01 | `findService('ride-elife')` | 返回该 capability（service_id/name/category=`ride`/provider=`elife`/cli_noun=`ride-elife`/verbs 5 个/workflow/since/discovery） |
| UT-REG-02 | `findService('nope')` | 返回 `undefined` |
| UT-REG-03 | `SERVICE_REGISTRY[0].verbs` | `['quote','book','get','cancel','list-orders']` |

### 4.8 PBT 属性测试（fast-check，Property 2 & 3）

文件：`tests/pbt.test.ts`

| 用例 | 生成器 | 不变量 |
|---|---|---|
| PBT-IDEM-01 | 任意 `[A-Za-z0-9_-]` 串，长度 1–128（1000 轮） | `normalizeIdempotencyKey(s)===s.trim()`（全部接受） |
| PBT-IDEM-02 | 任意含越界字符（空格/`!`/`@`/中文/emoji）或长度 0 或 >128 的串 | `normalizeIdempotencyKey` 必抛 `PARAM_INVALID`（全部拒绝） |
| PBT-IDEM-03 | 任意串 + yes=true | `resolveIdempotencyKey(undefined,{yes:true,...})` 恒抛 `IdempotencyKeyRequiredError`，永不返回自动生成键 |
| PBT-WATCH-01 | 任意状态序列（含/不含终态，随机长度） + 任意 interval/timeout（interval>0,timeout>0），假时钟 | `runWatch` 必终止（不挂起）；写行数有限 |
| PBT-WATCH-02 | 任意**不含**终态的状态序列 + 假时钟推进 | 最终必输出 `watch_status:'timeout'` 末行，且仅末行是 timeout 行 |
| PBT-WATCH-03 | 任意以终态结尾的序列 | 命中终态即停（终态后不再 `fetchStatus`/`writeLine`）；无 timeout 行 |
| PBT-WATCH-04 | 任意写出的 NDJSON 行 | 每行 `JSON.parse` 成功且为单行（不含未转义换行） |

```typescript
import fc from 'fast-check';
import { normalizeIdempotencyKey } from '../src/idempotency';

it('accepts any [A-Za-z0-9_-]{1,128}', () => {
  fc.assert(fc.property(
    fc.stringMatching(/^[A-Za-z0-9_-]{1,128}$/),
    (s) => normalizeIdempotencyKey(s) === s,
  ));
});
```

---

## 5. L3 命令级测试用例（每条命令逐个）

> 每条命令一节，结构统一：**用例表**（正/负/边界，作 mock `ApiClient` 集成断言）+ **执行步骤**（可复制命令，作 L4 手动 E2E）。
> mock 粒度（tasks 6.2–6.4）：mock `ApiClient`（拦截 `get`/`post` 返回预设 `{success,data}` 或 `{success:false,...}`），**不** mock commander（真实 `parseAsync`）；用 `vi.spyOn(process.stdout/stderr,'write')` 分离两条流。
> 约定变量：`$API_KEY`（merchant scope）、`$QUOTE_ID`（quote 产出）、`$RIDE_ID`（book 产出，= `ride_id`）在前序步骤产生并复用。

### 5.1 `services list`（R，内置注册表，无网络，无 idem）

对应：Req 1.1, 1.3, 5.1；cli-design §4.4.1.1。

| 用例 | 场景 | 输入 | 预期 |
|---|---|---|---|
| TC-SVC-LST-01 | 正常列出 | `services list` | data=`{ services:[ServiceListItem] }`，每项含 `service_id`/`name`/`category`/`provider`/`cli_noun`/`version`/`verbs`/`since`/`discovery`；退出 0 |
| TC-SVC-LST-02 | 无网络 | 抓包 | **不发起任何 HTTP**（数据源是内置 registry，D4） |
| TC-SVC-LST-03 | 无 idem flag | `services list --idempotency-key k` | commander 拒绝未知选项（只读不接受 idem）；非 0 |
| TC-SVC-LST-04 | json 信封 | `--format json` 管道 `jq .` | 解析成功；stdout 含 `services` + `profile`/`endpoint`；stderr 静默 |
| TC-SVC-LST-05 | table 摘要 | `--format table` | stdout 表头 `Service ID/Name/Category/Provider/Version/Verbs` + 一行 `ride-elife`；状态行（若有）走 stderr |
| TC-SVC-LST-06 | 列表精简 | json | list item **不含** `verb_descriptions`/`workflow`（那是 get 的全量字段） |

```bash
agenzo-merchant-cli services list --format json 1>out.json 2>err.txt
echo "exit=$?"; jq -e '.services | type=="array"' out.json
jq -e '.services[0].service_id=="ride-elife"' out.json
test ! -s err.txt && echo "stderr clean"   # json 模式 stderr 静默
```

### 5.2 `services get <service-id>`（R，内置注册表，无网络）

对应：Req 1.2, 1.3, 5.1；cli-design §4.4.1.2。

| 用例 | 场景 | 输入 | 预期 |
|---|---|---|---|
| TC-SVC-GET-01 | 命中 | `services get ride-elife` | data=完整 `ServiceCapability`（含 `verb_descriptions`/`workflow`/`discovery`）；退出 0 |
| TC-SVC-GET-02 | 未命中 | `services get nope` | 抛 `CliError('SERVICE_NOT_FOUND')`（code_num 4101，exit 1）；message 提示 `Run "services list"` |
| TC-SVC-GET-03 | 缺位置参数 | `services get` | commander 报缺 `<service-id>`；非 0 |
| TC-SVC-GET-04 | table 全量 | `services get ride-elife --format table` | stdout keyValue 含 `Workflow`/`Verb descriptions:` 块；退出 0 |
| TC-SVC-GET-05 | json 信封 | `--format json` | stdout 含 capability + `profile`/`endpoint`；stderr 静默 |

```bash
agenzo-merchant-cli services get ride-elife --format json | jq '{service_id,verbs,workflow}'
agenzo-merchant-cli services get nope 2>&1; echo "exit=$?"   # 期望 1（SERVICE_NOT_FOUND）
```

### 5.3 `ride-elife quote`（R，`POST /ride/quote`，无 idem）

对应：Req 2.1, 5.1, 7.1；cli-design §4.4.1.3 quote schema。

| 用例 | 场景 | 输入 | 预期 |
|---|---|---|---|
| TC-QUOTE-01 | 正常报价 | 全必填 + `--pickup-time now` | `POST /ride/quote`（`X-Api-Key`）；body `pickup{lat,lng,name}`/`dropoff{...}`/`pickup_time:'now'`；data=`QuoteResponse`（`vehicle_classes[]`+`meet_and_greet`+`is_airport_transfer`）；退出 0 |
| TC-QUOTE-02 | 坐标 number 化 | `--pickup-lat 37.79` | body.pickup.lat **=== number** `37.79`（非字符串）（§4.4.1.3） |
| TC-QUOTE-03 | epoch pickup-time | `--pickup-time 1735689600` | body.pickup_time === number `1735689600` |
| TC-QUOTE-04 | 缺必填 | 缺 `--dropoff-name` | 抛 `PARAM_INVALID`（`Missing required --dropoff-name.`）；**不发请求**；退出 1 |
| TC-QUOTE-05 | 非数坐标 | `--pickup-lat abc` | 抛 `PARAM_INVALID`（`must be a number`）；退出 1 |
| TC-QUOTE-06 | 可选字段条件组装 | 带 `--passenger-count 2 --luggage-count 1` | body 含 `passenger_count:2`/`luggage_count:1`（number 化）；省略时 body 无对应键 |
| TC-QUOTE-07 | 金额单位 | json | `vehicle_classes[].price.amount` 为 decimal 货币单位（**非 cents**），原样透传 |
| TC-QUOTE-08 | api-key 401 | post 返回 401 | 抛 `CliError`（`fromApi(...,{auth:'api-key'})`）code=`KEY_INVALID`；退出 3 |
| TC-QUOTE-09 | json stderr 静默 | `--format json 1>out 2>err` | `Fetching quotes...` 进度行（`notify('loading')`）**不**出现在 stderr；stdout 仅 payload+信封 |
| TC-QUOTE-10 | table 进度行 | `--format table` | stderr 含 `Fetching quotes...` 状态行；stdout 为 vehicle 表 + 信息块 |

```bash
agenzo-merchant-cli ride-elife quote --api-key "$API_KEY" \
  --pickup-lat 37.7937 --pickup-lng -122.3956 --pickup-name "1 Market St" \
  --dropoff-lat 37.6213 --dropoff-lng -122.3790 --dropoff-name "SFO Airport" \
  --pickup-time now --format json 1>q.json 2>err.txt
echo "exit=$?"; QUOTE_ID=$(jq -r '.vehicle_classes[0].price.quote_id' q.json); echo "$QUOTE_ID"
```

### 5.4 `ride-elife book`（W/Y，`POST /ride/book`，[idem]）

对应：Req 2.2, 2.3, 2.4, 2.5, 5.1, 5.3, 7.1；cli-design §4.4.1.3 book schema + §4.4.2.1。【Property 5】

| 用例 | 场景 | 输入 | 预期 |
|---|---|---|---|
| TC-BOOK-01 | 正常下单（--yes） | `--yes` + 必填 + `--idempotency-key k` | `POST /ride/book`（`X-Api-Key` + 头 `Idempotency-Key:k`）；body `quote_id`/`vehicle_class`/`price_amount`(num)/`price_currency`/`passenger_name`/`passenger_phone`；data=`BookResponse`；退出 0；记录 `$RIDE_ID` |
| TC-BOOK-02 | **无 payment_method_id**（Property 5） | 任意 book 调用 | body **绝不含** `payment_method_id` 或任何卡字段；至多含可选 `payment_order_id` |
| TC-BOOK-03 | pay_per_call | `--payment-order-id po_1` | body.payment_order_id===`'po_1'`；省略时 body 无该键（monthly_settlement） |
| TC-BOOK-04 | price-currency 默认 | 不传 `--price-currency` | body.price_currency===`'USD'` |
| TC-BOOK-05 | 价格 number 化 | `--price-amount 42.50` | body.price_amount === number `42.5`（decimal，非 cents） |
| TC-BOOK-06 | 缺必填 | 缺 `--passenger-phone` | 抛 `PARAM_INVALID`；不发请求；退出 1 |
| TC-BOOK-07 | 座椅越界 | `--child-seat-count 6` | 抛 `PARAM_INVALID`（整数 0–5）；退出 1 |
| TC-BOOK-08 | pickup 组条件装配 | 任一 `--pickup-{lat/lng/name}` 出现 | body.pickup 三字段齐全（缺 name→`PARAM_INVALID`）；全不传则 body 无 pickup |
| TC-BOOK-09 | 航班组装配 | `--arrival-flight-no AA1 --arrival-airline AA` | body.arrival_flight={flight_no,airline} |
| TC-BOOK-10 | 非 --yes confirm | 非 `--yes`（mock confirm=true） | 弹 `Book ride with quote <id>?`（default true）→ 确认后下单；退出 0 |
| TC-BOOK-11 | confirm 拒绝 | 非 `--yes`（confirm=false） | 抛 `CliError('CLIENT_ABORTED')`；**不发请求**；退出 5 |
| TC-BOOK-12 | --yes 缺幂等键 | `--yes`（无 `--idempotency-key`） | 抛 `PARAM_IDEMPOTENCY_KEY_REQUIRED`；**不发请求**；退出 1 |
| TC-BOOK-13 | 非法幂等键 | `--idempotency-key "bad!"` | 抛 `PARAM_INVALID`（归一拦截）；不发请求；退出 1 |
| TC-BOOK-14 | 幂等键作头不进 body | `--idempotency-key k` | HTTP 头 `Idempotency-Key:k`；body **无** `idempotency_key`/任何幂等字段 |
| TC-BOOK-15 | ride 字符串码保真（D3） | post 返回 `{code:'QUOTE_EXPIRED'}` HTTP 410 | 经 `fromApi` 保真 `QUOTE_EXPIRED`（code_num 4202，exit 1），不被 410→PARAM_INVALID 覆盖 |
| TC-BOOK-16 | billing 错误 | post 返回 `BILLING_MODE_MISMATCH` | code 保真（3001，exit 1） |
| TC-BOOK-17 | json stderr 静默 | `--yes ... --format json 1>out 2>err` | `Booking ride...` 不在 stderr；stdout 仅 `BookResponse`+信封 |

```bash
agenzo-merchant-cli ride-elife book --api-key "$API_KEY" --yes \
  --quote-id "$QUOTE_ID" --vehicle-class Sedan --price-amount 42.50 \
  --passenger-name "Alice" --passenger-phone "+14155551234" \
  --idempotency-key "book-$(date +%s)" --format json 1>b.json 2>err.txt
echo "exit=$?"; RIDE_ID=$(jq -r '.ride_id' b.json); echo "$RIDE_ID"
# TC-BOOK-12 --yes 缺幂等键
agenzo-merchant-cli ride-elife book --api-key "$API_KEY" --yes \
  --quote-id "$QUOTE_ID" --vehicle-class Sedan --price-amount 42.50 \
  --passenger-name A --passenger-phone "+1415" 2>&1; echo "exit=$?"   # 期望 1
```

### 5.5 `ride-elife get`（R，`GET /ride/<id>/status`；`--watch` → NDJSON）

对应：Req 3.1, 3.2, 5.1, 7.1；cli-design §4.4.1.3 get schema。【Property 2】

| 用例 | 场景 | 输入 | 预期 |
|---|---|---|---|
| TC-GET-01 | 单次查询 | `get --order-id $RIDE_ID`（无 watch） | `GET /ride/<id>/status`（id 经 `encodeURIComponent`）；data=`GetOrderResponse`；`CommandResult`+renderWithContext；退出 0 |
| TC-GET-02 | 字段保真 | json | pickup/dropoff 为 `from_location`/`to_location`（**v3 snake_case**，非 elife `from`/`to`）；含 `source` 标记；金额 decimal |
| TC-GET-03 | 缺 order-id | `get`（无 `--order-id`） | 抛 `PARAM_INVALID`；退出 1 |
| TC-GET-04 | 404 透传 | get 返回 `VEHICLE_UNAVAILABLE`/404 | code 保真/映射；退出 1 |
| TC-GET-05 | api-key 403 | get 返回 403 | code=`KEY_SCOPE_DENIED`；退出 3 |
| TC-GET-06 | watch 终态停止 | `--watch`（mock 序列 `Pending`→`At destination`，缩短 interval） | stdout 2 行 NDJSON，每行独立 `jq` 可解析；末行 status=`At destination`；**无** timeout 行；退出 0 |
| TC-GET-07 | watch 超时末行 | `--watch --watch-timeout`（mock 恒 `Pending`，假时钟） | 末行 `{ watch_status:'timeout', message, last_status:'Pending' }`；退出 0 |
| TC-GET-08 | watch 不套信封 | `--watch --format json` | NDJSON 行**不含** `profile`/`endpoint`（line stream，逐行）；非 watch 单次则含信封 |
| TC-GET-09 | watch 无 spinner | `--watch` | 无 `notify('loading')` 进度行（流本身即进度）；stderr 不含 `Fetching ride status...` |
| TC-GET-10 | watch interval 解析 | `--watch-interval 0`（非正） | 回退默认 5s（`resolveSeconds`） |

```bash
agenzo-merchant-cli ride-elife get --api-key "$API_KEY" --order-id "$RIDE_ID" --format json | jq '{ride_id,status,from_location,to_location}'
# watch（每行独立 NDJSON）
agenzo-merchant-cli ride-elife get --api-key "$API_KEY" --order-id "$RIDE_ID" --watch --watch-interval 3 --watch-timeout 30 \
  | while read -r line; do echo "$line" | jq -e . >/dev/null && echo "valid: $(echo "$line" | jq -r '.status // .watch_status')"; done
```

### 5.6 `ride-elife cancel`（W/Y，`POST /ride/<id>/cancel`，无 body，[idem]）

对应：Req 3.3, 3.5, 5.1, 5.3, 7.1；cli-design §4.4.1.3 cancel schema。

| 用例 | 场景 | 输入 | 预期 |
|---|---|---|---|
| TC-CANCEL-01 | 正常取消（--yes） | `--yes --order-id $RIDE_ID --idempotency-key k` | `POST /ride/<id>/cancel`（**无 body**，`X-Api-Key` + 头 `Idempotency-Key:k`）；data=`CancelResponse`（`ride_id`/`ride_stat`/`cancellation{fee,reversal,currency}`/`refund_amount`）；退出 0 |
| TC-CANCEL-02 | 无 body 断言 | 任意 cancel | `apiClient.post` 第 3 参 body===`undefined`；幂等键仅在第 4 参 header |
| TC-CANCEL-03 | 缺 order-id | 无 `--order-id` | 抛 `PARAM_INVALID`；退出 1 |
| TC-CANCEL-04 | 非 --yes 确认 | 非 `--yes`（mock confirm=true） | 弹 `Cancel ride <id>? This may incur a fee.`（default **false**）→ 确认后取消；退出 0 |
| TC-CANCEL-05 | 确认拒绝 | 非 `--yes`（confirm=false） | 抛 `CliError('CLIENT_ABORTED')`；**不发请求**；退出 5 |
| TC-CANCEL-06 | --yes 缺幂等键 | `--yes`（无 `--idempotency-key`） | 抛 `PARAM_IDEMPOTENCY_KEY_REQUIRED`；不发请求；退出 1 |
| TC-CANCEL-07 | 不可取消态 | post 返回 `CANCELLATION_NOT_ALLOWED` | code 保真（4204，exit 1） |
| TC-CANCEL-08 | cancellation 可空 | 响应 `cancellation:null` | table 不渲染 fee/reversal 行；json 原样 `null`；退出 0 |
| TC-CANCEL-09 | json stderr 静默 | `--yes ... --format json` | `Cancelling ride...` 不在 stderr；stdout 仅 payload+信封 |

```bash
agenzo-merchant-cli ride-elife cancel --api-key "$API_KEY" --yes \
  --order-id "$RIDE_ID" --idempotency-key "cancel-$(date +%s)" --format json | jq '{ride_id,ride_stat,refund_amount}'
echo "exit=$?"
```

### 5.7 `ride-elife list-orders`（R，`GET /ride/orders`，query 透传）

对应：Req 3.4, 5.1, 7.1；cli-design §4.4.1.3 list-orders schema。

| 用例 | 场景 | 输入 | 预期 |
|---|---|---|---|
| TC-LIST-01 | 有数据 | `list-orders` | `GET /ride/orders` query `page=1&page_size=20`（默认）；data=`ListOrdersResponse`（`orders[]`/`total`/`page`/`page_size`）；退出 0 |
| TC-LIST-02 | 默认分页 | 不传 page/page-size | query 含 `page:'1'`/`page_size:'20'` |
| TC-LIST-03 | 过滤透传 | `--status Pending --order-type airport` | query 含 `status:'Pending'`/`order_type:'airport'`；省略时 query 无对应键 |
| TC-LIST-04 | 非法分页 | `--page 0` / `--page-size -1` / `--page x` | 抛 `PARAM_INVALID`（正整数）；不发请求；退出 1 |
| TC-LIST-05 | 空列表 | 响应 `orders:[]` | table 显示 `No ride orders found`（stderr 信息行/stdout 视实现）；json `orders:[]`；退出 0 |
| TC-LIST-06 | 金额单位 | json | `orders[].price_amount` decimal（非 cents） |
| TC-LIST-07 | json 信封 | `--format json` | stdout 含 `orders`/`total`/`page`/`page_size` + `profile`/`endpoint`；stderr 静默 |

```bash
agenzo-merchant-cli ride-elife list-orders --api-key "$API_KEY" --status Pending --page 1 --page-size 10 --format json \
  | jq '{total,page,page_size,count:(.orders|length)}'
echo "exit=$?"
```

---

## 6. 横切一致性断言（跨全部命令）

> 这些是 design「Correctness Properties」在测试层的落地核对项，由 §4/§5 用例分摊覆盖；本节集中陈述不变量，作 task 6.4 横切测试（`tests/cross-cutting.test.ts` 或并入各命令测试）的契约。

### 6.1 输出通道纯净（Property 1 / Req 5.1）

文件：`tests/cross-cutting.test.ts`

| 用例 | 输入 | 预期 |
|---|---|---|
| TC-CHAN-01 | `notify('json','loading','x')` | 不写 stderr（spy 0 次） |
| TC-CHAN-02 | `notify('table','loading','x')` | 写 stderr 1 次（状态/spinner 文案） |
| TC-CHAN-03 | 任一联网命令 `--format json` 实跑（mock 成功） | stdout 单一合法 JSON 含 `profile`+`endpoint`；stderr 不含 `✓`/`ℹ`/`⚠`/`✗` 或进度文案 |
| TC-CHAN-04 | 同命令 `--format table` | stdout 业务输出（keyValue/table）；stderr 含进度/状态行 |
| TC-CHAN-05 | watch（`--watch --format json`） | stdout 仅 NDJSON 行（无信封）；非 watch 命令才套 `profile`/`endpoint` |
| TC-CHAN-06 | 默认格式：不传 `--format`（不设 `AGENZO_FORMAT`） | 解析为 `json`（D2，program 默认值） |

### 6.2 幂等键强制（Property 3 / Req 5.3）

文件：`tests/cross-cutting.test.ts`（书 `book`/`cancel`）

| 用例 | 命令 | 输入 | 预期 |
|---|---|---|---|
| TC-IDEM-REQ-01 | `ride-elife book` | `--yes` 无 `--idempotency-key` | 抛 `IdempotencyKeyRequiredError`（`PARAM_IDEMPOTENCY_KEY_REQUIRED`）；`apiClient.post` 未被调用；退出 1 |
| TC-IDEM-REQ-02 | `ride-elife cancel` | `--yes` 无 `--idempotency-key` | 同上 |
| TC-IDEM-REQ-03 | `book` / `cancel` | 传合法键 | 头 `Idempotency-Key:<值>`；body 无幂等字段；CLI 不自动生成 |
| TC-IDEM-REQ-04 | 只读命令 | `quote`/`get`/`list-orders`/`services *` | 不声明 `--idempotency-key`（commander 拒绝该 flag） |
| TC-IDEM-REQ-05 | 键格式 | 非法/越界键 | `normalizeIdempotencyKey` 抛 `PARAM_INVALID`（与 §4.1/PBT-IDEM-02 一致） |

### 6.3 错误码归并 + 退出码（Property 4 / Req 5.2, 5.4）

文件：`tests/cross-cutting.test.ts`

| 用例 | 输入 | 预期 code | 预期 exitCode |
|---|---|---|---|
| TC-ERR-01 | `fromApi({statusCode:401},{auth:'api-key'})` | `KEY_INVALID` | 3 |
| TC-ERR-02 | `fromApi({statusCode:403},{auth:'api-key'})` | `KEY_SCOPE_DENIED` | 3 |
| TC-ERR-03 | `fromApi({code:'QUOTE_EXPIRED',statusCode:410})` | `QUOTE_EXPIRED`（字符串码优先，D3；code_num 4202） | 1 |
| TC-ERR-04 | `fromApi({code:'VEHICLE_UNAVAILABLE',statusCode:404})` | `VEHICLE_UNAVAILABLE`（4201） | 1 |
| TC-ERR-05 | `fromApi({code:'BILLING_MODE_MISMATCH'})` | `BILLING_MODE_MISMATCH`（3001） | 1 |
| TC-ERR-06 | `fromApi({code:'PAYMENT_ORDER_NOT_PAID'})` | `PAYMENT_ORDER_NOT_PAID`（3202） | 1 |
| TC-ERR-07 | `fromApi({code:'ACCOUNT_INSUFFICIENT_BALANCE'})` | `ACCOUNT_INSUFFICIENT_BALANCE`（3103） | 1 |
| TC-ERR-08 | `CliError('SERVICE_NOT_FOUND')` | `SERVICE_NOT_FOUND`（4101） | 1 |
| TC-ERR-09 | `CliError('PARAM_INVALID')` / `PARAM_IDEMPOTENCY_KEY_REQUIRED` | 同输入（2xxx） | 1 |
| TC-ERR-10 | `fromApi({statusCode:429})` | `RATE_LIMITED`（5001） | 4 |
| TC-ERR-11 | `fromApi({statusCode:500})` / `NetworkError` | `INTERNAL_ERROR`/`UPSTREAM_ERROR` | 4 |
| TC-ERR-12 | `UserCancelError`（SIGINT / confirm 拒绝） | `CLIENT_ABORTED` | 5 |
| TC-ERR-13 | `UpgradeRequiredError` | `UPGRADE_REQUIRED` | 2 |
| TC-ERR-14 | 任一失败 `--format json` | stderr 仅 `{ error:{ code, code_num, message, request_id? } }`（§8.2）；stdout 空（无半个 payload） | 按矩阵 |
| TC-ERR-15 | 同失败 `--format table` | stderr `✗ [<code_num>] <message>`；`request_id` 仅 HTTP 来源时存在 | 按矩阵 |

> 对外码恒 ∈ cli-core `error-catalog`；退出码恒由 `exitCodeFor` 映射（与 §1.1.5 / §3.5 一致）。D3 字符串码保真的前提（v3 ride 错误响应是否带字符串 `error.code`）需 §7 E2E 阶段 curl 实测确认。

### 6.4 复用 cli-core（无重复实现，Property 6 / Req 4.1, 4.3）

文件：`tests/cross-cutting.test.ts`（静态/结构断言）

| 用例 | 断言 |
|---|---|
| TC-CORE-01 | `src/` 下**不存在** `core/`（无本地 api-client/config-manager/errors/formatter/output/prompt-engine/version 副本）；上述符号均自 `@agenzo/cli-core` import |
| TC-CORE-02 | `src/**` 无 `import ... from '../admin-cli'`/`token-cli`/`payment-cli`（不 import 任何其它 app） |
| TC-CORE-03 | ride/service 响应类型（`QuoteResponse`/`BookResponse`/... ）import 自 `@agenzo/cli-core`，app 内不重复定义 |
| TC-CORE-04 | 商户域件（`watch.ts`/`verb-schema.ts`/`services/registry.ts`/`idempotency.ts` 的 resolve/normalize）留在 app 内（未下沉 cli-core） |

---

## 7. L4 命令级冒烟（E2E，手动可执行）+ 逐字对齐核对（Diff Review）

### 7.1 E2E 执行顺序（建议一次性走通）

需真实 merchant-scope key（`$API_KEY`）。按业务依赖链执行，每步 `echo $?` 校验退出码：

```text
services list → services get ride-elife
  → ride-elife quote（产出 $QUOTE_ID）
  → ride-elife book --yes --idempotency-key …（产出 $RIDE_ID）
  → ride-elife get --order-id $RIDE_ID
  → ride-elife get --order-id $RIDE_ID --watch（观察 NDJSON / 终态 / 超时末行）
  → ride-elife list-orders
  → ride-elife cancel --order-id $RIDE_ID --yes --idempotency-key …
```

每条写命令补一条「`--yes` 缺 `--idempotency-key`」用例确认本地拦截（exit 1、不发请求），一条 `--format table` 用例确认状态行走 stderr。

### 7.2 curl 确认 D3（错误码保真前提）

```bash
# 触发一个 ride 业务错误（如过期 quote 再 book），确认 v3 错误响应是否带字符串 error.code
curl -s -X POST "$HOST/api/v3/agent-pay/ride/book" -H "X-Api-Key: $API_KEY" \
  -H 'Content-Type: application/json' -d '{"quote_id":"expired",...}' | jq '.code, .message, .data'
```

- 若响应带字符串码（如 `QUOTE_EXPIRED`）→ D3 保真生效（§6.3 TC-ERR-03/04 端到端成立）。
- 若仅返数字码/HTTP status → ride 专有码保真需后端补 `error.code`（§7.7.3 BACK-021），CLI 侧暂回退 HTTP-status 映射。

### 7.3 逐字对齐核对清单（Diff Review，Property 7 / Req 7.1）

代码走查逐项核对（与 cli-design §4.4 + 现有 `merchant-cli/src/` 对照）：

| 核对项 | 断言 |
|---|---|
| DIFF-01 | noun 名为 `ride-elife`（非 `ride`）；services group 为 `services` |
| DIFF-02 | HTTP method+path：quote=`POST /ride/quote`、book=`POST /ride/book`、get=`GET /ride/<id>/status`、cancel=`POST /ride/<id>/cancel`（无 body）、list-orders=`GET /ride/orders`；base `/api/v3/agent-pay` |
| DIFF-03 | 鉴权全部 `X-Api-Key`（`{type:'api-key'}`）；无 Bearer/keystore |
| DIFF-04 | 金额为 decimal 货币单位（非 cents）——quote/book/get/list-orders/cancel 全链 |
| DIFF-05 | get 字段 `from_location`/`to_location`（v3 snake_case，非 elife `from`/`to`）+ `source` 标记 |
| DIFF-06 | book body 无 `payment_method_id`/卡字段，至多可选 `payment_order_id`（Property 5） |
| DIFF-07 | watch 终态集合 5 个（大小写敏感）；默认 interval 5s / timeout 600s；超时末行 `watch_status:'timeout'`；NDJSON 不套信封 |
| DIFF-08 | book/cancel 各 flags 全集与 verb-schema 一致；`--idempotency-key` 为 header 透传不进 body |
| DIFF-09 | services list 字段子集 / get 全量（含 `verb_descriptions`/`workflow`/`discovery`）；未命中 `SERVICE_NOT_FOUND` |
| DIFF-10 | 成功路径 stdout 文案/字段与现有实现等价（迁移不改成功路径输出；仅错误路径统一改走 cli-core 信封） |

---

## 8. 覆盖矩阵（命令 × 需求/属性）

| 命令 | 主要用例 | 覆盖需求 | 覆盖属性 |
|---|---|---|---|
| services list | TC-SVC-LST-01..06 | 1.1, 1.3, 5.1 | P1 |
| services get | TC-SVC-GET-01..05 | 1.2, 1.3, 5.1 | P1, P4 |
| ride-elife quote | TC-QUOTE-01..10 | 2.1, 5.1, 7.1 | P1, P4, P7 |
| ride-elife book | TC-BOOK-01..17 | 2.2, 2.3, 2.4, 2.5, 5.1, 5.3, 7.1 | P1, P3, P4, P5, P7 |
| ride-elife get (+watch) | TC-GET-01..10 | 3.1, 3.2, 5.1, 7.1 | P1, P2, P4, P7 |
| ride-elife cancel | TC-CANCEL-01..09 | 3.3, 3.5, 5.1, 5.3, 7.1 | P1, P3, P4, P7 |
| ride-elife list-orders | TC-LIST-01..07 | 3.4, 5.1, 7.1 | P1, P4, P7 |
| 横切（输出通道） | TC-CHAN-01..06 | 5.1 | P1 |
| 横切（幂等强制） | TC-IDEM-REQ-01..05、UT-IDEM-01..15、PBT-IDEM-01..03 | 5.3 | P3 |
| 横切（错误/退出码） | TC-ERR-01..15 | 5.2, 5.4 | P4 |
| 横切（复用 cli-core） | TC-CORE-01..04 | 4.1, 4.3 | P6 |
| watch 引擎 | UT-WATCH-01..17、PBT-WATCH-01..04 | 3.2 | P2 |
| verb-schema/help | UT-SCHEMA-01..07 | 7.1 | P5*, P7 |
| body 校验助手 | UT-BODY-01..09 | 2.1, 2.2, 3.1, 3.4 | P7 |

> 属性编号 P1–P7 对应 design.md「Correctness Properties」。退出码语义见 §3.5。`P5*`：verb-schema 的 `book` flags 无 `payment-method-id`，间接佐证 Property 5。

---

## 9. 已规划自动化测试文件映射（tasks 6.2–6.5）

| 测试文件 | 覆盖的用例/属性 | 对应 task |
|---|---|---|
| `tests/helpers.ts` | mock `ApiClient`（拦截 get/post）、captureStdout/captureStderr、buildProgram —— 共享工具（对齐 admin/token `tests/helpers.ts`） | 6.2 |
| `tests/services.test.ts` | TC-SVC-LST-01..06、TC-SVC-GET-01..05、UT-REG-01..03；输出契约（json stdout 纯净） | 6.2 |
| `tests/ride-elife.test.ts` | TC-QUOTE/BOOK/GET(非 watch)/CANCEL/LIST happy + 关键分支；UT-BODY-01..09；book 无 `payment_method_id`、confirm、坐标 number 化、字段逐字对齐 | 6.3 |
| `tests/cross-cutting.test.ts` | TC-CHAN-01..06、TC-IDEM-REQ-01..05、TC-ERR-01..15、TC-CORE-01..04（输出通道/幂等必传/错误映射/复用 cli-core） | 6.4 |
| `tests/idempotency.test.ts` | UT-IDEM-01..15 | 6.4/6.5 |
| `tests/watch.test.ts` | UT-WATCH-01..17（含假时钟 `runWatch`） | 6.5 |
| `tests/verb-schema.test.ts` | UT-SCHEMA-01..07 | 6.3 |
| `tests/pbt.test.ts` | PBT-IDEM-01..03、PBT-WATCH-01..04（fast-check） | 6.5 |

> 运行 PBT 时在 `execute-bash` 的 warning 字段传 `LongRunningPBT`。L3 命令集成 mock `ApiClient`、真实 `parseAsync`；L4 E2E（§7）需真实 merchant-scope key，手动复现，不纳入 `vitest run`。

---

## 10. 未覆盖项与后续计划

| 项 | 说明 | 优先级 |
|---|---|---|
| 交互模式 prompt 补输（api-key / 幂等键） | 需 stdin/TTY 模拟（commander 真实 parse 下挂起） | P3（§7 手动 E2E 覆盖） |
| D3 ride 字符串码端到端保真 | 依赖 curl 确认 v3 错误响应是否带 `error.code`（§7.2） | P1（接后端时确认） |
| 后端 `/services` discovery endpoint | BACK-063 pending impl；本期读内置 registry | 范围外 |
| `ride-elife track` | D5 pending impl；`get --watch` 覆盖订单状态轮询诉求 | 范围外 |
| ride 第二阶段（payment-order-id 反查 / 月结扣减） | CLI 仅透传可选 `--payment-order-id`，服务端逻辑属后端 | 范围外 |
