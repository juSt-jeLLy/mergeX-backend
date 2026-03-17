// ── AI Audit Module ─────────────────────────────────────────────────────────
// Cross-references GitHub state vs on-chain bounty state to detect discrepancies
// Stores the audit report to Filecoin via Synapse (store/pull/commit)
import crypto from "node:crypto";
import { Synapse, getChain } from "@filoz/synapse-sdk";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getPdpDataSets, getAllPieceMetadata } from "@filoz/synapse-core/warm-storage";
import { calculate as calculatePieceCID, parse as parsePieceCID } from "@filoz/synapse-core/piece";
import { resolvePieceUrl } from "@filoz/synapse-core/piece";

const STATUS_NAMES = ["OPEN", "ASSIGNED", "PR_SUBMITTED", "MERGED", "COMPLETED", "CANCELLED"];

let synapseClient = null;
let synapsePromise = null;

function normalizePrivateKey(raw) {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, "");
  if (trimmed.length === 42) {
    throw new Error("FILECOIN_PRIVATE_KEY looks like an address. Provide the 32-byte private key (0x...).");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error("FILECOIN_PRIVATE_KEY must be a 32-byte hex private key (0x + 64 hex chars).");
  }
  return trimmed;
}

async function getSynapseClient() {
  if (synapseClient) return synapseClient;
  if (synapsePromise) return synapsePromise;

  const privateKey = normalizePrivateKey(process.env.FILECOIN_PRIVATE_KEY);
  if (!privateKey) throw new Error("FILECOIN_PRIVATE_KEY is required for Filecoin storage.");

  const rpcUrl = process.env.FILECOIN_RPC_URL || "https://api.calibration.node.glif.io/rpc/v1";
  const chainId = Number(process.env.FILECOIN_CHAIN_ID || 314159);
  const account = privateKeyToAccount(privateKey);

  synapsePromise = Promise.resolve(
    Synapse.create({
      account,
      chain: getChain(chainId),
      transport: http(rpcUrl),
      withCDN: false,
    })
  )
    .then((client) => {
      synapseClient = client;
      return client;
    })
    .catch((err) => {
      synapsePromise = null;
      throw new Error(`Synapse init failed: ${err?.message || err}`);
    });

  return synapsePromise;
}

