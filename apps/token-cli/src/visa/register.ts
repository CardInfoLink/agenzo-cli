import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  Formatter,
  PromptEngine,
  resolveFormat,
  notify,
  CliError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult } from '@agenzo/cli-core';

/**
 * enabler: 显式前置注册 Visa agent（一步：录第三方公司信息 + 触发 onboarding）。
 *
 * 走 API Key 鉴权——register 是绑卡的前置动作，与绑卡链同为 developer 的机器身份操作，
 * developer_id 由服务端从 API Key 上下文解析，不在命令里带 developer_id。
 *
 * 薄封装，不做校验——格式（按国家 type）、平台内唯一、direct 拒绝、幂等全在 platform 的
 * POST /visa/register 里做。CLI 只收参数、组 body、透传 API Key。无需 idempotency key
 * （onboarding 幂等由 Visa 侧 businessId 去重键保证）。
 */
interface VisaRegisterResult {
  developer_id: string;
  relationship_id: string;
  visa_agent_id: string | null;
}

type Deps = { apiClient: ApiClient };

export function registerVisaRegisterCommand(parent: Command, deps: Deps): void {
  parent
    .command('register')
    .description(
      'Register a Visa agent (enabler mode): submit the third-party company info and trigger onboarding in one call',
    )
    .option('--api-key <key>', 'API Key for authentication')
    // 6 个必填（platform 侧强制；CLI 不预校验，缺了让 platform 报错）
    .requiredOption('--company-legal-name <name>', 'Third-party company legal name')
    .requiredOption('--website-url <url>', 'Third-party website URL')
    .requiredOption('--company-city <city>', 'Company city')
    .requiredOption('--company-country-code <cc>', 'ISO 3166-1 alpha-2 country code (e.g. HK, US)')
    .requiredOption('--contact-email <email>', 'Primary contact email')
    .requiredOption('--business-id-type <type>', 'Business identification type (e.g. HKBR, EIN, USCI, VAT, PAN)')
    .requiredOption('--business-id-value <value>', 'Business identification value (must be unique across developers)')
    // Optional
    .option('--company-trade-name <name>', 'Trade / DBA name')
    .option('--company-address1 <addr>', 'Address line 1')
    .option('--company-address2 <addr>', 'Address line 2')
    .option('--company-state-province-code <code>', 'State / province code')
    .option('--company-postal-code <code>', 'Postal code')
    .option('--company-phone <phone>', 'Company phone')
    .option('--contact-first-name <name>', 'Primary contact first name')
    .option('--contact-last-name <name>', 'Primary contact last name')
    .action(async (options, command: Command) => {
      const opts = command.optsWithGlobals();
      const format = resolveFormat(opts.format as string | undefined);

      const apiKey = await PromptEngine.resolveInput(options.apiKey as string | undefined, {
        message: 'API Key:',
        type: 'password',
      });

      // 键名对齐 platform 的 AgentBusinessProfile schema。omit undefined。
      const body: Record<string, unknown> = {
        company_legal_name: options.companyLegalName,
        website_url: options.websiteUrl,
        company_city: options.companyCity,
        company_country_code: options.companyCountryCode,
        contact_email: options.contactEmail,
        business_identification_type: options.businessIdType,
        business_identification_value: options.businessIdValue,
      };
      const optional: Record<string, unknown> = {
        company_trade_name: options.companyTradeName,
        company_address1: options.companyAddress1,
        company_address2: options.companyAddress2,
        company_state_province_code: options.companyStateProvinceCode,
        company_postal_code: options.companyPostalCode,
        company_phone: options.companyPhone,
        contact_first_name: options.contactFirstName,
        contact_last_name: options.contactLastName,
      };
      for (const [k, v] of Object.entries(optional)) {
        if (v !== undefined) body[k] = v;
      }

      const result = await deps.apiClient.post<VisaRegisterResult>(
        '/visa/register',
        { type: 'api-key', key: apiKey },
        body,
      );

      if (!result.success) {
        throw CliError.fromApi(result, { auth: 'api-key' });
      }

      const data = result.data;
      const commandResult: CommandResult<VisaRegisterResult> = {
        data,
        note: 'Visa agent registered',
        text: () =>
          Formatter.keyValue([
            ['Developer ID', data.developer_id],
            ['Relationship ID', data.relationship_id],
            ['Visa Agent ID', String(data.visa_agent_id ?? '-')],
          ]),
      };

      notify(format, 'success', commandResult.note as string);
      const configManager = new ConfigManager();
      await renderWithContext(commandResult, { format }, configManager);
    });
}
