import {
  ActionRows,
  Database,
  Embeds,
  MembershipCollection,
  MembershipRoleCollection,
  MembershipRoleDoc,
  YouTubeChannelDoc,
} from '@divine-bridge/common';
import { OCRService, supportedOCRLanguages } from '@divine-bridge/ocr-service';
import {
  Attachment,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Guild,
  RepliableInteraction,
  SlashCommandBuilder,
} from 'discord.js';

import { ChatInputCommand } from '../structures/chat-input-command.js';
import { Env } from '../utils/env.js';
import { Utils } from '../utils/index.js';
import { Validators } from '../utils/validators.js';

export class VerifyCommand extends ChatInputCommand {
  public readonly command = this.commandFactory({ alias: false });
  public readonly global = true;
  public readonly guildOnly = true;

  public constructor(context: ChatInputCommand.Context) {
    super(context);
  }

  public commandFactory(
    args:
      | {
          alias: false;
        }
      | {
          alias: true;
          name: string;
          youtubeChannelTitle: string;
        },
  ) {
    const command = new SlashCommandBuilder()
      .setName(args.alias ? args.name : 'verify')
      .setDescription(
        `Provide a screenshot and verify your ${
          args.alias ? args.youtubeChannelTitle : 'YouTube'
        } membership in this server.`,
      )
      .addAttachmentOption((option) =>
        option
          .setName('screenshot')
          .setDescription('Your YouTube membership proof screenshot')
          .setRequired(true),
      );
    if (!args.alias) {
      // Global command
      command
        .addStringOption((option) =>
          option
            .setName('membership_role')
            .setDescription('The membership role you would like to apply for in this server')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .setDMPermission(false);
    }
    command.addStringOption((option) =>
      option
        .setName('language')
        .setDescription('The language of the text in your picture')
        .addChoices(
          ...supportedOCRLanguages.map(({ language, code }) => ({
            name: language,
            value: code,
          })),
        )
        .setRequired(false),
    );

    return command;
  }

  public override async autocomplete(
    interaction: AutocompleteInteraction,
    { guild }: ChatInputCommand.AutocompleteContext,
  ) {
    const focusedOption = interaction.options.getFocused(true);
    if (focusedOption.name === 'membership_role') {
      const keyword = focusedOption.value.toLocaleLowerCase();
      const membershipRoleDocs = await MembershipRoleCollection.find({ guild: guild.id })
        .limit(25)
        .populate<{
          youtube: YouTubeChannelDoc | null;
        }>('youtube');
      const filteredMembershipRoleDocs = membershipRoleDocs.filter(
        (
          membershipRoleDoc,
        ): membershipRoleDoc is Omit<MembershipRoleDoc, 'youtube'> & {
          youtube: YouTubeChannelDoc;
        } => membershipRoleDoc.youtube !== null,
      );

      const searchedMembershipRoleDocs = filteredMembershipRoleDocs.filter((membershipRoleDoc) => {
        const { title, customUrl } = membershipRoleDoc.youtube.profile;
        const { name } = membershipRoleDoc.profile;
        if (
          title.toLocaleLowerCase().includes(keyword) ||
          customUrl.toLocaleLowerCase().includes(keyword) ||
          name.toLocaleLowerCase().includes(keyword)
        ) {
          return true;
        }
      });

      await interaction.respond(
        (searchedMembershipRoleDocs.length > 0
          ? searchedMembershipRoleDocs
          : filteredMembershipRoleDocs
        ).map((membershipRoleDoc) => ({
          name: `${membershipRoleDoc.youtube.profile.title} (${membershipRoleDoc.youtube.profile.customUrl}) - @${membershipRoleDoc.profile.name}`,
          value: membershipRoleDoc._id,
        })),
      );
    }
  }

  public async execute(
    interaction: ChatInputCommandInteraction,
    { guild }: ChatInputCommand.ExecuteContext,
  ) {
    const { options } = interaction;

    const picture = options.getAttachment('screenshot', true);
    const membershipRoleId = options.getString('membership_role', true);
    const langCode = options.getString('language');

    await this._execute(interaction, { guild, picture, membershipRoleId, langCode });
  }

  public async executeAlias(
    interaction: ChatInputCommandInteraction,
    args: { membershipRoleId: string },
  ) {
    const { guild, options } = interaction;
    const { membershipRoleId } = args;
    if (guild === null) return;

    const picture = options.getAttachment('screenshot', true);
    const langCode = options.getString('language');

    await this._execute(interaction, { guild, picture, membershipRoleId, langCode });
  }

  private async _execute(
    interaction: ChatInputCommandInteraction,
    args: {
      guild: Guild;
      picture: Attachment;
      membershipRoleId: string;
      langCode: string | null;
    },
  ) {
    const { user } = interaction;
    const { guild, picture, membershipRoleId, langCode } = args;

    await interaction.deferReply({ ephemeral: true });

    // Get user attachment
    if (!(picture.contentType?.startsWith('image/') ?? false)) {
      return await interaction.editReply({
        content: 'Please provide an image file.',
      });
    }

    // Get membership role
    const membershipRoleResult = await Validators.isGuildHasMembershipRole(
      guild.id,
      membershipRoleId,
    );
    if (!membershipRoleResult.success) {
      return await interaction.editReply({
        content: membershipRoleResult.error,
      });
    }
    const membershipRoleDoc = membershipRoleResult.data;

    // Upsert user config, check log channel
    const [userDoc, logChannelResult] = await Promise.all([
      Database.upsertUser({
        id: user.id,
        username: user.username,
        image: user.displayAvatarURL(),
      }),
      Validators.isGuildHasLogChannel(guild),
    ]);
    if (!logChannelResult.success) {
      return await interaction.editReply({
        content: logChannelResult.error,
      });
    }
    const logChannel = logChannelResult.data;

    // Get language
    let selectedLanguage: (typeof supportedOCRLanguages)[number];
    if (langCode === null) {
      selectedLanguage = supportedOCRLanguages.find(
        ({ code }) => code === userDoc.preference.language,
      ) ?? { language: 'English', code: 'eng' };
    } else {
      selectedLanguage = supportedOCRLanguages.find(({ code }) => code === langCode) ?? {
        language: 'English',
        code: 'eng',
      };
    }

    // Check if the user already has `auth` or `live_chat` membership
    const existingMembershipDoc = await MembershipCollection.findOne({
      user: user.id,
      membershipRole: membershipRoleId,
    });
    let activeInteraction: RepliableInteraction = interaction;
    if (
      existingMembershipDoc !== null &&
      (existingMembershipDoc.type === 'auth' || existingMembershipDoc.type === 'live_chat')
    ) {
      const confirmedResult = await Utils.awaitUserConfirm(
        activeInteraction,
        'verify-detected-oauth',
        {
          content:
            `You already have a membership with this membership role, which is periodically renewed with ${existingMembershipDoc.type === 'auth' ? 'your authorized YouTube channel credentials' : 'your message activity in the live chat room'}.\n` +
            'If your screenshot request is accepted, your current membership will be overwritten and no longer be renewed automatically. Do you want to continue?',
        },
      );
      if (!confirmedResult.confirmed) return;
      activeInteraction = confirmedResult.interaction;
      await activeInteraction.deferReply({ ephemeral: true });
    }

    // Save user config to DB
    userDoc.preference.language = selectedLanguage.code;
    await userDoc.save();

    // Send response to user
    const screenshotSubmission = Embeds.screenshotSubmission(
      Utils.convertUser(user),
      membershipRoleDoc,
      selectedLanguage.language,
      guild.name,
      picture.url,
    );
    await activeInteraction.editReply({
      embeds: [screenshotSubmission],
    });

    // Send picture to membership service for OCR
    // ? Do not send error to user if OCR failed due to errors that are not related to the user
    const ocrService = new OCRService(Env.OCR_API_ENDPOINT, Env.OCR_API_KEY);
    const recognizedResult = await ocrService.recognizeBillingDate(
      picture.url,
      selectedLanguage.code,
    );
    if (!recognizedResult.success) {
      this.bot.logger.error(recognizedResult.error);
    }
    const recognizedDate = recognizedResult.success
      ? recognizedResult.date
      : { year: null, month: null, day: null };

    const adminActionRow = ActionRows.adminVerificationButton();
    const membershipVerificationRequestEmbed = Embeds.membershipVerificationRequest(
      Utils.convertUser(user),
      recognizedDate,
      membershipRoleDoc._id,
      selectedLanguage.language,
      picture.url,
    );

    await logChannel.send({
      components: [adminActionRow],
      embeds: [membershipVerificationRequestEmbed],
    });
  }
}
