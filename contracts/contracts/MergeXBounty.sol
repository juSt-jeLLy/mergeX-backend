// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title MergeXBounty
 * @notice Decentralized bounty platform for open-source security issues.
 *
 * Full lifecycle:
 *   1. Org registers a GitHub repo + funds a reward pool
 *   2. Org creates bounties (one per GitHub issue) — or batch-imports open issues
 *   3. Contributor calls takeBounty() + stakes 10-20% collateral → ASSIGNED //TO DO: add a modifier which checks if a issue is currently free or not , if not free then only can be assigned
 *   4. Contributor opens a PR, calls submitPR() to record the PR URL on-chain → PR_SUBMITTED
 *   5a. Org merges the PR on GitHub → calls approveMerge() → MERGED //optional: can return the stake to the contributor in the same function only along with bounty reward(won't need claimBounty then ig )
 *       Contributor calls claimBounty() → receives bounty + full stake → COMPLETED
 *   5b. Org rejects the PR → calls rejectPR() → bounty reopens, contributor gets full stake back
 *
 * Expiry rules:
 *   - Deadline passed, status ASSIGNED (no PR submitted):
 *       contributor gets 50% stake back, 50% slashed to repo pool (penalty for abandonment)
 *       bounty reopens
 *   - Deadline passed, status PR_SUBMITTED (org never responded):
 *       contributor gets full stake back (org's fault for not reviewing)
 *       bounty reopens 
 
 */
contract MergeXBounty is ReentrancyGuard, Ownable, Pausable {

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event RepoRegistered(address indexed org, uint256 indexed repoId, string repoUrl, uint256 stakedAmount);
    event RepoFunded(address indexed org, uint256 indexed repoId, uint256 addedAmount, uint256 newTotal);
    event FundsWithdrawn(address indexed org, uint256 indexed repoId, uint256 amount);

    event BountyCreated(
        uint256 indexed bountyId,
        uint256 indexed repoId,
        address indexed org,
        string githubIssueUrl,
        uint256 amount,
        Severity severity
    );
    event BountyIncreased(uint256 indexed bountyId, uint256 addedAmount, uint256 newTotal);
    event BountyCancelled(uint256 indexed bountyId);

    event BountyTaken(uint256 indexed bountyId, address indexed contributor, uint256 deadline, uint256 stake);
    event PRSubmitted(uint256 indexed bountyId, address indexed contributor, string prUrl);
    event PRRejected(uint256 indexed bountyId, address indexed org, string prUrl, uint256 stakeReturned);
    event MergeApproved(uint256 indexed bountyId, address indexed org, string prUrl);
    event BountyClaimed(uint256 indexed bountyId, address indexed contributor, uint256 reward);
    // stakeReturned = amount actually sent back; slashedAmount = amount added to repo pool
    event BountyExpired(uint256 indexed bountyId, address indexed contributor, BountyStatus statusAtExpiry, uint256 stakeReturned, uint256 slashedAmount);

    event StakeWithdrawn(address indexed contributor, uint256 amount);

    // ─────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────

    enum Severity { LOW, MEDIUM, HIGH, CRITICAL }

    /**
     * OPEN          — bounty is live, anyone can take it
     * ASSIGNED      — contributor staked and is working on it
     * PR_SUBMITTED  — contributor submitted a PR URL on-chain, waiting for org to merge
     * MERGED        — org confirmed the PR was merged; contributor can now claim
     * COMPLETED     — bounty paid out
     * CANCELLED     — org cancelled before anyone took it
     */
    enum BountyStatus { OPEN, ASSIGNED, PR_SUBMITTED, MERGED, COMPLETED, CANCELLED }

    struct Repo {
        uint256 id;
        string repoUrl;         // e.g. "owner/repo"
        address owner;
        uint256 totalFunded;    // lifetime ETH deposited
        uint256 available;      // ETH available to fund new bounties
        bool isActive;
        uint256 easyDuration;   // deadline window for LOW bounties
        uint256 mediumDuration; // deadline window for MEDIUM bounties
        uint256 hardDuration;   // deadline window for HIGH + CRITICAL bounties
    }

    struct Bounty {
        uint256 id;
        uint256 repoId;
        address org;
        string githubIssueUrl;   // e.g. https://github.com/owner/repo/issues/42
        string githubIssueId;    // e.g. "42"
        string title;
        string description;
        uint256 amount;          // locked reward in wei
        Severity severity;
        BountyStatus status;
        address assignedTo;
        uint256 createdAt;
        uint256 deadline;        // 0 until taken
        uint256 contributorStake;
        string prUrl;            // set by contributor via submitPR()
        uint256 prSubmittedAt;   // block.timestamp when PR was submitted
    }

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public nextRepoId   = 1;
    uint256 public nextBountyId = 1;

    mapping(uint256 => Repo)    public repos;
    mapping(address => uint256[]) public orgRepos;
    mapping(bytes32 => uint256) public repoUrlToId;   // lowercase hash → repoId

    mapping(uint256 => Bounty)  public bounties;
    mapping(uint256 => uint256[]) public repoBounties; // repoId → bountyIds
    mapping(bytes32 => uint256) public issueUrlToBountyId; // issue URL hash → bountyId

    mapping(address => uint256) public contributorStakes;
    mapping(address => uint256[]) public contributorBounties;
    mapping(uint256 => address[]) public bountyApplicants;
    mapping(uint256 => mapping(address => bool)) public hasAttempted;

    // ─────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public constant MIN_ORG_STAKE             = 0.000001 ether;
    uint256 public constant CONTRIBUTOR_STAKE_BPS     = 1000;  // 10%
    uint256 public constant MAX_CONTRIBUTOR_STAKE_BPS = 2000;  // 20%
    // Slash 50% of stake if contributor abandons (never submits PR before deadline)
    uint256 public constant ABANDON_SLASH_BPS         = 5000;  // 50%
    uint256 public constant DEFAULT_TEST_DURATION= 3 minutes;
    uint256 public constant DEFAULT_LOW_DURATION      = 3 minutes;
    uint256 public constant DEFAULT_MEDIUM_DURATION   = 30 days;
    uint256 public constant DEFAULT_HIGH_DURATION     = 60 days;
    uint256 public constant DEFAULT_CRITICAL_DURATION = 150 days;

    // ─────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────────────────

    modifier onlyRepoOwner(uint256 _repoId) {
        require(repos[_repoId].owner == msg.sender, "Not repo owner");
        _;
    }

    modifier repoExists(uint256 _repoId) {
        require(repos[_repoId].id != 0, "Repo does not exist");
        _;
    }

    modifier bountyExists(uint256 _bountyId) {
        require(bounties[_bountyId].id != 0, "Bounty does not exist");
        _;
    }
    modifier isBountyAvailable(uint256 _bountyId){
        require(bounties[_bountyId].assignedTo== address(0),"Bounty is already assigned ");
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    constructor() Ownable(msg.sender) {}

    // ─────────────────────────────────────────────────────────────────────────
    // Repo Management
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Register a GitHub repo and seed its reward pool.
     *         An org can register multiple repos; each gets its own pool.
     * @param _repoUrl        "owner/repo" — case-insensitive, duplicates rejected
     * @param _easyDuration   deadline for LOW bounties   (0 = use default 14d)
     * @param _mediumDuration deadline for MEDIUM bounties (0 = use default 30d)
     * @param _hardDuration   deadline for HIGH+CRITICAL  (0 = use default 150d)
     */
    function registerRepo(
        string calldata _repoUrl,
        uint256 _easyDuration,
        uint256 _mediumDuration,
        uint256 _hardDuration
    ) external payable whenNotPaused returns (uint256 repoId) {
        require(msg.value >= MIN_ORG_STAKE, "Stake too low");
        require(bytes(_repoUrl).length > 0, "Empty repo URL");

        bytes32 urlHash = keccak256(bytes(_toLower(_repoUrl)));
        require(repoUrlToId[urlHash] == 0, "Repo already registered");

        repoId = nextRepoId++;
        repos[repoId] = Repo({
            id: repoId,
            repoUrl: _repoUrl,
            owner: msg.sender,
            totalFunded: msg.value,
            available: msg.value,
            isActive: true,

            easyDuration:   _easyDuration   > 0 ? _easyDuration   : DEFAULT_LOW_DURATION,
            mediumDuration: _mediumDuration  > 0 ? _mediumDuration  : DEFAULT_MEDIUM_DURATION,
            hardDuration:   _hardDuration    > 0 ? _hardDuration    : DEFAULT_CRITICAL_DURATION
        });

        repoUrlToId[urlHash] = repoId;
        orgRepos[msg.sender].push(repoId);

        emit RepoRegistered(msg.sender, repoId, _repoUrl, msg.value);
    }

    /// @notice Top up an existing repo's reward pool.
    function fundRepo(uint256 _repoId)
        external payable
        repoExists(_repoId)
        onlyRepoOwner(_repoId)
        whenNotPaused
    {
        require(msg.value > 0, "Send ETH");
        repos[_repoId].totalFunded += msg.value;
        repos[_repoId].available   += msg.value;
        emit RepoFunded(msg.sender, _repoId, msg.value, repos[_repoId].available);
    }

    /// @notice Withdraw idle funds (only what isn't locked in active bounties).
    function withdrawRepoFunds(uint256 _repoId, uint256 _amount)
        external
        nonReentrant
        repoExists(_repoId)
        onlyRepoOwner(_repoId)
    {
        require(_amount > 0 && _amount <= repos[_repoId].available, "Invalid amount");
        repos[_repoId].available   -= _amount;
        repos[_repoId].totalFunded -= _amount;
        payable(msg.sender).transfer(_amount);
        emit FundsWithdrawn(msg.sender, _repoId, _amount);
    }

    /// @notice Update deadline windows for a repo.
    function updateDeadlines(
        uint256 _repoId,
        uint256 _easyDuration,
        uint256 _mediumDuration,
        uint256 _hardDuration
    ) external repoExists(_repoId) onlyRepoOwner(_repoId) {
        require(_easyDuration > 0 && _mediumDuration > 0 && _hardDuration > 0, "Durations must be > 0");
        Repo storage r = repos[_repoId];
        r.easyDuration   = _easyDuration;
        r.mediumDuration = _mediumDuration;
        r.hardDuration   = _hardDuration;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Bounty Creation
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Create a bounty for a single GitHub issue.
     * @param _githubIssueUrl Full URL e.g. https://github.com/owner/repo/issues/42
     * @param _githubIssueId  Issue number as string e.g. "42"
     */
    function createBounty(
        uint256 _repoId,
        string calldata _githubIssueUrl,
        string calldata _githubIssueId,
        string calldata _title,
        string calldata _description,
        uint256 _amount,
        Severity _severity
    ) external repoExists(_repoId) onlyRepoOwner(_repoId) whenNotPaused returns (uint256 bountyId) {
        require(_amount > 0, "Bounty must be > 0");
        require(repos[_repoId].available >= _amount, "Insufficient repo funds");
        require(bytes(_githubIssueUrl).length > 0, "Empty issue URL");

        bytes32 issueHash = keccak256(bytes(_githubIssueUrl));
        require(issueUrlToBountyId[issueHash] == 0, "Bounty already exists for this issue");

        bountyId = nextBountyId++;
        bounties[bountyId] = Bounty({
            id: bountyId,
            repoId: _repoId,
            org: msg.sender,
            githubIssueUrl: _githubIssueUrl,
            githubIssueId: _githubIssueId,
            title: _title,
            description: _description,
            amount: _amount,
            severity: _severity,
            status: BountyStatus.OPEN,
            assignedTo: address(0),
            createdAt: block.timestamp,
            deadline: 0,
            contributorStake: 0,
            prUrl: "",
            prSubmittedAt: 0
        });

        repos[_repoId].available -= _amount;
        repoBounties[_repoId].push(bountyId);
        issueUrlToBountyId[issueHash] = bountyId;

        emit BountyCreated(bountyId, _repoId, msg.sender, _githubIssueUrl, _amount, _severity);
    }

    /**
     * @notice Batch-create bounties from already-open GitHub issues in one transaction.
     *         Silently skips any issue URL that already has a bounty.
     */
    function batchCreateBounties(
        uint256 _repoId,
        string[] calldata _githubIssueUrls,
        string[] calldata _githubIssueIds,
        string[] calldata _titles,
        string[] calldata _descriptions,
        uint256[] calldata _amounts,
        Severity[] calldata _severities
    ) external repoExists(_repoId) onlyRepoOwner(_repoId) whenNotPaused returns (uint256[] memory bountyIds) {
        uint256 len = _githubIssueUrls.length;
        require(
            len == _githubIssueIds.length &&
            len == _titles.length &&
            len == _descriptions.length &&
            len == _amounts.length &&
            len == _severities.length,
            "Array length mismatch"
        );

        uint256 totalNeeded;
        for (uint256 i = 0; i < len; i++) totalNeeded += _amounts[i];
        require(repos[_repoId].available >= totalNeeded, "Insufficient repo funds for batch");

        bountyIds = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            bytes32 issueHash = keccak256(bytes(_githubIssueUrls[i]));
            if (issueUrlToBountyId[issueHash] != 0) continue;

            uint256 bid = nextBountyId++;
            bounties[bid] = Bounty({
                id: bid,
                repoId: _repoId,
                org: msg.sender,
                githubIssueUrl: _githubIssueUrls[i],
                githubIssueId: _githubIssueIds[i],
                title: _titles[i],
                description: _descriptions[i],
                amount: _amounts[i],
                severity: _severities[i],
                status: BountyStatus.OPEN,
                assignedTo: address(0),
                createdAt: block.timestamp,
                deadline: 0,
                contributorStake: 0,
                prUrl: "",
                prSubmittedAt: 0
            });

            repos[_repoId].available -= _amounts[i];
            repoBounties[_repoId].push(bid);
            issueUrlToBountyId[issueHash] = bid;
            bountyIds[i] = bid;

            emit BountyCreated(bid, _repoId, msg.sender, _githubIssueUrls[i], _amounts[i], _severities[i]);
        }
    }

    /// @notice Increase the reward on any non-closed bounty. ETH sent goes directly to the bounty.
    function increaseBounty(uint256 _bountyId)
        external payable
        bountyExists(_bountyId)
        onlyRepoOwner(bounties[_bountyId].repoId)
        whenNotPaused
    {
        Bounty storage b = bounties[_bountyId];
        require(
            b.status != BountyStatus.COMPLETED && b.status != BountyStatus.CANCELLED,
            "Bounty closed"
        );
        require(msg.value > 0, "Send ETH");
        repos[b.repoId].totalFunded += msg.value;
        b.amount += msg.value;
        emit BountyIncreased(_bountyId, msg.value, b.amount);
    }

    /// @notice Cancel an OPEN (unassigned) bounty and return funds to repo pool.
    function cancelBounty(uint256 _bountyId)
        external
        bountyExists(_bountyId)
        onlyRepoOwner(bounties[_bountyId].repoId)
    {
        Bounty storage b = bounties[_bountyId];
        require(b.status == BountyStatus.OPEN, "Can only cancel open bounties");

        b.status = BountyStatus.CANCELLED;
        repos[b.repoId].available += b.amount;

        bytes32 issueHash = keccak256(bytes(b.githubIssueUrl));
        delete issueUrlToBountyId[issueHash];

        emit BountyCancelled(_bountyId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Contributor Flow
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Step 1 — Take an open bounty. Stake 10–20% of the bounty as collateral.
     *                  Deadline countdown begins from this call.
     */
    function takeBounty(uint256 _bountyId)
        external payable
        nonReentrant
        whenNotPaused
        bountyExists(_bountyId)
    {
        Bounty storage b = bounties[_bountyId];
        require(b.status == BountyStatus.OPEN, "Bounty not open");
        require(msg.sender != b.org, "Org cannot take own bounty");
        require(!hasAttempted[_bountyId][msg.sender], "Already attempted this bounty");

        uint256 minStake = (b.amount * CONTRIBUTOR_STAKE_BPS) / 10000;
        uint256 maxStake = (b.amount * MAX_CONTRIBUTOR_STAKE_BPS) / 10000;
        require(msg.value >= minStake && msg.value <= maxStake, "Stake out of range (10-20% of bounty)");

        Repo storage r = repos[b.repoId];
        uint256 deadline;
        if      (b.severity == Severity.LOW)    deadline = block.timestamp + r.easyDuration;
        else if (b.severity == Severity.MEDIUM) deadline = block.timestamp + r.mediumDuration;
        else                                    deadline = block.timestamp + r.hardDuration;

        b.status           = BountyStatus.ASSIGNED;
        b.assignedTo       = msg.sender;
        b.deadline         = deadline;
        b.contributorStake = msg.value;

        hasAttempted[_bountyId][msg.sender] = true;
        bountyApplicants[_bountyId].push(msg.sender);
        contributorStakes[msg.sender] += msg.value;
        contributorBounties[msg.sender].push(_bountyId);

        emit BountyTaken(_bountyId, msg.sender, deadline, msg.value);
    }

    /**
     * @notice Step 2 — Submit a pull request URL on-chain.
     *                  Only the assigned contributor can call this.
     *                  Status advances to PR_SUBMITTED.
     * @param _prUrl  e.g. https://github.com/owner/repo/pull/7
     */
    function submitPR(uint256 _bountyId, string calldata _prUrl)
        external
        bountyExists(_bountyId)
    {
        Bounty storage b = bounties[_bountyId];
        require(b.assignedTo == msg.sender, "Only assigned contributor");
        require(b.status == BountyStatus.ASSIGNED, "Bounty not in ASSIGNED state");
        require(bytes(_prUrl).length > 0, "Empty PR URL");
        require(block.timestamp <= b.deadline, "Deadline has passed");

        b.status       = BountyStatus.PR_SUBMITTED;
        b.prUrl        = _prUrl;
        b.prSubmittedAt = block.timestamp;

        emit PRSubmitted(_bountyId, msg.sender, _prUrl);
    }

    /**
     * @notice Step 3a — Org confirms the PR was merged on GitHub.
     *                   Status advances to MERGED; contributor can now claim.
     */
    function approveMerge(uint256 _bountyId)
        external
        bountyExists(_bountyId)
    {
        Bounty storage b = bounties[_bountyId];
        require(msg.sender == repos[b.repoId].owner, "Only repo owner");
        require(b.status == BountyStatus.PR_SUBMITTED, "No PR submitted yet");

        b.status = BountyStatus.MERGED;

        emit MergeApproved(_bountyId, msg.sender, b.prUrl);
    }

    /**
     * @notice Step 3b — Org rejects the submitted PR (bad fix, wrong approach, etc.).
     *                   Contributor gets their full stake back — they did the work.
     *                   Bounty is reopened so another contributor can attempt it.
     *                   Only the repo owner can call this.
     */
    function rejectPR(uint256 _bountyId)
        external
        nonReentrant
        bountyExists(_bountyId)
    {
        Bounty storage b = bounties[_bountyId];
        require(msg.sender == repos[b.repoId].owner, "Only repo owner");
        require(b.status == BountyStatus.PR_SUBMITTED, "No PR submitted");

        address contributor = b.assignedTo;
        uint256 stake       = b.contributorStake;
        string memory prUrl = b.prUrl;

        // Reopen bounty
        b.status           = BountyStatus.OPEN;
        b.assignedTo       = address(0);
        b.deadline         = 0;
        b.contributorStake = 0;
        b.prUrl            = "";
        b.prSubmittedAt    = 0;

        repos[b.repoId].available += b.amount;
        contributorStakes[contributor] -= stake;
        _removeBountyFromContributor(contributor, _bountyId);

        // Full stake returned — contributor made an honest attempt
        payable(contributor).transfer(stake);

        emit PRRejected(_bountyId, msg.sender, prUrl, stake);
    }

    /**
     * @notice Step 4 — Contributor claims their bounty reward + stake after merge approval.
     *                  Can only be called once status is MERGED.
     */
    function claimBounty(uint256 _bountyId)
        external
        nonReentrant
        bountyExists(_bountyId)
    {
        Bounty storage b = bounties[_bountyId];
        require(b.assignedTo == msg.sender, "Only assigned contributor");
        require(b.status == BountyStatus.MERGED, "PR not approved yet");

        b.status = BountyStatus.COMPLETED;

        uint256 stake  = b.contributorStake;
        uint256 payout = b.amount + stake;

        contributorStakes[msg.sender] -= stake;
        _removeBountyFromContributor(msg.sender, _bountyId);

        payable(msg.sender).transfer(payout);

        emit BountyClaimed(_bountyId, msg.sender, payout);
    }

    /**
     * @notice Deadline expired without the org approving a merge.
     *         Bounty reopens. Stake handling depends on how far the contributor got:
     *
     *         ASSIGNED (no PR submitted) — abandonment penalty:
     *           50% of stake slashed → added to repo pool
     *           50% of stake returned to contributor
     *
     *         PR_SUBMITTED (org never reviewed) — org's fault:
     *           100% of stake returned to contributor
     */
    // function claimExpiredBounty(uint256 _bountyId)
    //     external
    //     nonReentrant
    //     bountyExists(_bountyId)
    // {
    //     Bounty storage b = bounties[_bountyId];
    //     require(b.assignedTo == msg.sender, "Not assigned to you");
    //     require(
    //         b.status == BountyStatus.ASSIGNED || b.status == BountyStatus.PR_SUBMITTED,
    //         "Not in an expirable state"
    //     );
    //     require(block.timestamp > b.deadline, "Deadline not passed");

    //     BountyStatus prevStatus = b.status;
    //     uint256 stake = b.contributorStake;

    //     // Reset bounty to OPEN
    //     b.status           = BountyStatus.OPEN;
    //     b.assignedTo       = address(0);
    //     b.deadline         = 0;
    //     b.contributorStake = 0;
    //     b.prUrl            = "";
    //     b.prSubmittedAt    = 0;

    //     repos[b.repoId].available += b.amount;
    //     contributorStakes[msg.sender] -= stake;
    //     _removeBountyFromContributor(msg.sender, _bountyId);

    //     uint256 stakeReturned;
    //     uint256 slashedAmount;

    //     if (prevStatus == BountyStatus.ASSIGNED) {
    //         // Abandoned — never submitted a PR — slash 50%
    //         slashedAmount  = (stake * ABANDON_SLASH_BPS) / 10000;
    //         stakeReturned  = stake - slashedAmount;
    //         // Slashed portion goes back into the repo's reward pool
    //         repos[b.repoId].available += slashedAmount;
    //     } else {
    //         // PR was submitted but org didn't respond — full return
    //         stakeReturned = stake;
    //         slashedAmount = 0;
    //     }

    //     payable(msg.sender).transfer(stakeReturned);

    //     emit BountyExpired(_bountyId, msg.sender, prevStatus, stakeReturned, slashedAmount);
    // }

    function claimExpiredBounty(uint256 _bountyId)
    external
    nonReentrant
    bountyExists(_bountyId)
{
    Bounty storage b = bounties[_bountyId];
    require(b.assignedTo != address(0), "No one assigned");
    require(
        b.status == BountyStatus.ASSIGNED || b.status == BountyStatus.PR_SUBMITTED,
        "Not in an expirable state"
    );
    require(block.timestamp > b.deadline, "Deadline not passed");

    BountyStatus prevStatus = b.status;
    address contributor = b.assignedTo;  // ← capture before reset
    uint256 stake = b.contributorStake;

    // Reset bounty to OPEN
    b.status           = BountyStatus.OPEN;
    b.assignedTo       = address(0);
    b.deadline         = 0;
    b.contributorStake = 0;
    b.prUrl            = "";
    b.prSubmittedAt    = 0;

    repos[b.repoId].available += b.amount;
    contributorStakes[contributor] -= stake;
    _removeBountyFromContributor(contributor, _bountyId);

    uint256 stakeReturned;
    uint256 slashedAmount;

    if (prevStatus == BountyStatus.ASSIGNED) {
        slashedAmount = (stake * ABANDON_SLASH_BPS) / 10000;
        stakeReturned = stake - slashedAmount;
        repos[b.repoId].available += slashedAmount;
    } else {
    // PR_SUBMITTED — org didn't review in time
    // contributor did everything right → full stake back
        stakeReturned = stake;
        slashedAmount = 0;
    }

    payable(contributor).transfer(stakeReturned);  // ← contributor, not msg.sender

    emit BountyExpired(_bountyId, contributor, prevStatus, stakeReturned, slashedAmount);
}

    /**
     * @notice Safety valve: withdraw stake that is no longer locked in any bounty.
     */
    // function withdrawStake() external nonReentrant {
    //     uint256 amount = contributorStakes[msg.sender];
    //     require(amount > 0, "Nothing to withdraw");
    //     contributorStakes[msg.sender] = 0;
    //     payable(msg.sender).transfer(amount);
    //     emit StakeWithdrawn(msg.sender, amount);
    // }

    // ─────────────────────────────────────────────────────────────────────────
    // View Helpers
    // ─────────────────────────────────────────────────────────────────────────

    function getRepo(uint256 _repoId) external view repoExists(_repoId) returns (Repo memory) {
        return repos[_repoId];
    }

    function getRepoByUrl(string calldata _repoUrl) external view returns (Repo memory) {
        bytes32 h = keccak256(bytes(_toLower(_repoUrl)));
        uint256 id = repoUrlToId[h];
        require(id != 0, "Repo not registered");
        return repos[id];
    }

    function getBounty(uint256 _bountyId) external view bountyExists(_bountyId) returns (Bounty memory) {
        return bounties[_bountyId];
    }

    function getRepoBounties(uint256 _repoId) external view returns (uint256[] memory) {
        return repoBounties[_repoId];
    }

    function getOrgRepos(address _org) external view returns (uint256[] memory) {
        return orgRepos[_org];
    }

    function getContributorBounties(address _contributor) external view returns (uint256[] memory) {
        return contributorBounties[_contributor];
    }

    function getBountyApplicants(uint256 _bountyId) external view returns (address[] memory) {
        return bountyApplicants[_bountyId];
    }

    function isBountyExpired(uint256 _bountyId) external view bountyExists(_bountyId) returns (bool) {
        Bounty storage b = bounties[_bountyId];
        return (
            (b.status == BountyStatus.ASSIGNED || b.status == BountyStatus.PR_SUBMITTED) &&
            block.timestamp > b.deadline
        );
    }

    function getBountyIdByIssueUrl(string calldata _githubIssueUrl) external view returns (uint256) {
        return issueUrlToBountyId[keccak256(bytes(_githubIssueUrl))];
    }

    function getContractBalance() external view returns (uint256) {
        return address(this).balance;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    function _removeBountyFromContributor(address _contributor, uint256 _bountyId) internal {
        uint256[] storage list = contributorBounties[_contributor];
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == _bountyId) {
                list[i] = list[list.length - 1];
                list.pop();
                break;
            }
        }
    }

    /// @dev Naive ASCII lowercase for repo URL dedup hashing only.
    function _toLower(string memory _str) internal pure returns (string memory) {
        bytes memory b = bytes(_str);
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] >= 0x41 && b[i] <= 0x5A) {
                b[i] = bytes1(uint8(b[i]) + 32);
            }
        }
        return string(b);
    }
}
