import { Router } from "express";
import { addSmsNumber, createCustomer, deleteCustomer, findCustomers, getCustomerByAccountNumber, getCustomerById, getCustomersByCompany, getCustomersByStaff, loginCustomer, removeSmsNumber, searchCustomers, toggleSendSms, udpateCustomerInfoMobile, updateCustomer} from "../controllers/customerController.mjs";
import { requirePermission } from "../middlewares/staffPermissions.mjs";
import { verifyCompanyToken } from "../middlewares/verifyCompany.mjs";
import { checkDayNotClosed } from "../middlewares/checkDayNotClosed.mjs";
import { generateCustomerStatement } from "../controllers/customerAccountStatementController.mjs";
import { getCustomerAccounts, getCustomerCardReplacements, searchCustomer, updateCardReplacementStatus } from "../controllers/accountController.mjs";
import { authenticateToken } from "../middlewares/authenticateToken.mjs";


export const customerRouter = Router();

customerRouter.post('/create', createCustomer);
customerRouter.get('/staff/:staffId', getCustomersByStaff);
customerRouter.get('/search',authenticateToken, searchCustomer);
customerRouter.get('/:customerId/accounts', getCustomerAccounts);
customerRouter.get('/:customerId/card-replacements', authenticateToken, getCustomerCardReplacements);
customerRouter.put('/card-replacements/:replacementId/status', authenticateToken, updateCardReplacementStatus);
customerRouter.get('/company/:companyId', getCustomersByCompany);
customerRouter.get('/:customerId/statement', generateCustomerStatement);
customerRouter.delete('/delete', deleteCustomer);
customerRouter.put('/update-mobile', udpateCustomerInfoMobile); 
customerRouter.get('/:customerId', getCustomerById);
customerRouter.put('/customer', updateCustomer);
customerRouter.get("/account/:accountNumber", getCustomerByAccountNumber);
customerRouter.post("/login", loginCustomer);
customerRouter.get("/:companyId/search", searchCustomers);
customerRouter.get("/:companyId/find", findCustomers);
customerRouter.post("/:customerId/sms-numbers", addSmsNumber);
customerRouter.delete("/:customerId/sms-numbers", removeSmsNumber);
customerRouter.patch("/:customerId/toggle-sms", toggleSendSms)