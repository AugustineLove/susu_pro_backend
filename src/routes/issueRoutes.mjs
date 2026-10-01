// routes/issueRoutes.mjs

import express from 'express';
import {
  createIssue,
  getIssues,
  getIssueStats,
  getAssignees,
  getIssueDetail,
  updateIssue,
  addComment,
  deleteIssue,
} from '../controllers/issueController.mjs';

const issueRouter = express.Router();

issueRouter.get('/detail/:id', getIssueDetail);

issueRouter.post('/', createIssue);
issueRouter.patch('/:id', updateIssue);
issueRouter.delete('/:id', deleteIssue);
issueRouter.post('/:id/comments', addComment);

issueRouter.get('/:company_id/stats', getIssueStats);
issueRouter.get('/:company_id/assignees', getAssignees);
issueRouter.get('/:company_id', getIssues);

export default issueRouter;
