import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerEvoCreateCommand } from '../src/payment-tokens/evo-create.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient } from './helpers.js';

// evo-create 跑 --yes 且必填参数给齐，不该触发任何交互提示。防御性地 mock
// @inquirer/prompts，这样漏判的分支会表现为坏值而不是挂住。
vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
  select: vi.fn().mockResolvedValue('pm_auto'),
  input: vi.fn().mockResolvedValue('mocked_input'),
  password: vi.fn().mockResolvedValue('mocked_password'),
}));

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

// ============================================================
// --credential：EVO 轨的凭证形态在**铸币时**选定
//
// EVO/Mastercard 有两条静默结算轨，区别在 ptk 里装的是哪种凭证：
//
// - `network_token`（缺省）铸一枚带 cryptogram 的网络令牌，扣款报 type=networkToken
// - `gateway_token` 不铸币，直接装卡自己的 EVO 网关（COF）令牌，扣款报 type=token
//
// 选择放在铸币时而非扣款时，是因为平台的分流判据是「ptk 有没有 cryptogram」这一个事实，
// 前移之后扣款路径一行不用改。所以这个 flag 的唯一职责就是把取值原样送到请求体。
//
// 四件事在这里被钉住：
//
// 1. **「省略」与「声明了无效值」是两件事**：判据是 flag 有没有出现，不是真值判断。空串
//    必须原样上送，由平台以 INVALID_REQUEST fail-closed。CLI 把它折叠成「没声明」会让
//    平台按缺省铸出网络令牌，而调用方以为自己拿到的是网关令牌形态 —— 直到扣款时才发现
//    走的是另一条轨，那时钱已经动了。第三个用例就是这条护栏。
// 2. **字面量只有 `credential` 一种形态**：base 侧那个 collected 字段叫
//    `token_credential`（它要跟 schema 里别的 collected 键并列），平台请求体叫
//    `credential`。两个名字各有来历，不是笔误，请求体里不许出现 base 侧的形态。
// 3. **`type` 与 `credential` 是两个维度**：两条轨都在 `type=network_token` 下，由
//    `credential` 再分流。把 `type` 跟着改成 `gateway_token` 会让平台认不出这是哪种
//    令牌请求 —— 看起来像笔误，其实是契约。
// 4. **输出要说出走的是哪条轨**：`Type` 行此前对两条轨都硬写 "Network Token"，一次排查
//    正是因此把网关令牌扣款读成了网络令牌扣款。
// ============================================================

/** ACTIVE 的 EVO 响应 —— evo-create 要求 ACTIVE，否则守卫先抛错。 */
const EVO_ACTIVE = {
  id: 'ptk_evo_001',
  type: 'network_token',
  status: 'ACTIVE',
  payment_brand: 'evo',
};

/** base 侧 / 驼峰形态的字段名：请求体里一个都不许出现。 */
const FOREIGN_SHAPES = ['token_credential', 'tokenCredential', 'credential_kind'] as const;

const baseArgs = (extra: string[]) => [
  'node', 'cli', '--yes', 'payment-tokens', 'evo-create',
  '--api-key', 'sk_key',
  '--payment-method-id', 'pm_evo_1',
  '--amount-cents', '12345',
  '--idempotency-key', 'idem_evo',
  ...extra,
];

function run(extra: string[]) {
  const apiClient = mockApiClient({ '/payment-tokens/create': EVO_ACTIVE });
  const program = buildProgram();
  registerEvoCreateCommand(program.command('payment-tokens'), { apiClient } as any);
  const out = captureStdout();
  captureStderr();
  return { apiClient, out, parse: () => program.parseAsync(baseArgs(extra)) };
}

describe('payment-tokens evo-create — --credential 透传', () => {
  it('给了就作为 credential 进请求体（只用 snake_case 这一种形态）', async () => {
    const { apiClient, parse } = run(['--credential', 'gateway_token']);
    await parse();

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body.credential).toBe('gateway_token');
    for (const shape of FOREIGN_SHAPES) {
      expect(body).not.toHaveProperty(shape);
    }
  });

  it('没给则整个 credential 字段不发（平台按缺省的 network_token 铸币）', async () => {
    const { apiClient, parse } = run([]);
    await parse();

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body).not.toHaveProperty('credential');
  });

  it('空串原样上送（已声明但无效，由平台 INVALID_REQUEST fail-closed，不等同于没给）', async () => {
    const { apiClient, parse } = run(['--credential', '']);
    await parse();

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body).toHaveProperty('credential');
    expect(body.credential).toBe('');
  });

  it('拼错的取值也原样上送，CLI 不校验枚举（合法性的唯一判据在平台）', async () => {
    const { apiClient, parse } = run(['--credential', 'gatewaytoken']);
    await parse();

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body.credential).toBe('gatewaytoken');
  });

  it('选 gateway_token 时 type 仍是 network_token（两者是不同维度，不要跟着改）', async () => {
    const { apiClient, parse } = run(['--credential', 'gateway_token']);
    await parse();

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body.type).toBe('network_token');
  });
});

describe('payment-tokens evo-create — 输出要说出走的是哪条轨', () => {
  it('选 gateway_token 时 Type 行不再谎称 Network Token', async () => {
    const { out, parse } = run(['--credential', 'gateway_token']);
    await parse();

    const text = out.text();
    expect(text).toContain('Gateway Token');
    expect(text).not.toContain('Network Token');
  });

  it('缺省仍渲染 Network Token（回归保护）', async () => {
    const { out, parse } = run([]);
    await parse();

    expect(out.text()).toContain('Network Token');
  });
});
