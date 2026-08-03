import { Events } from 'discord.js';
import { handleReactionAdd } from '../services/reactionRolePanelService.js';

export default {
  name: Events.MessageReactionAdd,
  once: false,
  async execute(reaction, user) {
    await handleReactionAdd(reaction, user);
  },
};
