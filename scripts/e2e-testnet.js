// E2E demo on Aevum Testnet: create invoice -> pay (escrow) -> confirm (release).
// Seller = deployer wallet (from .env). Payer = fresh throwaway wallet funded
// by the seller with 0.5 tUSD8 + 0.01 tQDAY for gas. Prints every tx hash.
// Run: npx hardhat run scripts/e2e-testnet.js --network aevum
require("dotenv").config();
const { ethers } = require("ethers");
const deployment = require("../deployments/aevum.json");

const TUSD8_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider("https://rpc-test.qday.info");
  const seller = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const payer = ethers.Wallet.createRandom().connect(provider);
  const agent = new ethers.Contract(deployment.address, deployment.abi, provider);
  const tusd8 = new ethers.Contract(deployment.tusd8, TUSD8_ABI, provider);
  const AMOUNT = 500000n; // 0.5 tUSD8 (6 decimals)
  const dueDate = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;

  console.log("seller:", seller.address);
  console.log("payer (throwaway):", payer.address);
  console.log("contract:", deployment.address);

  // 1. Fund the payer: 0.5 tUSD8 + 0.01 tQDAY for gas.
  let tx = await tusd8
    .connect(seller)
    .transfer(payer.address, AMOUNT);
  console.log("fund tUSD8 tx:", tx.hash);
  await tx.wait();
  tx = await seller.sendTransaction({
    to: payer.address,
    value: ethers.parseEther("0.01"),
  });
  console.log("fund tQDAY tx:", tx.hash);
  await tx.wait();
  console.log("payer tUSD8:", ethers.formatUnits(await tusd8.balanceOf(payer.address), 6));

  // 2. Seller creates the invoice.
  tx = await agent
    .connect(seller)
    .createInvoice(payer.address, AMOUNT, dueDate, "Demo invoice - desain logo");
  console.log("createInvoice tx:", tx.hash);
  const rc = await tx.wait();
  console.log("createInvoice block:", rc.blockNumber);
  const id = 0; // first invoice on this contract
  let inv = await agent.getInvoice(id);
  console.log("status after create (0=Created):", Number(inv.status));

  // 3. Payer approves + pays (escrow).
  tx = await tusd8.connect(payer).approve(deployment.address, AMOUNT);
  console.log("approve tx:", tx.hash);
  await tx.wait();
  tx = await agent.connect(payer).payInvoice(id);
  console.log("payInvoice tx:", tx.hash);
  await tx.wait();
  inv = await agent.getInvoice(id);
  console.log("status after pay (1=Paid):", Number(inv.status));
  console.log("escrow in contract:", ethers.formatUnits(await tusd8.balanceOf(deployment.address), 6), "tUSD8");

  // 4. Payer confirms receipt -> escrow releases to seller.
  tx = await agent.connect(payer).confirmReceipt(id);
  console.log("confirmReceipt tx:", tx.hash);
  await tx.wait();
  inv = await agent.getInvoice(id);
  console.log("status after confirm (2=Completed):", Number(inv.status));
  console.log("escrow in contract:", ethers.formatUnits(await tusd8.balanceOf(deployment.address), 6), "tUSD8");
  console.log("seller tUSD8:", ethers.formatUnits(await tusd8.balanceOf(seller.address), 6));
  console.log("payer tUSD8:", ethers.formatUnits(await tusd8.balanceOf(payer.address), 6));
  console.log("E2E DONE — invoice #0 Completed on-chain.");
}

main().catch((e) => {
  console.error("E2E FAILED:", e.message);
  process.exit(1);
});
