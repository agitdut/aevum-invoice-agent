const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// tUSD8 has 6 decimals; 150 tUSD8 = 150_000_000 units.
const AMOUNT = 150_000_000n;
const GRACE = 7n * 24n * 60n * 60n;

async function deployFixture() {
  const [deployer, seller, payer, stranger] = await ethers.getSigners();

  // Mock tUSD8: a plain ERC-20 with 6 decimals.
  const Token = await ethers.getContractFactory("MockTUSD8");
  const token = await Token.deploy();
  await token.waitForDeployment();

  // Fund the payer with tUSD8.
  await token.mint(payer.address, 10_000_000_000n); // 10,000 tUSD8

  const InvoiceAgent = await ethers.getContractFactory("InvoiceAgent");
  const agent = await InvoiceAgent.deploy(await token.getAddress());
  await agent.waitForDeployment();

  const dueDate = (await time.latest()) + 30 * 24 * 60 * 60; // +30 days
  return { token, agent, deployer, seller, payer, stranger, dueDate };
}

async function createPaidInvoice(agent, token, seller, payer, dueDate, amount = AMOUNT, id = 0) {
  await agent.connect(seller).createInvoice(payer.address, amount, dueDate, "Logo design");
  await token.connect(payer).approve(await agent.getAddress(), amount);
  await agent.connect(payer).payInvoice(id);
}

