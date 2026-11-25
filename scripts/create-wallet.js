const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

/**
 * Creates ONE throwaway wallet for Aevum Testnet use only.
 * The key is written to .env (mode 600) in the repo root and NEVER printed.
 * This wallet must never hold real funds or mainnet assets.
 */
async function main() {
  const envPath = path.join(__dirname, "..", ".env");
  const wallet = ethers.Wallet.createRandom();
  const lines = [
    "# Aevum Builder Challenge #1 — TESTNET ONLY throwaway deployer wallet",
    "# NEVER fund this wallet with real assets. Never reuse on mainnet.",
    `DEPLOYER_PRIVATE_KEY=${wallet.privateKey}`,
    `DEPLOYER_ADDRESS=${wallet.address}`,
    "",
  ];
  fs.writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
  console.log("Throwaway testnet wallet created.");
  console.log("Address (public, safe to share):", wallet.address);
  console.log(".env written with mode 600. Private key was NOT printed.");
  console.log("Next: claim 5 tQDAY for this address at https://faucet.qday.info");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
