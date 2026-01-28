import express, { Router } from 'express'
import { getAllCommissions, getCommissionStat } from '../controllers/commissionController.mjs';

const commissionRoute = Router();
commissionRoute.get('/stats/:companyId', getCommissionStat);
commissionRoute.get('/all/:companyId', getAllCommissions);

export default commissionRoute;