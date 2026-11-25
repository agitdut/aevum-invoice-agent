# Demo script — Aevum Invoice Agent (3–5 min, live)

For Demo Day, 15 Dec 2026, 06:00 UTC. One presenter, live video call.
All amounts are test tUSD8 on Aevum Testnet (chain 44005). Have two wallets
ready in MetaMask: **Seller** (presenter) and **Payer** (second account).

## 0:00–0:30 — The problem (30s)

"Freelancers invoice by PDF and chase payment by chat. Stablecoins move the
money, but creating an on-chain invoice still means a form full of hex
addresses. So we built an assistant you just talk to."

> **Funding note:** the QDay faucet gives 1 tUSD8 per wallet per day (the
> Discord `/faucet` gives 5 tUSD8), so this script uses small amounts that
> fit a few days of claims. Pre-fund both wallets before the call — the
> happy path needs 0.5 tUSD8, the dispute demo 0.3 tUSD8 (0.8 total).

## 0:30–1:30 — The happy path (60s)

1. Open the demo. Type (Indonesian, to show it is bilingual):
   _"Buatkan invoice 0,5 tUSD8 untuk 0x742d…, jasa desain logo, jatuh tempo 5 Des"_
2. The assistant shows the parsed invoice — amount, payer, due date, memo —
   and asks for confirmation. Nothing executes silently.
3. Click **Create invoice on-chain**, sign in MetaMask. Show the tx on the
   Aevum explorer.
4. Switch to the Payer account, approve tUSD8, click **Pay**. Point out the
   escrow: the contract now holds 0.5 tUSD8.
5. Click **Confirm receipt**. Escrow releases to the seller. Show the seller's
   balance increase and the invoice status flipping to Completed.

## 1:30–2:30 — The safety story (60s)

1. Create a second invoice (0.3 tUSD8, "monthly bookkeeping"), pay it.
2. As the payer, click **Dispute**. The escrow freezes.
3. As the seller, **Resolve: refund payer** — funds return immediately.
4. Explain the two backstops, briefly: if a dispute is never resolved, the
   payer reclaims after 7 days; if the payer goes silent, the seller claims
   after 7 days. "Escrowed funds can never be locked forever."

## 2:30–3:30 — Under the hood + close (60s)

1. Show the contract on the explorer + the repo: one small contract,
   OpenZeppelin SafeERC20 + ReentrancyGuard, 14 unit tests.
2. Show the parser: rule-based, works offline in English and Indonesian,
   with an optional LLM layer (any OpenAI-compatible API).
3. Close: "One sentence in, one settled payment out. Next: recurring
   invoices, ERC-8004 agent identity, and the same flow on QDay mainnet."

## If something goes wrong live

- Faucet empty → the payer/seller wallets are pre-funded before the call;
  never claim live on stage.
- RPC slow → the local Hardhat replay (`npx hardhat run scripts/e2e-local.js`)
  shows the same flow in seconds as a backup.
- Keep the explorer tab and the repo tab open before the call starts.
