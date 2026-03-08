const { expect } = require("chai");
const hre = require("hardhat");

const { ethers } = hre;

const ISSUE_URL = "https://github.com/owner/repo/issues/1";
const PR_URL    = "https://github.com/owner/repo/pull/7";

describe("MergeXBounty", function () {
  let contract, owner, org, contributor, other;
  const MIN_STAKE = ethers.parseEther("0.000001");
  const BOUNTY    = ethers.parseEther("0.01");

  beforeEach(async () => {
    [owner, org, contributor, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("MergeXBounty");
    contract = await Factory.deploy();
    await contract.waitForDeployment();
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function setupRepo() {
    await contract.connect(org).registerRepo("owner/repo", 0, 0, 0, { value: BOUNTY * 10n });
    return 1n;
  }

  async function setupBounty() {
    const repoId = await setupRepo();
    await contract.connect(org).createBounty(
      repoId, ISSUE_URL, "1", "SQL Injection", "desc", BOUNTY, 2 // HIGH
    );
    return 1n; // bountyId
  }

  async function setupAssigned() {
    const bountyId = await setupBounty();
    const stake = BOUNTY / 10n;
    await contract.connect(contributor).takeBounty(bountyId, { value: stake });
    return bountyId;
  }

  async function setupPRSubmitted() {
    const bountyId = await setupAssigned();
    await contract.connect(contributor).submitPR(bountyId, PR_URL);
    return bountyId;
  }

  async function setupMerged() {
    const bountyId = await setupPRSubmitted();
    await contract.connect(org).approveMerge(bountyId);
    return bountyId;
  }

  // ── Repo Registration ──────────────────────────────────────────────────────

  it("registers a repo", async () => {
    await contract.connect(org).registerRepo("owner/repo", 0, 0, 0, { value: MIN_STAKE });
    const repo = await contract.getRepo(1);
    expect(repo.repoUrl).to.equal("owner/repo");
    expect(repo.owner).to.equal(org.address);
  });

  it("rejects duplicate repo (case-insensitive)", async () => {
    await contract.connect(org).registerRepo("owner/repo", 0, 0, 0, { value: MIN_STAKE });
    await expect(
      contract.connect(org).registerRepo("Owner/Repo", 0, 0, 0, { value: MIN_STAKE })
    ).to.be.revertedWith("Repo already registered");
  });

  it("funds an existing repo", async () => {
    await contract.connect(org).registerRepo("owner/repo", 0, 0, 0, { value: MIN_STAKE });
    await contract.connect(org).fundRepo(1, { value: BOUNTY });
    expect((await contract.getRepo(1)).available).to.equal(MIN_STAKE + BOUNTY);
  });

  // ── Bounty Creation ────────────────────────────────────────────────────────

  it("creates a bounty — status OPEN", async () => {
    const repoId = await setupRepo();
    await contract.connect(org).createBounty(repoId, ISSUE_URL, "1", "t", "d", BOUNTY, 3);
    const b = await contract.getBounty(1);
    expect(b.status).to.equal(0n); // OPEN
    expect(b.amount).to.equal(BOUNTY);
  });

  it("rejects duplicate bounty for same issue URL", async () => {
    const repoId = await setupRepo();
    await contract.connect(org).createBounty(repoId, ISSUE_URL, "1", "t", "d", BOUNTY, 1);
    await expect(
      contract.connect(org).createBounty(repoId, ISSUE_URL, "1", "t", "d", BOUNTY, 1)
    ).to.be.revertedWith("Bounty already exists for this issue");
  });

  it("batch creates bounties from existing issues", async () => {
    const repoId = await setupRepo();
    const urls = [
      "https://github.com/owner/repo/issues/1",
      "https://github.com/owner/repo/issues/2",
    ];
    await contract.connect(org).batchCreateBounties(
      repoId, urls, ["1","2"], ["T1","T2"], ["d1","d2"], [BOUNTY, BOUNTY], [0, 1]
    );
    expect(await contract.getBountyIdByIssueUrl(urls[0])).to.equal(1n);
    expect(await contract.getBountyIdByIssueUrl(urls[1])).to.equal(2n);
  });

  // ── Step 1: takeBounty → ASSIGNED ─────────────────────────────────────────

  it("contributor takes bounty with 10% stake → ASSIGNED", async () => {
    const bountyId = await setupBounty();
    await contract.connect(contributor).takeBounty(bountyId, { value: BOUNTY / 10n });
    const b = await contract.getBounty(bountyId);
    expect(b.status).to.equal(1n); // ASSIGNED
    expect(b.assignedTo).to.equal(contributor.address);
    expect(b.deadline).to.be.gt(0n);
  });

  it("rejects stake below 10%", async () => {
    const bountyId = await setupBounty();
    await expect(
      contract.connect(contributor).takeBounty(bountyId, { value: 1n })
    ).to.be.revertedWith("Stake out of range (10-20% of bounty)");
  });

  it("rejects stake above 20%", async () => {
    const bountyId = await setupBounty();
    await expect(
      contract.connect(contributor).takeBounty(bountyId, { value: BOUNTY / 4n }) // 25%
    ).to.be.revertedWith("Stake out of range (10-20% of bounty)");
  });

  it("org cannot take own bounty", async () => {
    const bountyId = await setupBounty();
    await expect(
      contract.connect(org).takeBounty(bountyId, { value: BOUNTY / 10n })
    ).to.be.revertedWith("Org cannot take own bounty");
  });

  // ── Step 2: submitPR → PR_SUBMITTED ───────────────────────────────────────

  it("contributor submits PR → PR_SUBMITTED", async () => {
    const bountyId = await setupAssigned();
    await contract.connect(contributor).submitPR(bountyId, PR_URL);
    const b = await contract.getBounty(bountyId);
    expect(b.status).to.equal(2n); // PR_SUBMITTED
    expect(b.prUrl).to.equal(PR_URL);
    expect(b.prSubmittedAt).to.be.gt(0n);
  });

  it("non-contributor cannot submit PR", async () => {
    const bountyId = await setupAssigned();
    await expect(
      contract.connect(other).submitPR(bountyId, PR_URL)
    ).to.be.revertedWith("Only assigned contributor");
  });

  it("cannot submit PR when status is not ASSIGNED", async () => {
    const bountyId = await setupPRSubmitted();
    await expect(
      contract.connect(contributor).submitPR(bountyId, PR_URL)
    ).to.be.revertedWith("Bounty not in ASSIGNED state");
  });

  // ── Step 3: approveMerge → MERGED ─────────────────────────────────────────

  it("org approves merge → MERGED", async () => {
    const bountyId = await setupPRSubmitted();
    await contract.connect(org).approveMerge(bountyId);
    expect((await contract.getBounty(bountyId)).status).to.equal(3n); // MERGED
  });

  it("non-owner cannot approve merge", async () => {
    const bountyId = await setupPRSubmitted();
    await expect(
      contract.connect(other).approveMerge(bountyId)
    ).to.be.revertedWith("Only repo owner");
  });

  it("cannot approve merge when no PR submitted", async () => {
    const bountyId = await setupAssigned();
    await expect(
      contract.connect(org).approveMerge(bountyId)
    ).to.be.revertedWith("No PR submitted yet");
  });

  // ── Step 4: claimBounty → COMPLETED ───────────────────────────────────────

  it("contributor claims bounty after merge → receives bounty + stake", async () => {
    const bountyId = await setupMerged();
    const stake  = BOUNTY / 10n;

    const before = await ethers.provider.getBalance(contributor.address);
    await contract.connect(contributor).claimBounty(bountyId);
    const after = await ethers.provider.getBalance(contributor.address);

    expect(after - before).to.be.closeTo(BOUNTY + stake, ethers.parseEther("0.001"));
    expect((await contract.getBounty(bountyId)).status).to.equal(4n); // COMPLETED
  });

  it("non-contributor cannot claim", async () => {
    const bountyId = await setupMerged();
    await expect(
      contract.connect(other).claimBounty(bountyId)
    ).to.be.revertedWith("Only assigned contributor");
  });

  it("cannot claim before merge is approved", async () => {
    const bountyId = await setupPRSubmitted();
    await expect(
      contract.connect(contributor).claimBounty(bountyId)
    ).to.be.revertedWith("PR not approved yet");
  });

  // ── Expiry ─────────────────────────────────────────────────────────────────

  it("contributor reclaims stake when deadline passes (ASSIGNED) — bounty reopens", async () => {
    const bountyId = await setupAssigned();
    const stake = BOUNTY / 10n;

    await ethers.provider.send("evm_increaseTime", [150 * 24 * 60 * 60 + 1]); // 150 days (hardDuration)
    await ethers.provider.send("evm_mine");

    const before = await ethers.provider.getBalance(contributor.address);
    const tx      = await contract.connect(contributor).claimExpiredBounty(bountyId);
    const receipt = await tx.wait();
    const after   = await ethers.provider.getBalance(contributor.address);

    expect(after - before + receipt.gasUsed * tx.gasPrice).to.equal(stake);
    expect((await contract.getBounty(bountyId)).status).to.equal(0n); // OPEN again
  });

  it("contributor reclaims stake when deadline passes (PR_SUBMITTED) — bounty reopens", async () => {
    const bountyId = await setupPRSubmitted();
    const stake = BOUNTY / 10n;

    // Use absolute timestamp so test is independent of prior evm_increaseTime calls
    const latest = await ethers.provider.getBlock("latest");
    await ethers.provider.send("evm_setNextBlockTimestamp", [latest.timestamp + 150 * 24 * 60 * 60 + 60]);
    await ethers.provider.send("evm_mine");

    await contract.connect(contributor).claimExpiredBounty(bountyId);
    expect((await contract.getBounty(bountyId)).status).to.equal(0n); // OPEN again
    expect((await contract.getBounty(bountyId)).prUrl).to.equal("");
  });

  it("cannot expire before deadline", async () => {
    const bountyId = await setupAssigned();
    await expect(
      contract.connect(contributor).claimExpiredBounty(bountyId)
    ).to.be.revertedWith("Deadline not passed");
  });

  // ── Cancel / Increase ─────────────────────────────────────────────────────

  it("cancels open bounty — funds return to repo pool", async () => {
    const repoId = await setupRepo();
    const availBefore = (await contract.getRepo(repoId)).available;
    await contract.connect(org).createBounty(repoId, "https://github.com/owner/repo/issues/99", "99", "t", "d", BOUNTY, 0);
    await contract.connect(org).cancelBounty(1n);
    expect((await contract.getRepo(repoId)).available).to.equal(availBefore);
  });

  it("increases bounty amount", async () => {
    const bountyId = await setupBounty();
    const extra = ethers.parseEther("0.005");
    await contract.connect(org).increaseBounty(bountyId, { value: extra });
    expect((await contract.getBounty(bountyId)).amount).to.equal(BOUNTY + extra);
  });

  // ── isBountyExpired view ───────────────────────────────────────────────────

  it("isBountyExpired returns true after deadline in PR_SUBMITTED state", async () => {
    const bountyId = await setupPRSubmitted();
    expect(await contract.isBountyExpired(bountyId)).to.equal(false);
    await ethers.provider.send("evm_increaseTime", [150 * 24 * 60 * 60 + 1]); // 150 days (hardDuration)
    await ethers.provider.send("evm_mine");
    expect(await contract.isBountyExpired(bountyId)).to.equal(true);
  });
});
