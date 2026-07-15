import { PromptEngine, ValidationError } from '@agenzo/cli-core';
import type { Command } from 'commander';

/**
 * Payout bank account for a developer. Mandatory on `developers create`
 * regardless of --billing-mode — every developer needs a payout target on
 * file before it can receive transfers. One account per developer;
 * `developers update` can replace it wholesale via the same flags.
 *
 * Modeled on a generic international SWIFT wire (works across currencies/
 * countries); routing_number is optional and only meaningful for corridors
 * that require it alongside SWIFT (e.g. US ABA routing).
 */
export interface BankAccountInfo {
  beneficiary_name: string;
  account_number: string;
  bank_name: string;
  bank_country: string;
  swift_code: string;
  bank_address?: string;
  routing_number?: string;
}

// ISO 9362 SWIFT/BIC: 8 or 11 alphanumeric characters.
const SWIFT_PATTERN = /^[A-Za-z0-9]{8}([A-Za-z0-9]{3})?$/;
// ISO 3166-1 alpha-2 country code.
const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;
// Bank account number / IBAN: alphanumeric only, 4-34 chars (IBAN max per
// ISO 13616; 4 chars as a practical floor for real-world account numbers).
// No spaces/hyphens/punctuation — mirrors the backend BankAccountInfo schema.
const ACCOUNT_NUMBER_PATTERN = /^[A-Za-z0-9]{4,34}$/;
// Routing number (e.g. US ABA): digits only.
const ROUTING_NUMBER_PATTERN = /^[0-9]{1,34}$/;

/** CLI flags accepted by `developers create` / `developers update` for the bank account. */
export interface BankAccountFlags {
  bankBeneficiaryName?: string;
  bankAccountNumber?: string;
  bankName?: string;
  bankCountry?: string;
  bankSwiftCode?: string;
  bankAddress?: string;
  bankRoutingNumber?: string;
}

function validateSwiftCode(value: string): boolean | string {
  return SWIFT_PATTERN.test(value.trim()) || 'SWIFT/BIC must be 8 or 11 alphanumeric characters';
}

function validateCountry(value: string): boolean | string {
  return COUNTRY_PATTERN.test(value.trim()) || 'Country must be an ISO 3166-1 alpha-2 code (e.g. US, CN)';
}

function validateAccountNumber(value: string): boolean | string {
  return (
    ACCOUNT_NUMBER_PATTERN.test(value.trim()) ||
    'Account number must be 4-34 alphanumeric characters, no spaces or punctuation'
  );
}

function validateRoutingNumber(value: string): boolean | string {
  return ROUTING_NUMBER_PATTERN.test(value.trim()) || 'Routing number must be digits only';
}

function nonBlank(fieldLabel: string) {
  return (value: string): boolean | string => value.trim().length > 0 || `${fieldLabel} is required`;
}

/**
 * Resolve the mandatory bank account fields from flags, prompting
 * interactively for any that are missing (unless --yes was passed, in which
 * case a missing required field throws ValidationError → PARAM_INVALID / exit 1).
 */
