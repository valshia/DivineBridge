'use server';

import {
  AppEventLogService,
  GuildDoc,
  MembershipCollection,
  MembershipDoc,
  MembershipRoleDoc,
  MembershipService,
} from '@divine-bridge/common';
import { defaultLocale } from '@divine-bridge/i18n';
import { z } from 'zod';

import { authAction } from '.';
import type { DeleteAccountActionData } from '../../../types/server-actions';
import { cryptoUtils } from '../crypto';
import { discordBotApi } from '../discord';
import { googleOAuth } from '../google';
import { getServerTranslation } from '../i18n';
import { logger } from '../logger';

const deleteAccountActionInputSchema = z.object({});

export const deleteAccountAction = authAction<
  typeof deleteAccountActionInputSchema,
  DeleteAccountActionData
>(deleteAccountActionInputSchema, async (_input, { userDoc }) => {
  const userLocale = userDoc.preference.locale;
  const { original_t: t } = await getServerTranslation(undefined);

  // Revoke YouTube refresh token if user has connected their YouTube account
  if (userDoc.youtube !== null) {
    const decryptResult = cryptoUtils.decrypt(userDoc.youtube.refreshToken);
    if (decryptResult.success) {
      const { plain: refreshToken } = decryptResult;
      // Revoke YouTube refresh token
      // ? We don't do error handling here and proceed to remove the membership
      await googleOAuth.revokeRefreshToken(refreshToken);
    }
  }

  // Get user's memberships in DB
  const membershipDocs = await MembershipCollection.find({
    user: userDoc._id,
  }).populate<{
    membershipRole:
      | (Omit<MembershipRoleDoc, 'guild'> & {
          guild: GuildDoc | null;
        })
      | null;
  }>({ path: 'membershipRole', populate: 'guild' });

  // Split valid and invalid memberships
  const validMembershipDocs: (Omit<MembershipDoc, 'membershipRole'> & {
    membershipRole: Omit<MembershipRoleDoc, 'guild'> & {
      guild: GuildDoc;
    };
  })[] = [];
  const invalidMembershipDocs: (Omit<MembershipDoc, 'membershipRole'> & {
    membershipRole: null;
  })[] = [];
  for (const membershipDoc of membershipDocs) {
    if (membershipDoc.membershipRole !== null) {
      validMembershipDocs.push(
        membershipDoc as Omit<MembershipDoc, 'membershipRole'> & {
          membershipRole: Omit<MembershipRoleDoc, 'guild'> & {
            guild: GuildDoc;
          };
        },
      );
    } else {
      invalidMembershipDocs.push(
        membershipDoc as Omit<MembershipDoc, 'membershipRole'> & {
          membershipRole: null;
        },
      );
    }
  }

  // Remove invalid memberships
  await MembershipCollection.deleteMany({
    _id: {
      $in: invalidMembershipDocs.map((membershipDoc) => membershipDoc._id),
    },
  });

  // Group valid membership docs by guild
  const membershipDocRecord = validMembershipDocs.reduce<
    Record<
      string,
      (Omit<MembershipDoc, 'membershipRole'> & {
        membershipRole: Omit<MembershipRoleDoc, 'guild'> & {
          guild: GuildDoc;
        };
      })[]
    >
  >((prev, membershipDoc) => {
    const guildId = membershipDoc.membershipRole.guild._id;
    return { ...prev, [guildId]: [...(guildId in prev ? prev[guildId] : []), membershipDoc] };
  }, {});

  // Remove memberships by group
  for (const [guildId, membershipDocGroup] of Object.entries(membershipDocRecord)) {
    if (membershipDocGroup.length === 0) continue;

    const guildLocale = membershipDocGroup[0].membershipRole.guild.config.locale ?? defaultLocale;

    // Initialize log service and membership service
    const appEventLogService = await new AppEventLogService(
      (key) => t(key, guildLocale),
      logger,
      discordBotApi,
      guildId,
    ).init();
    const membershipService = new MembershipService(t, discordBotApi, appEventLogService);

    // Remove membership
    const failedRoleRemovalIds: string[] = [];
    for (const membershipDoc of membershipDocGroup) {
      const removeMembershipResult = await membershipService.remove({
        userLocale,
        guildLocale,
        guildId,
        membershipRoleDoc: membershipDoc.membershipRole,
        membershipDoc,
        removeReason: `you have deleted your account from Divine Bridge`,
        manual: false,
      });
      if (!removeMembershipResult.success || !removeMembershipResult.roleRemoved) {
        failedRoleRemovalIds.push(membershipDoc.membershipRole._id);
      }
    }

    // Send log to the log channel if there are failed role removals
    if (failedRoleRemovalIds.length > 0) {
      await appEventLogService.log({
        content:
          `The user <@!${userDoc._id}> has deleted their account from Divine Bridge.\n` +
          `However, I can't remove the following membership roles from the user:\n` +
          failedRoleRemovalIds.map((id) => `<@&${id}>`).join('\n') +
          `\n\nPlease manually remove the roles from the user, and check if the bot has correct permissions.`,
      });
    }
  }

  // Remove user from DB
  await userDoc.deleteOne();

  return {};
});