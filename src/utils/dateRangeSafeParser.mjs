export const buildDateRangeFilter = (startDate, endDate, paramIndex, values, whereConditions) => {
  if (startDate && endDate) {
    whereConditions.push(`
      DATE(t.transaction_date) BETWEEN $${paramIndex} AND $${paramIndex + 1}
    `);
    values.push(startDate, endDate);
    return paramIndex + 2;
  }

  if (startDate) {
    whereConditions.push(`DATE(t.transaction_date) >= $${paramIndex}`);
    values.push(startDate);
    return paramIndex + 1;
  }

  if (endDate) {
    whereConditions.push(`DATE(t.transaction_date) <= $${paramIndex}`);
    values.push(endDate);
    return paramIndex + 1;
  }

  return paramIndex;
};