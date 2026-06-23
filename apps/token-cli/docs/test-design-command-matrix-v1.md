# agenzo-token-cli 测试设计文档（Test Design）

> 本文档为 `agenzo-token-cli` 的测试设计，对齐 spec（`requirements.md` / `design.md` / `tasks.md`）与 `doc/architecture-upgrade/v1/cli-design.md` §3（命令字段级规范）。
> 范围 = **8 条命令矩阵** + 7 项横切一致性约束（输出格式 / 退出码 / 错误信封 / 幂等键 / 输出通道纯净 / type 映射 / get-create 差异保留）。
> 权威顺序：cli-standard.md > cli-design.md §3 > design.md。
> 仓库：`agenzo-cli/apps/token-cli`（binary `agenzo-token-cli`），TypeScript + commander@14 + vitest + tsup。

---

## 1. 测试目标与范围

### 1.1 目标

1. 验证 8 条命令的输入/输出/HTTP 行为与 cli-design §3.4 字段级规范逐字一致。
2. 验证 API Key 鉴权（`X-Api-Key`）在全部 8 条命令上正确携带。
3. 验证 `--idempotency-key` 在 4 条写命令上必传（`--yes` 缺失→`PARAM_IDEMPOTENCY_KEY_REQUIRED`/exit 1 且不发请求）。
4. 验证 `--format json` 模式 stdout 仅含合法 JSON（含 profile/endpoint 信封），stderr 完全静默；`--format table` 模式状态行走 stderr。
5. 验证错误码归并（对外码 ∈ §8 catalog）与退出码映射（KEY_*→3、TOKEN_*/CLIENT_*/PARAM_*→1、UPSTREAM_/INTERNAL_/RATE_LIMITED→4、CLIENT_ABORTED→5）。
6. 验证 `payment-tokens create` 的复合逻辑：type 映射、支付方式解析优先级、VCN 金额无浮点漂移、三类型分支。
7. 验证 `payment-tokens get` 与 `create` 的 keyValue 差异逐字保留（Property 7）。

### 1.2 范围内（In Scope）

- 8 条命令：`payment-methods add/list/get/disable` + `payment-tokens create/list/get/revoke`。
- 全局 flag：`--format`（json/table，默认 table）、`--yes`、`--verbose`。
- API Key 鉴权模型（`--api-key` → `X-Api-Key` header）。
- `CliError.fromApi` 的 `{auth:'api-key'}` 参数化（401→KEY_INVALID、403→KEY_SCOPE_DENIED）。
- `renderWithContext`（profile/endpoint 信封，BACK-011）。
- 3DS 轮询（payment-methods add）。
- VCN fee 计算（string→cents 无浮点）。
- Network-token fee fallback。
- X402 USDC 计算。
- 支付方式解析四级优先级。
- `formatPaymentToken`（create）vs `formatPaymentTokenGet`（get）差异保留。

### 1.3 范围外（Out of Scope）

- admin-cli 的 auth/config/orgs/developers/keys/accounts 命令（属 §2）。
- merchant-cli / payment-cli（属 §4/§5）。
- 后端 API 的实际去重行为（仅验证 CLI 侧 header 透传，不验服务端幂等落地）。
- 后端 3DS 邮件发送行为（CLI 侧仅验证轮询逻辑）。
- CLI 的 OS keychain / credential store（token-cli 无 Bearer 凭证）。

---

## 2. 测试分层策略

| 层级 | 工具 | 是否需网络 | 覆盖对象 | 优先级 |
|---|---|---|---|---|
| L1 单元测试（Unit） | vitest，纯函数 | 否 | `usdToCents` / `mapTokenType` / `resolvePaymentMethod` / `formatPaymentToken` / `formatPaymentTokenGet` / `getSummary` | P0（必做） |
| L2 属性测试（PBT） | vitest + fast-check | 否 | 金额无浮点漂移 / type 映射全域 / 退出码映射域 | P0（必做） |
| L3 命令集成（CLI mock） | vitest + mock ApiClient | 否 | 8 条命令 happy path + 关键分支 | P0（必做） |
| L4 命令冒烟（CLI E2E） | 编译产物 + 真实 testing host | 是 | 8 条命令端到端 | P1（手动） |
| L5 横切一致性 | vitest + capture stdout/stderr | 否 | 幂等键/输出通道/错误码/get-create 差异 | P0（必做） |

---

