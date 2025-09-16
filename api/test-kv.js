import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  try {
    await kv.set("debug:test-key", "hello-world", { ex: 30 });
    const value = await kv.get("debug:test-key");
    return res.status(200).json({ success: true, value });
  } catch (error) {
    console.error("KV test failed:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