export async function resolveBankAccount(
  flags: BankAccountFlags,
  command: Command,
): Promise<BankAccountInfo> {
  const nonInteractive = Boolean(command.optsWithGlobals().yes);

  const requireFlag = (flagValue: string | undefined, flagName: string): string => {
    if (nonInteractive && !flagValue) {
      throw new ValidationError(
        `--yes requires ${flagName} to be supplied (bank account is mandatory for every developer).`,
      );
    }
    return flagValue ?? '';
  };

  // In non-interactive mode, missing required flags throw immediately above
  // (resolveInput is never reached with an empty prompt). In interactive
  // mode, requireFlag returns '' as a passthrough and resolveInput prompts.
  const beneficiaryName = nonInteractive
    ? requireFlag(flags.bankBeneficiaryName, '--bank-beneficiary-name')
    : await PromptEngine.resolveInput(flags.bankBeneficiaryName, {
        message: 'Bank account — beneficiary name:',
        validate: nonBlank('Beneficiary name'),
      });

  const accountNumber = nonInteractive
    ? requireFlag(flags.bankAccountNumber, '--bank-account-number')
    : await PromptEngine.resolveInput(flags.bankAccountNumber, {
        message: 'Bank account — account number / IBAN:',
        validate: validateAccountNumber,
      });

  const bankName = nonInteractive
    ? requireFlag(flags.bankName, '--bank-name')
    : await PromptEngine.resolveInput(flags.bankName, {
        message: 'Bank account — bank name:',
        validate: nonBlank('Bank name'),
      });

  const bankCountry = nonInteractive
    ? requireFlag(flags.bankCountry, '--bank-country')
    : await PromptEngine.resolveInput(flags.bankCountry, {
        message: 'Bank account — bank country (ISO alpha-2, e.g. US):',
        validate: validateCountry,
      });

  const swiftCode = nonInteractive
    ? requireFlag(flags.bankSwiftCode, '--bank-swift-code')
    : await PromptEngine.resolveInput(flags.bankSwiftCode, {
        message: 'Bank account — SWIFT/BIC code:',
        validate: validateSwiftCode,
      });

  // Non-interactive mode still needs its required values format-checked
  // (requireFlag above only checks presence, not shape).
  if (nonInteractive) {
    const swiftCheck = validateSwiftCode(swiftCode);
    if (swiftCheck !== true) {
      throw new ValidationError(String(swiftCheck));
    }
    const countryCheck = validateCountry(bankCountry);
    if (countryCheck !== true) {
      throw new ValidationError(String(countryCheck));
    }
    const accountNumberCheck = validateAccountNumber(accountNumber);
    if (accountNumberCheck !== true) {
      throw new ValidationError(String(accountNumberCheck));
    }
  }

  // Optional fields (bank_address / routing_number) are collected via flags
  // only, never prompted — but routing_number's format is still checked
  // whenever it's supplied, interactive or not.
  if (flags.bankRoutingNumber) {
    const routingCheck = validateRoutingNumber(flags.bankRoutingNumber);
    if (routingCheck !== true) {
      throw new ValidationError(String(routingCheck));
    }
  }

  const bankAccount: BankAccountInfo = {
    beneficiary_name: beneficiaryName.trim(),
    account_number: accountNumber.trim().toUpperCase(),
    bank_name: bankName.trim(),
    bank_country: bankCountry.trim().toUpperCase(),
    swift_code: swiftCode.trim().toUpperCase(),
  };
  if (flags.bankAddress) {
    bankAccount.bank_address = flags.bankAddress;
  }
  if (flags.bankRoutingNumber) {
    bankAccount.routing_number = flags.bankRoutingNumber;
  }
  return bankAccount;
}

/**
 * Resolve an OPTIONAL bank account replacement for `developers update`.
 * Returns undefined when the caller supplied none of the bank-account flags
 * (leaves the developer's stored bank account untouched). If ANY bank-account
 * flag is supplied, all mandatory fields must be resolvable (prompted for
 * interactively, or all present when --yes) — partial replacement is not
 * supported (one account per developer, replaced wholesale).
 */
export async function resolveOptionalBankAccount(
  flags: BankAccountFlags,
  command: Command,
): Promise<BankAccountInfo | undefined> {
  const anyProvided = Boolean(
    flags.bankBeneficiaryName ||
      flags.bankAccountNumber ||
      flags.bankName ||
      flags.bankCountry ||
      flags.bankSwiftCode ||
      flags.bankAddress ||
      flags.bankRoutingNumber,
  );
  if (!anyProvided) {
    return undefined;
  }
  return resolveBankAccount(flags, command);
}

/** Register the shared --bank-* option group on a create/update command. */
export function addBankAccountOptions(cmd: Command): Command {
  return cmd
    .option('--bank-beneficiary-name <name>', 'Bank account beneficiary name')
    .option('--bank-account-number <number>', 'Bank account number or IBAN')
    .option('--bank-name <name>', 'Bank name')
    .option('--bank-country <code>', 'Bank country, ISO 3166-1 alpha-2 (e.g. US, CN)')
    .option('--bank-swift-code <code>', 'SWIFT/BIC code (8 or 11 alphanumeric characters)')
    .option('--bank-address <address>', 'Bank address (optional)')
    .option('--bank-routing-number <number>', 'Routing number, e.g. US ABA (optional)');
}