## 3. 测试环境与前置准备

### 3.1 构建

```bash
npm install
npm run build -w @agenzo/cli-core   # 必须先 build cli-core
npm run build -w @agenzo/token-cli
npm test                             # vitest run (全量)
```

### 3.2 后端环境（L4 手动测试用）

- testing host：`https://agent-test.everonet.com`
- API path：`/api/v3/agent-pay`
- 需要一个有效的 API Key（由 `agenzo-admin-cli keys create` 签发）

### 3.3 通用断言工具

- JSON 校验：`agenzo-token-cli <cmd> --format json | jq .` 必须成功解析。
- 退出码：`echo $?`。
- stdout/stderr 分离：`1>out.txt 2>err.txt`。
- json 模式 stderr 静默：`err.txt` 不含 `✓`/`ℹ`/`⚠`/`✗` 图标。

---

## 4. L1/L2 单元测试与属性测试（自动化 / vitest）

### 4.1 `usdToCents` — VCN 金额字符串→cents 无浮点漂移（Property 1 / Req 3.3）

文件：`tests/pbt-amount.test.ts`

| 用例 | 输入 | 预期 |
|---|---|---|
| PBT-AMT-01 | 任意合法金额 ∈ [0.01, 500.00]（1000 轮） | `usdToCents(a) === 精确 cents`（字符串拆分计算） |
| PBT-AMT-02 | 同上 | `usdToCents(a) === Math.round(parseFloat(a)*100)`（证明一致性） |
| UT-AMT-03 | `"1.005"`（3 位小数） | 抛 PARAM_INVALID |
| UT-AMT-04 | `"0.01"` | 返回 1 |
| UT-AMT-05 | `"500.00"` | 返回 50000 |
| UT-AMT-06 | `"1"` | 返回 100 |
| UT-AMT-07 | `"100"` | 返回 10000 |
| UT-AMT-08 | `"0.10"`（float: 10.000000000000002） | 返回 10 |
| UT-AMT-09 | `"0.29"`（float: 28.999999999999996） | 返回 29 |
| UT-AMT-10 | `"1.1"`（单位小数，padEnd→"10"） | 返回 110 |

### 4.2 `mapTokenType` — type 映射稳定（Property 2 / Req 3.1）

文件：`tests/pbt-type-and-resolve.test.ts`

| 用例 | 输入 | 预期 |
|---|---|---|
| UT-TYPE-01 | `"vcn"` | `"vcn"` |
| UT-TYPE-02 | `"network-token"` | `"network_token"` |
| UT-TYPE-03 | `"x402"` | `"x402"` |
| PBT-TYPE-04 | 任意非 `"network-token"` 字符串（200 轮） | 原值透传 |
| PBT-TYPE-05 | 已知三组映射随机抽样（50 轮） | 始终正确 |

### 4.3 `resolvePaymentMethod` — 支付方式解析优先级（Property 3 / Req 3.2）

文件：`tests/pbt-type-and-resolve.test.ts`

| 用例 | 输入 | 预期 |
|---|---|---|
| UT-RES-01 | `--payment-method-id=pm_x` + 多卡 | 返回 `pm_x`，API 不被调用 |
| UT-RES-02 | `--card=5678` + ACTIVE 卡含 last4=5678 | 返回对应 pm_id |
| UT-RES-03 | `--card=9999` + 无匹配 | 抛 `CLIENT_CARD_NOT_MATCHED` |
| UT-RES-04 | 无 flag + 零 ACTIVE 卡 | 抛 `CLIENT_NO_PAYMENT_METHOD` |
| UT-RES-05 | 无 flag + 空卡列表 | 抛 `CLIENT_NO_PAYMENT_METHOD` |
| UT-RES-06 | 无 flag + 单 ACTIVE 卡 | 自动选该卡 |
| UT-RES-07 | 无 flag + 多 ACTIVE 卡 + `--yes` | 抛 `PARAM_INVALID`（不能 prompt） |
| UT-RES-08 | 只看 ACTIVE 卡（过滤 PENDING/DISABLED） | 正确过滤 |
| UT-RES-09 | `--card` 精确匹配 last4 | 精确匹配 |
| UT-RES-10 | 错误是 CliError 实例 | instanceof 断言 |

### 4.4 幂等键强制（Property 4 / Req 6.3）

文件：`tests/properties.test.ts`

