import bcrypt from 'bcrypt';
import express from 'express';
import pool from "../db.mjs";
import speakeasy from "speakeasy";
import QRCode from "qrcode";

export const changeUserPassword = async (req, res) => {
    const { currentPassword, newPassword, companyId } = req.body;
    if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Missing password fields.' });
  }

  try {
    const { rows: company} = await pool.query('SELECT password_hash FROM companies WHERE id = $1', [companyId]);
    if(company.length === 0){
        return res.status(401).json({status: 'error', message: 'Company does not exist'});
    }
    
    // Verify current password matches stored hash
    const passwordMatch = await bcrypt.compare(currentPassword, company[0].password_hash);
    if (!passwordMatch) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }

    
    // Hash new password and update in DB
    const newHash = await bcrypt.hash(newPassword, 10);
    
    await pool.query('UPDATE companies SET password_hash = $1 WHERE id = $2', [newHash, companyId]);

    return res.status(200).json({ message: 'Password updated successfully.' });
  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}

export const setTwoStepVerification = async (req, res) => {
  const { companyId } = req.body;

  if (!companyId) {
    return res.status(400).json({ error: "companyId is required" });
  }

  try {

     const companyRes = await pool.query(
      "SELECT two_factor_enabled FROM companies WHERE id = $1",
      [companyId]
    );

    if (companyRes.rows.length === 0) {
      return res.status(404).json({ error: "Company not found" });
    }

    const twoFA = await pool.query("SELECT two_factor_enabled from companies where id = $1", [companyId]);
    const isEnabled = twoFA.rows[0].two_factor_enabled;

    if (isEnabled) {
      await pool.query(
        "UPDATE companies SET two_factor_enabled = false, two_factor_secret = NULL WHERE id = $1",
        [companyId]
      );

      return res.json({ message: "Two-Factor Authentication disabled." });
    }

    const secret = speakeasy.generateSecret({
      name: "MyApp (Company Account)", // app name shown in Authenticator
      length: 20,
    });

   const result = await pool.query(
      `UPDATE companies
       SET two_factor_secret = $1, two_factor_enabled = TRUE
       WHERE id = $2
       RETURNING id, company_name, two_factor_enabled`,
      [secret.base32, companyId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Company not found" });
    }

    // Step 3: Generate QR Code for frontend
    const otpauthUrl = secret.otpauth_url;
    const qrCodeImageUrl = await QRCode.toDataURL(otpauthUrl);

    return res.json({
      message: "Two-factor authentication enabled",
      secret: secret.base32, 
      qrCode: qrCodeImageUrl, 
      company: result.rows[0],
    });
  } catch (err) {
    console.error("Error enabling 2FA:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
