/* Aevum Invoice Agent — frontend (ethers v6, no build step). */
const AGENT_ABI = [
  "function createInvoice(address payer, uint256 amount, uint256 dueDate, string memo) returns (uint256)",
  "function payInvoice(uint256 id)",
  "function confirmReceipt(uint256 id)",
  "function refundInvoice(uint256 id)",
  "function disputeInvoice(uint256 id)",
  "function resolveDispute(uint256 id, bool refundPayer)",
  "function claimDisputeRefund(uint256 id)",
  "function claimExpired(uint256 id)",
  "function cancelInvoice(uint256 id)",
  "function getInvoice(uint256 id) view returns (tuple(address seller, address payer, uint256 amount, uint256 dueDate, bytes32 memoHash, string memo, uint8 status, uint256 paidAt))",
  "function nextInvoiceId() view returns (uint256)",
  "function tusd8() view returns (address)",
  "function GRACE_PERIOD() view returns (uint256)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
];
const STATUS = ["Created", "Paid", "Completed", "Refunded", "Cancelled", "Disputed"];
const AEVUM = {
  chainId: "0xABE5",
  chainName: "QDay Aevum",
  rpcUrls: ["https://rpc-test.qday.info"],
  blockExplorerUrls: ["https://explorer-test.qday.info"],
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
};

let config = null;
let provider = null;
let signer = null;
let account = null;
let agent = null;
let tusd8 = null;

const $ = (id) => document.getElementById(id);

function log(msg, txHash) {
  const box = $("log");
  if (box.querySelector(".muted") && box.children.length === 1) box.innerHTML = "";
  const div = document.createElement("div");
  const time = new Date().toLocaleTimeString();
  div.innerHTML = `[${time}] ${msg}` + (txHash
    ? ` — <a href="${config.explorer}/tx/${txHash}" target="_blank" rel="noopener">${txHash.slice(0, 18)}…</a>`
    : "");
  box.prepend(div);
}

function fmtTusd8(units) {
  return ethers.formatUnits(units, 6);
}

async function loadConfig() {
  const res = await fetch("config.json");
  config = await res.json();
  if (!config.contractAddress) {
    const n = $("deployNotice");
    n.hidden = false;
    n.innerHTML = `<b>Contract not deployed yet.</b> ${config.note || "Deploy first: npx hardhat run scripts/deploy.js --network aevum."} The assistant parser below still works — it just cannot send on-chain transactions until a contract address is set in <code>config.json</code>.`;
  }
}

async function connectWallet() {
  if (!window.ethereum) return alert("MetaMask (or another EIP-1193 wallet) is required for on-chain actions.");
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer = await provider.getSigner();
  account = await signer.getAddress();
  try {
    await provider.send("wallet_switchEthereumChain", [{ chainId: AEVUM.chainId }]);
  } catch (e) {
    if (e.code === 4902) await provider.send("wallet_addEthereumChain", [AEVUM]);
    else throw e;
  }
  $("walletInfo").textContent = `Connected: ${account.slice(0, 6)}…${account.slice(-4)} (Aevum 44005)`;
  $("connectBtn").textContent = "Connected ✓";
  if (config.contractAddress) {
    agent = new ethers.Contract(config.contractAddress, AGENT_ABI, signer);
    tusd8 = new ethers.Contract(config.tusd8, ERC20_ABI, signer);
  }
  await refreshBalances();
  await loadInvoices();
  window.ethereum.on("accountsChanged", () => window.location.reload());
  window.ethereum.on("chainChanged", () => window.location.reload());
}

async function refreshBalances() {
  if (!provider || !account) return;
  const [gas, tus] = await Promise.all([
    provider.getBalance(account),
    tusd8 ? tusd8.balanceOf(account) : Promise.resolve(0n),
  ]);
  $("balances").textContent = `${ethers.formatEther(gas)} tQDAY · ${fmtTusd8(tus)} tUSD8`;
}

