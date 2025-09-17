// api/unsubscribe.js
import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { subscriptionId, mastodonToken, mastodonInstance } = req.body;

    if (!subscriptionId || !mastodonToken || !mastodonInstance) {
      return res.status(400).json({
        error:
          "subscriptionId, mastodonToken, and mastodonInstance are required.",
      });
    }

    // 1️⃣ Attempt to remove the push subscription from the Mastodon instance
    try {
      const mastodonResponse = await fetch(
        `${mastodonInstance}/api/v1/push/subscription`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${mastodonToken}`,
          },
        }
      );

      if (!mastodonResponse.ok) {
        // Log the error but don't block the process.
        // A 404 here is fine; it means the subscription was already gone.
        const errorData = await mastodonResponse.text();
        console.warn(
          `Mastodon API could not delete subscription (ID: ${subscriptionId}). It might have already been removed. Details: ${errorData}`
        );
      } else {
        console.log(
          `Successfully unsubscribed from Mastodon for ID: ${subscriptionId}`
        );
      }
    } catch (mastodonError) {
      console.error(
        `Error calling Mastodon API for unsubscription (ID: ${subscriptionId}):`,
        mastodonError
      );
      // We still proceed to delete our KV data.
    }

    // 2️⃣ Delete the subscription data from Vercel KV
    // We create a key to find our secondary index.
    const fcmKeyLookup = `sub_id:${subscriptionId}`;
    const fcmKey = await kv.get(fcmKeyLookup);

    if (fcmKey) {
        await kv.del(fcmKey); // Delete the fcmToken -> subscriptionId mapping
        await kv.del(fcmKeyLookup); // Delete the subscriptionId -> fcmToken mapping
    }
    await kv.del(subscriptionId); // Delete the main subscription object

    return res
      .status(200)
      .json({ message: "Unsubscribed successfully." });

  } catch (error) {
    console.error("Unhandled error in unsubscribe handler:", error);
    return res
      .status(500)
      .json({ error: "Internal Server Error", details: error.message });
  }
}