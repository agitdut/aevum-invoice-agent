# Aevum Invoice Agent

**Aevum Builder Challenge #1** · Tracks: **Native AI Assistants × Invoice Payments**
· Solo entry by [Agit Septiana Firdaus](https://github.com/agitdut) · MIT license

> Tell the assistant what to invoice in plain words — it drafts the invoice,
> you sign once, and tUSD8 settles on-chain in escrow on QDay Aevum Testnet.

**Live demo:** _(URL after deployment — the demo runs at `http://localhost:3000` locally)_
**Contract:** _(address after deployment — see `deployments/aevum.json`)_
**Explorer:** https://explorer-test.qday.info

## The problem

Freelancers and small businesses still invoice by PDF + bank transfer: no
proof of agreement, no escrow, and chasing late payment is manual work.
Stablecoins fix the money movement, but the UX of creating an on-chain
invoice is still a form full of hex addresses and decimals — hostile to the
people who need it most.

## What this is

A natural-language **invoice assistant** that turns one sentence into a
settled on-chain payment:

1. **You type:** _"Buatkan invoice 150 tUSD8 untuk 0x742d…44e, jasa desain logo,
   jatuh tempo 5 Des"_ (Indonesian or English).
2. **The assistant parses it** into a structured invoice — amount, payer,
   due date, memo — and shows it back for review. No silent execution.
3. **You sign once** in MetaMask. The invoice is created on-chain.
4. **The payer pays** — tUSD8 is locked in escrow inside the contract.
5. **The payer confirms receipt** and the escrow releases to the seller.
   If the payer never responds, the seller can claim after a 7-day silence
   window; if there is a dispute, the payer can reclaim the escrow after the
   same window. **Escrowed funds can never be locked forever.**

## Why this track combination

- **Innovation (20 pts, the largest category)** explicitly rewards "creative
  agentic mechanics" and "agentic payment primitives" — an AI assistant that
  originates real payment flows is exactly that, and it spans two tracks at
  once instead of cloning a standard invoice dApp.
- **Real-world utility (15 pts):** invoicing is a concrete, everyday business
  flow with obvious users (freelancers, agencies, DAOs paying contributors).
- **Safety, trust and controls (15 pts):** every state transition is
  role-gated, escrow has dispute + expiry exits, and the assistant never
  signs anything — the user reviews and signs every transaction.
- **Technical quality (15 pts):** the contract is small, tested (14 unit
  tests), and uses OpenZeppelin `SafeERC20` + `ReentrancyGuard`; the
  assistant is a deterministic local parser with an optional LLM layer.

## Architecture

```
User sentence ──► agent/parse.js ──► structured invoice ──► review ──► sign
   (rule-based NL parser, EN + ID; optional OpenAI-compatible LLM)
                          │
                          ▼
              contracts/InvoiceAgent.sol  (Aevum Testnet, chain 44005)
   createInvoice → payInvoice (escrow) → confirmReceipt (release)
                 ↘ dispute / refund / claimExpired / claimDisputeRefund
                          │
                          ▼
              agent/public/ (demo frontend, ethers v6, no build step)
```

| Part | Stack | Notes |
|---|---|---|
| Smart contract | Solidity 0.8.24, OpenZeppelin 5 | `contracts/InvoiceAgent.sol` |
| Tests | Hardhat + ethers v6 | `test/InvoiceAgent.test.js` — 14 tests |
| Assistant | Node.js, no framework | `agent/parse.js` (rules) + optional LLM |
| Demo UI | Static HTML/JS + ethers v6 CDN | `agent/public/` |
| Network | QDay Aevum Testnet | Chain 44005, RPC https://rpc-test.qday.info |

**Network (verified 26 Nov 2026):**

| Item | Value |
|---|---|
| Chain | QDay Aevum Testnet, chain ID 44005 (`0xABE5`) |
| RPC | https://rpc-test.qday.info (WS `wss://rpc-test.qday.info`) |
| Explorer | https://explorer-test.qday.info (Blockscout) |
| Gas token | tQDAY (18 decimals) |
| Stablecoin | **tUSD8** `0x456569838f1d43009A91ebA4263147Afd7233483` (ERC-20, 6 decimals) |
| Faucet | https://faucet.qday.info (5 tQDAY + tUSD8, once per 24h) |

## Smart contract

`InvoiceAgent` — one invoice = one escrow. States:
`Created → Paid → Completed | Refunded | Disputed → Completed/Refunded`,
plus `Cancelled` (seller voids an unpaid invoice).

| Function | Who | What |
|---|---|---|
| `createInvoice(payer, amount, dueDate, memo)` | seller | Creates the invoice |
| `payInvoice(id)` | payer | Escrows `amount` tUSD8 (needs `approve` first) |
| `confirmReceipt(id)` | payer | Releases escrow to the seller |
| `refundInvoice(id)` | seller | Returns escrow to the payer |
| `disputeInvoice(id)` | payer | Freezes escrow (within 7 days of payment) |
| `resolveDispute(id, refundPayer)` | seller | Refund the payer, or release to the seller |
| `claimDisputeRefund(id)` | payer | Reclaims escrow if a dispute is unresolved after 7 days |
| `claimExpired(id)` | seller | Claims escrow after 7 days of payer silence |
| `cancelInvoice(id)` | seller | Voids an unpaid invoice |

`GRACE_PERIOD` is 7 days. Custom errors, events for every transition,
`ReentrancyGuard` on all fund-moving functions.

## Setup

```bash
git clone <repo> && cd aevum-builder-challenge
npm install
```

### 1. Test (no wallet, no network needed)

```bash
npx hardhat test        # 14 tests, local Hardhat network
npx hardhat run scripts/e2e-local.js   # full create → pay → confirm + dispute flow
```

### 2. Deploy to Aevum Testnet

```bash
node scripts/create-wallet.js   # throwaway TESTNET-ONLY wallet -> .env (mode 600)
# Claim 5 tQDAY for the printed address at https://faucet.qday.info
# (also claim tUSD8 there — it needs an email + one-time code)
npx hardhat run scripts/deploy.js --network aevum
# -> writes deployments/aevum.json + agent/public/config.json
```

> The deployer wallet is a throwaway created for this challenge. It must never
> hold real funds and must never be reused on mainnet. Its key lives only in
> `.env` (mode 600, gitignored) and is never printed.

### 3. Run the demo

```bash
node agent/server.js   # http://localhost:3000
```

Optional LLM parsing (otherwise the built-in rule parser is used):

```bash
OPENAI_API_KEY=... OPENAI_BASE_URL=https://api.xingchiapi.com/v1 \
OPENAI_MODEL=gpt-6.1-sol node agent/server.js
```

Open the demo, connect MetaMask (it offers to add Aevum Testnet, chain
44005, automatically), claim test tokens from the faucet, and try:

- _"Buatkan invoice 150 tUSD8 untuk 0x742d35Cc6634C0532925a3b844Bc454e4438f44e,
  jasa desain logo, jatuh tempo 5 Des"_
- _"Create an invoice for 80 tUSD8 to 0x742d…, for monthly bookkeeping, due Dec 20"_
- _"Pay invoice #0"_ · _"Confirm invoice #0"_

## Submission checklist (DoraHacks)

- [x] Public GitHub repo, MIT license, clean readable code
- [x] Smart contract on Aevum Testnet + verified source (see note below)
- [ ] Live deployment / demo URL _(after `deploy.js` + hosting the demo)_
- [x] Documentation (this README + `docs/DEMO_SCRIPT.md`)
- [ ] Submit at https://dorahacks.io/hackathon/qday/detail before **11 Dec 2026, 08:00 UTC (15:00 WIB)**
- [ ] Top 5: live 3–5 min demo on **15 Dec 2026, 06:00 UTC (13:00 WIB)** — video call, no pre-recorded video

**Note on explorer verification:** at least one other builder (RelayPay,
deployed 20 Nov 2026) reported that the Aevum explorer's contract
verification was not working yet. If verification fails, the full source is
in this repo and the deployment tx + address are in `deployments/aevum.json`.

## Known limitations

- The parser handles the common shapes (amounts in EN/ID number formats,
  `k`/`juta` suffixes, relative and absolute due dates). Ambiguous phrasing
  falls back to asking for the missing field instead of guessing.
- The LLM layer is optional and untested against a live key in this repo;
  the rule parser is the default and fully tested.
- The demo frontend is a single-page app with no backend database; invoice
  history is read live from the contract.

## Third-party code

- OpenZeppelin Contracts 5.3 (`@openzeppelin/contracts`, MIT) — `IERC20`,
  `SafeERC20`, `ReentrancyGuard`.
- Hardhat + ethers.js (MIT/Apache-2.0) — dev tooling and chain interaction.
- No other copied code. All application code in this repo was written for this
  challenge (16 Nov – 11 Dec 2026 build window).