function getFilecoinConfig() {
  const privateKey = normalizePrivateKey(process.env.FILECOIN_PRIVATE_KEY);
  if (!privateKey) {
    throw new Error("FILECOIN_PRIVATE_KEY is required for Filecoin storage.");
  }
  const rpcUrl = process.env.FILECOIN_RPC_URL || "https://api.calibration.node.glif.io/rpc/v1";
  const chainId = Number(process.env.FILECOIN_CHAIN_ID || 314159);
  const account = privateKeyToAccount(privateKey);
  return { privateKey, rpcUrl, chainId, account };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function uploadWithRetry(synapse, data, options = {}, maxAttempts = 3) {
  let attempt = 0;
  let lastError = null;
  while (attempt < maxAttempts) {
    try {
      return await synapse.storage.upload(data, options);
    } catch (err) {
      lastError = err;
      const delay = Math.min(15000, 1000 * Math.pow(2, attempt));
      await sleep(delay);
      attempt += 1;
    }
  }
  throw lastError || new Error("Filecoin upload failed");
}

async function storeAuditOnFilecoin(report, repoUrl) {
  const json = JSON.stringify(report);
  const encoder = new TextEncoder();
  let bytes = encoder.encode(json);
  if (bytes.length < 127) {
    const pad = " ".repeat(127 - bytes.length);
    bytes = encoder.encode(json + pad);
  }

  const auditId = crypto.randomUUID();
  const synapse = await getSynapseClient();
  const copies = Math.max(1, Number(process.env.SYNAPSE_COPIES || 1));
  const calculatedCid = calculatePieceCID(bytes);
  const metadata = {
    source: "mergeX-audit",
    repoUrl: repoUrl || "",
    timestamp: new Date().toISOString(),
    auditId,
    pieceCid: calculatedCid?.toString?.() ?? String(calculatedCid),
  };

  const upload = await uploadWithRetry(
    synapse,
    bytes,
    {
      count: copies,
      pieceMetadata: metadata,
    },
    Number(process.env.SYNAPSE_RETRIES || 3)
  );

  return {
    pieceCid: upload.pieceCid?.toString?.() ?? String(upload.pieceCid),
    size: upload.size,
    copies: upload.copies?.length ?? 0,
    providers: (upload.copies || []).map((copy) => ({
      providerId: copy.providerId?.toString?.() ?? String(copy.providerId),
      dataSetId: copy.dataSetId?.toString?.() ?? String(copy.dataSetId),
      role: copy.role,
      retrievalUrl: copy.retrievalUrl,
    })),
    failures: upload.failures || [],
    auditId,
    timestamp: metadata.timestamp,
    repoUrl: metadata.repoUrl,
  };
}

function toBountiesSnapshot(bounties) {
  if (!Array.isArray(bounties)) return [];
  return bounties.map((b) => ({
    id: b.id?.toString?.() ?? b.id,
    status: b.status,
    githubIssueUrl: b.githubIssueUrl,
    prUrl: b.prUrl,
    amount: b.amount,
    title: b.title,
    severity: b.severity,
  }));
}

async function storeEventAudit({ repoUrl, bounties, event }) {
  const timestamp = new Date().toISOString();
  const report = {
    repoUrl,
    timestamp,
    event,
    snapshot: {
      bounties: toBountiesSnapshot(bounties),
      hasOnChainData: Array.isArray(bounties) && bounties.length > 0,
    },
  };

  const storage = await storeAuditOnFilecoin(report, repoUrl);
  const cid = storage?.pieceCid || null;
  return {
    report: { ...report, cid, storage },
    cid,
    storage,
  };
}

async function listAuditLogsFromFilecoin({ repoUrl, limit = 50 }) {
  const { rpcUrl, chainId, account } = getFilecoinConfig();
  const client = createPublicClient({
    chain: getChain(chainId),
    transport: http(rpcUrl),
  });

  const datasets = await getPdpDataSets(client, { address: account.address });
  const entries = [];

  for (const dataset of datasets) {
    if (dataset.pdpEndEpoch && dataset.pdpEndEpoch !== 0n) continue;
    const pieceCount = Number(dataset.activePieceCount ?? 0n);
    for (let pieceId = 0; pieceId < pieceCount; pieceId += 1) {
      const metadata = await getAllPieceMetadata(client, {
        dataSetId: dataset.dataSetId,
        pieceId: BigInt(pieceId),
      });
      if (!metadata || metadata.source !== "mergeX-audit") continue;
      if (repoUrl && metadata.repoUrl !== repoUrl) continue;
      entries.push({
        pieceCid: metadata.pieceCid || null,
        repoUrl: metadata.repoUrl || "",
        timestamp: metadata.timestamp || null,
        auditId: metadata.auditId || null,
        legacy: !metadata.pieceCid,
        dataSetId: dataset.dataSetId.toString(),
        providerName: dataset.provider?.name || "",
        providerId: dataset.provider?.id?.toString?.() || "",
      });
    }
  }

  entries.sort((a, b) => {
    const at = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const bt = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return bt - at;
  });

  return limit > 0 ? entries.slice(0, limit) : entries;
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

function detectDiscrepancies(allIssues, mergedPRs, bounties, opts = {}) {
  const bountyByIssueUrl = new Map();
  const bountyByPrUrl = new Map();
  const hasOnChainData =
    typeof opts.hasOnChainData === "boolean"
      ? opts.hasOnChainData
      : Array.isArray(bounties) && bounties.length > 0;

  for (const b of bounties) {
    if (b.githubIssueUrl) bountyByIssueUrl.set(b.githubIssueUrl, b);
    if (b.prUrl) bountyByPrUrl.set(b.prUrl, b);
  }

  const discrepancies = [];

  // Check 1: Open issue with no on-chain bounty
  if (hasOnChainData) {
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

export async function runAudit({
  repoUrl,
  bounties = [],
  event = null,
  githubRequest,
  getGithubAppPrivateKey,
  createGithubAppJwt,
}) {
  if (!repoUrl) throw new Error("repoUrl is required");

  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) throw new Error("Invalid GitHub repo URL");
  const [, owner, repo] = match;

  const ghToken = await resolveGithubToken({
    owner,
    repo,
    githubRequest,
    getGithubAppPrivateKey,
    createGithubAppJwt,
  });
  if (!ghToken) throw new Error("No GitHub token available");

  const [allIssues, mergedPRs] = await Promise.all([
    fetchAllIssues(owner, repo, ghToken, githubRequest),
    fetchMergedPRs(owner, repo, ghToken, githubRequest),
  ]);

  const hasOnChainData = Array.isArray(bounties) && bounties.length > 0;
  const discrepancies = detectDiscrepancies(allIssues, mergedPRs, bounties, {
    hasOnChainData,
  });

  const stats = {
    totalIssues: allIssues.length,
    mergedPRs: mergedPRs.length,
    discrepanciesFound: discrepancies.length,
    critical: discrepancies.filter((d) => d.severity === "CRITICAL").length,
    high: discrepancies.filter((d) => d.severity === "HIGH").length,
    medium: discrepancies.filter((d) => d.severity === "MEDIUM").length,
    low: discrepancies.filter((d) => d.severity === "LOW").length,
  };

  const aiAnalysis = await runAIAnalysis(discrepancies, repoUrl, stats);

  const issuesSnapshot = allIssues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.html_url,
    user: issue.user?.login || "unknown",
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
  }));

  const mergedPRsSnapshot = mergedPRs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    user: pr.user?.login || "unknown",
    mergedAt: pr.merged_at,
    updatedAt: pr.updated_at,
  }));

  const bountiesSnapshot = Array.isArray(bounties)
    ? toBountiesSnapshot(bounties)
    : [];

  const timestamp = new Date().toISOString();

  const report = {
    repoUrl,
    timestamp,
    event,
    stats,
    discrepancies,
    aiAnalysis,
    snapshot: {
      issues: issuesSnapshot,
      mergedPRs: mergedPRsSnapshot,
      bounties: bountiesSnapshot,
      hasOnChainData,
    },
  };

  let storage = null;
  let storageError = null;
  try {
    storage = await storeAuditOnFilecoin(report, repoUrl);
  } catch (err) {
    storageError = err?.message || String(err);
  }
  const cid = storage?.pieceCid || null;

  console.log(
    `[audit] ${repoUrl} — ${discrepancies.length} discrepancies${cid ? ` — CID: ${cid}` : ""}${storageError ? ` — storage error: ${storageError}` : ""}`
  );

  return { report: { ...report, cid, storage, storageError }, cid, storage, storageError };
}

