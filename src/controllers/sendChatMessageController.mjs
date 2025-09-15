
import admin from 'firebase-admin';
import dotenv from 'dotenv';
dotenv.config();
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

export const sendChatMessage = async (req, res) => {
  try {
    const { companyId, staffId, title, body, data } = req.body;

    if (!companyId || !staffId) {
      return res.status(400).json({ error: "companyId and staffId are required" });
    }

    // Get staff token from Firestore
    const staffRef = db.doc(`companies/${companyId}/staff/${staffId}`);
    const staffDoc = await staffRef.get();

    if (!staffDoc.exists) {
      return res.status(404).json({ error: "Staff not found" });
    }

    const staffData = staffDoc.data();
    const fcmToken = staffData?.fcmToken;

    if (!fcmToken) {
      return res.status(400).json({ error: "Staff does not have an FCM token" });
    }

    console.log("fcm Token:", fcmToken);
    // Build notification payload
    const payload = {
      notification: {
        title: title || "Notification",
        body: body,
      },
      data: data || {}, // optional custom data
    };

    // Send notification
    const response = await admin.messaging().sendEachForMulticast({
    tokens: [fcmToken],
    notification: {
      title: title || "Notification",
      body: body || "",
      },
      data: data || {},
    });

    console.log("FCM response:", response);


    console.log(response.body);
    return res.json({ success: true, message: "Notification sent" });
  } catch (err) {
    console.error("Error sending notification:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};


export const sendMessageToWeb = async (req, res) => {
  try {
    const { companyId, title, body, data } = req.body;

    if (!companyId) {
      return res.status(400).json({ error: "companyId is required" });
    }

    // Get all web tokens for the company
    const tokensSnap = await db
      .collection(`companies/${companyId}/tokens`)
      .where("platform", "==", "web")
      .get();

    if (tokensSnap.empty) {
      return res.status(404).json({ error: "No web tokens found for this company" });
    }

    const tokens = [];
    tokensSnap.forEach(doc => {
      const tokenData = doc.data();
      if (tokenData.token) tokens.push(tokenData.token);
    });

    // Build payload
    const payload = {
      notification: {
        title: title || "New Message",
        body: body || "",
      },
      data: data || {},
    };

    // Send to multiple web tokens
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      ...payload,
    });

    console.log("FCM response:", response);

    return res.json({
      success: true,
      sent: response.successCount,
      failed: response.failureCount,
    });

  } catch (err) {
    console.error("Error sending web notification:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
