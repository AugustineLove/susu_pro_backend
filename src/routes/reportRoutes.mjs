import { Router } from "express";
import { getAllCustomersForReport, getDashboardReport } from "../controllers/reportsController.mjs";

const reportRoutes = Router();

reportRoutes.get('/customers', getAllCustomersForReport)
reportRoutes.get('/dashboard/:companyId', getDashboardReport);

export default reportRoutes;