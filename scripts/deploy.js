const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const TUSD8 = "0x456569838f1d43009A91ebA4263147Afd7233483";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "tQDAY");

  const InvoiceAgent = await ethers.getContractFactory("InvoiceAgent");
  const agent = await InvoiceAgent.deploy(TUSD8);
  await agent.waitForDeployment();
  const address = await agent.getAddress();
  console.log("InvoiceAgent deployed at:", address);

  const receipt = await agent.deploymentTransaction().wait();
  console.log("Deploy tx:", receipt.hash, "| block:", receipt.blockNumber);

  // Save deployment info for the demo frontend.
  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const artifact = await hre.artifacts.readArtifact("InvoiceAgent");
  const deployment = {
    network: "aevum",
    chainId: 44005,
    contract: "InvoiceAgent",
    address,
    deployTx: receipt.hash,
    blockNumber: receipt.blockNumber,
    deployer: deployer.address,
    tusd8: TUSD8,
    explorer: `https://explorer-test.qday.info/address/${address}`,
    abi: artifact.abi,
  };
  fs.writeFileSync(path.join(outDir, "aevum.json"), JSON.stringify(deployment, null, 2));
  fs.writeFileSync(
    path.join(__dirname, "..", "agent", "public", "config.json"),
    JSON.stringify(
      { chainId: 44005, contractAddress: address, tusd8: TUSD8, explorer: "https://explorer-test.qday.info" },
      null,
      2
    )
  );
  console.log("Deployment info saved to deployments/aevum.json and agent/public/config.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
