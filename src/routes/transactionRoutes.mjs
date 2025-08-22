import { Router } from "express";
import { stakeMoney } from "../controllers/stakeController.mjs";
import { approveTransaction, getCompanyTransactions, getRecentTransactions, getTransactionsByAccount, getTransactionsByCustomer, getTransactionsByStaff, rejectTransaction } from "../controllers/transactionController.mjs";


export const transactionRouter = Router();

transactionRouter.post('/stake', stakeMoney);
transactionRouter.get('/staff/:staff_id', getTransactionsByStaff);
transactionRouter.get('/account/:account_id', getTransactionsByAccount);
transactionRouter.get('/customer/:customer_id', getTransactionsByCustomer); 
transactionRouter.get('/company/:company_id', getCompanyTransactions);
transactionRouter.get('/all/:company_id', getRecentTransactions);
transactionRouter.post('/:id/approve', approveTransaction);
transactionRouter.post('/:id/reject', rejectTransaction);