export function registerAuditRoutes(app, { githubRequest, getGithubAppPrivateKey, createGithubAppJwt }) {
  app.post("/api/audit-repo", async (req, res) => {
    const { repoUrl, bounties = [], event = null, eventOnly = false } = req.body;
    if (!repoUrl) return res.status(400).json({ error: "repoUrl is required" });

    try {
      if (eventOnly) {
        const { report } = await storeEventAudit({ repoUrl, bounties, event });
        return res.json(report);
      }
      const { report } = await runAudit({
        repoUrl,
        bounties,
        event,
        githubRequest,
        getGithubAppPrivateKey,
        createGithubAppJwt,
      });
      return res.json(report);
    } catch (err) {
      console.error("audit-repo error:", err);
      if (event) {
        try {
          const { report } = await storeEventAudit({ repoUrl, bounties, event });
          return res.json({ ...report, auditMode: "event_only_fallback", storageError: err.message });
        } catch (fallbackErr) {
          console.error("audit-repo fallback error:", fallbackErr);
        }
      }
      return res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/audit-logs", async (req, res) => {
    try {
      const { repoUrl, limit } = req.query;
      const entries = await listAuditLogsFromFilecoin({
        repoUrl: typeof repoUrl === "string" ? repoUrl : null,
        limit: Number(limit || 50),
      });
      return res.json({ entries });
    } catch (err) {
      console.error("audit-logs error:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/audit-download", async (req, res) => {
    try {
      const { pieceCid } = req.query;
      if (typeof pieceCid !== "string" || !pieceCid.trim()) {
        return res.status(400).json({ error: "pieceCid is required" });
      }

      const { rpcUrl, chainId, account } = getFilecoinConfig();
      const client = createPublicClient({
        chain: getChain(chainId),
        transport: http(rpcUrl),
      });

      const url = await resolvePieceUrl({
        client,
        address: account.address,
        pieceCid: parsePieceCID(pieceCid.trim()),
      });

      const rsp = await fetch(url);
      if (!rsp.ok) throw new Error(`Failed to fetch piece content (${rsp.status})`);

      const buf = Buffer.from(await rsp.arrayBuffer());
      res.setHeader("Content-Type", rsp.headers.get("content-type") || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename=\"audit-${pieceCid.trim()}.json\"`);
      return res.send(buf);
    } catch (err) {
      console.error("audit-download error:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/audit-content", async (req, res) => {
    try {
      const { pieceCid } = req.query;
      if (typeof pieceCid !== "string" || !pieceCid.trim()) {
        return res.status(400).json({ error: "pieceCid is required" });
      }

      const { rpcUrl, chainId, account } = getFilecoinConfig();
      const client = createPublicClient({
        chain: getChain(chainId),
        transport: http(rpcUrl),
      });

      const url = await resolvePieceUrl({
        client,
        address: account.address,
        pieceCid: parsePieceCID(pieceCid.trim()),
      });

      const rsp = await fetch(url);
      if (!rsp.ok) throw new Error(`Failed to fetch piece content (${rsp.status})`);
      const text = (await rsp.text()).trimEnd();
      return res.json({ content: text });
    } catch (err) {
      console.error("audit-content error:", err);
      return res.status(500).json({ error: err.message });
    }
  });
}
