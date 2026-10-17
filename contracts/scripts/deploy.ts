/**
 * deploy.ts — deploys AlertRegistry, registers a demo alert (on-chain activity),
 * and writes deployment evidence (address + tx hashes) to deployment.json.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network portaldot_testnet
 */
import { ethers, network } from "hardhat";
import { writeFileSync } from "node:fs";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))}`);

  const factory = await ethers.getContractFactory("AlertRegistry");
  const registry = await factory.deploy();
  const deployTx = registry.deploymentTransaction();
  await registry.waitForDeployment();

  const address = await registry.getAddress();
  console.log(`\n✅ AlertRegistry deployed at ${address}`);
  console.log(`   deployment tx: ${deployTx?.hash}`);

  // Register a demo alert so the contract has verifiable interaction history:
  // kind 0 = ValidatorUptime, threshold 9950 bps (99.50%), channel 0 = Discord
  const target = ethers.zeroPadValue("0x01", 32);
  const regTx = await registry.registerAlert(0, target, 9950, 0);
  const regRc = await regTx.wait();
  console.log(`   demo alert registered, tx: ${regTx.hash}`);

  const evidence = {
    contract: "AlertRegistry",
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    address,
    deployTxHash: deployTx?.hash ?? null,
    demoAlertTxHash: regTx.hash,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    explorer: null, // fill in when testnet explorer is available
  };
  writeFileSync("deployment.json", JSON.stringify(evidence, null, 2));
  console.log("\n📄 deployment.json written — keep for the DoraHacks submission.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
