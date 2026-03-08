// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title MergeXBounty
 * @notice Decentralized bounty platform for open-source security issues.
 *         Organizations register repos and fund bounties.
 *         Contributors pick up issues, stake collateral, and earn rewards.
 */
contract MergeXBounty is ReentrancyGuard, Ownable, Pausable {

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event RepoRegistered(
        address indexed org,
        uint256 indexed repoId,
        string repoUrl,
        uint256 stakedAmount
    );
    event RepoFunded(address indexed org, uint256 indexed repoId, uint256 addedAmount, uint256 newTotal);
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
    event BountyCompleted(uint256 indexed bountyId, address indexed contributor, uint256 reward);
    event BountyExpired(uint256 indexed bountyId, address indexed contributor);
    event StakeWithdrawn(address indexed contributor, uint256 amount);
    event FundsWithdrawn(address indexed org, uint256 indexed repoId, uint256 amount);

    // ─────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────

    enum Severity { LOW, MEDIUM, HIGH, CRITICAL }
    enum BountyStatus { OPEN, ASSIGNED, COMPLETED, CANCELLED }

    struct Repo {
        uint256 id;
        string repoUrl;         // e.g. "owner/repo"
        address owner;
        uint256 totalFunded;    // lifetime ETH deposited
        uint256 available;      // ETH currently available to fund new bounties
        bool isActive;
        uint256 easyDuration;   // deadline window for LOW bounties
        uint256 mediumDuration;
        uint256 hardDuration;   // deadline window for CRITICAL bounties
    }

    struct Bounty {
        uint256 id;
        uint256 repoId;
        address org;
        string githubIssueUrl;  // canonical GitHub issue URL
        string githubIssueId;   // numeric GitHub issue id (string for flexibility)
        string title;
        string description;
        uint256 amount;         // locked reward
        Severity severity;
        BountyStatus status;
        address assignedTo;
        uint256 createdAt;
        uint256 deadline;       // 0 until taken
        uint256 contributorStake; // contributor's skin-in-the-game deposit
    }

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public nextRepoId  = 1;
    uint256 public nextBountyId = 1;

    // repoId → Repo
    mapping(uint256 => Repo) public repos;
    // org address → list of repoIds they own
    mapping(address => uint256[]) public orgRepos;
    // repoUrl (lowercase) → repoId  (prevents duplicate registrations)
    mapping(bytes32 => uint256) public repoUrlToId;

    // bountyId → Bounty
    mapping(uint256 => Bounty) public bounties;
    // repoId → list of bountyIds
    mapping(uint256 => uint256[]) public repoBounties;
    // githubIssueUrl hash → bountyId  (prevents duplicate bounties per issue)
    mapping(bytes32 => uint256) public issueUrlToBountyId;

    // contributor address → total staked (across all active bounties)
    mapping(address => uint256) public contributorStakes;
    // contributor → list of bountyIds they're assigned to
    mapping(address => uint256[]) public contributorBounties;
    // bountyId → all addresses that ever attempted it
    mapping(uint256 => address[]) public bountyApplicants;
    // bountyId → address → attempted?
    mapping(uint256 => mapping(address => bool)) public hasAttempted;

    // ─────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public constant MIN_ORG_STAKE = 0.000001 ether;
    uint256 public constant CONTRIBUTOR_STAKE_BPS = 1000; // 10 % of bounty (basis points)
    uint256 public constant MAX_CONTRIBUTOR_STAKE_BPS = 2000; // 20 %

    uint256 public constant DEFAULT_LOW_DURATION      = 14 days;
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

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    constructor() Ownable(msg.sender) {}

    // ─────────────────────────────────────────────────────────────────────────
    // Organization / Repo Management
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Register a GitHub repo and fund it. Org can register multiple repos.
     * @param _repoUrl  e.g. "owner/repo"
     * @param _easyDuration     deadline override for LOW bounties (0 = use default)
     * @param _mediumDuration   deadline override for MEDIUM
     * @param _hardDuration     deadline override for HIGH/CRITICAL
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

    /**
     * @notice Add more ETH to an existing repo's reward pool.
     */
    function fundRepo(uint256 _repoId)
        external
        payable
        repoExists(_repoId)
        onlyRepoOwner(_repoId)
        whenNotPaused
    {
        require(msg.value > 0, "Send ETH");
        repos[_repoId].totalFunded += msg.value;
        repos[_repoId].available   += msg.value;
        emit RepoFunded(msg.sender, _repoId, msg.value, repos[_repoId].available);
    }

    /**
     * @notice Withdraw idle funds from a repo (only what isn't locked in open bounties).
     */
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

    /**
     * @notice Update deadline windows for a repo.
     */
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
    // Bounty Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Create a bounty linked to a GitHub issue.
     *         Can be called by the repo owner OR any address that provides extra ETH
     *         to top-up the repo first (owner-only for simplicity here).
     * @param _repoId         Registered repo id
     * @param _githubIssueUrl Full GitHub issue URL (e.g. https://github.com/owner/repo/issues/42)
     * @param _githubIssueId  GitHub issue number as string (e.g. "42")
     * @param _title          Issue title
     * @param _description    Short description / audit scope
     * @param _amount         Reward in wei (deducted from repo.available)
     * @param _severity       LOW / MEDIUM / HIGH / CRITICAL
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
            contributorStake: 0
        });

        repos[_repoId].available -= _amount;
        repoBounties[_repoId].push(bountyId);
        issueUrlToBountyId[issueHash] = bountyId;

        emit BountyCreated(bountyId, _repoId, msg.sender, _githubIssueUrl, _amount, _severity);
    }

    /**
     * @notice Batch-create bounties from a list of already-open GitHub issues.
     *         Useful for importing existing repo issues as bounties in one tx.
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
            if (issueUrlToBountyId[issueHash] != 0) continue; // skip duplicates silently

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
                contributorStake: 0
            });

            repos[_repoId].available -= _amounts[i];
            repoBounties[_repoId].push(bid);
            issueUrlToBountyId[issueHash] = bid;
            bountyIds[i] = bid;

            emit BountyCreated(bid, _repoId, msg.sender, _githubIssueUrls[i], _amounts[i], _severities[i]);
        }
    }

    /**
     * @notice Increase the reward of an open or assigned bounty.
     *         Sends extra ETH — added directly to the bounty (not the repo pool).
     */
    function increaseBounty(uint256 _bountyId)
        external
        payable
        bountyExists(_bountyId)
        onlyRepoOwner(bounties[_bountyId].repoId)
        whenNotPaused
    {
        Bounty storage b = bounties[_bountyId];
        require(b.status != BountyStatus.COMPLETED && b.status != BountyStatus.CANCELLED, "Bounty closed");
        require(msg.value > 0, "Send ETH");

        repos[b.repoId].totalFunded += msg.value;
        b.amount += msg.value;

        emit BountyIncreased(_bountyId, msg.value, b.amount);
    }

    /**
     * @notice Cancel an OPEN (unassigned) bounty and return funds to repo pool.
     */
    function cancelBounty(uint256 _bountyId)
        external
        bountyExists(_bountyId)
        onlyRepoOwner(bounties[_bountyId].repoId)
    {
        Bounty storage b = bounties[_bountyId];
        require(b.status == BountyStatus.OPEN, "Can only cancel open bounties");

        b.status = BountyStatus.CANCELLED;
        repos[b.repoId].available += b.amount;

        // clear the url reservation so a new bounty can be created for same issue
        bytes32 issueHash = keccak256(bytes(b.githubIssueUrl));
        delete issueUrlToBountyId[issueHash];

        emit BountyCancelled(_bountyId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Contributor Flow
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Take an open bounty. Contributor must stake 10–20 % of the bounty amount.
     */
    function takeBounty(uint256 _bountyId) external payable nonReentrant whenNotPaused bountyExists(_bountyId) {
        Bounty storage b = bounties[_bountyId];
        require(b.status == BountyStatus.OPEN, "Bounty not open");
        require(msg.sender != b.org, "Org cannot take own bounty");
        require(!hasAttempted[_bountyId][msg.sender], "Already attempted");

        uint256 minStake = (b.amount * CONTRIBUTOR_STAKE_BPS) / 10000;
        uint256 maxStake = (b.amount * MAX_CONTRIBUTOR_STAKE_BPS) / 10000;
        require(msg.value >= minStake && msg.value <= maxStake, "Stake out of range");

        Repo storage r = repos[b.repoId];
        uint256 deadline;
        if (b.severity == Severity.LOW)      deadline = block.timestamp + r.easyDuration;
        else if (b.severity == Severity.MEDIUM) deadline = block.timestamp + r.mediumDuration;
        else                                    deadline = block.timestamp + r.hardDuration;

        b.status        = BountyStatus.ASSIGNED;
        b.assignedTo    = msg.sender;
        b.deadline      = deadline;
        b.contributorStake = msg.value;

        hasAttempted[_bountyId][msg.sender] = true;
        bountyApplicants[_bountyId].push(msg.sender);
        contributorStakes[msg.sender] += msg.value;
        contributorBounties[msg.sender].push(_bountyId);

        emit BountyTaken(_bountyId, msg.sender, deadline, msg.value);
    }

    /**
     * @notice Org owner marks a bounty complete after verifying the fix on GitHub.
     *         Contributor receives bounty reward + their stake back.
     */
    function completeBounty(uint256 _bountyId) external nonReentrant bountyExists(_bountyId) {
        Bounty storage b = bounties[_bountyId];
        require(msg.sender == repos[b.repoId].owner, "Only repo owner");
        require(b.status == BountyStatus.ASSIGNED, "Not assigned");

        b.status = BountyStatus.COMPLETED;

        uint256 stake  = b.contributorStake;
        uint256 payout = b.amount + stake;

        contributorStakes[b.assignedTo] -= stake;
        _removeBountyFromContributor(b.assignedTo, _bountyId);

        payable(b.assignedTo).transfer(payout);

        emit BountyCompleted(_bountyId, b.assignedTo, payout);
    }

    /**
     * @notice If the deadline passes without the org completing the bounty,
     *         the contributor can call this to get their stake back.
     *         The bounty is reopened for someone else to take.
     */
    function claimExpiredBounty(uint256 _bountyId) external nonReentrant bountyExists(_bountyId) {
        Bounty storage b = bounties[_bountyId];
        require(b.assignedTo == msg.sender, "Not assigned to you");
        require(b.status == BountyStatus.ASSIGNED, "Not assigned");
        require(block.timestamp > b.deadline, "Deadline not passed");

        uint256 stake = b.contributorStake;

        b.status           = BountyStatus.OPEN;
        b.assignedTo       = address(0);
        b.deadline         = 0;
        b.contributorStake = 0;

        repos[b.repoId].available += b.amount;
        contributorStakes[msg.sender] -= stake;
        _removeBountyFromContributor(msg.sender, _bountyId);

        payable(msg.sender).transfer(stake);

        emit BountyExpired(_bountyId, msg.sender);
    }

    /**
     * @notice Withdraw any stake that is no longer locked (edge case safety valve).
     */
    function withdrawStake() external nonReentrant {
        uint256 amount = contributorStakes[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        contributorStakes[msg.sender] = 0;
        payable(msg.sender).transfer(amount);
        emit StakeWithdrawn(msg.sender, amount);
    }

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
        return b.status == BountyStatus.ASSIGNED && block.timestamp > b.deadline;
    }

    function getBountyIdByIssueUrl(string calldata _githubIssueUrl) external view returns (uint256) {
        bytes32 h = keccak256(bytes(_githubIssueUrl));
        return issueUrlToBountyId[h];
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

    /// @dev Very naive ASCII lowercase — only needed for the repo URL dedup hash.
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
