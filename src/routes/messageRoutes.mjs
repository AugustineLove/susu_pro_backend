import { Router } from "express";
import { sendCustomerMessage } from "../controllers/smsController.mjs";
import { sendChatMessage, sendMessageToWeb } from "../controllers/sendChatMessageController.mjs";
export const messageRouter = Router();

messageRouter.post('/send-customer', sendCustomerMessage);
messageRouter.post('/send-staff-notification', sendChatMessage);
messageRouter.post('/send-web-notification', sendMessageToWeb);
