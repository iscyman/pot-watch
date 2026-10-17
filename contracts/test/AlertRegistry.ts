import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("AlertRegistry", () => {
  async function deployFixture() {
    const [owner, watcher, other] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("AlertRegistry");
    const registry = await factory.deploy();
    await registry.waitForDeployment();
    return { registry, owner, watcher, other };
  }

  const TARGET = ethers.zeroPadValue("0x01", 32);

  it("deploys with clean counters", async () => {
    const { registry } = await loadFixture(deployFixture);
    expect(await registry.nextId()).to.equal(1);
    expect(await registry.totalRegistered()).to.equal(0);
    expect(await registry.activeAlertCount()).to.equal(0);
  });

  it("registers an alert and emits AlertRegistered", async () => {
    const { registry, owner } = await loadFixture(deployFixture);
    await expect(registry.registerAlert(0, TARGET, 9950, 0))
      .to.emit(registry, "AlertRegistered")
      .withArgs(1, owner.address, 0, TARGET, 9950, 0);

    const alert = await registry.getAlert(1);
    expect(alert.owner).to.equal(owner.address);
    expect(alert.active).to.equal(true);
    expect(await registry.totalRegistered()).to.equal(1);
    expect(await registry.activeAlertCount()).to.equal(1);
  });

  it("lists alerts per owner", async () => {
    const { registry, owner, other } = await loadFixture(deployFixture);
    await registry.connect(owner).registerAlert(0, TARGET, 9950, 0);
    await registry.connect(owner).registerAlert(1, ethers.ZeroHash, 0, 1);
    await registry.connect(other).registerAlert(2, TARGET, 0, 0);

    expect(await registry.listAlertIds(owner.address)).to.deep.equal([1n, 2n]);
    expect(await registry.listAlertIds(other.address)).to.deep.equal([3n]);
    const all = await registry.listAlerts(owner.address);
    expect(all.length).to.equal(2);
    expect(all[1].kind).to.equal(1); // EraRotation
  });

  it("cancels only by owner, and only once", async () => {
    const { registry, owner, other } = await loadFixture(deployFixture);
    await registry.registerAlert(0, TARGET, 9950, 0);

    await expect(registry.connect(other).cancelAlert(1)).to.be.revertedWithCustomError(registry, "NotOwner");
    await expect(registry.cancelAlert(1)).to.emit(registry, "AlertCancelled").withArgs(1, owner.address);
    await expect(registry.cancelAlert(1)).to.be.revertedWithCustomError(registry, "NotActive");

    expect((await registry.getAlert(1)).active).to.equal(false);
    expect(await registry.totalCancelled()).to.equal(1);
    expect(await registry.activeAlertCount()).to.equal(0);
  });

  it("records watcher fires with stats and per-block cooldown", async () => {
    const { registry, watcher } = await loadFixture(deployFixture);
    await registry.registerAlert(0, TARGET, 9950, 0);

    await expect(registry.connect(watcher).recordFire(1))
      .to.emit(registry, "AlertFired");

    const alert = await registry.getAlert(1);
    expect(alert.fireCount).to.equal(1);
    expect(alert.lastFiredAt).to.be.greaterThan(0);

    // two fires packed into the SAME block → second one reverts (Cooldown)
    await ethers.provider.send("evm_setAutomine", [false]);
    const tx1 = await registry.connect(watcher).recordFire(1, { gasLimit: 300000 });
    const tx2 = await registry.connect(watcher).recordFire(1, { gasLimit: 300000 });
    await ethers.provider.send("evm_mine", []);
    await ethers.provider.send("evm_setAutomine", [true]);
    const rc1 = await tx1.wait();
    expect(rc1!.status).to.equal(1); // first fire in block: ok
    // ethers v6 throws on reverted receipts → catching proves the Cooldown revert
    let secondReverted = false;
    try {
      await tx2.wait();
    } catch {
      secondReverted = true;
    }
    expect(secondReverted, "same-block fire should revert").to.equal(true);

    // next block → fires again, counter increments
    await expect(registry.connect(watcher).recordFire(1)).to.emit(registry, "AlertFired");
    expect((await registry.getAlert(1)).fireCount).to.equal(3);
  });

  it("cannot fire inactive or missing alerts", async () => {
    const { registry } = await loadFixture(deployFixture);
    await registry.registerAlert(0, TARGET, 9950, 0);
    await registry.cancelAlert(1);
    await expect(registry.recordFire(1)).to.be.revertedWithCustomError(registry, "NotActive");
    await expect(registry.recordFire(99)).to.be.revertedWithCustomError(registry, "NotFound");
    await expect(registry.getAlert(99)).to.be.revertedWithCustomError(registry, "NotFound");
  });
});
