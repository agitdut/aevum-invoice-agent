/**
 * End-to-end smoke test against the in-process Hardhat network.
 * Mirrors exactly what the frontend does: create -> approve -> pay -> confirm,
 * plus a dispute round-trip on a second invoice.
 * Run: npx hardhat run scripts/e2e-local.js
 */
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

async function main() {
  const [deployer, seller, payer] = await ethers.getSigners();
  console.log("seller:", seller.address);
  console.log("payer: ", payer.address);

  const Token = await ethers.getContractFactory("MockTUSD8");
  const token = await Token.deploy();
  await token.waitForDeployment();
  await token.mint(payer.address, 10_000_000_000n);
  console.log("MockTUSD8:", await token.getAddress());

  const Agent = await ethers.getContractFactory("InvoiceAgent");
  const agent = await Agent.deploy(await token.getAddress());
  await agent.waitForDeployment();
  console.log("InvoiceAgent:", await agent.getAddress());

  // --- Invoice #0: happy path, 150 tUSD8, memo from the NL parser example.
  const dueDate = (await time.latest()) + 10 * 24 * 60 * 60;
  const amount = 150_000_000n; // 150 tUSD8 (6 decimals)
  await (await agent.connect(seller).createInvoice(payer.address, amount, dueDate, "desain logo")).wait();
  console.log("invoice #0 created (150 tUSD8, memo 'desain logo')");

  await (await token.connect(payer).approve(await agent.getAddress(), amount)).wait();
  await (await agent.connect(payer).payInvoice(0)).wait();
  console.log("invoice #0 paid, escrow =", ethers.formatUnits(await token.balanceOf(await agent.getAddress()), 6), "tUSD8");

  const sellerBefore = await token.balanceOf(seller.address);
  await (await agent.connect(payer).confirmReceipt(0)).wait();
  const sellerAfter = await token.balanceOf(seller.address);
  console.log("invoice #0 confirmed; seller received:", ethers.formatUnits(sellerAfter - sellerBefore, 6), "tUSD8");
  console.log("invoice #0 status:", ["Created", "Paid", "Completed", "Refunded", "Cancelled", "Disputed"][Number((await agent.getInvoice(0)).status)]);

  // --- Invoice #1: dispute path, 80 tUSD8.
  const amount1 = 80_000_000n;
  await (await agent.connect(seller).createInvoice(payer.address, amount1, dueDate, "monthly bookkeeping")).wait();
  await (await token.connect(payer).approve(await agent.getAddress(), amount1)).wait();
  await (await agent.connect(payer).payInvoice(1)).wait();
  await (await agent.connect(payer).disputeInvoice(1)).wait();
  console.log("invoice #1 disputed");
  const payerBefore = await token.balanceOf(payer.address);
  await (await agent.connect(seller).resolveDispute(1, true)).wait();
  console.log("invoice #1 resolved with refund; payer got back:", ethers.formatUnits((await token.balanceOf(payer.address)) - payerBefore, 6), "tUSD8");
  console.log("invoice #1 status:", ["Created", "Paid", "Completed", "Refunded", "Cancelled", "Disputed"][Number((await agent.getInvoice(1)).status)]);

  // --- Final assertions.
  if ((await agent.getInvoice(0)).status !== 2n) throw new Error("invoice #0 should be Completed");
  if ((await agent.getInvoice(1)).status !== 3n) throw new Error("invoice #1 should be Refunded");
  if ((await token.balanceOf(await agent.getAddress())) !== 0n) throw new Error("escrow should be empty");
  console.log("E2E OK: both flows settled, escrow empty.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