describe("InvoiceAgent", function () {
  describe("createInvoice", function () {
    it("stores the invoice and emits InvoiceCreated", async function () {
      const { agent, seller, payer, dueDate } = await deployFixture();
      await expect(agent.connect(seller).createInvoice(payer.address, AMOUNT, dueDate, "Logo design"))
        .to.emit(agent, "InvoiceCreated")
        .withArgs(0, seller.address, payer.address, AMOUNT, dueDate, "Logo design");

      const inv = await agent.getInvoice(0);
      expect(inv.seller).to.equal(seller.address);
      expect(inv.payer).to.equal(payer.address);
      expect(inv.amount).to.equal(AMOUNT);
      expect(inv.memo).to.equal("Logo design");
      expect(inv.status).to.equal(0); // Created
      expect(await agent.nextInvoiceId()).to.equal(1);
    });

    it("reverts on zero amount, self-invoice and past due date", async function () {
      const { agent, seller, payer, dueDate } = await deployFixture();
      await expect(
        agent.connect(seller).createInvoice(payer.address, 0, dueDate, "x")
      ).to.be.revertedWithCustomError(agent, "ZeroAmount");
      await expect(
        agent.connect(seller).createInvoice(seller.address, AMOUNT, dueDate, "x")
      ).to.be.revertedWithCustomError(agent, "SelfInvoice");
      await expect(
        agent.connect(seller).createInvoice(payer.address, AMOUNT, 1, "x")
      ).to.be.revertedWithCustomError(agent, "PastDueDate");
    });
  });

  describe("payInvoice", function () {
    it("escrows tUSD8 and flips status to Paid", async function () {
      const { agent, token, seller, payer, dueDate } = await deployFixture();
      await agent.connect(seller).createInvoice(payer.address, AMOUNT, dueDate, "Logo design");
      await token.connect(payer).approve(await agent.getAddress(), AMOUNT);

      await expect(agent.connect(payer).payInvoice(0))
        .to.emit(agent, "InvoicePaid")
        .withArgs(0, payer.address, AMOUNT);

      expect(await token.balanceOf(await agent.getAddress())).to.equal(AMOUNT);
      expect((await agent.getInvoice(0)).status).to.equal(1); // Paid
    });

    it("reverts without approval, for non-payers, and on double pay", async function () {
      const { agent, token, seller, payer, stranger, dueDate } = await deployFixture();
      await agent.connect(seller).createInvoice(payer.address, AMOUNT, dueDate, "Logo design");

      // No approval yet.
      await expect(agent.connect(payer).payInvoice(0)).to.be.reverted;
      await token.connect(payer).approve(await agent.getAddress(), AMOUNT);

      await expect(agent.connect(stranger).payInvoice(0)).to.be.revertedWithCustomError(
        agent,
        "NotPayer"
      );
      await agent.connect(payer).payInvoice(0);
      await expect(agent.connect(payer).payInvoice(0)).to.be.revertedWithCustomError(
        agent,
        "WrongStatus"
      );
    });
  });

  describe("confirmReceipt (happy path)", function () {
    it("releases escrow to the seller", async function () {
      const { agent, token, seller, payer, dueDate } = await deployFixture();
      await createPaidInvoice(agent, token, seller, payer, dueDate);

      const sellerBefore = await token.balanceOf(seller.address);
      await expect(agent.connect(payer).confirmReceipt(0))
        .to.emit(agent, "InvoiceCompleted")
        .withArgs(0, seller.address, AMOUNT);
      expect(await token.balanceOf(seller.address)).to.equal(sellerBefore + AMOUNT);
      expect(await token.balanceOf(await agent.getAddress())).to.equal(0);
      expect((await agent.getInvoice(0)).status).to.equal(2); // Completed
    });

    it("only the payer can confirm", async function () {
      const { agent, token, seller, payer, stranger, dueDate } = await deployFixture();
      await createPaidInvoice(agent, token, seller, payer, dueDate);
      await expect(agent.connect(stranger).confirmReceipt(0)).to.be.revertedWithCustomError(
        agent,
        "NotPayer"
      );
      await expect(agent.connect(seller).confirmReceipt(0)).to.be.revertedWithCustomError(
        agent,
        "NotPayer"
      );
    });
  });

  describe("refundInvoice", function () {
    it("seller refunds the escrow to the payer", async function () {
      const { agent, token, seller, payer, dueDate } = await deployFixture();
      await createPaidInvoice(agent, token, seller, payer, dueDate);

      const payerBefore = await token.balanceOf(payer.address);
      await expect(agent.connect(seller).refundInvoice(0))
        .to.emit(agent, "InvoiceRefunded")
        .withArgs(0, payer.address, AMOUNT);
      expect(await token.balanceOf(payer.address)).to.equal(payerBefore + AMOUNT);
      expect((await agent.getInvoice(0)).status).to.equal(3); // Refunded
    });
  });

  describe("dispute flow", function () {
    it("payer disputes, seller resolves with refund", async function () {
      const { agent, token, seller, payer, dueDate } = await deployFixture();
      await createPaidInvoice(agent, token, seller, payer, dueDate);

      await expect(agent.connect(payer).disputeInvoice(0))
        .to.emit(agent, "InvoiceDisputed")
        .withArgs(0, payer.address);
      expect((await agent.getInvoice(0)).status).to.equal(5); // Disputed

      const payerBefore = await token.balanceOf(payer.address);
      await agent.connect(seller).resolveDispute(0, true);
      expect(await token.balanceOf(payer.address)).to.equal(payerBefore + AMOUNT);
      expect((await agent.getInvoice(0)).status).to.equal(3); // Refunded
    });

    it("payer disputes, seller resolves by releasing to seller", async function () {
      const { agent, token, seller, payer, dueDate } = await deployFixture();
      await createPaidInvoice(agent, token, seller, payer, dueDate);
      await agent.connect(payer).disputeInvoice(0);

      const sellerBefore = await token.balanceOf(seller.address);
      await agent.connect(seller).resolveDispute(0, false);
      expect(await token.balanceOf(seller.address)).to.equal(sellerBefore + AMOUNT);
      expect((await agent.getInvoice(0)).status).to.equal(2); // Completed
    });

    it("unresolved dispute: payer reclaims escrow after the grace window", async function () {
      const { agent, token, seller, payer, dueDate } = await deployFixture();
      await createPaidInvoice(agent, token, seller, payer, dueDate);
      await agent.connect(payer).disputeInvoice(0);

      // Too early: still reverts.
      await expect(agent.connect(payer).claimDisputeRefund(0)).to.be.revertedWithCustomError(
        agent,
        "GraceNotElapsed"
      );
      await time.increase(GRACE + 1n);
      const payerBefore = await token.balanceOf(payer.address);
      await agent.connect(payer).claimDisputeRefund(0);
      expect(await token.balanceOf(payer.address)).to.equal(payerBefore + AMOUNT);
      expect((await agent.getInvoice(0)).status).to.equal(3); // Refunded
    });

    it("dispute is rejected after the grace window closes", async function () {
      const { agent, token, seller, payer, dueDate } = await deployFixture();
      await createPaidInvoice(agent, token, seller, payer, dueDate);
      await time.increase(GRACE + 1n);
      await expect(agent.connect(payer).disputeInvoice(0)).to.be.revertedWithCustomError(
        agent,
        "DisputeWindowClosed"
      );
    });
  });

  describe("claimExpired", function () {
    it("seller claims escrow after silence past the grace window", async function () {
      const { agent, token, seller, payer, dueDate } = await deployFixture();
      await createPaidInvoice(agent, token, seller, payer, dueDate);

      await expect(agent.connect(seller).claimExpired(0)).to.be.revertedWithCustomError(
        agent,
        "GraceNotElapsed"
      );
      await time.increase(GRACE + 1n);
      const sellerBefore = await token.balanceOf(seller.address);
      await agent.connect(seller).claimExpired(0);
      expect(await token.balanceOf(seller.address)).to.equal(sellerBefore + AMOUNT);
      expect((await agent.getInvoice(0)).status).to.equal(2); // Completed
    });
  });

  describe("cancelInvoice", function () {
    it("seller voids an unpaid invoice; paid invoices cannot be cancelled", async function () {
      const { agent, token, seller, payer, dueDate } = await deployFixture();
      await agent.connect(seller).createInvoice(payer.address, AMOUNT, dueDate, "Logo design");
      await expect(agent.connect(seller).cancelInvoice(0))
        .to.emit(agent, "InvoiceCancelled")
        .withArgs(0, seller.address);
      expect((await agent.getInvoice(0)).status).to.equal(4); // Cancelled

      // Second invoice (id 1), paid, then cancel must fail.
      await createPaidInvoice(agent, token, seller, payer, dueDate, AMOUNT, 1);
      await expect(agent.connect(seller).cancelInvoice(1)).to.be.revertedWithCustomError(
        agent,
        "WrongStatus"
      );
    });
  });

  describe("end-to-end: two invoices, independent state", function () {
    it("tracks ids separately and never mixes escrows", async function () {
      const { agent, token, seller, payer, dueDate } = await deployFixture();
      await agent.connect(seller).createInvoice(payer.address, AMOUNT, dueDate, "First");
      await agent
        .connect(seller)
        .createInvoice(payer.address, AMOUNT * 2n, dueDate, "Second");

      await token.connect(payer).approve(await agent.getAddress(), AMOUNT * 3n);
      await agent.connect(payer).payInvoice(0);
      await agent.connect(payer).payInvoice(1);
      await agent.connect(payer).confirmReceipt(1); // only #1 completes

      expect((await agent.getInvoice(0)).status).to.equal(1); // still Paid
      expect((await agent.getInvoice(1)).status).to.equal(2); // Completed
      expect(await token.balanceOf(await agent.getAddress())).to.equal(AMOUNT);
      expect(await token.balanceOf(seller.address)).to.equal(AMOUNT * 2n);
    });
  });
});
