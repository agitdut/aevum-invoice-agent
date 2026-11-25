require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.24",
  networks: {
    aevum: {
      url: "https://rpc-test.qday.info",
      chainId: 44005,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: { aevum: "dummy" },
    customChains: [
      {
        network: "aevum",
        chainId: 44005,
        urls: {
          apiURL: "https://explorer-test.qday.info/api",
          browserURL: "https://explorer-test.qday.info",
        },
      },
    ],
  },
};