| 用例 | 命令 | 输入 | 预期 |
|---|---|---|---|
| UT-IDEM-01 | `payment-methods disable` | `--yes` 无 `--idempotency-key` | 抛 IdempotencyKeyRequiredError；post 未调用 |
| UT-IDEM-02 | `payment-methods add` | `--yes` 无 `--idempotency-key` | 抛 IdempotencyKeyRequiredError；post 未调用 |
| UT-IDEM-03 | `payment-tokens create` | `--yes` 无 `--idempotency-key` | 抛 IdempotencyKeyRequiredError；post 未调用 |
| UT-IDEM-04 | `payment-tokens revoke` | `--yes` 无 `--idempotency-key` | 抛 IdempotencyKeyRequiredError；post 未调用 |
| UT-IDEM-05 | IdempotencyKeyRequiredError 构造 | `new IdempotencyKeyRequiredError('cmd')` | code=`PARAM_IDEMPOTENCY_KEY_REQUIRED`，message 含 `--idempotency-key` |

### 4.5 输出通道纯净（Property 5 / Req 6.1）

文件：`tests/properties.test.ts`

| 用例 | 输入 | 预期 |
|---|---|---|
| UT-CHAN-01 | `notify('json','success','x')` | stderr 不被写入 |
| UT-CHAN-02 | `notify('table','success','x')` | stderr 写 1 次含 `✓` |
| UT-CHAN-03 | `notify('json','info','x')` | 静默 |
| UT-CHAN-04 | `notify('table','info','x')` | stderr 含 `ℹ` |
| UT-CHAN-05 | `payment-methods disable --format json` | stdout 是合法 JSON 含 profile/endpoint；stderr 空 |
| UT-CHAN-06 | `payment-methods disable --format table` | stdout 含 keyValue；stderr 含 `✓` 状态行 |

### 4.6 错误码归并 + 退出码（Property 6 / Req 6.2）

文件：`tests/properties.test.ts`

| 用例 | 输入 | 预期 code | 预期 exitCode |
|---|---|---|---|
| UT-ERR-01 | `fromApi({statusCode:401}, {auth:'api-key'})` | KEY_INVALID | 3 |
| UT-ERR-02 | `fromApi({statusCode:403}, {auth:'api-key'})` | KEY_SCOPE_DENIED | 3 |
| UT-ERR-03 | `fromApi({statusCode:404})` | RESOURCE_NOT_FOUND | 1 |
| UT-ERR-04 | `fromApi({statusCode:429})` | RATE_LIMITED | 4 |
| UT-ERR-05 | `fromApi({statusCode:500})` | INTERNAL_ERROR | 4 |
| UT-ERR-06 | `CliError('TOKEN_FEATURE_DISABLED')` | TOKEN_FEATURE_DISABLED | 1 |
| UT-ERR-07 | `CliError('CLIENT_NO_PAYMENT_METHOD')` | CLIENT_NO_PAYMENT_METHOD | 1 |
| UT-ERR-08 | `CliError('CLIENT_CARD_NOT_MATCHED')` | CLIENT_CARD_NOT_MATCHED | 1 |
| UT-ERR-09 | `CliError('PARAM_IDEMPOTENCY_KEY_REQUIRED')` | PARAM_IDEMPOTENCY_KEY_REQUIRED | 1 |
| UT-ERR-10 | `UserCancelError()` | CLIENT_ABORTED | 5 |
| UT-ERR-11 | `CliError('UPGRADE_REQUIRED')` | UPGRADE_REQUIRED | 2 |
| UT-ERR-12 | `CliError('UPSTREAM_ERROR')` | UPSTREAM_ERROR | 4 |
| UT-ERR-13 | 全部 token-cli 错误码 | `toErrorEnvelope` 产出 code_num > 0 且 message 非空 | — |

### 4.7 get-create 逐字对齐（Property 7 / Req 4.2）

文件：`tests/properties.test.ts`

| 用例 | 断言 |
|---|---|
| UT-DIFF-01 | `formatPaymentToken`(VCN) 含 `Payment Token ID`；`formatPaymentTokenGet`(VCN) 含 `Token ID`，不含 `Payment Token ID` |
| UT-DIFF-02 | get 含 `Last 4` 行；create 不含 |
| UT-DIFF-03 | create Limit 行含 `$`；get Limit 行不含 `$` |
| UT-DIFF-04 | get 含 `Balance` 行；create 不含 |
| UT-DIFF-05 | network_token：create 用 `Payment Token ID`，get 用 `Token ID` |
| UT-DIFF-06 | x402：同上 ID 差异 |

