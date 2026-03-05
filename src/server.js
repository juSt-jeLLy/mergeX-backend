import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { signRequest } from "@worldcoin/idkit-server";

dotenv.config();

const app = express();

app.use(cors({
  origin: [
    "http://localhost:8080",
    "https://e3f8-2409-40e5-1059-6da9-94c8-55e4-504c-5c6d.ngrok-free.app",
  ],
}));
app.use(express.json());

// Route 1: Generate RP Signature
app.post("/api/rp-signature", (req, res) => {
  const { action } = req.body;
  const signingKey = process.env.RP_SIGNING_KEY;

  if (!signingKey) {
    return res.status(500).json({ error: "RP_SIGNING_KEY not set" });
  }

  try {
    const { sig, nonce, createdAt, expiresAt } = signRequest(action, signingKey);
    res.json({ sig, nonce, created_at: createdAt, expires_at: expiresAt });
  } catch (err) {
    console.error("signRequest error:", err);
    res.status(500).json({ error: "Failed to sign request" });
  }
});

app.post("/api/verify-proof", async (req, res) => {
  const { idkitResponse, action } = req.body;
  const rp_id = process.env.RP_ID;

  if (!rp_id) {
    return res.status(500).json({ error: "RP_ID not set" });
  }

  try {
    // ← unwrap .result, that's where the actual proof lives
    const proof = idkitResponse.result ?? idkitResponse;

    const response = await fetch(
      `https://developer.world.org/api/v4/verify/${rp_id}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...proof,
          action,
        }),
      }
    );

    const payload = await response.json();
    console.log("STATUS:", response.status);
    console.log("PAYLOAD:", JSON.stringify(payload, null, 2));

    res.status(response.status).json(payload);
  } catch (err) {
    console.error("CATCH ERROR:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

app.listen(3001, () => console.log("✅ Backend running on http://localhost:3001"));