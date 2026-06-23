import { password } from '@inquirer/prompts';
import { PromptEngine } from '@agenzo/cli-core';

// ============================================================
// Payment-method interactive prompts (token-cli domain)
// ============================================================
//
// These were relocated out of @agenzo/cli-core's PromptEngine: collecting card
// number / expiry / CVV is token-cli payment-method business, not a generic
// interactive fallback. cli-core keeps only the general `PromptEngine.resolveInput`.

/** Always collect CVV interactively with masked display. */
export async function collectCvv(): Promise<string> {
  return password({
    message: 'CVV:',
    mask: '*',
  });
}

/** Collect payment method params based on type. */
export async function collectPaymentMethodParams(
  type: string,
  flags: Record<string, string | undefined>,
): Promise<Record<string, string>> {
  const params: Record<string, string> = { type };

  const email = await PromptEngine.resolveInput(flags.cardEmail ?? flags.email, {
    message: 'Email (for 3DS verification):',
  });
  params.email = email;

  if (type === 'card') {
    params.card_number = await PromptEngine.resolveInput(flags.cardNumber, {
      message: 'Card number:',
    });
    params.expiry_date = await PromptEngine.resolveInput(flags.expiry, {
      message: 'Expiry (MMYY):',
    });
    // CVV: use flag if provided, otherwise collect interactively
    if (flags.cvv) {
      params.cvv = flags.cvv;
    } else {
      params.cvv = await collectCvv();
    }
  }

  return params;
}
