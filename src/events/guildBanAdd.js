import { Events } from 'discord.js';
import { handleGuildBanAdd } from '../services/altDetectService.js';

/**
 * Alt Detector bookkeeping: when a member is banned, keep any existing
 * alt-account flag honest (flagged alts banned by staff or by the detector
 * move to the terminal 'banned' status) so `/altdetect list` and future
 * rejoin alerts stay accurate.
 */
export default {
  name: Events.GuildBanAdd,
  once: false,

  async execute(ban) {
    await handleGuildBanAdd(ban);
  },
};
