// ── AI Audit Module ─────────────────────────────────────────────────────────
// Cross-references GitHub state vs on-chain bounty state to detect discrepancies
// Pins the audit report to Filecoin via Pinata for verifiable, immutable proof

const STATUS_NAMES = ["OPEN", "ASSIGNED", "PR_SUBMITTED", "MERGED", "COMPLETED", "CANCELLED"];

async function pinToIPFS(report) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) return null;
  try {
    const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        pinataContent: report,
        pinataMetadata: { name: `mergeX-audit-${Date.now()}` },
      }),
    });
    const data = await res.json();
    return data.IpfsHash || null;
  } catch {
    return null;
  }
}

async function resolveGithubToken({ owner, repo, githubRequest, getGithubAppPrivateKey, createGithubAppJwt }) {
  const appId = process.env.GITHUB_APP_ID;
  const { key: privateKey } = getGithubAppPrivateKey();
  let ghToken = process.env.GITHUB_TOKEN;

  if (appId && privateKey) {
    try {
      const appJwt = createGithubAppJwt(appId, privateKey);
      const inst = await githubRequest(`/repos/${owner}/${repo}/installation`, { token: appJwt });
      const tok = await githubRequest(`/app/installations/${inst.id}/access_tokens`, { token: appJwt, method: "POST" });
      ghToken = tok?.token || ghToken;
    } catch { /* fallback to PAT */ }
  }

  return ghToken;
}

async function fetchAllIssues(owner, repo, ghToken, githubRequest) {
  const issues = [];
  for (const state of ["open", "closed"]) {
    let page = 1;
    while (true) {
      const data = await githubRequest(
        `/repos/${owner}/${repo}/issues?state=${state}&per_page=100&page=${page}`,
        { token: ghToken }
      );
      if (!Array.isArray(data) || data.length === 0) break;
      // GitHub returns PRs as issues — filter them out
      issues.push(...data.filter(i => !i.pull_request));
      if (data.length < 100) break;
      if (++page > 5) break;
    }
  }
  return issues;
}

async function fetchMergedPRs(owner, repo, ghToken, githubRequest) {
  const merged = [];
  let page = 1;
  while (true) {
    const data = await githubRequest(
      `/repos/${owner}/${repo}/pulls?state=closed&per_page=100&page=${page}`,
      { token: ghToken }
    );
    if (!Array.isArray(data) || data.length === 0) break;
    merged.push(...data.filter(pr => pr.merged_at));
    if (data.length < 100) break;
    if (++page > 3) break;
  }
  return merged;
}

function detectDiscrepancies(allIssues, mergedPRs, bounties) {
  const bountyByIssueUrl = new Map();
  const bountyByPrUrl = new Map();

  for (const b of bounties) {
    if (b.githubIssueUrl) bountyByIssueUrl.set(b.githubIssueUrl, b);
    if (b.prUrl) bountyByPrUrl.set(b.prUrl, b);
  }

  const discrepancies = [];

  // Check 1: Open issue with no on-chain bounty
  for (const issue of allIssues.filter(i => i.state === "open")) {
    if (!bountyByIssueUrl.has(issue.html_url)) {
      discrepancies.push({
        type: "UNREGISTERED_OPEN_ISSUE",
        severity: "LOW",
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueUrl: issue.html_url,
        description: `Issue #${issue.number} "${issue.title}" is open on GitHub but has no on-chain bounty registered.`,
      });
    }
  }

  // Check 2: Closed issue with bounty still active (not COMPLETED or CANCELLED)
  for (const issue of allIssues.filter(i => i.state === "closed")) {
    const bounty = bountyByIssueUrl.get(issue.html_url);
    if (bounty && ![4, 5].includes(Number(bounty.status))) {
      discrepancies.push({
        type: "CLOSED_ISSUE_UNSETTLED_BOUNTY",
        severity: "HIGH",
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueUrl: issue.html_url,
        bountyId: bounty.id?.toString(),
        bountyStatus: STATUS_NAMES[Number(bounty.status)] || String(bounty.status),
        description: `Issue #${issue.number} "${issue.title}" is CLOSED on GitHub but its on-chain bounty is still ${STATUS_NAMES[Number(bounty.status)] || bounty.status}. Contributor may not have been paid.`,
      });
    }
  }

  // Check 3 (smoking gun): PR merged on GitHub but bounty is CANCELLED — possible code theft
  for (const pr of mergedPRs) {
    const bounty = bountyByPrUrl.get(pr.html_url);
    if (bounty && Number(bounty.status) === 5) {
      discrepancies.push({
        type: "MERGED_PR_REJECTED_BOUNTY",
        severity: "CRITICAL",
        prNumber: pr.number,
        prTitle: pr.title,
        prUrl: pr.html_url,
        bountyId: bounty.id?.toString(),
        description: `PR #${pr.number} "${pr.title}" was MERGED on GitHub but its on-chain bounty was CANCELLED/REJECTED. This strongly suggests code appropriation — the contributor's work was used without payment.`,
      });
    }
  }

  // Check 4: Bounty ASSIGNED but corresponding GitHub issue is closed/missing
  for (const bounty of bounties.filter(b => Number(b.status) === 1)) {
    const issue = allIssues.find(i => i.html_url === bounty.githubIssueUrl);
    if (issue && issue.state === "closed") {
      discrepancies.push({
        type: "ASSIGNED_BOUNTY_CLOSED_ISSUE",
        severity: "MEDIUM",
        bountyId: bounty.id?.toString(),
        issueUrl: bounty.githubIssueUrl,
        issueTitle: bounty.title,
        description: `Bounty #${bounty.id} is ASSIGNED on-chain but the corresponding GitHub issue was closed. The contributor may be unable to complete the work.`,
      });
    }
  }

  return discrepancies;
}

