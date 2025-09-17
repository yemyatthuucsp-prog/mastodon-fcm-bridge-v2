// api/subscribe.js
import { kv } from "@vercel/kv";
import { randomBytes, createECDH } from "crypto";

// Helper to encode keys in URL-safe Base64 (no changes here)
function toUrlSafeBase64(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export default async function handler(req, res) {
  const { v4: uuidv4 } = await import("uuid");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { fcmToken, mastodonToken, mastodonInstance } = req.body || {};

    if (!fcmToken || !mastodonToken || !mastodonInstance) {
      return res.status(400).json({
        error: "fcmToken, mastodonToken, and mastodonInstance are required.",
      });
    }

    // ✨ NEW: Check for an existing subscription using the FCM token
    const fcmKey = `fcm:${fcmToken}`;
    const existingSubscriptionId = await kv.get(fcmKey);

    if (existingSubscriptionId) {
      console.log(
        `Found existing subscription for FCM token: ${existingSubscriptionId}`
      );
      // Optional: You could fetch the full subscription data to verify it's still valid
      const subData = await kv.get(existingSubscriptionId);
      if (subData) {
        return res.status(200).json({
          message: "Subscription already exists.",
          subscriptionId: existingSubscriptionId,
        });
      }
    }
    // ✨ END NEW

    // --- If no subscription exists, proceed with creation ---

    // Clean up the instance URL (no changes here)
    let cleanInstance = mastodonInstance.trim();
    if (!cleanInstance.startsWith("http")) {
      cleanInstance = `https://${cleanInstance}`;
    }
    cleanInstance = cleanInstance.replace(/\/$/, "");

    const subscriptionId = uuidv4();
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const publicKey = ecdh.getPublicKey();
    const privateKey = ecdh.getPrivateKey();
    const authSecret = randomBytes(16);

    const subscriptionData = {
      fcmToken,
      mastodonInstance: cleanInstance,
      keys: {
        privateKey: privateKey.toString("base64"),
        auth: authSecret.toString("base64"),
      },
    };

    const webhookUrl = `https://mastodon-fcm-bridge-beta.vercel.app/api/notify?id=${subscriptionId}`;

    const mastodonResponse = await fetch(
      `${cleanInstance}/api/v1/push/subscription`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mastodonToken}`,
        },
        body: JSON.stringify({
          subscription: {
            endpoint: webhookUrl,
            keys: {
              p256dh: toUrlSafeBase64(publicKey),
              auth: toUrlSafeBase64(authSecret),
            },
          },
          data: {
            alerts: {
              follow: true,
              favourite: true,
              reblog: true,
              mention: true,
              poll: true,
            },
          },
        }),
      }
    );

    if (!mastodonResponse.ok) {
        const errorData = await mastodonResponse.text();
        console.error("Mastodon API responded with error:", errorData);
        return res.status(500).json({
            error: "Mastodon API error",
            details: errorData,
        });
    }
    
    // ✨ NEW: Store the subscription data AND the lookup keys in KV
    const thirtyDaysInSeconds = 60 * 60 * 24 * 30;
    const fcmKeyLookup = `sub_id:${subscriptionId}`;

    await kv.set(subscriptionId, subscriptionData, { ex: thirtyDaysInSeconds });
    await kv.set(fcmKey, subscriptionId, { ex: thirtyDaysInSeconds }); // fcmToken -> subscriptionId
    await kv.set(fcmKeyLookup, fcmKey, { ex: thirtyDaysInSeconds }); // subscriptionId -> fcmToken (for easy deletion)


    console.log(`Mastodon subscription created successfully for instance: ${cleanInstance}`);
    return res.status(200).json({
      message: "Subscription created successfully.",
      subscriptionId,
    });
  } catch (error) {
    console.error("Unhandled error in subscription handler:", error);
    return res
      .status(500)
      .json({ error: "Internal Server Error", details: error.message });
  }
}