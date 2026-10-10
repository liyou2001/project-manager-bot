import type {
  ChatInputCommandInteraction,
  MessageComponentInteraction,
  ModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

/** A slash command. Add new ones to the list in ./index.ts. */
export interface Command {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

/**
 * Handles buttons, select menus and modals whose custom ID is `${prefix}:${action}`.
 * Register new handlers in ../interactions.ts.
 */
export interface ComponentHandler {
  prefix: string;
  handle(interaction: MessageComponentInteraction | ModalSubmitInteraction, action: string): Promise<void>;
}
