import { Router } from "express";
import { addSmsNumber, createCustomer, deleteCustomer, getCustomerByAccountNumber, getCustomerById, getCustomersByCompany, getCustomersByStaff, loginCustomer, removeSmsNumber, searchCustomers, toggleSendSms, udpateCustomerInfoMobile, updateCustomer } from "../controllers/customerController.mjs";
import { requirePermission } from "../middlewares/staffPermissions.mjs";
import { verifyCompanyToken } from "../middlewares/verifyCompany.mjs";
import { checkDayNotClosed } from "../middlewares/checkDayNotClosed.mjs";


export const customerRouter = Router();

customerRouter.post('/create', checkDayNotClosed, createCustomer);
customerRouter.get('/staff/:staffId', getCustomersByStaff);
customerRouter.get('/company/:companyId', getCustomersByCompany);
customerRouter.delete('/delete', deleteCustomer);
customerRouter.put('/update-mobile', udpateCustomerInfoMobile); 
customerRouter.get('/:customerId', getCustomerById);
customerRouter.put('/customer', updateCustomer);
customerRouter.get("/account/:accountNumber", getCustomerByAccountNumber);
customerRouter.post("/login", loginCustomer);
customerRouter.get("/:companyId/search", searchCustomers);
customerRouter.post("/:customerId/sms-numbers", addSmsNumber);
customerRouter.delete("/:customerId/sms-numbers", removeSmsNumber);
customerRouter.patch("/:customerId/toggle-sms", toggleSendSms)