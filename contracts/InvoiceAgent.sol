// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Aevum Invoice Agent
/// @notice On-chain invoices settled in tUSD8 on QDay Aevum Testnet, driven by
///         a natural-language AI assistant (off-chain parser, see agent/).
///         Flow: seller creates invoice -> payer escrows tUSD8 -> payer confirms
///         receipt -> escrow releases to seller. Dispute and expiry paths make
///         sure escrowed funds can never be locked forever.
/// @dev Amounts are tUSD8 smallest units (6 decimals). The contract never holds
///      tQDAY and never moves funds except through the transitions below.
contract InvoiceAgent is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice tUSD8 on Aevum Testnet (ERC-20, 6 decimals).
    IERC20 public immutable tusd8;

    /// @notice Silence window after payment: if the payer neither confirms nor
    ///         disputes within this window, the seller may claim the escrow.
    uint256 public constant GRACE_PERIOD = 7 days;

    uint256 public nextInvoiceId;

    enum Status {
        Created, // invoice exists, not yet paid
        Paid, // tUSD8 escrowed in this contract
        Completed, // escrow released to seller
        Refunded, // escrow returned to payer
        Cancelled, // voided by seller before payment
        Disputed // payer raised a dispute; awaiting seller resolution
    }

    struct Invoice {
        address seller;
        address payer;
        uint256 amount;
        uint256 dueDate;
        bytes32 memoHash;
        string memo;
        Status status;
        uint256 paidAt;
    }

    mapping(uint256 => Invoice) public invoices;

    event InvoiceCreated(
        uint256 indexed id,
        address indexed seller,
        address indexed payer,
        uint256 amount,
        uint256 dueDate,
        string memo
    );
    event InvoicePaid(uint256 indexed id, address indexed payer, uint256 amount);
    event InvoiceCompleted(uint256 indexed id, address indexed seller, uint256 amount);
    event InvoiceRefunded(uint256 indexed id, address indexed payer, uint256 amount);
    event InvoiceCancelled(uint256 indexed id, address indexed seller);
    event InvoiceDisputed(uint256 indexed id, address indexed payer);
    event DisputeResolved(uint256 indexed id, bool refundedToPayer);

    error ZeroAmount();
    error SelfInvoice();
    error PastDueDate();
    error NotSeller();
    error NotPayer();
    error WrongStatus(Status current, Status expected);
    error GraceNotElapsed();
    error DisputeWindowClosed();

    modifier onlySeller(uint256 id) {
        if (msg.sender != invoices[id].seller) revert NotSeller();
        _;
    }

    modifier onlyPayer(uint256 id) {
        if (msg.sender != invoices[id].payer) revert NotPayer();
        _;
    }

    modifier inStatus(uint256 id, Status expected) {
        Status current = invoices[id].status;
        if (current != expected) revert WrongStatus(current, expected);
        _;
    }

    constructor(address _tusd8) {
        tusd8 = IERC20(_tusd8);
    }

    /// @notice Create an invoice for `payer`. The caller is the seller.
    /// @param payer Who must pay this invoice.
    /// @param amount tUSD8 amount in smallest units (6 decimals).
    /// @param dueDate Unix timestamp the payment is due.
    /// @param memo Human-readable description (e.g. "Logo design — Nov 2026").
    /// @return id The new invoice id.
    function createInvoice(
        address payer,
        uint256 amount,
        uint256 dueDate,
        string calldata memo
    ) external returns (uint256 id) {
        if (amount == 0) revert ZeroAmount();
        if (payer == msg.sender) revert SelfInvoice();
        if (dueDate <= block.timestamp) revert PastDueDate();

        id = nextInvoiceId++;
        invoices[id] = Invoice({
            seller: msg.sender,
            payer: payer,
            amount: amount,
            dueDate: dueDate,
            memoHash: keccak256(bytes(memo)),
            memo: memo,
            status: Status.Created,
            paidAt: 0
        });

        emit InvoiceCreated(id, msg.sender, payer, amount, dueDate, memo);
    }

    /// @notice Pay an invoice. Caller must be the payer and must have approved
    ///         this contract for at least `amount` tUSD8 beforehand. Funds are
    ///         escrowed in this contract until release or refund.
    function payInvoice(uint256 id) external nonReentrant onlyPayer(id) inStatus(id, Status.Created) {
        Invoice storage inv = invoices[id];
        inv.status = Status.Paid;
        inv.paidAt = block.timestamp;
        tusd8.safeTransferFrom(msg.sender, address(this), inv.amount);
        emit InvoicePaid(id, msg.sender, inv.amount);
    }

    /// @notice Payer confirms receipt of goods/services; escrow releases to seller.
    function confirmReceipt(uint256 id) external nonReentrant onlyPayer(id) inStatus(id, Status.Paid) {
        Invoice storage inv = invoices[id];
        inv.status = Status.Completed;
        tusd8.safeTransfer(inv.seller, inv.amount);
        emit InvoiceCompleted(id, inv.seller, inv.amount);
    }

    /// @notice Seller voluntarily refunds the escrow to the payer (Paid or Disputed).
    function refundInvoice(uint256 id) external nonReentrant onlySeller(id) {
        Invoice storage inv = invoices[id];
        Status current = inv.status;
        if (current != Status.Paid && current != Status.Disputed) {
            revert WrongStatus(current, Status.Paid);
        }
        inv.status = Status.Refunded;
        tusd8.safeTransfer(inv.payer, inv.amount);
        emit InvoiceRefunded(id, inv.payer, inv.amount);
    }

    /// @notice Payer raises a dispute while the grace window is still open.
    function disputeInvoice(uint256 id) external onlyPayer(id) inStatus(id, Status.Paid) {
        Invoice storage inv = invoices[id];
        if (block.timestamp > inv.paidAt + GRACE_PERIOD) revert DisputeWindowClosed();
        inv.status = Status.Disputed;
        emit InvoiceDisputed(id, msg.sender);
    }

    /// @notice Seller resolves a dispute: refund the payer, or release to seller.
    function resolveDispute(
        uint256 id,
        bool refundPayer
    ) external nonReentrant onlySeller(id) inStatus(id, Status.Disputed) {
        Invoice storage inv = invoices[id];
        if (refundPayer) {
            inv.status = Status.Refunded;
            tusd8.safeTransfer(inv.payer, inv.amount);
            emit InvoiceRefunded(id, inv.payer, inv.amount);
        } else {
            inv.status = Status.Completed;
            tusd8.safeTransfer(inv.seller, inv.amount);
            emit InvoiceCompleted(id, inv.seller, inv.amount);
        }
        emit DisputeResolved(id, refundPayer);
    }

    /// @notice If a dispute is never resolved, the payer can reclaim the escrow
    ///         after the grace window elapses. Funds can never lock forever.
    function claimDisputeRefund(uint256 id) external nonReentrant onlyPayer(id) inStatus(id, Status.Disputed) {
        Invoice storage inv = invoices[id];
        if (block.timestamp <= inv.paidAt + GRACE_PERIOD) revert GraceNotElapsed();
        inv.status = Status.Refunded;
        tusd8.safeTransfer(inv.payer, inv.amount);
        emit InvoiceRefunded(id, inv.payer, inv.amount);
    }

    /// @notice If the payer neither confirms nor disputes within the grace window,
    ///         the seller may claim the escrow (silence = acceptance).
    function claimExpired(uint256 id) external nonReentrant onlySeller(id) inStatus(id, Status.Paid) {
        Invoice storage inv = invoices[id];
        if (block.timestamp <= inv.paidAt + GRACE_PERIOD) revert GraceNotElapsed();
        inv.status = Status.Completed;
        tusd8.safeTransfer(inv.seller, inv.amount);
        emit InvoiceCompleted(id, inv.seller, inv.amount);
    }

    /// @notice Seller voids an unpaid invoice.
    function cancelInvoice(uint256 id) external onlySeller(id) inStatus(id, Status.Created) {
        invoices[id].status = Status.Cancelled;
        emit InvoiceCancelled(id, msg.sender);
    }

    /// @notice Full invoice record (the public mapping getter returns the same).
    function getInvoice(uint256 id) external view returns (Invoice memory) {
        return invoices[id];
    }
}
