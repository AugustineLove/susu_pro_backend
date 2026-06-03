import { Router } from "express";
import { deductCommission, stakeMoney } from "../controllers/stakeController.mjs";
import { approveTransaction, deleteTransaction, getCompanyTransactions, getRecentTransactions, getTransactionsByAccount, getTransactionsByCustomer, getTransactionsByStaff, rejectTransaction, reverseWithdrawal, transferBetweenAccounts } from "../controllers/transactionController.mjs";
import { getWithdrawals } from "../controllers/withdrawalController.mjs";
import { bulkStakeMoney } from "../controllers/bulkTransactions.mjs";
import { checkDayNotClosed } from "../middlewares/checkDayNotClosed.mjs";
import { approveBackdatedTransaction, bulkApproveBackdatedTransactions, getPendingBackdatedSummary, getPendingBackdatedTransactions, rejectBackdatedTransaction } from "../controllers/backDatedController.mjs";

export const transactionRouter = Router();

// Transaction creation
transactionRouter.post('/stake', checkDayNotClosed, stakeMoney);
transactionRouter.post('/bulk', bulkStakeMoney);
transactionRouter.post('/transfer-money', transferBetweenAccounts);

// Queries
transactionRouter.get('/staff/:staff_id', getTransactionsByStaff);
transactionRouter.get('/account/:account_id', getTransactionsByAccount);
transactionRouter.get('/customer/:customerId', getTransactionsByCustomer);
transactionRouter.get('/company/:company_id', getCompanyTransactions);
transactionRouter.get('/all/:company_id', getRecentTransactions);
transactionRouter.get('/all/withdrawals/:company_id', getWithdrawals);

// Commission
transactionRouter.post('/commission/:accountId', deductCommission);

// Pending backdated
transactionRouter.get(
  '/:companyId/pending-backdated',
  getPendingBackdatedTransactions
);

transactionRouter.get(
  '/:companyId/pending-backdated/summary',
  getPendingBackdatedSummary
);

transactionRouter.post(
  '/:companyId/pending-backdated/:transactionId/approve',
  approveBackdatedTransaction
);

transactionRouter.post(
  '/:companyId/pending-backdated/:transactionId/reject',
  rejectBackdatedTransaction
);

transactionRouter.post(
  '/:companyId/pending-backdated/bulk-approve',
  bulkApproveBackdatedTransactions
);

// Alternative approval endpoint
transactionRouter.post(
  '/approve-backdated',
  approveBackdatedTransaction
);

// Generic transaction actions
transactionRouter.post('/:transactionId/reverse', reverseWithdrawal);
transactionRouter.post('/:id/approve', approveTransaction);
transactionRouter.post('/:id/reject', rejectTransaction);
transactionRouter.delete('/:id', deleteTransaction);