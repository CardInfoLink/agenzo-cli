/**
 * Shared JSON envelope renderer (cli-design §7.7.2 BACK-011).
 *
 * In `--format json` mode, every command's payload is prefixed with two
 * client-assembled context fields:
 *   - `profile`:  the active environment name (production / testing / custom),
 *                 derived by reverse-looking-up the api_host in BUILTIN_PROFILES.
 *   - `endpoint`: the api **host only** (e.g. https://agent.everonet.com) —
 *                 NEVER the internal API path (/api/admin/v1), so internal
 *                 routing is not leaked to agent consumers.
 *
 * `result.data` is expected to be an object (single-resource payloads are flat
 * field maps; list payloads are `{ <namedKey>: [...], page: {...} }`). The two
 * context fields are spread in front of it.
 *
 * In `--format table` mode this is a passthrough to the standard `render`.
 *
 * This lives in `@agenzo/cli-core` (BACK-011) so every CLI shares one
 * implementation rather than copying it per app.
 */
import type { CommandResult } from '../types/commands.js';
import { type RenderOptions, render } from './output.js';
import { ConfigManager, BUILTIN_PROFILES } from '../config/config-manager.js';

export async function renderWithContext<T>(
  result: CommandResult<T>,
  opts: RenderOptions,
  configManager: ConfigManager,
): Promise<void> {
  if (opts.format !== 'json') {
    render(result, opts);
    return;
  }

  const config = await configManager.load();
  const host = config.api_host.replace(/\/+$/, '');
  const profile =
    Object.entries(BUILTIN_PROFILES).find(([, v]) => v === host)?.[0] ?? 'custom';

  const dataObj =
    result.data && typeof result.data === 'object'
      ? (result.data as Record<string, unknown>)
      : { value: result.data };

  const payload = {
    profile,
    endpoint: host,
    ...dataObj,
  };

  render({ ...result, data: payload } as CommandResult<typeof payload>, opts);
}