async function parseRequest() {
  const text = $("askInput").value.trim();
  if (!text) return;
  $("parseStatus").textContent = "Parsing…";
  const res = await fetch("/api/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const p = await res.json();
  $("parseStatus").textContent = `Parsed via ${p.source} (confidence ${(p.confidence * 100).toFixed(0)}%)`;
  renderParsed(p);
}

function renderParsed(p) {
  const box = $("parsedBox");
  if (p.intent === "unknown" || !p.intent) {
    box.innerHTML = `<div class="parsed">I could not understand that request. Try: “Create an invoice for 150 tUSD8 to 0x…, due in 7 days”.</div>`;
    return;
  }
  const rows = [
    ["Intent", p.intent.replaceAll("_", " ")],
    ["Amount", p.amount !== null ? `${p.amount} ${p.currency || "tUSD8"}` : "—"],
    ["Payer", p.payer || "—"],
    ["Due date", p.dueDateISO ? new Date(p.dueDate * 1000).toLocaleString() : "—"],
    ["Memo", p.memo || "—"],
    ["Invoice #", p.invoiceId !== null ? `#${p.invoiceId}` : "—"],
  ];
  box.innerHTML = `<div class="parsed">
    <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    ${p.missing.length ? `<p class="muted">Missing: ${p.missing.join(", ")} — add it to your message and parse again.</p>` : ""}
    <div class="actions" id="parsedActions"></div>
  </div>`;
  const actions = $("parsedActions");
  const mkBtn = (label, fn, cls) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = fn;
    actions.appendChild(b);
  };
  if (p.intent === "create_invoice" && p.missing.length === 0) {
    mkBtn("Create invoice on-chain", () => doCreate(p));
  } else if (p.intent === "pay_invoice" && p.invoiceId !== null) {
    mkBtn("Pay invoice #" + p.invoiceId, () => doPay(p.invoiceId));
  } else if (p.intent === "confirm_invoice" && p.invoiceId !== null) {
    mkBtn("Confirm receipt #" + p.invoiceId, () => doTx("confirmReceipt", [p.invoiceId], "Confirmed receipt"));
  } else if (p.intent === "check_status") {
    mkBtn("Refresh invoice list", loadInvoices, "ghost");
  }
}

function needContract() {
  if (!agent) { alert("Connect a wallet first, and deploy the contract (see the notice above)."); return false; }
  return true;
}

async function doTx(fn, args, okMsg) {
  if (!needContract()) return;
  try {
    const tx = await agent[fn](...args);
    log(`${okMsg} — tx sent`, tx.hash);
    await tx.wait();
    log(`${okMsg} — confirmed`, tx.hash);
    await refreshBalances();
    await loadInvoices();
  } catch (e) {
    log(`❌ ${fn} failed: ${e.reason || e.message}`);
    alert(`Transaction failed: ${e.reason || e.message}`);
  }
}

async function doCreate(p) {
  if (!needContract()) return;
  if (!account) return alert("Connect your wallet first — you are the seller.");
  try {
    const amountUnits = ethers.parseUnits(String(p.amount), 6);
    const tx = await agent.createInvoice(p.payer, amountUnits, p.dueDate, p.memo || "");
    log(`Invoice created for ${p.amount} tUSD8`, tx.hash);
    const receipt = await tx.wait();
    const id = receipt.logs.length
      ? agent.interface.parseLog(receipt.logs[0]).args.id
      : "?";
    log(`Invoice #${id} created — share it with the payer`, tx.hash);
    await loadInvoices();
  } catch (e) {
    log(`❌ createInvoice failed: ${e.reason || e.message}`);
    alert(`Transaction failed: ${e.reason || e.message}`);
  }
}

async function doPay(id) {
  if (!needContract()) return;
  try {
    const inv = await agent.getInvoice(id);
    const allowance = await tusd8.allowance(account, config.contractAddress);
    if (allowance < inv.amount) {
      const txA = await tusd8.approve(config.contractAddress, inv.amount);
      log(`Approving ${fmtTusd8(inv.amount)} tUSD8 for escrow`, txA.hash);
      await txA.wait();
    }
    await doTx("payInvoice", [id], `Paid invoice #${id} (escrowed)`);
  } catch (e) {
    log(`❌ pay failed: ${e.reason || e.message}`);
    alert(`Transaction failed: ${e.reason || e.message}`);
  }
}

