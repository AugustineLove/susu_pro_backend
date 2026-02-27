import { Router } from "express";
import { deductCommission, stakeMoney } from "../controllers/stakeController.mjs";
import { approveTransaction, deleteTransaction, getCompanyTransactions, getRecentTransactions, getTransactionsByAccount, getTransactionsByCustomer, getTransactionsByStaff, rejectTransaction, reverseWithdrawal, transferBetweenAccounts } from "../controllers/transactionController.mjs";
import { getWithdrawals } from "../controllers/withdrawalController.mjs";

export const transactionRouter = Router();

transactionRouter.post('/stake', stakeMoney);
transactionRouter.get('/staff/:staff_id', getTransactionsByStaff);
transactionRouter.get('/account/:account_id', getTransactionsByAccount);
transactionRouter.get('/customer/:customerId', getTransactionsByCustomer); 
transactionRouter.get('/company/:company_id', getCompanyTransactions);
transactionRouter.get('/all/:company_id', getRecentTransactions);
transactionRouter.post('/:id/approve', approveTransaction);
transactionRouter.post('/:id/reject', rejectTransaction);
transactionRouter.delete('/:id', deleteTransaction);
transactionRouter.post('/commission/:accountId', deductCommission);
transactionRouter.post('/:transactionId/reverse', reverseWithdrawal);
transactionRouter.post('/transfer-money', transferBetweenAccounts);
transactionRouter.get('/all/withdrawals/:company_id', getWithdrawals)