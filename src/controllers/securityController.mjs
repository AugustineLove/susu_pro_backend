import bcrypt from 'bcrypt';
import express from 'express';
import pool from "../db.mjs";
import speakeasy from "speakeasy";
import QRCode from "qrcode";


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

    const twoFA = await pool.query("SELECT two_factor_enabled, company_name FROM companies WHERE id = $1", [companyId]);
    const isEnabled = twoFA.rows[0].two_factor_enabled;
    const companyName = twoFA.rows[0].company_name;

    if (isEnabled) {
      await pool.query(
        "UPDATE companies SET two_factor_enabled = false, two_factor_secret = NULL WHERE id = $1",
        [companyId]
      );

      return res.json({ message: "Two-Factor Authentication disabled." });
    }

    const secret = speakeasy.generateSecret({
      name: `SusuPro (${companyName})`, // app name shown in Authenticator
      length: 20,
    });

   const result = await pool.query(
      `UPDATE companies
       SET two_factor_secret = $1, two_factor_enabled = false
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


export const verifyTwoFactor = async (req, res) => {
  try {
    const { companyId, token } = req.body;

    // Get secret from DB
    const result = await pool.query(
      `SELECT two_factor_secret FROM companies WHERE id=$1`,
      [companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Company not found" });
    }

    const secret = result.rows[0].two_factor_secret;
    
    const verified = speakeasy.totp.verify({
      secret: secret,
      encoding: "base32",
      token: token,
      window: 1,
    });

    console.log(verified);
    if (!verified) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    // Mark 2FA as enabled
    await pool.query(
      `UPDATE companies SET two_factor_enabled=true WHERE id=$1`,
      [companyId]
    );

    res.status(200).json({ message: "2FA verified & enabled successfully" });
  } catch (err) {
    console.error("Error verifying 2FA:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};