async function loadInvoices() {
  const list = $("invoiceList");
  if (!agent) {
    list.innerHTML = `<p class="muted">Contract not deployed yet — the invoice list will appear after deployment.</p>`;
    return;
  }
  list.innerHTML = `<p class="muted">Loading…</p>`;
  const total = Number(await agent.nextInvoiceId());
  if (total === 0) {
    list.innerHTML = `<p class="muted">No invoices yet. Ask the assistant to create one.</p>`;
    return;
  }
  list.innerHTML = "";
  for (let id = total - 1; id >= 0; id--) {
    const inv = await agent.getInvoice(id);
    const isSeller = account && inv.seller.toLowerCase() === account.toLowerCase();
    const isPayer = account && inv.payer.toLowerCase() === account.toLowerCase();
    const st = STATUS[Number(inv.status)];
    const div = document.createElement("div");
    div.className = "invoice";
    div.innerHTML = `
      <h3>Invoice #${id} <span class="badge b-${st}">${st}</span></h3>
      <dl class="kv">
        <dt>Seller</dt><dd>${inv.seller}</dd>
        <dt>Payer</dt><dd>${inv.payer}</dd>
        <dt>Amount</dt><dd>${fmtTusd8(inv.amount)} tUSD8</dd>
        <dt>Due</dt><dd>${new Date(Number(inv.dueDate) * 1000).toLocaleString()}</dd>
        <dt>Memo</dt><dd>${inv.memo || "—"}</dd>
        ${inv.paidAt ? `<dt>Paid at</dt><dd>${new Date(Number(inv.paidAt) * 1000).toLocaleString()}</dd>` : ""}
      </dl>
      <div class="actions"></div>`;
    const actions = div.querySelector(".actions");
    const mkBtn = (label, fn, cls) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = fn;
      actions.appendChild(b);
    };
    if (st === "Created") {
      if (isPayer) mkBtn(`Pay ${fmtTusd8(inv.amount)} tUSD8`, () => doPay(id));
      if (isSeller) mkBtn("Cancel", () => doTx("cancelInvoice", [id], `Cancelled invoice #${id}`), "ghost");
    }
    if (st === "Paid") {
      if (isPayer) {
        mkBtn("Confirm receipt (release)", () => doTx("confirmReceipt", [id], `Released escrow for #${id}`));
        mkBtn("Dispute", () => doTx("disputeInvoice", [id], `Disputed invoice #${id}`), "warn");
      }
      if (isSeller) {
        mkBtn("Refund payer", () => doTx("refundInvoice", [id], `Refunded invoice #${id}`), "ghost");
        mkBtn("Claim after 7d silence", () => doTx("claimExpired", [id], `Claimed expired escrow #${id}`), "ghost");
      }
    }
    if (st === "Disputed") {
      if (isSeller) {
        mkBtn("Resolve: refund payer", () => doTx("resolveDispute", [id, true], `Dispute #${id} resolved (refund)`), "warn");
        mkBtn("Resolve: release to me", () => doTx("resolveDispute", [id, false], `Dispute #${id} resolved (release)`));
      }
      if (isPayer) mkBtn("Reclaim after 7d (unresolved)", () => doTx("claimDisputeRefund", [id], `Reclaimed disputed escrow #${id}`), "ghost");
    }
    if (!actions.children.length) {
      actions.innerHTML = `<span class="muted">No actions available for your wallet on this invoice.</span>`;
    }
    list.appendChild(div);
  }
}

document.querySelectorAll(".examples button").forEach((b) => {
  b.onclick = () => { $("askInput").value = b.dataset.ex; parseRequest(); };
});
$("askBtn").onclick = parseRequest;
$("askInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); parseRequest(); }
});
$("connectBtn").onclick = connectWallet;
$("refreshBtn").onclick = async () => { await refreshBalances(); await loadInvoices(); };

loadConfig();
