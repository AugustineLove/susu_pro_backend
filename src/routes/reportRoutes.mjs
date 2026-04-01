import { Router } from "express";
import { getAllCustomersForReport, getDashboardReport } from "../controllers/reportsController.mjs";
import { getAccountantReport } from "../controllers/accountantReportController.mjs";

const reportRoutes = Router();

reportRoutes.get('/customers', getAllCustomersForReport)
reportRoutes.get('/dashboard/:companyId', getDashboardReport);
reportRoutes.get('/accountant/:companyId', getAccountantReport);

export default reportRoutes;