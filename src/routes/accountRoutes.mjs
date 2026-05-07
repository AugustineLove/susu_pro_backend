import { Router } from "express";
import { createAccount, getAccountsByCustomer, getAllCompanyAccounts, getLastAccountNumber, getLastAccountNumbersByStaff, getLastCustomerAccountNumber, toggleAccountStatus } from "../controllers/accountController.mjs";
import { authenticateToken } from "../middlewares/authenticateToken.mjs";
import { replaceAccountCard, unlockAccount, updateAccountSettings, verifyTransactionPin } from "../controllers/accountSettingsController.mjs";

export const accountRouter = Router();



accountRouter.post('/create', createAccount);
accountRouter.get('/customer/:customerId', getAccountsByCustomer);
accountRouter.get('/company/:companyId', getAllCompanyAccounts);
accountRouter.get('/last-account-number/:staffId', getLastAccountNumber);
accountRouter.get(
  '/last-account-numbers',
  getLastAccountNumbersByStaff
);
accountRouter.get('/last-customer-account-number/:staffId', getLastCustomerAccountNumber);

accountRouter.patch('/:accountId/toggle-status', toggleAccountStatus);
accountRouter.patch(
  "/:accountId/settings",
  authenticateToken,
  updateAccountSettings
);
 
accountRouter.post("/:accountId/card/replace", authenticateToken, replaceAccountCard);
 
accountRouter.post("/:accountId/unlock", unlockAccount);
accountRouter.post("/:accountId/pin/verify", verifyTransactionPin);