import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type BaseInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
  type MessageCreateOptions,
  type ModalSubmitInteraction,
  type TextChannel,
} from 'discord.js';
import { getProject, markPrompted, saveProject, wasPrompted, type ProjectRow } from './db.js';

export const SETUP_BUTTON_ID = 'project-setup:open';
export const SETUP_MODAL_ID = 'project-setup:submit';
const WEBSITE_INPUT_ID = 'website';
const GITHUB_INPUT_ID = 'github';

const MISSING_PERMISSION_MESSAGE = 'You need the **Manage Server** permission to set up the project.';

/** Pick a channel in a newly joined guild where the bot is allowed to post. */
function findPromptChannel(guild: Guild): TextChannel | undefined {
  const me = guild.members.me;
  if (!me) return undefined;

  const canPost = (channel: GuildBasedChannel | null): channel is TextChannel =>
    channel?.type === ChannelType.GuildText &&
    (channel.permissionsFor(me)?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ]) ??
      false);

  if (canPost(guild.systemChannel)) return guild.systemChannel;
  return guild.channels.cache
    .filter(canPost)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .first();
}

function buildPrompt(): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle('Thanks for adding me!')
    .setDescription(
      "To get started, I need this project's **website** and **GitHub** links.\n" +
        'Click the button below to enter them. You can change them later with `/setup`.',
    )
    .setColor(0x5865f2);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(SETUP_BUTTON_ID)
      .setLabel('Set up project')
      .setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row] };
}

/** Post the setup prompt in the guild, falling back to DMing the owner. */
async function sendSetupPrompt(guild: Guild): Promise<void> {
  const channel = findPromptChannel(guild);
  if (channel) {
    await channel.send(buildPrompt());
    return;
  }

  const owner = await guild.fetchOwner();
  await owner.send({
    content: `I couldn't find a channel to post in on **${guild.name}**. Run \`/setup\` there to enter your project links.`,
  });
}

/** Send the setup prompt unless the guild is already set up or was already prompted. */
export async function promptIfNeeded(guild: Guild): Promise<void> {
  if (getProject(guild.id) || wasPrompted(guild.id)) return;
  try {
    await sendSetupPrompt(guild);
    markPrompted(guild.id);
    console.log(`Sent setup prompt to ${guild.name} (${guild.id})`);
  } catch (error) {
    console.error(`Failed to send setup prompt to ${guild.name} (${guild.id}):`, error);
  }
}

export function buildSetupModal(existing?: ProjectRow): ModalBuilder {
  const website = new TextInputBuilder()
    .setCustomId(WEBSITE_INPUT_ID)
    .setLabel('Website URL')
    .setPlaceholder('https://example.com')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(200);

  const github = new TextInputBuilder()
    .setCustomId(GITHUB_INPUT_ID)
    .setLabel('GitHub URL')
    .setPlaceholder('https://github.com/owner/repo')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(200);

  if (existing) {
    website.setValue(existing.website_url);
    github.setValue(existing.github_url);
  }

  return new ModalBuilder()
    .setCustomId(SETUP_MODAL_ID)
    .setTitle('Project setup')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(website),
      new ActionRowBuilder<TextInputBuilder>().addComponents(github),
    );
}

/** Returns a normalized http(s) URL string, or null if invalid. */
function parseHttpUrl(raw: string): string | null {
  const value = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseGithubUrl(raw: string): string | null {
  const url = parseHttpUrl(raw);
  if (!url) return null;
  const { hostname, pathname } = new URL(url);
  if (hostname !== 'github.com' && hostname !== 'www.github.com') return null;
  // Require at least an owner: github.com/owner or github.com/owner/repo
  if (pathname.split('/').filter(Boolean).length === 0) return null;
  return url;
}

export function canManageSetup(interaction: BaseInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

export async function openSetupModal(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): Promise<void> {
  if (!interaction.inGuild()) return;
  if (!canManageSetup(interaction)) {
    await interaction.reply({ content: MISSING_PERMISSION_MESSAGE, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.showModal(buildSetupModal(getProject(interaction.guildId)));
}

export async function handleSetupSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.inGuild()) return;
  if (!canManageSetup(interaction)) {
    await interaction.reply({ content: MISSING_PERMISSION_MESSAGE, flags: MessageFlags.Ephemeral });
    return;
  }

  const websiteUrl = parseHttpUrl(interaction.fields.getTextInputValue(WEBSITE_INPUT_ID));
  const githubUrl = parseGithubUrl(interaction.fields.getTextInputValue(GITHUB_INPUT_ID));

  if (!websiteUrl || !githubUrl) {
    const errors: string[] = [];
    if (!websiteUrl) errors.push('• The website must be a valid URL, e.g. `https://example.com`.');
    if (!githubUrl) errors.push('• The GitHub link must look like `https://github.com/owner/repo`.');
    await interaction.reply({
      content: `Couldn't save that:\n${errors.join('\n')}\nRun \`/setup\` to try again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  saveProject({
    guildId: interaction.guildId,
    guildName: interaction.guild?.name ?? null,
    websiteUrl,
    githubUrl,
    updatedBy: interaction.user.id,
  });

  const saved = getProject(interaction.guildId);
  if (saved) await interaction.reply({ embeds: [projectEmbed(saved)] });
}

export function projectEmbed(project: ProjectRow): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('Project links saved')
    .addFields(
      { name: 'Website', value: project.website_url },
      { name: 'GitHub', value: project.github_url },
    )
    .setFooter({ text: 'Use /setup to change these.' })
    .setTimestamp(new Date(`${project.updated_at}Z`))
    .setColor(0x57f287);
}
