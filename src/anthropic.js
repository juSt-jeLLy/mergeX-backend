// import express from "express"
// import cors from "cors"
// import fetch from "node-fetch"
// import dotenv from "dotenv"

// dotenv.config();
// const app = express();
// const PORT = 3005;

// app.use(cors({ origin: ["http://localhost:8080", "http://localhost:3000", "http://localhost:5173"] }));
// app.use(express.json({ limit: "10mb" }));

// // ── Gemini API proxy ───────────────────────────────────────────────────────────
// app.post("/api/analyze", async (req, res) => {
//   try {
//     // Convert Anthropic format to Gemini format
//     const { messages, max_tokens } = req.body;
//     const userMessage = messages.find(m => m.role === "user")?.content || "";
    
//     const geminiPayload = {
//       contents: [{
//         parts: [{
//           text: userMessage
//         }]
//       }],
//       generationConfig: {
//         maxOutputTokens: max_tokens || 1000,
//         temperature: 0.1
//       }
//     };

// const response = await fetch(
//   `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`,
//   {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json",
//     },
//     body: JSON.stringify(geminiPayload),
//   }
// );

//     const data = await response.json();

//     if (!response.ok) {
//       console.error("Gemini API error:", data);
//       return res.status(response.status).json({ error: data });
//     }

//     // Convert Gemini response format to Anthropic-compatible format
//     const geminiText = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
//     const anthropicCompatibleResponse = {
//       content: [{ text: geminiText }]
//     };

//     res.json(anthropicCompatibleResponse);
//   } catch (err) {
//     console.error("Gemini proxy error:", err.message);
//     res.status(500).json({ error: err.message });
//   }
// });

// // ── GitHub proxy ──────────────────────────────────────────────────────────────
// app.get(/^\/api\/github\/(.+)$/, async (req, res) => {
//   try {
//     const githubPath = req.params[0];
//     const queryString = new URLSearchParams(req.query).toString();
//     const url = `https://api.github.com/${githubPath}${queryString ? "?" + queryString : ""}`;

//     const headers = {
//       Accept: "application/vnd.github.v3+json",
//       "User-Agent": "RepoScan-App",
//     };

//     if (process.env.GITHUB_TOKEN) {
//       headers["Authorization"] = `token ${process.env.GITHUB_TOKEN}`;
//     }

//     const response = await fetch(url, { headers });
//     const data = await response.json();

//     res.status(response.status).json(data);
//   } catch (err) {
//     console.error("GitHub proxy error:", err.message);
//     res.status(500).json({ error: err.message });
//   }
// });
// // app.get("/api/github/:githubPath(*)", async (req, res) => {
// //   try {
// //     const githubPath = req.params[0];
// //     const queryString = new URLSearchParams(req.query).toString();
// //     const url = `https://api.github.com/${githubPath}${queryString ? "?" + queryString : ""}`;

// //     const headers = {
// //       Accept: "application/vnd.github.v3+json",
// //       "User-Agent": "RepoScan-App",
// //     };

// //     if (process.env.GITHUB_TOKEN) {
// //       headers["Authorization"] = `token ${process.env.GITHUB_TOKEN}`;
// //     }

// //     const response = await fetch(url, { headers });
// //     const data = await response.json();

// //     res.status(response.status).json(data);
// //   } catch (err) {
// //     console.error("GitHub proxy error:", err.message);
// //     res.status(500).json({ error: err.message });
// //   }
// // });

// // ── health check ──────────────────────────────────────────────────────────────
// app.get("/health", (_, res) => res.json({ status: "ok" }));

// app.listen(PORT, () => {
//   console.log(`✅ RepoScan proxy server running on http://localhost:${PORT}`);
//   console.log(`   Google AI API key: ${process.env.GOOGLE_AI_API_KEY ? "✅ loaded" : "❌ missing"}`);
//   console.log(`   GitHub token:      ${process.env.GITHUB_TOKEN ? "✅ loaded" : "⚠️  not set (rate limits apply)"}`);
// });

import express from "express"
import cors from "cors"
import fetch from "node-fetch"
import dotenv from "dotenv"

dotenv.config();
const app = express();
const PORT = 3005;

const localOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || localOriginPattern.test(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
  })
);
app.use(express.json({ limit: "10mb" }));

// ── Groq API proxy ─────────────────────────────────────────────────────────────
app.post("/api/analyze", async (req, res) => {
  try {
    const { messages, max_tokens } = req.body;
    const bountySystem = {
      role: "system",
      content:
        "When the user asks for JSON findings or suggestions, always include a 'bountyEth' field. bountyEth must be between 0.0001 and 0.0005 ETH. Use severity/priority mapping: CRITICAL=0.0005, HIGH=0.0004, MEDIUM=0.0003, LOW=0.0002, INFO=0.0001. For improvements use priority mapping: HIGH=0.0005, MEDIUM=0.0003, LOW=0.0001. Return bountyEth as a numeric string in ETH (up to 6 decimals).",
    };

    const groqPayload = {
      model: "llama-3.3-70b-versatile", // Free tier model on Groq
      messages: Array.isArray(messages) ? [bountySystem, ...messages] : [bountySystem],
      max_tokens: max_tokens || 1000,
      temperature: 0.1,
    };

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(groqPayload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Groq API error:", data);
      return res.status(response.status).json({ error: data });
    }

    // Convert Groq response to Anthropic-compatible format
    const groqText = data.choices?.[0]?.message?.content || "[]";
    const anthropicCompatibleResponse = {
      content: [{ text: groqText }]
    };

    res.json(anthropicCompatibleResponse);
  } catch (err) {
    console.error("Groq proxy error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GitHub proxy ──────────────────────────────────────────────────────────────
app.get(/^\/api\/github\/(.+)$/, async (req, res) => {
  try {
    const githubPath = req.params[0];
    const queryString = new URLSearchParams(req.query).toString();
    const url = `https://api.github.com/${githubPath}${queryString ? "?" + queryString : ""}`;

    const headers = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "RepoScan-App",
    };

    if (process.env.GITHUB_TOKEN) {
      headers["Authorization"] = `token ${process.env.GITHUB_TOKEN}`;
    }

    const response = await fetch(url, { headers });
    const data = await response.json();

    res.status(response.status).json(data);
  } catch (err) {
    console.error("GitHub proxy error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── health check ──────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`✅ RepoScan proxy server running on http://localhost:${PORT}`);
  console.log(`   Groq API key:  ${process.env.GROQ_API_KEY ? "✅ loaded" : "❌ missing"}`);
  console.log(`   GitHub token:  ${process.env.GITHUB_TOKEN ? "✅ loaded" : "⚠️  not set (rate limits apply)"}`);
});
