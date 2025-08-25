import { Router } from "express";
import sendCustomerMessage from "../controllers/smsController.mjs";
export const messageRouter = Router();

messageRouter.post('/send-customer', sendCustomerMessage);