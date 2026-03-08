const { expect } = require("chai");
const hre = require("hardhat");

const { ethers } = hre;

describe("MergeXBounty", function () {
  let contract, owner, org, contributor;
  const MIN_STAKE = ethers.parseEther("0.000001");
  const BOUNTY    = ethers.parseEther("0.01");

  beforeEach(async () => {
    [owner, org, contributor] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("MergeXBounty");
    contract = await Factory.deploy();
    await contract.waitForDeployment();
  });

  // ── Repo Registration ──────────────────────────────────────────────────────

  it("registers a repo", async () => {
    await contract.connect(org).registerRepo("owner/repo", 0, 0, 0, { value: MIN_STAKE });
    const repo = await contract.getRepo(1);
    expect(repo.repoUrl).to.equal("owner/repo");
    expect(repo.owner).to.equal(org.address);
    expect(repo.available).to.equal(MIN_STAKE);
  });

  it("prevents duplicate repo registration (case-insensitive)", async () => {
    await contract.connect(org).registerRepo("owner/repo", 0, 0, 0, { value: MIN_STAKE });
    await expect(
      contract.connect(org).registerRepo("Owner/Repo", 0, 0, 0, { value: MIN_STAKE })
    ).to.be.revertedWith("Repo already registered");
  });

  it("funds an existing repo", async () => {
    await contract.connect(org).registerRepo("owner/repo", 0, 0, 0, { value: MIN_STAKE });
    await contract.connect(org).fundRepo(1, { value: BOUNTY });
    const repo = await contract.getRepo(1);
    expect(repo.available).to.equal(MIN_STAKE + BOUNTY);
  });

  // ── Bounty Creation ────────────────────────────────────────────────────────

  async function setupRepo() {
    await contract.connect(org).registerRepo("owner/repo", 0, 0, 0, { value: BOUNTY * 10n });
    return 1n;
  }

  it("creates a bounty", async () => {
    const repoId = await setupRepo();
    await contract.connect(org).createBounty(
      repoId,
      "https://github.com/owner/repo/issues/1",
      "1",
      "SQL Injection",
      "Found in db.js",
      BOUNTY,
      3 // CRITICAL
    );
    const b = await contract.getBounty(1);
    expect(b.amount).to.equal(BOUNTY);
    expect(b.status).to.equal(0n); // OPEN
  });

  it("prevents duplicate bounty for same issue URL", async () => {
    const repoId = await setupRepo();
    await contract.connect(org).createBounty(repoId, "https://github.com/owner/repo/issues/1", "1", "t", "d", BOUNTY, 1);
    await expect(
      contract.connect(org).createBounty(repoId, "https://github.com/owner/repo/issues/1", "1", "t", "d", BOUNTY, 1)
    ).to.be.revertedWith("Bounty already exists for this issue");
  });

  it("batch creates bounties from existing issues", async () => {
    const repoId = await setupRepo();
    await contract.connect(org).batchCreateBounties(
      repoId,
      ["https://github.com/owner/repo/issues/1", "https://github.com/owner/repo/issues/2"],
      ["1", "2"],
      ["Issue 1", "Issue 2"],
      ["desc 1", "desc 2"],
      [BOUNTY, BOUNTY],
      [0, 1]
    );
    expect(await contract.getBountyIdByIssueUrl("https://github.com/owner/repo/issues/1")).to.equal(1n);
    expect(await contract.getBountyIdByIssueUrl("https://github.com/owner/repo/issues/2")).to.equal(2n);
  });

  // ── Contributor Flow ───────────────────────────────────────────────────────

  async function setupBounty() {
    const repoId = await setupRepo();
    await contract.connect(org).createBounty(
      repoId, "https://github.com/owner/repo/issues/1", "1", "title", "desc", BOUNTY, 2
    );
    return 1n;
  }

  it("contributor takes a bounty with valid stake (10%)", async () => {
    const bountyId = await setupBounty();
    const stake = BOUNTY / 10n;
    await contract.connect(contributor).takeBounty(bountyId, { value: stake });
    const b = await contract.getBounty(bountyId);
    expect(b.status).to.equal(1n); // ASSIGNED
    expect(b.assignedTo).to.equal(contributor.address);
  });

  it("rejects stake below minimum", async () => {
    const bountyId = await setupBounty();
    await expect(
      contract.connect(contributor).takeBounty(bountyId, { value: 1n })
    ).to.be.revertedWith("Stake out of range");
  });

  it("org completes bounty — contributor gets bounty + stake back", async () => {
    const bountyId = await setupBounty();
    const stake = BOUNTY / 10n;
    await contract.connect(contributor).takeBounty(bountyId, { value: stake });

    const before = await ethers.provider.getBalance(contributor.address);
    await contract.connect(org).completeBounty(bountyId);
    const after = await ethers.provider.getBalance(contributor.address);

    expect(after - before).to.be.closeTo(BOUNTY + stake, ethers.parseEther("0.001"));
  });

  it("contributor reclaims stake after deadline, bounty reopens", async () => {
    const bountyId = await setupBounty();
    const stake = BOUNTY / 10n;
    await contract.connect(contributor).takeBounty(bountyId, { value: stake });

    await ethers.provider.send("evm_increaseTime", [150 * 24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine");

    const before = await ethers.provider.getBalance(contributor.address);
    const tx = await contract.connect(contributor).claimExpiredBounty(bountyId);
    const receipt = await tx.wait();
    const gasCost = receipt.gasUsed * tx.gasPrice;
    const after = await ethers.provider.getBalance(contributor.address);

    expect(after - before + gasCost).to.equal(stake);
    expect((await contract.getBounty(bountyId)).status).to.equal(0n); // OPEN
  });

  // ── Cancel / Increase ─────────────────────────────────────────────────────

  it("cancels an open bounty — funds return to repo pool", async () => {
    const repoId = await setupRepo();
    const availBefore = (await contract.getRepo(repoId)).available;
    await contract.connect(org).createBounty(repoId, "https://github.com/owner/repo/issues/99", "99", "t", "d", BOUNTY, 0);
    await contract.connect(org).cancelBounty(1n);
    expect((await contract.getRepo(repoId)).available).to.equal(availBefore);
  });

  it("increases a bounty amount", async () => {
    const bountyId = await setupBounty();
    const extra = ethers.parseEther("0.005");
    await contract.connect(org).increaseBounty(bountyId, { value: extra });
    expect((await contract.getBounty(bountyId)).amount).to.equal(BOUNTY + extra);
  });
});
