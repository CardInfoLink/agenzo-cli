import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerTravellersListCommand } from '../src/travellers/list.js';
import { travellersListSchema } from '../src/verb-schema.js';
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
