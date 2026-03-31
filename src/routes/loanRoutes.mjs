import express from 'express';
import {
  createIndividualLoan,
  createGroupLoan,
  getGroupLoanWithMembers,
  createP2PLoan,
  updateP2PStatus,
  logRepayment,
  getLoanRepayments,
  getLoans,
  getLoanById,
  getCustomerLoans,
  approveLoan,
  rejectLoan,
} from '../controllers/loanController.mjs';

const loanRoutes = express.Router();

// ── Create
loanRoutes.post('/individual',              createIndividualLoan);
loanRoutes.post('/group',                   createGroupLoan);
loanRoutes.post('/p2p',                     createP2PLoan);

// ── Read
loanRoutes.get('/',                         getLoans);                    // ?company_id=&type=&status=&page=&limit=
loanRoutes.get('/customer/:customerId',     getCustomerLoans);            // ?company_id=
loanRoutes.get('/:id',                      getLoanById);
loanRoutes.get('/:id/repayments',           getLoanRepayments);
loanRoutes.get('/group/:groupId/members',   getGroupLoanWithMembers);

// ── Actions
loanRoutes.post('/:id/repayment',           logRepayment);
loanRoutes.patch('/:id/approve',            approveLoan);
loanRoutes.patch('/:id/reject',             rejectLoan);
loanRoutes.patch('/p2p/:id/status',         updateP2PStatus);

export default loanRoutes;
