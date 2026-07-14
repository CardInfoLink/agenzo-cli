import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import {
  addBankAccountOptions,
  resolveBankAccount,
  resolveOptionalBankAccount,
  type BankAccountFlags,
} from '../../src/developers/bank-account.js';

/** Build a bare Command carrying only the global --yes flag, matching
 * command.optsWithGlobals().yes usage inside bank-account.ts. */
function commandWithYes(yes: boolean): Command {
  const cmd = new Command();
  cmd.option('--yes');
  if (yes) {
    cmd.setOptionValue('yes', true);
  }
  return cmd;
}

const VALID_FLAGS: BankAccountFlags = {
  bankBeneficiaryName: 'Bot Inc',
  bankAccountNumber: '1234567890123456',
  bankName: 'Test Bank',
  bankCountry: 'us',
  bankSwiftCode: 'testus33',
};

describe('resolveBankAccount', () => {
  it('resolves all fields from flags in --yes mode, normalizing case', async () => {
    const result = await resolveBankAccount(VALID_FLAGS, commandWithYes(true));
    expect(result).toEqual({
      beneficiary_name: 'Bot Inc',
      account_number: '1234567890123456',
      bank_name: 'Test Bank',
      bank_country: 'US',
      swift_code: 'TESTUS33',
    });
  });

  it('includes optional bank_address / routing_number when supplied', async () => {
    const result = await resolveBankAccount(
      { ...VALID_FLAGS, bankAddress: '123 Main St', bankRoutingNumber: '021000021' },
      commandWithYes(true),
    );
    expect(result.bank_address).toBe('123 Main St');
    expect(result.routing_number).toBe('021000021');
  });

  it('omits optional fields when not supplied', async () => {
    const result = await resolveBankAccount(VALID_FLAGS, commandWithYes(true));
    expect(result.bank_address).toBeUndefined();
    expect(result.routing_number).toBeUndefined();
  });

  it.each([
    ['bankBeneficiaryName', '--bank-beneficiary-name'],
    ['bankAccountNumber', '--bank-account-number'],
    ['bankName', '--bank-name'],
    ['bankCountry', '--bank-country'],
    ['bankSwiftCode', '--bank-swift-code'],
  ] as const)('throws ValidationError naming %s when missing under --yes', async (key, flagName) => {
    const flags = { ...VALID_FLAGS };
    delete flags[key];
    await expect(resolveBankAccount(flags, commandWithYes(true))).rejects.toThrow(flagName);
  });

  it('rejects a malformed SWIFT code under --yes', async () => {
    await expect(
      resolveBankAccount({ ...VALID_FLAGS, bankSwiftCode: 'bad' }, commandWithYes(true)),
    ).rejects.toThrow(/SWIFT/);
  });

  it('rejects a malformed country code under --yes', async () => {
    await expect(
      resolveBankAccount({ ...VALID_FLAGS, bankCountry: 'USA' }, commandWithYes(true)),
    ).rejects.toThrow(/ISO 3166-1/);
  });

  it('accepts an 11-character SWIFT/BIC code', async () => {
    const result = await resolveBankAccount(
      { ...VALID_FLAGS, bankSwiftCode: 'testus33xxx' },
      commandWithYes(true),
    );
    expect(result.swift_code).toBe('TESTUS33XXX');
  });
});

describe('resolveOptionalBankAccount', () => {
  it('returns undefined when no --bank-* flags are supplied', async () => {
    const result = await resolveOptionalBankAccount({}, commandWithYes(true));
    expect(result).toBeUndefined();
  });

  it('resolves a full bank account when any single --bank-* flag is supplied', async () => {
    const result = await resolveOptionalBankAccount(VALID_FLAGS, commandWithYes(true));
    expect(result).toEqual({
      beneficiary_name: 'Bot Inc',
      account_number: '1234567890123456',
      bank_name: 'Test Bank',
      bank_country: 'US',
      swift_code: 'TESTUS33',
    });
  });

  it('throws under --yes when only a subset of required flags is supplied (no partial replace)', async () => {
    await expect(
      resolveOptionalBankAccount({ bankBeneficiaryName: 'Bot Inc' }, commandWithYes(true)),
    ).rejects.toThrow('--bank-account-number');
  });
});

describe('addBankAccountOptions', () => {
  it('registers all 7 --bank-* flags on the command', () => {
    const cmd = addBankAccountOptions(new Command('create'));
    const flagNames = cmd.options.map((o) => o.long);
    expect(flagNames).toEqual(
      expect.arrayContaining([
        '--bank-beneficiary-name',
        '--bank-account-number',
        '--bank-name',
        '--bank-country',
        '--bank-swift-code',
        '--bank-address',
        '--bank-routing-number',
      ]),
    );
  });
});
