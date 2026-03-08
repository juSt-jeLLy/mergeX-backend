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

  // Wait a few blocks before verifying
  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
    console.log("\n⏳ Waiting 10s for block confirmations before verifying...");
    await new Promise((r) => setTimeout(r, 10000));
    try {
      await hre.run("verify:verify", {
        address,
        constructorArguments: [],
      });
      console.log("✅ Contract verified on Worldscan");
    } catch (e) {
      if (e.message?.includes("Already Verified")) {
        console.log("✅ Already verified");
      } else {
        console.warn("⚠️  Verification failed (you can retry manually):", e.message);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
