import { editableMessageModal } from '../../../handlers/editableMessageButtons.js';
import {
  createTicketModalHandler,
  closeTicketModalHandler,
} from '../../../handlers/ticketButtons.js';

export default [
    createTicketModalHandler,
    closeTicketModalHandler,
    editableMessageModal,
];
