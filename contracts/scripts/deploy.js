const hre = require("hardhat");
const fs = require("fs");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying MergeXBounty with:", deployer.address);
  console.log("Balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");

  const MergeXBounty = await hre.ethers.getContractFactory("MergeXBounty");
  const contract = await MergeXBounty.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("✅ MergeXBounty deployed to:", address);
  console.log("Network:", hre.network.name);

  const deployments = { MergeXBounty: address, network: hre.network.name, deployedAt: new Date().toISOString() };
  fs.writeFileSync("deployments.json", JSON.stringify(deployments, null, 2));
  console.log("Saved to deployments.json");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