---

## 5. L3 命令集成测试（vitest + mock ApiClient）

> mock 粒度：mock `ApiClient`（拦截 get/post 返回预设响应），不 mock commander（真实 parseAsync）。
> 共享工具：`tests/helpers.ts`（captureStdout / captureStderr / buildProgram / mockApiClient）。

### 5.1 `payment-methods add`（§3.4.0.1）

文件：`tests/payment-methods.test.ts`

| 用例 | 场景 | 输入 | 预期 |
|---|---|---|---|
| TC-PM-ADD-01 | 正常创建（status=ACTIVE，跳过 3DS） | 全 flag + `--idempotency-key` | POST /payment-methods/create with X-Api-Key + Idempotency-Key；stderr 含 `Payment method created` + `Complete 3DS`；stdout 含 pm_id/ACTIVE |
| TC-PM-ADD-02 | 3DS 成功（PENDING → poll → ACTIVE） | status=PENDING，poll 返回 ACTIVE | stderr 含 `Payment method activated` |
| TC-PM-ADD-03 | 3DS 失败（PENDING → poll → FAILED） | poll 返回 FAILED | stderr 含 `3DS verification failed` |
| TC-PM-ADD-04 | 3DS 超时 | poll 不终止（需 fake timer） | stderr 含 `Verification timed out (15 min)` + hint 命令 |
| TC-PM-ADD-05 | `--yes` 缺 `--idempotency-key` | 缺键 | 抛 IdempotencyKeyRequiredError；post 未调用 |
| TC-PM-ADD-06 | API 失败 401 | post 返回 401 | 抛 CliError code=KEY_INVALID |
| TC-PM-ADD-07 | json 模式 | `--format json` | stdout 合法 JSON 含 profile/endpoint；stderr 空 |

### 5.2 `payment-methods list`（§3.4.0.2）

| 用例 | 场景 | 输入 | 预期 |
|---|---|---|---|
| TC-PM-LST-01 | 有数据 | `--api-key k` | GET /payment-methods with X-Api-Key；stdout 含表头 + 数据行 |
| TC-PM-LST-02 | 缺失字段 | brand/first6/last4 为 null | 显示 `-` |
| TC-PM-LST-03 | 空列表 | 返回 [] | stdout 含 `No payment methods found`；不含表头 |
| TC-PM-LST-04 | `--member` 透传 | `--member mem_1` | API 调用含 `{member_id:'mem_1'}` query |
| TC-PM-LST-05 | API 失败 403 | 返回 403 | 抛 CliError code=KEY_SCOPE_DENIED |

### 5.3 `payment-methods get`（§3.4.0.3）

| 用例 | 场景 | 输入 | 预期 |
|---|---|---|---|
| TC-PM-GET-01 | 正常（含 Brand/First6/Last4） | `get pm_abc` | GET /payment-methods/pm_abc；stdout keyValue 含全字段 |
| TC-PM-GET-02 | 条件字段缺失 | brand/first6/last4 为空 | stdout 不含 Brand/First 6/Last 4 行 |
| TC-PM-GET-03 | 404 | 返回 404 | 抛 CliError code=RESOURCE_NOT_FOUND |

### 5.4 `payment-methods disable`（§3.4.0.4）

| 用例 | 场景 | 输入 | 预期 |
|---|---|---|---|
| TC-PM-DIS-01 | 正常禁用 | `disable pm_001 --api-key k --idempotency-key i` | POST /payment-methods/pm_001/disable (no body, X-Api-Key + Idempotency-Key)；stderr `✓ Payment method pm_001 disabled`；stdout 含 Status + Revoked tokens |
| TC-PM-DIS-02 | revoked_tokens_count 缺失 | 响应无此字段 | 显示 `0` |
| TC-PM-DIS-03 | `--yes` 缺键 | 缺 `--idempotency-key` | 抛 IdempotencyKeyRequiredError；post 未调用 |
| TC-PM-DIS-04 | json 模式 | `--format json` | stdout JSON 含 status + revoked_tokens_count + profile/endpoint |

### 5.5 `payment-tokens create`（§3.4.1）

