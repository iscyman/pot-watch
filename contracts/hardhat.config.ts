import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    // Local Portaldot dev node (portaldot_dev --dev) with EVM RPC, if exposed:
    portaldot_local: {
      url: process.env.PORTALDOT_LOCAL_RPC ?? "http://127.0.0.1:8545",
      accounts: process.env.DEPLOYER_PK ? [process.env.DEPLOYER_PK] : [],
    },
    // Official PortaldotV3 testnet (confirmed live by organizers, verified 2026-10-17):
    portaldot_testnet: {
      url: process.env.PORTALDOT_TESTNET_RPC ?? "https://test-evm-rpc-v3.portaldot.dev",
      chainId: 420420777,
      accounts: process.env.DEPLOYER_PK ? [process.env.DEPLOYER_PK] : [],
    },
  },
};

export default config;
