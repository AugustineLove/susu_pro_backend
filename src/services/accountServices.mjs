import pool from "../db.mjs";
import { normalizeAccountType } from "../utils/helpers.mjs";

export const getAccountCountByType = async (customerId, suffix) => {
  const result = await pool.query(
    `
    SELECT COUNT(*)::int AS count
    FROM accounts
    WHERE customer_id = $1
    AND account_number LIKE $2
    `,
    [customerId, `%${suffix}%`]
  );

  return result.rows[0].count;
};


export const generateAccountNumber = async ({
  customerId,
  baseNumber,
  accountType
}) => {
  const suffix = normalizeAccountType(accountType);

  const count = await getAccountCountByType(customerId, suffix);
  const nextIndex = count + 1;

  return `${baseNumber}${suffix}${nextIndex}`;
};

export const getCustomerBaseAccountNumber = async (customerId) => {
  const result = await pool.query(
    `
    SELECT account_number
    FROM customers
    WHERE id = $1
    ORDER BY created_at ASC
    LIMIT 1
    `,
    [customerId]
  );

  if (result.rowCount === 0) {
    throw new Error("Customer has no existing account");
  }

  return result.rows[0].account_number.replace(/(SU|SA)\d+$/, "");
};
