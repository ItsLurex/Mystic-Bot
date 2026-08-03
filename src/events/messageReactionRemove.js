import { Events } from 'discord.js';
import { handleReactionRemove } from '../services/reactionRolePanelService.js';

export default {
  name: Events.MessageReactionRemove,
  once: false,
  async execute(reaction, user) {
    await handleReactionRemove(reaction, user);
  },
};