async function runAIAnalysis(discrepancies, repoUrl, stats) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey || discrepancies.length === 0) {
    return {
      overallRisk: discrepancies.length === 0 ? "LOW" : "MEDIUM",
      riskScore: discrepancies.length === 0 ? 0 : 40,
      summary: discrepancies.length === 0
        ? "No discrepancies found. The repository appears to be operating with integrity."
        : "Discrepancies detected. Manual review recommended.",
      findings: [],
    };
  }

  const prompt = `You are an expert auditor for a decentralized open-source bounty platform. Your job is to analyze discrepancies between a GitHub repository and its on-chain smart contract state to detect potential fraud, code theft, or contributor exploitation.

Repository: ${repoUrl}
Issues scanned: ${stats.totalIssues} | Merged PRs scanned: ${stats.mergedPRs} | Discrepancies found: ${stats.discrepanciesFound}

Discrepancies:
${JSON.stringify(discrepancies, null, 2)}

Severity guide:
- CRITICAL (MERGED_PR_REJECTED_BOUNTY): Strong indicator of code theft — treat as serious
- HIGH (CLOSED_ISSUE_UNSETTLED_BOUNTY): Contributor likely not paid for completed work
- MEDIUM (ASSIGNED_BOUNTY_CLOSED_ISSUE): Operational issue, may block contributor
- LOW (UNREGISTERED_OPEN_ISSUE): Informational, may be intentional

For each discrepancy assess suspicion (1-10), likely explanation, and recommended action.

Respond ONLY with valid JSON, no markdown:
{
  "overallRisk": "LOW|MEDIUM|HIGH|CRITICAL",
  "riskScore": <0-100>,
  "summary": "<2-3 sentence assessment>",
  "findings": [
    {
      "type": "<discrepancy type>",
      "suspicionScore": <1-10>,
      "explanation": "<most likely explanation>",
      "action": "<recommended action for contributors or platform>"
    }
  ]
}`;

  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1200,
        temperature: 0.1,
      }),
    });
    const groqData = await groqRes.json();
    const raw = groqData.choices?.[0]?.message?.content || "{}";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch {
    return null;
  }
}

export function registerAuditRoutes(app, { githubRequest, getGithubAppPrivateKey, createGithubAppJwt }) {
  app.post("/api/audit-repo", async (req, res) => {
    const { repoUrl, bounties = [] } = req.body;
    if (!repoUrl) return res.status(400).json({ error: "repoUrl is required" });

    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) return res.status(400).json({ error: "Invalid GitHub repo URL" });
    const [, owner, repo] = match;

    try {
      const ghToken = await resolveGithubToken({
        owner, repo, githubRequest, getGithubAppPrivateKey, createGithubAppJwt,
      });
      if (!ghToken) return res.status(500).json({ error: "No GitHub token available" });

      const [allIssues, mergedPRs] = await Promise.all([
        fetchAllIssues(owner, repo, ghToken, githubRequest),
        fetchMergedPRs(owner, repo, ghToken, githubRequest),
      ]);

      const discrepancies = detectDiscrepancies(allIssues, mergedPRs, bounties);

      const stats = {
        totalIssues: allIssues.length,
        mergedPRs: mergedPRs.length,
        discrepanciesFound: discrepancies.length,
        critical: discrepancies.filter(d => d.severity === "CRITICAL").length,
        high: discrepancies.filter(d => d.severity === "HIGH").length,
        medium: discrepancies.filter(d => d.severity === "MEDIUM").length,
        low: discrepancies.filter(d => d.severity === "LOW").length,
      };

      const aiAnalysis = await runAIAnalysis(discrepancies, repoUrl, stats);

      const report = {
        repoUrl,
        timestamp: new Date().toISOString(),
        stats,
        discrepancies,
        aiAnalysis,
      };

      const cid = await pinToIPFS(report);

      console.log(`[audit] ${repoUrl} — ${discrepancies.length} discrepancies${cid ? ` — CID: ${cid}` : ""}`);
      return res.json({ ...report, cid });

    } catch (err) {
      console.error("audit-repo error:", err);
      return res.status(500).json({ error: err.message });
    }
  });
}
