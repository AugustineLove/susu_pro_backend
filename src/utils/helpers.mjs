export const normalizeAccountType = (type) => {
  const t = type.toLowerCase();
  if (t === "susu") return "SU";
  if (t === "savings") return "SA";
  throw new Error("Invalid account type");
};
