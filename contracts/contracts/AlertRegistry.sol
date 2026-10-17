// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * AlertRegistry — on-chain alert subscriptions for POT Watch.
 *
 * Users register watch rules (validator uptime, era rotation, slash events,
 * large transfers) with a delivery channel. The off-chain POT Watch watcher
 * mirrors these rules, evaluates them against live chain state, delivers
 * notifications (Discord/Telegram), and records each fire back on-chain so
 * every alert has a verifiable on-chain trail.
 *
 * Deployed on Portaldot Network V3.0 EVM (chain ID 420420777).
 */
contract AlertRegistry {
    enum Kind {
        ValidatorUptime, // fire when a validator's uptime drops below threshold (bps)
        EraRotation,     // fire on era change
        SlashEvent,      // fire when target validator is slashed
        LargeTransfer    // fire on transfers above threshold (raw units, 14 decimals)
    }

    enum Channel {
        Discord,
        Telegram
    }

    struct Alert {
        address owner;
        Kind kind;
        bytes32 target;   // validator account (ss58 pubkey hash) or zero for network-wide
        uint64 threshold; // bps for uptime, raw units for transfers, 0 otherwise
        Channel channel;
        bool active;
        uint64 createdAt;
        uint64 lastFiredAt;
        uint32 fireCount;
    }

    uint256 public nextId = 1;
    uint256 public totalRegistered;
    uint256 public totalCancelled;

    mapping(uint256 => Alert) private _alerts;
    mapping(address => uint256[]) private _byOwner;
    mapping(uint256 => uint256) private _fireBlock; // id → last block fired

    event AlertRegistered(
        uint256 indexed id,
        address indexed owner,
        Kind kind,
        bytes32 target,
        uint64 threshold,
        Channel channel
    );
    event AlertCancelled(uint256 indexed id, address indexed owner);
    event AlertFired(uint256 indexed id, address indexed watcher, uint256 blockNumber);

    error NotOwner();
    error NotActive();
    error NotFound();
    error Cooldown();

    /// @notice Register a new alert rule. Returns the alert id.
    function registerAlert(
        Kind kind,
        bytes32 target,
        uint64 threshold,
        Channel channel
    ) external returns (uint256 id) {
        id = nextId++;
        _alerts[id] = Alert({
            owner: msg.sender,
            kind: kind,
            target: target,
            threshold: threshold,
            channel: channel,
            active: true,
            createdAt: uint64(block.timestamp),
            lastFiredAt: 0,
            fireCount: 0
        });
        _byOwner[msg.sender].push(id);
        totalRegistered++;
        emit AlertRegistered(id, msg.sender, kind, target, threshold, channel);
    }

    /// @notice Cancel an alert. Only the owner can cancel.
    function cancelAlert(uint256 id) external {
        Alert storage a = _alerts[id];
        if (a.owner == address(0)) revert NotFound();
        if (a.owner != msg.sender) revert NotOwner();
        if (!a.active) revert NotActive();
        a.active = false;
        totalCancelled++;
        emit AlertCancelled(id, msg.sender);
    }

    /**
     * @notice Record that the watcher fired an alert. Permissionless by design
     * (watcher runs under its own key), rate-limited to once per block per alert.
     */
    function recordFire(uint256 id) external {
        Alert storage a = _alerts[id];
        if (a.owner == address(0)) revert NotFound();
        if (!a.active) revert NotActive();
        if (_fireBlock[id] == block.number) revert Cooldown();
        _fireBlock[id] = block.number;
        a.lastFiredAt = uint64(block.timestamp);
        a.fireCount++;
        emit AlertFired(id, msg.sender, block.number);
    }

    /// @notice Get a single alert.
    function getAlert(uint256 id) external view returns (Alert memory) {
        if (_alerts[id].owner == address(0)) revert NotFound();
        return _alerts[id];
    }

    /// @notice List all alert ids owned by an account.
    function listAlertIds(address owner) external view returns (uint256[] memory) {
        return _byOwner[owner];
    }

    /// @notice List full alert records owned by an account.
    function listAlerts(address owner) external view returns (Alert[] memory out) {
        uint256[] storage ids = _byOwner[owner];
        out = new Alert[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            out[i] = _alerts[ids[i]];
        }
    }

    /// @notice Number of currently active alerts across all owners.
    function activeAlertCount() external view returns (uint256 count) {
        for (uint256 id = 1; id < nextId; id++) {
            if (_alerts[id].active) count++;
        }
    }
}
