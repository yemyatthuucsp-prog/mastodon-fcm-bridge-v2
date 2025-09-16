// api/subscribe.js
import { kv } from "@vercel/kv";
import { randomBytes, createECDH } from "crypto";

// Helper to encode keys in URL-safe Base64
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
    // ✨ CHANGED: Added 'mastodonInstance' to the request body
    const { fcmToken, mastodonToken, mastodonInstance } = req.body || {};

    // ✨ CHANGED: Updated validation to require 'mastodonInstance'
    if (!fcmToken || !mastodonToken || !mastodonInstance) {
      return res.status(400).json({
        error: "fcmToken, mastodonToken, and mastodonInstance are required.",
      });
    }

    // Clean up the instance URL to ensure it has a protocol and no trailing slash
    let cleanInstance = mastodonInstance.trim();
    if (!cleanInstance.startsWith("http")) {
      cleanInstance = `https://${cleanInstance}`;
    }
    cleanInstance = cleanInstance.replace(/\/$/, "");

    // 1️⃣ Generate a unique subscription ID
    const subscriptionId = uuidv4();

    // 2️⃣ Generate correct Web Push subscription keys
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const publicKey = ecdh.getPublicKey();
    const privateKey = ecdh.getPrivateKey();
    const authSecret = randomBytes(16);
    console.log(`Generated keys for subscription ID: ${subscriptionId}`);
    console.log(`privateKey: ${privateKey}`);

    // 3️⃣ Store mapping in Vercel KV, now including the instance URL
    const subscriptionData = {
      fcmToken,
      mastodonInstance: cleanInstance, // ✨ ADDED: Store the Mastodon instance URL
      keys: {
        privateKey: privateKey.toString("base64"),
        auth: authSecret.toString("base64"),
      },
    };
    console.log("KV_REST_API_URL:", process.env.KV_REST_API_URL);
    console.log("KV_REST_API_TOKEN exists:", process.env.KV_REST_API_TOKEN);
    await kv.set(subscriptionId, subscriptionData, { ex: 60 * 60 * 24 * 30 }); // 30 days

    // 4️⃣ Construct the webhook URL
    const host = process.env.VERCEL_URL || req.headers.host;
    const webhookUrl = `https://${host}/api/notify?id=${subscriptionId}`;

    // 5️⃣ Register webhook with the user's Mastodon instance dynamically
    // ✨ CHANGED: The Mastodon API URL is now built dynamically
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
      await kv.del(subscriptionId);
      return res.status(500).json({
        error: "Mastodon API error",
        details: errorData,
      });
    }

    console.log(
      `Mastodon subscription created successfully for instance: ${cleanInstance}`
    );
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