| 用例 | 场景 | 输入 | 预期 |
|---|---|---|---|
| TC-PT-CRT-01 | VCN 正常 | `--yes --type vcn --amount 25.00 --payment-method-id pm_x --idempotency-key k` | POST body: type=vcn, amount=2500, payment_method_id=pm_x；stdout 含 VCN keyValue |
| TC-PT-CRT-02 | VCN feature 关闭 | GET /features/vcn → enabled:false | 抛 TOKEN_FEATURE_DISABLED |
| TC-PT-CRT-03 | VCN amount 超界 | `--amount 600.00` | 抛 PARAM_INVALID |
| TC-PT-CRT-04 | VCN fee 计算 | amount=10.00 (1000 cents) | fee=max(1,round(1000*0.05))=50；freeze=1050 |
| TC-PT-CRT-05 | Network-token type 映射 | `--type network-token` | POST body type=`network_token` |
| TC-PT-CRT-06 | NT fee fallback | GET /config/network-token-fee 失败 | fee=DEFAULT_NT_FEE_CENTS=500 |
| TC-PT-CRT-07 | X402 正常 | 全 x402 flag | POST body 含 pay_to/nonce/network/deadline；stdout 含 X402 + `ℹ Use the Signature Value` |
| TC-PT-CRT-08 | X402 fee 计算 | amount=1.00 USDC | fee=max(10000, round(1000000*0.05))=50000 |
| TC-PT-CRT-09 | 支付方式解析—单卡自动 | 无 --payment-method-id/--card + 单 ACTIVE 卡 | 自动选中 |
| TC-PT-CRT-10 | 支付方式解析—无卡 | 无 ACTIVE 卡 | 抛 CLIENT_NO_PAYMENT_METHOD |
| TC-PT-CRT-11 | 支付方式解析—card 无匹配 | `--card 9999` + 无匹配 | 抛 CLIENT_CARD_NOT_MATCHED |
| TC-PT-CRT-12 | `--yes` 缺键 | 缺 `--idempotency-key` | 抛 IdempotencyKeyRequiredError；post 未调用 |
| TC-PT-CRT-13 | `--yes` 省略 `--member` | 不传 `--member` | body 无 member_id 字段 |
| TC-PT-CRT-14 | Idempotency-Key 头透传 | `--idempotency-key my-key` | HTTP 头 `Idempotency-Key: my-key` |

### 5.6 `payment-tokens list`（§3.4.2）

| 用例 | 场景 | 输入 | 预期 |
|---|---|---|---|
| TC-PT-LST-01 | 有数据 | 三种 token | stdout 含表头 + getSummary（vcn: `411111****1234 $25.00`、nt: `Visa`、x402: `1000000 Base`） |
| TC-PT-LST-02 | 空列表 | 返回 [] | stdout 含 `No payment tokens found`；不含表头 |
| TC-PT-LST-03 | `--type`+`--member` 透传 | 两个 flag | API 调用含 query params |

### 5.7 `payment-tokens get`（§3.4.3）— Property 7

| 用例 | 场景 | 输入 | 预期 |
|---|---|---|---|
| TC-PT-GET-01 | VCN keyValue（Property 7）默认脱敏 | VCN 响应 | stdout 含 `Token ID`（非 `Payment Token ID`）+ `Last 4` + Limit 无 `$` + Balance 无 `$`；Card Number/CVC 脱敏，不含完整 PAN/CVC |
| TC-PT-GET-02 | Network Token | NT 响应 | stdout 含 `Token ID` + Brand/ECI/Cryptogram/Expiry/Value |
| TC-PT-GET-03 | X402 | X402 响应 | stdout 含 `Token ID` + Signature Value/Status |
| TC-PT-GET-04 | 404 | 返回 404 | 抛 RESOURCE_NOT_FOUND |
| TC-PT-GET-05 | VCN 显式 reveal | `--reveal` | stdout/JSON 才返回完整 Card Number/CVC |

### 5.8 `payment-tokens revoke`（§3.4.4）

| 用例 | 场景 | 输入 | 预期 |
|---|---|---|---|
| TC-PT-REV-01 | 立即撤销 | status=REVOKED | stderr `✓ Payment token revoked`；stdout 含 Token ID/REVOKED/Revoked At |
| TC-PT-REV-02 | 延迟撤销（X402） | status=ACTIVE + expires_at 非空 | stderr `✓ Revoke scheduled (cryptogram will auto-expire)`；stdout 含 Token ID/ACTIVE/Expires At + message |
| TC-PT-REV-03 | `--yes` 缺键 | 缺 `--idempotency-key` | 抛 IdempotencyKeyRequiredError；post 未调用 |
| TC-PT-REV-04 | json 模式 | `--format json` | stdout JSON 含 profile/endpoint + id/status |

