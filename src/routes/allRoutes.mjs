import { Router } from 'express';
import pool from '../db.mjs';
import companyRoutes from './companyRoutes.mjs';
import { staffRoutes } from './staffRoutes.mjs';
import { customerRouter } from './customerRoutes.mjs';
import { accountRouter } from './accountRoutes.mjs';
import { transactionRouter } from './transactionRoutes.mjs';
import authRouter from './auth/authRoutes.mjs';
import { messageRouter } from './messageRoutes.mjs';
import { financeRoutes } from './expenseRoutes.mjs';

const allRoutes = Router();

allRoutes.use('/api/auth', authRouter);
allRoutes.use('/api/staff', staffRoutes);
allRoutes.use('/api/companies', companyRoutes);
allRoutes.use('/api/customers', customerRouter);
allRoutes.use('/api/accounts', accountRouter);
allRoutes.use('/api/transactions', transactionRouter);
allRoutes.use('/api/messages', messageRouter);
allRoutes.use('/api/financials', financeRoutes)


export default allRoutes;
