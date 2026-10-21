import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerTravellersListCommand } from '../src/travellers/list.js';
import { registerTravellersDeleteCommand } from '../src/travellers/delete.js';
import { travellersDeleteSchema, travellersListSchema } from '../src/verb-schema.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient, parseJsonOutput } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

const T1 = {
  traveller_token: 'tvp_001',
  surname: 'WANG',
  name: 'WALTER',
  gender: '1',
  birthday: '1990-01-02',
  nationality: 'CN',
  id_type: '2',
  id_number_masked: 'E1*****78',
  expiration: '2030-01-01',
};

function run(data: unknown, args: string[]) {
  const apiClient = mockApiClient({ '/travellers': data });
  const program = buildProgram();
  registerTravellersListCommand(program.command('travellers'), { apiClient } as any);
  const out = captureStdout();
  captureStderr();
  return { apiClient, out, done: program.parseAsync(['node', 'cli', 'travellers', 'list', '--api-key', 'sk', ...args]) };
}

describe('travellers list', () => {
  it('GET /travellers with --member mapped to member_id, json wraps travellers[]', async () => {
    const { apiClient, out, done } = run({ travellers: [T1] }, ['--member', 'm_1', '--format', 'json']);
    await done;
    expect(apiClient.get).toHaveBeenCalledWith('/travellers', { type: 'api-key', key: 'sk' }, { member_id: 'm_1' });
    const p = parseJsonOutput(out.text()) as any;
    expect(p.travellers[0].traveller_token).toBe('tvp_001');
    expect(p.travellers[0].id_number_masked).toBe('E1*****78');
  });

  it('table shows name and masked number only', async () => {
    const { out, done } = run({ travellers: [T1] }, []);
    await done;
    const text = out.text();
    expect(text).toContain('tvp_001');
    expect(text).toContain('WANG/WALTER');
    expect(text).toContain('E1*****78');
  });

  it('empty list prints an info line', async () => {
    const { out, done } = run({ travellers: [] }, []);
    await done;
    expect(out.text()).toContain('No saved travellers');
  });

  it('schema is read-only and documents the masked field', () => {
    expect(travellersListSchema.noun).toBe('travellers');
    expect(travellersListSchema.verb).toBe('list');
    expect((travellersListSchema as any).write).toBeFalsy();
    expect(JSON.stringify(travellersListSchema.response)).toContain('id_number_masked');
  });
});

describe('travellers delete', () => {
  function setup(apiClient: any) {
    const program = buildProgram();
    registerTravellersDeleteCommand(program.command('travellers'), { apiClient } as any);
    const out = captureStdout();
    const err = captureStderr();
    return { program, out, err };
  }

  it('POST /travellers/<token>/delete with member and idempotency key', async () => {
    const apiClient = mockApiClient({
      '/travellers/tvp_001/delete?member_id=m_1': { deleted: true, traveller_token: 'tvp_001' },
    });
    const { program, out, err } = setup(apiClient);
    await program.parseAsync([
      'node', 'cli', 'travellers', 'delete', 'tvp_001',
      '--api-key', 'sk', '--member', 'm_1', '--idempotency-key', 'idem_1', '--format', 'json',
    ]);
    expect(apiClient.post).toHaveBeenCalledWith(
      '/travellers/tvp_001/delete?member_id=m_1',
      { type: 'api-key', key: 'sk' },
      undefined,
      { 'Idempotency-Key': 'idem_1' },
    );
    expect((parseJsonOutput(out.text()) as any).deleted).toBe(true);
    expect(err.text()).not.toContain('tvp_001 deleted'); // json mode keeps stderr quiet
  });

  it('accepts --id for flag-only callers and url-encodes the token', async () => {
    const apiClient = mockApiClient();
    const { program } = setup(apiClient);
    await program.parseAsync([
      'node', 'cli', 'travellers', 'delete', '--id', 'tvp/../x',
      '--api-key', 'sk', '--member', 'm 1', '--idempotency-key', 'idem_2',
    ]);
    expect(apiClient.post.mock.calls[0][0]).toBe('/travellers/tvp%2F..%2Fx/delete?member_id=m%201');
  });

  it('requires --idempotency-key under --yes and sends nothing', async () => {
    const apiClient = mockApiClient();
    const { program } = setup(apiClient);
    await expect(
      program.parseAsync(['node', 'cli', '--yes', 'travellers', 'delete', 'tvp_001', '--api-key', 'sk', '--member', 'm_1']),
    ).rejects.toThrow('--idempotency-key');
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("someone else's or missing token surfaces the platform error", async () => {
    const apiClient = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({
        success: false,
        statusCode: 400,
        errorCode: 1001,
        code: 'INVALID_REQUEST',
        errorMessage: 'Saved traveller not found.',
      }),
    };
    const { program } = setup(apiClient);
    await expect(
      program.parseAsync([
        'node', 'cli', 'travellers', 'delete', 'tvp_other',
        '--api-key', 'sk', '--member', 'm_1', '--idempotency-key', 'idem_3',
      ]),
    ).rejects.toThrow(/parameters are invalid/);
  });

  it('bad API key surfaces an auth error', async () => {
    const apiClient = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ success: false, statusCode: 401, errorCode: 1002, code: 'TOKEN_INVALID', errorMessage: 'Invalid token' }),
    };
    const { program } = setup(apiClient);
    await expect(
      program.parseAsync([
        'node', 'cli', 'travellers', 'delete', 'tvp_001',
        '--api-key', 'bad', '--member', 'm_1', '--idempotency-key', 'idem_4',
      ]),
    ).rejects.toThrow();
  });

  it('schema is a write with mandatory member and idempotency key', () => {
    expect(travellersDeleteSchema.verb).toBe('delete');
    expect(travellersDeleteSchema.flags.member.required).toBe(true);
    expect(travellersDeleteSchema.flags['idempotency-key'].required).toBe(true);
  });
});