---

## 6. L4 命令级测试用例（手动可执行，需真实后端）

> 约定变量：`$API_KEY`（由 admin-cli keys create 签发）、`$PM_ID`（绑卡后产生）、`$PT_ID`（创建 token 后产生）。
> 退出码语义：`0` 成功 · `1` 业务/参数 · `2` 需升级 · `3` 认证失败/无效 key · `4` 网络/5xx · `5` 用户取消。

### 6.1 `payment-methods add`

```bash
# TC-E2E-PM-ADD-01: 绑卡 + 3DS（需完成邮件验证）
agenzo-token-cli payment-methods add \
  --api-key "$API_KEY" --email test@example.com \
  --card-number 4111111111111111 --expiry 1228 --cvv 123 \
  --idempotency-key pm-add-$(date +%s) --format json 1>out.json 2>err.log
echo "exit=$?"
jq . out.json   # 合法 JSON
PM_ID=$(jq -r '.id' out.json)

# TC-E2E-PM-ADD-02: 无效 API Key
agenzo-token-cli payment-methods add --api-key invalid_key \
  --email a@b.com --card-number 4111111111111111 --expiry 1228 --cvv 123 \
  --idempotency-key k1 2>&1; echo "exit=$?"  # 期望 3 (KEY_INVALID)
```

### 6.2 `payment-methods list`

```bash
# TC-E2E-PM-LST-01: 列出绑卡
agenzo-token-cli payment-methods list --api-key "$API_KEY" --format json | jq .
echo "exit=$?"  # 0

# TC-E2E-PM-LST-02: 带 member 筛选
agenzo-token-cli payment-methods list --api-key "$API_KEY" --member mem_none --format json
```

### 6.3 `payment-methods get`

```bash
# TC-E2E-PM-GET-01: 查询已有 PM
agenzo-token-cli payment-methods get "$PM_ID" --api-key "$API_KEY" --format json | jq .
echo "exit=$?"  # 0

# TC-E2E-PM-GET-02: 不存在
agenzo-token-cli payment-methods get pm_notexist --api-key "$API_KEY" 2>&1
echo "exit=$?"  # 1 (RESOURCE_NOT_FOUND)
```

### 6.4 `payment-methods disable`

```bash
# TC-E2E-PM-DIS-01: 禁用
agenzo-token-cli payment-methods disable "$PM_ID" --api-key "$API_KEY" \
  --idempotency-key pm-dis-$(date +%s) --format json | jq '{status,revoked_tokens_count}'
echo "exit=$?"  # 0
```

### 6.5 `payment-tokens create`（VCN）

```bash
# TC-E2E-PT-CRT-01: 创建 VCN
agenzo-token-cli --yes payment-tokens create \
  --api-key "$API_KEY" --type vcn --amount 10.00 \
  --payment-method-id "$PM_ID" --idempotency-key pt-crt-$(date +%s) --format json 1>pt.json
echo "exit=$?"; PT_ID=$(jq -r '.id' pt.json)
jq '{id,type,status}' pt.json  # type=vcn, status=ACTIVE

# TC-E2E-PT-CRT-02: VCN feature 关（如适用）
# TC-E2E-PT-CRT-03: amount 超界
agenzo-token-cli --yes payment-tokens create --api-key "$API_KEY" --type vcn \
  --amount 600 --payment-method-id "$PM_ID" --idempotency-key k 2>&1; echo "exit=$?"  # 1
```

### 6.6 `payment-tokens list`

```bash
# TC-E2E-PT-LST-01: 列出
agenzo-token-cli payment-tokens list --api-key "$API_KEY" --format json | jq '.payment_tokens | length'
echo "exit=$?"  # 0
```

### 6.7 `payment-tokens get`

```bash
# TC-E2E-PT-GET-01: 查询 VCN token
agenzo-token-cli payment-tokens get "$PT_ID" --api-key "$API_KEY" --format json | jq .
echo "exit=$?"  # 0
# 断言: 默认脱敏 Card Number/CVC；含 Token ID（非 Payment Token ID）、Limit 无 $

# TC-E2E-PT-GET-02: 显式取用 VCN 明文（仅支付流需要）
agenzo-token-cli payment-tokens get "$PT_ID" --api-key "$API_KEY" --reveal --format json | jq .
```

