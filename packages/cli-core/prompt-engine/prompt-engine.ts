import { input, password, select } from '@inquirer/prompts';

interface PromptConfig {
  message: string;
  type?: 'input' | 'password' | 'select';
  choices?: { name: string; value: string }[];
  validate?: (input: string) => boolean | string;
}

export class PromptEngine {
  /** Return flagValue directly if provided, otherwise prompt interactively */
  static async resolveInput(
    flagValue: string | undefined,
    config: PromptConfig,
  ): Promise<string> {
    if (flagValue !== undefined) {
      return flagValue;
    }

    if (config.type === 'password') {
      return password({ message: config.message, mask: '*' });
    }

    if (config.type === 'select' && config.choices) {
      return select({
        message: config.message,
        choices: config.choices,
      });
    }

    return input({
      message: config.message,
      validate: config.validate,
    });
  }
}
