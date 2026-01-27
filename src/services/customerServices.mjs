import db from "../db/index.mjs";
import { generateWithdrawalCode } from "../utils/withdrawalCode.mjs";

export const generateUniqueWithdrawalCode = async () => {
  let code;
  let exists = true;

  while (exists) {
    code = generateWithdrawalCode();

    const { rowCount } = await db.query(
      "SELECT 1 FROM customers WHERE withdrawal_code = $1",
      [code]
    );

    exists = rowCount > 0;
  }

  return code;
};