### 6.8 `payment-tokens revoke`

```bash
# TC-E2E-PT-REV-01: 撤销
agenzo-token-cli payment-tokens revoke "$PT_ID" --api-key "$API_KEY" \
  --idempotency-key pt-rev-$(date +%s) --format json | jq '{id,status}'
echo "exit=$?"  # 0
```

---

## 7. 横切一致性断言

### 7.1 API Key 鉴权（全 8 条命令）

- 所有命令的 HTTP 请求均携带 `X-Api-Key: <value>` header。
- 无效 key → 401 → KEY_INVALID → exit 3。
- scope 不匹配 → 403 → KEY_SCOPE_DENIED → exit 3。

### 7.2 幂等键（4 条写命令）

- `--yes` + 缺 `--idempotency-key` → 本地拦截 `PARAM_IDEMPOTENCY_KEY_REQUIRED`（exit 1），**不发请求**。
- 交互模式缺键 → prompt 补输（非空校验）。
- 传键时 → HTTP 头 `Idempotency-Key: <value>` 透传。
- CLI 永不自动生成键。

### 7.3 json 模式 stderr 静默

- 所有 8 条命令在 `--format json` 下：stderr 不含 `✓`/`ℹ`/`⚠`/`✗`。
- stdout 是单一合法 JSON（含 `profile` + `endpoint` 字段）。
- `notify(format, ...)` 在 json 模式完全静默。

### 7.4 退出码矩阵

| 错误前缀 | 退出码 |
|---|---|
| KEY_* | 3 |
| TOKEN_* / CLIENT_* / PARAM_* | 1 |
| UPSTREAM_* / INTERNAL_* / RATE_LIMITED | 4 |
| CLIENT_ABORTED (SIGINT) | 5 |
| UPGRADE_REQUIRED | 2 |

### 7.5 错误信封

失败时 stderr 输出（json 模式）：

```json
{"error":{"code":"KEY_INVALID","code_num":1101,"message":"...","request_id":"..."}}
```

`request_id` 仅在 HTTP 来源时存在。

---

## 8. 已实现的自动化测试映射

| 测试文件 | 覆盖的用例/属性 | 用例数 |
|---|---|---|
| `tests/pbt-amount.test.ts` | PBT-AMT-01~02、UT-AMT-03~10（Property 1） | 10 |
| `tests/pbt-type-and-resolve.test.ts` | UT-TYPE-01~03、PBT-TYPE-04~05（Property 2）+ UT-RES-01~10（Property 3） | 16 |
| `tests/payment-methods.test.ts` | TC-PM-ADD-01~05、TC-PM-LST-01~04、TC-PM-GET-01~02、TC-PM-DIS-01~03 | 13 |
| `tests/payment-tokens.test.ts` | TC-PT-CRT-01/05/07/12、TC-PT-LST-01~03、TC-PT-GET-01~05、TC-PT-REV-01~03 | 15 |
| `tests/properties.test.ts` | UT-IDEM-01~05、UT-CHAN-01~06、UT-ERR-01~13、UT-DIFF-01~06（Properties 4–7） | 27 |
| `tests/coverage-gaps.test.ts` | 3DS 超时(fake timer)、JSON 信封精确断言(3)、API 错误集成(3)、VCN fee 验证、List JSON 结构、幂等键 header 精确值(2) | 11 |

**总计：90 个自动化测试，全部通过。**

---

## 9. 未覆盖项与后续计划

| 项 | 说明 | 优先级 |
|---|---|---|
| ~~3DS 超时（fake timer）~~ | ✅ 已覆盖（coverage-gaps.test.ts） | — |
| ~~`--format json` 端到端信封字段精确断言~~ | ✅ 已覆盖（coverage-gaps.test.ts） | — |
| 交互模式 prompt 补输幂等键 | 需 stdin mock / TTY 模拟 | P3（手动覆盖） |
| Network Token 不支持卡的错误路径 | 依赖后端特定卡状态 | P3（手动覆盖） |
| VCN `gateway_token` 缺失的错误路径 | 同上 | P3（手动覆盖） |

> 剩余 3 项均为 P3（依赖真实后端特定状态或 stdin TTY 模拟），由 L4 手动 E2E 覆盖。
