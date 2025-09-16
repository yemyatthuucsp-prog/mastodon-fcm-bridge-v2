// api/notify.js
import { kv } from "@vercel/kv";
import admin from "firebase-admin";
import http_ece from "http_ece";
import { createECDH } from "crypto";

// Initialize Firebase Admin
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString(
      "utf-8"
    )
  );
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

export const config = {
  api: {
    bodyParser: false,
  },
};

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ error: "Subscription ID is missing." });
    }

    const subscription = await kv.get(id);
    if (!subscription) {
      return res.status(404).json({ error: "Subscription not found." });
    }

    // ✨ CHANGED: Retrieve 'mastodonInstance' from the subscription data
    const { fcmToken, mastodonInstance, keys } = subscription;

    // ✨ CHANGED: Updated validation to check for 'mastodonInstance'
    if (
      !fcmToken ||
      !mastodonInstance ||
      !keys ||
      !keys.privateKey ||
      !keys.auth
    ) {
      return res
        .status(500)
        .json({ error: "Invalid subscription data in KV." });
    }

    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(keys.privateKey, "base64"));
    const authSecret = Buffer.from(keys.auth, "base64");

    let decryptedPayload;
    try {
      const rawBody = await buffer(req);
      const params = {
        version: "aesgcm",
        privateKey: ecdh,
        authSecret: authSecret,
        dh: req.headers["crypto-key"]?.split(";")[0]?.split("=")[1],
        salt: req.headers["encryption"]?.split("=")[1],
      };
      decryptedPayload = http_ece.decrypt(rawBody, params);
    } catch (decryptError) {
      console.error("Failed to decrypt notification:", decryptError);
      return res
        .status(500)
        .json({ error: "Decryption failed", details: decryptError.message });
    }

    const notificationData = JSON.parse(decryptedPayload.toString("utf-8"));
    console.log(
      `✅ Successfully decrypted Mastodon Notification from ${mastodonInstance}:`,
      notificationData
    );

    let fullNotification = {};
    try {
      const { notification_id, access_token } = notificationData;
      if (!notification_id || !access_token) {
        throw new Error(
          "Missing notification_id or access_token in webhook payload."
        );
      }

      // ✨ CHANGED: The fetch URL is now built dynamically using the stored instance
      const mastodonAPIResponse = await fetch(
        `${mastodonInstance}/api/v1/notifications/${notification_id}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${access_token}`,
          },
        }
      );

      if (!mastodonAPIResponse.ok) {
        throw new Error(
          `Mastodon API failed with status: ${mastodonAPIResponse.status}`
        );
      }

      fullNotification = await mastodonAPIResponse.json();
      console.log(
        "✅ Successfully fetched full notification:",
        fullNotification
      );
    } catch (fetchError) {
      console.error("Could not fetch full notification details:", fetchError);
    }

    const mastodonStatus = fullNotification.status || {};

    const fcmMessage = {
      notification: {
        title: "Patchwork",
        body: notificationData.title || "You have a new notification",
      },
      token: fcmToken,
      data: {
        noti_type:
          fullNotification.type ||
          notificationData.notification_type ||
          "unknown",
        reblogged_id: mastodonStatus.reblog?.id || "0",
        destination_id: mastodonStatus.id || "",
        visibility: mastodonStatus.visibility || "public",
      },
    };

    try {
      const fcmResponse = await admin.messaging().send(fcmMessage);
      console.log("FCM sent successfully:", fcmResponse);
    } catch (fcmError) {
      console.error("FCM send failed:", fcmError);
      if (fcmError.code === "messaging/registration-token-not-registered") {
        await kv.del(id);
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Unhandled error in notify handler:", error);
    return res
      .status(500)
      .json({ error: "Internal Server Error", details: error.message });
  }
}
