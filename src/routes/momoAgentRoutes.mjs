import { Router } from "express";
import { getPendingMomoWithdrawals, getWithdrawalById, updateWithdrawalProcessingStatus } from "../controllers/momoAgentController.mjs";

const momoAgentRouter = Router();

momoAgentRouter.get('/withdrawals/pending', getPendingMomoWithdrawals)
momoAgentRouter.get('/withdrawals/:transactionId/processing-status', updateWithdrawalProcessingStatus);
momoAgentRouter.get('/withdrawals/:transactionId', getWithdrawalById);

export default momoAgentRouter;