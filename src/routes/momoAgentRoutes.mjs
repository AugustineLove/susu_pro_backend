import { Router } from "express";
import { getPendingMomoWithdrawals, getWithdrawalById, updateWithdrawalProcessingStatus } from "../controllers/momoAgentController.mjs";

const momoAgentRouter = Router();

momoAgentRouter.get('/withdrawals/pending', getPendingMomoWithdrawals)
momoAgentRouter.patch('/withdrawals/:transactionId/processing-status', updateWithdrawalProcessingStatus);
momoAgentRouter.get('/withdrawals/:transactionId', getWithdrawalById);

export default momoAgentRouter;