import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { signRequest } from "@worldcoin/idkit-server";
import crypto from "node:crypto";
import { registerAuditRoutes } from "./audit.js";

dotenv.config();

const app = express();
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

app.use(cors({
  origin: [
    "http://localhost:5173",
    "http://localhost:8080",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8080",
    "https://e3f8-2409-40e5-1059-6da9-94c8-55e4-504c-5c6d.ngrok-free.app",
  ],
}));
app.use(express.json());

const toBase64Url = (value) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const getGithubAppPrivateKey = () => {
  const rawPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!rawPrivateKey) {
    return {
      key: null,
      error: "Missing GITHUB_APP_PRIVATE_KEY in backend environment.",
    };
  }

  const cleaned = rawPrivateKey.trim().replace(/^['"]|['"]$/g, "");

  if (cleaned.startsWith("SHA256:")) {
    return {
      key: null,
      error:
        "GITHUB_APP_PRIVATE_KEY is a fingerprint (SHA256:...). Paste the full PEM private key from the .pem download.",
    };
  }

  const parsedKey = cleaned.includes("\\n")
    ? cleaned.replace(/\\n/g, "\n")
    : cleaned;

  const isPkcs8Pem =
    parsedKey.includes("-----BEGIN PRIVATE KEY-----") &&
    parsedKey.includes("-----END PRIVATE KEY-----");
  const isPkcs1Pem =
    parsedKey.includes("-----BEGIN RSA PRIVATE KEY-----") &&
    parsedKey.includes("-----END RSA PRIVATE KEY-----");
  const isPem = isPkcs8Pem || isPkcs1Pem;

  if (!isPem) {
    return {
      key: null,
      error:
        "GITHUB_APP_PRIVATE_KEY must be the full PEM content (BEGIN/END PRIVATE KEY or BEGIN/END RSA PRIVATE KEY).",
    };
  }

  if (parsedKey.includes("...")) {
    return {
      key: null,
      error:
        "GITHUB_APP_PRIVATE_KEY appears to be a placeholder (contains '...'). Paste the full PEM private key content from your downloaded .pem file.",
    };
  }

  try {
    crypto.createPrivateKey(parsedKey);
  } catch {
    return {
      key: null,
      error:
        "GITHUB_APP_PRIVATE_KEY is not a valid PEM private key. Download a new private key in GitHub App settings and paste the entire file content.",
    };
  }

  return { key: parsedKey, error: null };
};

const createGithubAppJwt = (appId, privateKey) => {
  const now = Math.floor(Date.now() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = toBase64Url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    })
  );
  const unsignedToken = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();

  const signature = signer
    .sign(privateKey, "base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  return `${unsignedToken}.${signature}`;
};


const parseRepoInput = (repoInput) => {
  if (!repoInput || typeof repoInput !== "string") {
    return null;
  }

  const trimmed = repoInput.trim();
  if (!trimmed) {
    return null;
  }

  const ownerRepoMatch = trimmed.match(
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/
  );
  if (ownerRepoMatch) {
    return {
      owner: ownerRepoMatch[1],
      repo: ownerRepoMatch[2],
    };
  }

  const normalized = trimmed.startsWith("git@github.com:")
    ? `https://github.com/${trimmed.slice("git@github.com:".length)}`
    : trimmed;

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") {
      return null;
    }

    const [owner, repoSegment] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !repoSegment) {
      return null;
    }

    return {
      owner,
      repo: repoSegment.replace(/\.git$/i, ""),
    };
  } catch {
    return null;
  }
};

const githubRequest = async (
  path,
  { token, method = "GET", body } = {}
) => {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const rawBody = await response.text();
  let payload = null;

  if (rawBody) {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = { message: rawBody };
    }
  }

  if (!response.ok) {
    const err = new Error(
      payload?.message || `GitHub API failed with HTTP ${response.status}`
    );
    err.status = response.status;
    err.payload = payload;
    throw err;
  }

  return payload;
};

const fetchGithubCollection = async (path, token, maxPages = 10) => {
  const allItems = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const pageData = await githubRequest(
      `${path}${separator}per_page=100&page=${page}`,
      { token }
    );

    if (!Array.isArray(pageData) || pageData.length === 0) {
      break;
    }

    allItems.push(...pageData);

    if (pageData.length < 100) {
      break;
    }
  }

  return allItems;
};

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

