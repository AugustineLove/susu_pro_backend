import express from "express";
import {
  getAccountingRules,
  getTransactionTypes,
  createAccountingRule,
  updateAccountingRule,
  deleteAccountingRule,
  seedAccountingRules,
  previewAccountingRule,
} from "../controllers/accountingRulesController.mjs";

const accountingRulesRouter = express.Router({ mergeParams: true });

// All routes are scoped under /api/:companyId/accounting-rules

accountingRulesRouter.get  ("/",                  getAccountingRules);
accountingRulesRouter.get  ("/transaction-types", getTransactionTypes);
accountingRulesRouter.get  ("/preview",           previewAccountingRule);
accountingRulesRouter.post ("/",                  createAccountingRule);
accountingRulesRouter.post ("/seed",              seedAccountingRules);
accountingRulesRouter.patch("/:ruleId",           updateAccountingRule);
accountingRulesRouter.delete("/:ruleId",          deleteAccountingRule);

export default accountingRulesRouter;