import pool from '../../db.mjs';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
export const changeStaffPassword = async (req, res) => {
  const { staff_id, current_password, new_password, companyId } = req.body;

  console.log(req.body);

  if (!staff_id || !current_password || !new_password) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  try {
    const { rows } = await pool.query(
      `SELECT password_hash FROM staff 
       WHERE id = $1 AND company_id = $2`,
      [staff_id, companyId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Staff not found." });
    }

    const passwordMatch = await bcrypt.compare(
      current_password,
      rows[0].password_hash
    );

    if (!passwordMatch) {
      return res.status(400).json({ error: "Current password is incorrect." });
    }

    const newHash = await bcrypt.hash(new_password, 10);

    await pool.query(
      `UPDATE staff 
       SET password_hash = $1 
       WHERE id = $2 AND company_id = $3`,
      [newHash, staff_id, companyId]
    );

    return res.status(200).json({
      message: "Staff password updated successfully.",
    });
  } catch (error) {
    console.error("Change staff password error:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

export const forceResetPassword = async (req, res) => {
  const { staff_id, current_password, new_password, companyId } = req.body;


  if (!staff_id || !current_password || !new_password) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  try {
    const { rows } = await pool.query(
      `SELECT password_hash FROM staff 
       WHERE id = $1 AND company_id = $2`,
      [staff_id, companyId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Staff not found." });
    }

    const passwordMatch = await bcrypt.compare(
      current_password,
      rows[0].password_hash
    );

    if (!passwordMatch) {
      return res.status(400).json({ error: "Current password is incorrect." });
    }

    const newHash = await bcrypt.hash(new_password, 10);

    await pool.query(
      `UPDATE staff 
       SET password_hash = $1, change_password_after_signin = FALSE
       WHERE id = $2 AND company_id = $3`,
      [newHash, staff_id, companyId]
    );

    return res.status(200).json({
      message: "Staff password updated successfully.",
    });
  } catch (error) {
    console.error("Change staff password error:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

export const updateStaffDetails = async (req, res) => {
  const { staff_id } = req.params;
  const { full_name, email, phone_number, role, companyId } = req.body;

  try {
    const { rows } = await pool.query(
      `SELECT id FROM staff 
       WHERE id = $1 AND company_id = $2`,
      [staff_id, companyId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Staff not found." });
    }

    await pool.query(
      `UPDATE staff
       SET 
         full_name = COALESCE($1, full_name),
         email = COALESCE($2, email),
         phone_number = COALESCE($3, phone_number),
         role = COALESCE($4, role)
       WHERE id = $5 AND company_id = $6`,
      [full_name, email, phone_number, role, staff_id, companyId]
    );

    return res.status(200).json({
      message: "Staff details updated successfully.",
    });
  } catch (error) {
    console.error("Update staff error:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

export const deactivateStaff = async (req, res) => {
  const { staff_id } = req.params;
  const { companyId } = req.body;

  try {
    const { rows } = await pool.query(
      `SELECT id FROM staff 
       WHERE id = $1 AND company_id = $2`,
      [staff_id, companyId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Staff not found." });
    }

    await pool.query(
      `UPDATE staff
       SET status = 'inactive'
       WHERE id = $1 AND company_id = $2`,
      [staff_id, companyId]
    );

    return res.status(200).json({
      message: "Staff deactivated successfully.",
    });
  } catch (error) {
    console.error("Deactivate staff error:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

export const reactivateStaff = async (req, res) => {
  const { staff_id } = req.params;
  const { companyId } = req.body;

  try {
    await pool.query(
      `UPDATE staff
       SET status = 'active'
       WHERE id = $1 AND company_id = $2`,
      [staff_id, companyId]
    );

    return res.status(200).json({
      message: "Staff reactivated successfully.",
    });
  } catch (error) {
    console.error("Reactivate staff error:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

export const adminResetStaffPassword = async (req, res) => {
  const { staff_id } = req.params;
  const { newPassword, companyId } = req.body;
  console.log(req.body, staff_id)

  if (!newPassword) {
    return res.status(400).json({ error: "New password is required." });
  }

  try {
    // Check staff exists
    const { rows } = await pool.query(
      `SELECT id FROM staff 
       WHERE id = $1 AND company_id = $2`,
      [staff_id, companyId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Staff not found." });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await pool.query(
      `UPDATE staff 
       SET password_hash = $1, change_password_after_signin = TRUE 
       WHERE id = $2 AND company_id = $3`,
      [hashedPassword, staff_id, companyId]
    );

    return res.status(200).json({
      message: "Password reset successfully.",
    });
  } catch (error) {
    console.error("Admin reset password error:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};
