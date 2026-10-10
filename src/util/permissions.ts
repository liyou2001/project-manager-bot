import { PermissionFlagsBits, type BaseInteraction } from 'discord.js';

export const MISSING_PERMISSION_MESSAGE = 'You need the **Manage Server** permission to do that.';

/** Changing project settings or re-reading the site is limited to members who can manage the server. */
export function canManageProject(interaction: BaseInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}