app.get("/api/github/repo-snapshot", async (req, res) => {
  const { repoUrl } = req.query;
  const parsedRepo = parseRepoInput(repoUrl);
  const appId = process.env.GITHUB_APP_ID;
  const { key: privateKey, error: privateKeyError } = getGithubAppPrivateKey();

  if (!parsedRepo) {
    return res.status(400).json({
      error:
        "Provide a valid GitHub URL (https://github.com/owner/repo) or owner/repo.",
    });
  }

  if (!appId) {
    return res.status(500).json({
      error: "Missing GITHUB_APP_ID in backend environment.",
    });
  }

  if (privateKeyError || !privateKey) {
    return res.status(500).json({
      error: privateKeyError || "Missing GITHUB_APP_PRIVATE_KEY.",
    });
  }

  const { owner, repo } = parsedRepo;

  try {
    const appJwt = createGithubAppJwt(appId, privateKey);
    let installation;

    try {
      installation = await githubRequest(`/repos/${owner}/${repo}/installation`, {
        token: appJwt,
      });
    } catch (installationError) {
      if (installationError?.status === 404) {
        let installUrl = process.env.GITHUB_APP_INSTALL_URL || null;
        let appSlug = process.env.GITHUB_APP_SLUG || null;

        if (!installUrl) {
          try {
            const appInfo = await githubRequest("/app", { token: appJwt });
            appSlug = appInfo?.slug || appSlug;
            if (appSlug) {
              installUrl = `https://github.com/apps/${appSlug}/installations/new`;
            }
          } catch (appInfoError) {
            console.warn("Could not load app slug for install URL:", appInfoError);
          }
        }

        return res.status(404).json({
          error:
            "GitHub App is not installed on this repository yet. Install it, then retry.",
          notInstalled: true,
          owner,
          repo,
          appSlug,
          installUrl,
        });
      }

      throw installationError;
    }

    const installationTokenResponse = await githubRequest(
      `/app/installations/${installation.id}/access_tokens`,
      {
        token: appJwt,
        method: "POST",
      }
    );

    const installationToken = installationTokenResponse?.token;
    if (!installationToken) {
      throw new Error("Failed to create installation token.");
    }

    const repoData = await githubRequest(`/repos/${owner}/${repo}`, {
      token: installationToken,
    });

    const [issuesData, pullRequestsData, rootContents, repoTree] =
      await Promise.all([
        fetchGithubCollection(
          `/repos/${owner}/${repo}/issues?state=all&sort=updated&direction=desc`,
          installationToken
        ),
        fetchGithubCollection(
          `/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc`,
          installationToken
        ),
        githubRequest(`/repos/${owner}/${repo}/contents`, {
          token: installationToken,
        }).catch(() => []),
        githubRequest(
          `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(
            repoData.default_branch
          )}?recursive=1`,
          { token: installationToken }
        ).catch(() => ({ tree: [], truncated: false })),
      ]);

    const issues = Array.isArray(issuesData)
      ? issuesData
          .filter((issue) => !issue.pull_request)
          .map((issue) => ({
            id: issue.id,
            number: issue.number,
            title: issue.title,
            state: issue.state,
            comments: issue.comments,
            user: issue.user?.login || "unknown",
            createdAt: issue.created_at,
            updatedAt: issue.updated_at,
            url: issue.html_url,
          }))
      : [];

    const pullRequests = Array.isArray(pullRequestsData)
      ? pullRequestsData.map((pr) => ({
          id: pr.id,
          number: pr.number,
          title: pr.title,
          state: pr.state,
          user: pr.user?.login || "unknown",
          draft: Boolean(pr.draft),
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
          mergedAt: pr.merged_at,
          url: pr.html_url,
        }))
      : [];

    const rootFiles = Array.isArray(rootContents)
      ? rootContents.map((item) => ({
          name: item.name,
          path: item.path,
          type: item.type,
          size: item.size || 0,
          url: item.html_url || item.url,
        }))
      : [];

    const treeEntries = Array.isArray(repoTree?.tree) ? repoTree.tree : [];
    const MAX_TREE_RESULTS = 5000;
    const fileTree = treeEntries.slice(0, MAX_TREE_RESULTS).map((entry) => ({
      path: entry.path,
      type: entry.type,
      size: entry.size || 0,
      sha: entry.sha,
      url:
        entry.type === "blob"
          ? `https://github.com/${owner}/${repo}/blob/${repoData.default_branch}/${entry.path}`
          : `https://github.com/${owner}/${repo}/tree/${repoData.default_branch}/${entry.path}`,
    }));

    return res.json({
      repo: {
        id: repoData.id,
        name: repoData.name,
        fullName: repoData.full_name,
        private: repoData.private,
        description: repoData.description,
        defaultBranch: repoData.default_branch,
        language: repoData.language,
        stars: repoData.stargazers_count,
        forks: repoData.forks_count,
        openIssuesCount: repoData.open_issues_count,
        htmlUrl: repoData.html_url,
        pushedAt: repoData.pushed_at,
        createdAt: repoData.created_at,
        updatedAt: repoData.updated_at,
      },
      issues,
      pullRequests,
      rootFiles,
      fileTree,
      summary: {
        issueCount: issues.length,
        pullRequestCount: pullRequests.length,
        rootFileCount: rootFiles.length,
        treeEntryCount: treeEntries.length,
        treeTruncated:
          Boolean(repoTree?.truncated) || treeEntries.length > MAX_TREE_RESULTS,
        installationId: installation.id,
        tokenExpiresAt: installationTokenResponse?.expires_at,
      },
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("GitHub fetch failed:", error);

    if (error.status === 404) {
      return res.status(404).json({
        error:
          "Repository not found or the GitHub App is not installed on this repository.",
      });
    }

    if (error.status === 403) {
      return res.status(403).json({
        error:
          "GitHub denied access. Check app permissions and make sure it is installed on the target repo.",
      });
    }

    return res.status(error.status || 500).json({
      error: error.message || "Failed to fetch repository data from GitHub.",
      details: error.payload || null,
    });
  }
});

// ── GitHub App Webhook ──────────────────────────────────────────────────────

app.post("/api/github/create-issues", async (req, res) => {
  const { repoUrl, findings } = req.body;

  if (!findings || !Array.isArray(findings) || findings.length === 0) {
    return res.status(400).json({ error: "No findings provided." });
  }

  const parsedRepo = parseRepoInput(repoUrl);
  if (!parsedRepo) {
    return res.status(400).json({ error: "Invalid repo URL." });
  }

  const appId = process.env.GITHUB_APP_ID;
  const { key: privateKey, error: privateKeyError } = getGithubAppPrivateKey();

  if (!appId) {
    return res.status(500).json({ error: "Missing GITHUB_APP_ID in backend environment." });
  }
  if (privateKeyError || !privateKey) {
    return res.status(500).json({ error: privateKeyError || "Missing GITHUB_APP_PRIVATE_KEY." });
  }

  const { owner, repo } = parsedRepo;

  try {
    const appJwt = createGithubAppJwt(appId, privateKey);
    const installation = await githubRequest(`/repos/${owner}/${repo}/installation`, { token: appJwt });
    const tokenResponse = await githubRequest(
      `/app/installations/${installation.id}/access_tokens`,
      { token: appJwt, method: "POST" }
    );
    const installationToken = tokenResponse?.token;
    if (!installationToken) throw new Error("Failed to create installation token.");

    const severityEmoji = { CRITICAL: "🔴", HIGH: "🟠", MEDIUM: "🟡", LOW: "🟢", INFO: "🔵" };

    const created = [];
    for (const finding of findings) {
      const emoji = severityEmoji[finding.severity] || "⚪";
      const title = `${emoji} [${finding.severity}] ${finding.type} — ${finding.file}${finding.line ? `:${finding.line}` : ""}`;
      const body = `## Security Finding: ${finding.type}

**Severity:** \`${finding.severity}\`
**File:** \`${finding.file}${finding.line ? `:${finding.line}` : ""}\`

### Description
${finding.description}

### Suggested Fix
${finding.suggestion || "No suggestion provided."}

---
*Detected by mergeX AI Security Scanner*`;

      try {
        const issue = await githubRequest(`/repos/${owner}/${repo}/issues`, {
          token: installationToken,
          method: "POST",
          body: { title, body },
        });
        created.push({ number: issue.number, url: issue.html_url, title: issue.title });
      } catch (issueErr) {
        console.error(`Failed to create issue for "${finding.type}":`, issueErr.message);
        created.push({ error: issueErr.message, type: finding.type });
      }
    }

    return res.json({ created });
  } catch (error) {
    console.error("create-issues failed:", error);
    if (error.status === 404) {
      return res.status(404).json({ error: "GitHub App not installed on this repository." });
    }
    if (error.status === 403) {
      return res.status(403).json({ error: "GitHub App lacks issues write permission." });
    }
    return res.status(error.status || 500).json({ error: error.message });
  }
});

// ── PR Analysis ──────────────────────────────────────────────────────────────
const parsePRUrl = (url) => {
  try {
    const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!m) return null;
    return { owner: m[1], repo: m[2], prNumber: Number(m[3]) };
  } catch { return null; }
};

const parseIssueUrl = (url) => {
  try {
    const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (!m) return null;
    return { owner: m[1], repo: m[2], issueNumber: Number(m[3]) };
  } catch { return null; }
};

app.post("/api/analyze-pr", async (req, res) => {
  const { prUrl, issueUrl, issueTitle, issueDescription } = req.body;

  if (!prUrl) return res.status(400).json({ error: "prUrl is required" });

  const pr = parsePRUrl(prUrl);
  if (!pr) return res.status(400).json({ error: "Invalid GitHub PR URL" });

  const appId = process.env.GITHUB_APP_ID;
  const { key: privateKey } = getGithubAppPrivateKey();
  const fallbackToken = process.env.GITHUB_TOKEN;

  // Resolve a GitHub token (App installation preferred, fallback to PAT)
  let ghToken = fallbackToken;
  if (appId && privateKey) {
    try {
      const appJwt = createGithubAppJwt(appId, privateKey);
      const inst = await githubRequest(`/repos/${pr.owner}/${pr.repo}/installation`, { token: appJwt });
      const tok = await githubRequest(`/app/installations/${inst.id}/access_tokens`, { token: appJwt, method: "POST" });
      ghToken = tok?.token || fallbackToken;
    } catch { /* use fallback */ }
  }

  if (!ghToken) return res.status(500).json({ error: "No GitHub token available" });

  try {
    // Fetch PR + files in parallel; issue only if URL given
    const [prData, prFiles, issueData] = await Promise.all([
      githubRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.prNumber}`, { token: ghToken }),
      githubRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.prNumber}/files`, { token: ghToken }).catch(() => []),
      issueUrl ? (() => {
        const iss = parseIssueUrl(issueUrl);
        return iss ? githubRequest(`/repos/${iss.owner}/${iss.repo}/issues/${iss.issueNumber}`, { token: ghToken }).catch(() => null) : Promise.resolve(null);
      })() : Promise.resolve(null),
    ]);

    // Build diff summary — include meaningful patch per file (40 lines each)
    const files = Array.isArray(prFiles) ? prFiles : [];
    const filesSummary = files.slice(0, 15).map((f) => {
      let patch = "(binary or no patch)";
      if (f.patch) {
        const lines = f.patch.split("\n");
        const truncated = lines.length > 40;
        patch = lines.slice(0, 40).join("\n") + (truncated ? "\n... (patch truncated at 40 lines)" : "");
      }
      return `### ${f.filename} [${f.status}] +${f.additions}/-${f.deletions}\n\`\`\`diff\n${patch}\n\`\`\``;
    }).join("\n\n");

    const resolvedIssueTitle = issueData?.title || issueTitle || "(not provided)";
    const resolvedIssueBody = issueData?.body || issueDescription || "(not provided)";

    const prompt = `You are an expert code reviewer for a bug bounty platform. Your job is to deeply analyze a Pull Request and determine whether it correctly fixes the reported issue.

## REPORTED ISSUE
Title: ${resolvedIssueTitle}
Description:
${resolvedIssueBody.slice(0, 1500)}

## PULL REQUEST
Title: ${prData.title}
PR Description:
${(prData.body || "(no description)").slice(0, 800)}
Stats: ${prData.additions} additions, ${prData.deletions} deletions across ${files.length} file(s)

## CODE CHANGES
${filesSummary}

## YOUR ANALYSIS TASK
Review the code changes carefully. Check:
1. Does the code actually fix the root cause of the issue?
2. Are there any bugs, security issues, or regressions introduced?
3. Is the implementation correct and complete?
4. Are there edge cases not handled?

Respond ONLY with a JSON object — no markdown fences, no extra text:
{
  "verdict": "APPROVED" | "NEEDS_WORK" | "REJECTED",
  "confidence": <number 0-100>,
  "summary": "<2-3 sentence overall assessment of the PR>",
  "issueAddressed": <true|false>,
  "keyPoints": ["<specific finding about the code change>", "..."],
  "concerns": ["<bug, security issue, or missing case>", "..."],
  "codeQuality": "<one sentence on code quality, style, and correctness>",
  "recommendation": "<one clear action for the org — approve, request changes, or reject with reason>"
}`;

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        //model: "llama-3.3-70b-versatile",
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1200,
        temperature: 0.1,
      }),
    });

    const groqData = await groqRes.json();
    if (!groqRes.ok) return res.status(500).json({ error: "AI analysis failed", details: groqData });

    const rawText = groqData.choices?.[0]?.message?.content || "{}";
    let analysis;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
    } catch {
      analysis = { verdict: "NEEDS_WORK", confidence: 50, summary: rawText, issueAddressed: false, keyPoints: [], concerns: [], recommendation: "Manual review required" };
    }

    return res.json({
      analysis,
      pr: { title: prData.title, url: prUrl, filesChanged: (Array.isArray(prFiles) ? prFiles : []).length, additions: prData.additions, deletions: prData.deletions },
      issue: { title: resolvedIssueTitle, url: issueUrl },
    });
  } catch (err) {
    console.error("analyze-pr error:", err);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

registerAuditRoutes(app, { githubRequest, getGithubAppPrivateKey, createGithubAppJwt });

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "127.0.0.1";

const server = app.listen(PORT, HOST, () => {
  console.log(`✅ Backend running on http://${HOST}:${PORT}`);
});

server.on("error", (error) => {
  console.error(`❌ Failed to start backend on ${HOST}:${PORT}`);
  console.error(error);
  process.exit(1);
});
