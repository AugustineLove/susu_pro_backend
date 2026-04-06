import { Router } from "express";
import { getAcquisitionReport, getAllBankers, getDistinctLocations, getFieldReport, getRetentionReport, getTargetVsActual } from "../controllers/salesManagerController.mjs";
const salesRoutes = Router();

salesRoutes.get('/:companyId/staff', getAllBankers);
salesRoutes.get('/:companyId/locations', getDistinctLocations);
salesRoutes.get('/:companyId/field-report', getFieldReport);
salesRoutes.get('/:companyId/target-vs-actual', getTargetVsActual);
salesRoutes.get('/:companyId/retention', getRetentionReport);
salesRoutes.get('/:companyId/acquisition', getAcquisitionReport);

export default salesRoutes;