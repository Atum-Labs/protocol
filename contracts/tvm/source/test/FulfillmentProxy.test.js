const FulfillmentProxy = artifacts.require('FulfillmentProxy');
const MockERC20 = artifacts.require('MockERC20');
const testHelpers = require('./test-helpers');

const {
  setupAccounts,
  toBase58,
  getTronWebInstance,
  expectRevert
} = testHelpers;

contract('FulfillmentProxy', () => {

  // TronWeb instances for all accounts
  let fulfillmentProxy;    // owner's instance
  let fulfillmentProxy2;   // second's instance
  let fulfillmentProxy3;   // third's instance

  let mockERC20;          // owner's instance
  let _mockERC20_2;        // second's instance
  let mockERC20_3;        // third's instance

  // Use our test accounts configuration (accessed after setupAccounts)
  let expectedOwner, zeroAddress, secondAccount, thirdAccount;

  before(async () => {
    // Setup and fund all accounts before running tests
    await setupAccounts();

    // Now set up our test account variables
    expectedOwner = testHelpers.accounts.owner.address;
    zeroAddress = testHelpers.accounts.zeroAddress;
    secondAccount = testHelpers.accounts.second.address;
    thirdAccount = testHelpers.accounts.third.address;

    // Create TronWeb instances for all accounts
    fulfillmentProxy = await getTronWebInstance(FulfillmentProxy, 'owner');
    fulfillmentProxy2 = await getTronWebInstance(FulfillmentProxy, 'second');
    fulfillmentProxy3 = await getTronWebInstance(FulfillmentProxy, 'third');

    mockERC20 = await getTronWebInstance(MockERC20, 'owner');
    _mockERC20_2 = await getTronWebInstance(MockERC20, 'second');
    mockERC20_3 = await getTronWebInstance(MockERC20, 'third');

    // PAUSING IS ROLE-GATED, NOT ADMIN-GATED. pause()/unpause() are onlyRole(PAUSER_ROLE), and the
    // constructor grants the deployer DEFAULT_ADMIN_ROLE only — so the owner cannot pause until it
    // is granted PAUSER_ROLE. The pause specs below assumed owner == pauser, which was true under
    // the Ownable model this contract no longer uses. Granting it here keeps them testing what they
    // mean to test; the "non-pauser cannot pause" spec still holds, because the second account is
    // deliberately NOT granted the role.
    const pauserRole = await fulfillmentProxy.PAUSER_ROLE().call();
    const ownerHasPauser = await fulfillmentProxy.hasRole(pauserRole, expectedOwner).call();
    if (!ownerHasPauser) {
      await fulfillmentProxy.grantRole(pauserRole, expectedOwner).send();
    }
  });

  beforeEach(async () => {
    // No need to get deployed instances here anymore
    // All contract instances are already set up in before()
  });

  describe('Deployment', () => {
    it('should deploy successfully', async () => {
      assert(fulfillmentProxy.address);
      assert.notEqual(fulfillmentProxy.address, '');
      assert.notEqual(fulfillmentProxy.address, null);
      assert.notEqual(fulfillmentProxy.address, undefined);
    });

    it('should have multiple tronWeb instances available', async () => {
      // Verify they're different
      assert.notEqual(testHelpers.ownerWeb.defaultAddress.base58, testHelpers.secondWeb.defaultAddress.base58);
      assert.notEqual(testHelpers.ownerWeb.defaultAddress.base58, testHelpers.thirdWeb.defaultAddress.base58);
      assert.notEqual(testHelpers.secondWeb.defaultAddress.base58, testHelpers.thirdWeb.defaultAddress.base58);
    });

    it('should have all expected functions', async () => {
      assert(fulfillmentProxy.pause, 'Contract should have pause function');
      assert(fulfillmentProxy.unpause, 'Contract should have unpause function');
      assert(fulfillmentProxy.fulfill, 'Contract should have fulfill function');
      assert(fulfillmentProxy.strictFulfill, 'Contract should have strictFulfill function');
    });
  });

  // ADMIN TRANSFER TESTS
  //
  // These were written against Ownable2Step (transferOwnership / acceptOwnership / pendingOwner)
  // and had drifted completely: FulfillmentProxy uses AccessControlDefaultAdminRules, which has
  // none of those functions. They never failed because the TronBox suite never ran — see the
  // migration and feeLimit fixes that made it run at all. Rewritten against the real API:
  //
  //   transferOwnership(x) -> beginDefaultAdminTransfer(x)   (onlyRole(DEFAULT_ADMIN_ROLE))
  //   acceptOwnership()    -> acceptDefaultAdminTransfer()   (callable only by the pending admin,
  //                                                           and only once the delay has elapsed)
  //   pendingOwner()       -> pendingDefaultAdmin()          (returns a TUPLE: newAdmin, schedule)
  //
  // `owner()` still exists (IERC5313) and still reads the current default admin.
  //
  // EACH TEST DEPLOYS ITS OWN PROXY. The suite otherwise shares one migration-deployed instance,
  // and the old tests carried a large "restore the owner afterwards" beforeEach to undo their own
  // mutations — which is exactly the kind of cross-test coupling that makes one failure cascade.
  // A fresh contract per test removes the need for any of it.
  describe('Admin Transfer (AccessControlDefaultAdminRules)', () => {
    // The constructor sets a 1-second delay and acceptDefaultAdminTransfer reverts with
    // AccessControlEnforcedDefaultAdminDelay until it elapses.
    //
    // THE LOCAL TRE NODE ONLY MINTS A BLOCK WHEN A TRANSACTION ARRIVES. It is not a periodic
    // chain: left alone it sits on the same block indefinitely, so `block.timestamp` — which is
    // what `_hasSchedulePassed` compares against — simply does not advance. Measured on a idle
    // node: 4 seconds of wall clock, same block number, same timestamp, and the chain clock 33
    // seconds behind the host.
    //
    // So neither sleeping nor polling can work on its own. Sleeping only appeared to work because
    // the NEXT test transaction happened to mint the block that carried time forward, which is why
    // the same sequence passed in one test and failed in another. This nudges the chain with a
    // throwaway transfer until the head block is strictly past the schedule.
    async function advancePast(scheduledAt) {
      assert.notEqual(scheduledAt, 0, 'advancePast called with no schedule');

      for (let i = 0; i < 20; i++) {
        const block = await testHelpers.ownerWeb.trx.getCurrentBlock();
        const headSec = Math.floor(block.block_header.raw_data.timestamp / 1000);
        if (headSec > scheduledAt) { return; }
        // 1 SUN to the second account: the cheapest transaction that forces a new block.
        await testHelpers.ownerWeb.trx.sendTransaction(secondAccount, 1);
        await new Promise((r) => setTimeout(r, 400));
      }
      throw new Error(`chain never advanced past admin transfer schedule ${scheduledAt}`);
    }

    /** Read the currently scheduled transfer off `handle` and advance the chain past it. */
    async function advancePastAdminSchedule(handle) {
      const pending = await handle.pendingDefaultAdmin().call();
      return advancePast(Number(pending.schedule.toString()));
    }

    // A proxy owned by `owner`, plus per-signer handles on that same fresh address.
    async function freshProxy() {
      const deployed = await FulfillmentProxy.new(expectedOwner);
      return {
        address: deployed.address,
        asOwner: await getTronWebInstance(FulfillmentProxy, 'owner', deployed.address),
        asSecond: await getTronWebInstance(FulfillmentProxy, 'second', deployed.address),
        asThird: await getTronWebInstance(FulfillmentProxy, 'third', deployed.address)
      };
    }

    it('should set the default admin during construction', async () => {
      const p = await freshProxy();
      const owner = await p.asOwner.owner().call();
      assert.equal(toBase58(owner), expectedOwner, 'owner() should be the constructor default admin');

      const defaultAdmin = await p.asOwner.defaultAdmin().call();
      assert.equal(toBase58(defaultAdmin), expectedOwner, 'defaultAdmin() should agree with owner()');
    });

    it('should ensure the default admin is not zero after construction', async () => {
      const p = await freshProxy();
      const owner = await p.asOwner.owner().call();
      assert.notEqual(owner, zeroAddress, 'Default admin should not be the zero address');
    });

    it('should have no pending admin initially', async () => {
      const p = await freshProxy();
      const pending = await p.asOwner.pendingDefaultAdmin().call();
      // pendingDefaultAdmin returns (newAdmin, schedule); with none scheduled both are empty.
      assert.equal(toBase58(pending.newAdmin), toBase58(zeroAddress), 'Pending admin should be zero');
      assert.equal(pending.schedule.toString(), '0', 'Schedule should be unset');
    });

    it('should transfer the default admin in two steps', async () => {
      const p = await freshProxy();

      await p.asOwner.beginDefaultAdminTransfer(secondAccount).send({ shouldPollResponse: true });
      const pending = await p.asOwner.pendingDefaultAdmin().call();
      assert.equal(toBase58(pending.newAdmin), toBase58(secondAccount), 'Pending admin should be the second account');
      assert.notEqual(pending.schedule.toString(), '0', 'A schedule should be set');

      // Still the old admin until the transfer is accepted.
      assert.equal(toBase58(await p.asOwner.owner().call()), expectedOwner, 'Admin must not change on begin alone');

      await advancePastAdminSchedule(p.asOwner);
      await p.asSecond.acceptDefaultAdminTransfer().send({ shouldPollResponse: true });

      assert.equal(toBase58(await p.asOwner.owner().call()), toBase58(secondAccount), 'Admin should now be the second account');
    });

    it('should not allow a non-admin to begin a transfer', async () => {
      const p = await freshProxy();
      const before = await p.asOwner.owner().call();

      await expectRevert(async () => {
        await p.asSecond.beginDefaultAdminTransfer(thirdAccount).send({ shouldPollResponse: true });
      });

      assert.equal(await p.asOwner.owner().call(), before, 'Admin should not have changed');
      const pending = await p.asOwner.pendingDefaultAdmin().call();
      assert.equal(toBase58(pending.newAdmin), toBase58(zeroAddress), 'No transfer should have been scheduled');
    });

    it('should not allow an account other than the pending admin to accept', async () => {
      const p = await freshProxy();
      await p.asOwner.beginDefaultAdminTransfer(secondAccount).send({ shouldPollResponse: true });
      await advancePastAdminSchedule(p.asOwner);

      await expectRevert(async () => {
        await p.asThird.acceptDefaultAdminTransfer().send({ shouldPollResponse: true });
      });

      assert.equal(toBase58(await p.asOwner.owner().call()), expectedOwner, 'Admin should not have changed');
      const pending = await p.asOwner.pendingDefaultAdmin().call();
      assert.equal(toBase58(pending.newAdmin), toBase58(secondAccount), 'The scheduled transfer should survive');

      // The rightful pending admin can still complete it.
      await p.asSecond.acceptDefaultAdminTransfer().send({ shouldPollResponse: true });
      assert.equal(toBase58(await p.asOwner.owner().call()), toBase58(secondAccount), 'Pending admin should be able to accept');
    });

    it('should handle consecutive admin transfers', async () => {
      const p = await freshProxy();

      await p.asOwner.beginDefaultAdminTransfer(secondAccount).send({ shouldPollResponse: true });
      await advancePastAdminSchedule(p.asOwner);
      await p.asSecond.acceptDefaultAdminTransfer().send({ shouldPollResponse: true });
      assert.equal(toBase58(await p.asOwner.owner().call()), toBase58(secondAccount), 'Admin should be the second account');

      // The NEW admin is the only one who can schedule the next transfer.
      await p.asSecond.beginDefaultAdminTransfer(thirdAccount).send({ shouldPollResponse: true });
      await advancePastAdminSchedule(p.asOwner);
      await p.asThird.acceptDefaultAdminTransfer().send({ shouldPollResponse: true });
      assert.equal(toBase58(await p.asOwner.owner().call()), toBase58(thirdAccount), 'Admin should be the third account');
    });

    it('should replace a pending transfer when a new one is scheduled', async () => {
      const p = await freshProxy();

      await p.asOwner.beginDefaultAdminTransfer(secondAccount).send({ shouldPollResponse: true });
      assert.equal(
        toBase58((await p.asOwner.pendingDefaultAdmin().call()).newAdmin),
        toBase58(secondAccount),
        'Second account should be pending'
      );

      // Scheduling a new transfer supersedes the first.
      await p.asOwner.beginDefaultAdminTransfer(thirdAccount).send({ shouldPollResponse: true });
      assert.equal(
        toBase58((await p.asOwner.pendingDefaultAdmin().call()).newAdmin),
        toBase58(thirdAccount),
        'Third account should now be pending'
      );

      await advancePastAdminSchedule(p.asOwner);

      // The superseded account can no longer accept.
      await expectRevert(async () => {
        await p.asSecond.acceptDefaultAdminTransfer().send({ shouldPollResponse: true });
      });
      assert.equal(toBase58(await p.asOwner.owner().call()), expectedOwner, 'Admin should not have changed');

      await p.asThird.acceptDefaultAdminTransfer().send({ shouldPollResponse: true });
      assert.equal(toBase58(await p.asOwner.owner().call()), toBase58(thirdAccount), 'Third account should be admin');
    });

    it('should cancel a pending transfer', async () => {
      const p = await freshProxy();

      await p.asOwner.beginDefaultAdminTransfer(secondAccount).send({ shouldPollResponse: true });
      // Captured BEFORE the cancel: cancelling clears the schedule, so there would be nothing left
      // to wait on afterwards — and the point of this test is that the second account still cannot
      // accept once that original moment has passed.
      const cancelledSchedule = Number((await p.asOwner.pendingDefaultAdmin().call()).schedule.toString());

      await p.asOwner.cancelDefaultAdminTransfer().send({ shouldPollResponse: true });

      const pending = await p.asOwner.pendingDefaultAdmin().call();
      assert.equal(toBase58(pending.newAdmin), toBase58(zeroAddress), 'Pending admin should be cleared');

      await advancePast(cancelledSchedule);
      await expectRevert(async () => {
        await p.asSecond.acceptDefaultAdminTransfer().send({ shouldPollResponse: true });
      });
      assert.equal(toBase58(await p.asOwner.owner().call()), expectedOwner, 'Admin should still be the original');
    });
  });

  describe('Pause and Unpause', () => {
    it('should be deployed with paused state as false', async () => {
      const isPaused = await fulfillmentProxy.paused().call();
      assert.equal(isPaused, false, 'Contract should not be paused by default');
    });

    it('should be able to pause and unpause', async () => {
      await fulfillmentProxy.pause().send();
      const isPaused = await fulfillmentProxy.paused().call();
      assert.equal(isPaused, true, 'Contract should be paused');

      await fulfillmentProxy.unpause().send();
      const isUnpaused = await fulfillmentProxy.paused().call();
      assert.equal(isUnpaused, false, 'Contract should be unpaused');
    });

    it('should not be able to pause or unpause if not owner', async () => {
      // Try to pause from non-owner account
      await expectRevert(
        async () => {
          await fulfillmentProxy2.pause().send({
            shouldPollResponse: true
          });
        }
      );

      // Verify contract is still not paused
      const isPaused = await fulfillmentProxy.paused().call();
      assert.equal(isPaused, false, 'Contract should not be paused');
    });
  });

  describe('Fulfillment', () => {
    // Use reasonable token amounts: 1000 tokens with 18 decimals = 1000 * 10^18
    const TOKEN_AMOUNT = '1000000000000000000000'; // 1000 tokens with 18 decimals

    beforeEach(async () => {
      // Mint 1000 tokens to third account
      await mockERC20.mint(thirdAccount, TOKEN_AMOUNT).send();
    });

    it('should fulfill', async () => {
      // Approve tokens to fulfillment proxy from third account
      await mockERC20_3.approve(fulfillmentProxy.address, TOKEN_AMOUNT).send();

      // Get initial balance of second account
      const initialBalance = await mockERC20.balanceOf(secondAccount).call();

      // Call fulfillmentProxy contract `fulfill` function with struct params
      // TronWeb expects struct parameters as an array in the correct order:
      // [quoteHash, to, token, amount]
      const params = [
        '0x1234567890123456789012345678901234567890123456789012345678901234', // quoteHash (bytes32)
        secondAccount,        // to (address)
        mockERC20.address,     // token (address)
        TOKEN_AMOUNT          // amount (uint256)
      ];

      // Call fulfill from third account (the settler)
      await fulfillmentProxy3.fulfill(params).send();

      // Check if the second account received the tokens
      const finalBalance = await mockERC20.balanceOf(secondAccount).call();
      const expectedBalance = BigInt(initialBalance) + BigInt(TOKEN_AMOUNT);

      assert.equal(finalBalance.toString(), expectedBalance.toString(), `Second account should have ${expectedBalance.toString()} tokens`);
    });

    it('should not fulfill if paused', async () => {
      // Approve tokens to fulfillment proxy from third account
      await mockERC20_3.approve(fulfillmentProxy.address, TOKEN_AMOUNT).send();

      // Get initial balance of second account
      const initialBalance = await mockERC20.balanceOf(secondAccount).call();

      // Call fulfillmentProxy contract `fulfill` function with struct params
      // TronWeb expects struct parameters as an array in the correct order:
      // [quoteHash, to, token, amount]
      const params = [
        '0x1234567890123456789012345678901234567890123456789012345678901234', // quoteHash (bytes32)
        secondAccount,        // to (address)
        mockERC20.address,     // token (address)
        TOKEN_AMOUNT          // amount (uint256)
      ];

      // Pause the contract
      await fulfillmentProxy.pause().send();

      // Call fulfill from third account (the settler) - should fail
      await expectRevert(
        async () => {
          await fulfillmentProxy3.fulfill(params).send({
            shouldPollResponse: true
          });
        }
      );

      // unpause the contract
      await fulfillmentProxy.unpause().send();

      // Check if the second account received the tokens - should still have initial balance
      const finalBalance = await mockERC20.balanceOf(secondAccount).call();

      assert.equal(finalBalance.toString(), initialBalance.toString(), `Second account should still have ${initialBalance.toString()} tokens`);
    });

    // Cantina F2 (Jayfromthe13th): a zero-value transfer is legal, so before the guard anyone could
    // emit a genuine Fulfilled event bound to any quoteHash for the price of gas. strictFulfill has
    // rejected it since CORE-2116; fulfill and fulfillMany now do too.
    //
    // NOTE ON WHAT MAKES THESE LOAD-BEARING: expectRevert without an expected string accepts ANY
    // revert, so each test below FUNDS and APPROVES the caller in full first. A funded, approved
    // caller sending amount 0 succeeded before the guard — so the only thing left that can revert
    // is the amount check itself, not an incidental balance or allowance failure.
    it('should revert fulfill with a zero amount', async () => {
      await mockERC20_3.approve(fulfillmentProxy.address, TOKEN_AMOUNT).send();

      const initialBalance = await mockERC20.balanceOf(secondAccount).call();

      const params = [
        '0x1234567890123456789012345678901234567890123456789012345678901234',
        secondAccount,
        mockERC20.address,
        '0'
      ];

      await expectRevert(async () => {
        await fulfillmentProxy3.fulfill(params).send({ shouldPollResponse: true });
      });

      const finalBalance = await mockERC20.balanceOf(secondAccount).call();
      assert.equal(finalBalance.toString(), initialBalance.toString(), 'No transfer should have occurred');
    });

    it('should revert fulfillMany when any item has a zero amount', async () => {
      await mockERC20_3.approve(fulfillmentProxy.address, TOKEN_AMOUNT).send();

      const initialBalance = await mockERC20.balanceOf(secondAccount).call();
      const half = (BigInt(TOKEN_AMOUNT) / 2n).toString();

      // The zero sits LAST — the position a guard placed outside the loop would miss.
      const params = [
        ['0x1111111111111111111111111111111111111111111111111111111111111111', secondAccount, mockERC20.address, half],
        ['0x2222222222222222222222222222222222222222222222222222222222222222', secondAccount, mockERC20.address, '0']
      ];

      await expectRevert(async () => {
        await fulfillmentProxy3.fulfillMany(params).send({ shouldPollResponse: true });
      });

      // The valid transfer ahead of it is rolled back with the revert.
      const finalBalance = await mockERC20.balanceOf(secondAccount).call();
      assert.equal(finalBalance.toString(), initialBalance.toString(), 'The whole batch should have reverted');
    });

    it('should revert fulfillMany with an empty batch', async () => {
      await mockERC20_3.approve(fulfillmentProxy.address, TOKEN_AMOUNT).send();

      await expectRevert(async () => {
        await fulfillmentProxy3.fulfillMany([]).send({ shouldPollResponse: true });
      });
    });

    it('should fulfillMany with non-zero amounts', async () => {
      await mockERC20_3.approve(fulfillmentProxy.address, TOKEN_AMOUNT).send();

      const initialBalance = await mockERC20.balanceOf(secondAccount).call();
      const quarter = (BigInt(TOKEN_AMOUNT) / 4n).toString();

      const params = [
        ['0x3333333333333333333333333333333333333333333333333333333333333333', secondAccount, mockERC20.address, quarter],
        ['0x4444444444444444444444444444444444444444444444444444444444444444', secondAccount, mockERC20.address, quarter]
      ];

      await fulfillmentProxy3.fulfillMany(params).send();

      const finalBalance = await mockERC20.balanceOf(secondAccount).call();
      const expectedBalance = BigInt(initialBalance) + BigInt(quarter) * 2n;
      assert.equal(finalBalance.toString(), expectedBalance.toString(), 'Both fulfillments should have landed');
    });

    it('should strictFulfill revert with deadline = 0', async () => {
      // Approve tokens to fulfillment proxy from third account
      await mockERC20_3.approve(fulfillmentProxy.address, TOKEN_AMOUNT).send();

      // Get initial balance of second account
      const initialBalance = await mockERC20.balanceOf(secondAccount).call();

      // Struct parameters for fulfill
      const params = [
        '0x1234567890123456789012345678901234567890123456789012345678901234', // quoteHash (bytes32)
        secondAccount,        // to (address)
        mockERC20.address,    // token (address)
        TOKEN_AMOUNT          // amount (uint256)
      ];

      // Call strictFulfill with deadline = 0 - should revert
      await expectRevert(
        async () => {
          await fulfillmentProxy3.strictFulfill(params, 0).send({
            shouldPollResponse: true
          });
        }
      );

      // Verify tokens were NOT transferred
      const finalBalance = await mockERC20.balanceOf(secondAccount).call();
      assert.equal(finalBalance.toString(), initialBalance.toString(),
        `Second account should still have ${initialBalance.toString()} tokens`);
    });

    it('should strictFulfill revert with deadline = 1', async () => {
      // Approve tokens to fulfillment proxy from third account
      await mockERC20_3.approve(fulfillmentProxy.address, TOKEN_AMOUNT).send();

      // Get initial balance of second account
      const initialBalance = await mockERC20.balanceOf(secondAccount).call();

      // Struct parameters for fulfill
      const params = [
        '0x1234567890123456789012345678901234567890123456789012345678901234', // quoteHash (bytes32)
        secondAccount,        // to (address)
        mockERC20.address,    // token (address)
        TOKEN_AMOUNT          // amount (uint256)
      ];

      // Call strictFulfill with deadline = 1 - should revert
      await expectRevert(
        async () => {
          await fulfillmentProxy3.strictFulfill(params, 1).send({
            shouldPollResponse: true
          });
        }
      );

      // Verify tokens were NOT transferred
      const finalBalance = await mockERC20.balanceOf(secondAccount).call();
      assert.equal(finalBalance.toString(), initialBalance.toString(),
        `Second account should still have ${initialBalance.toString()} tokens`);
    });

    it('should strictFulfill succeed with future deadline', async () => {
      // Approve tokens to fulfillment proxy from third account
      await mockERC20_3.approve(fulfillmentProxy.address, TOKEN_AMOUNT).send();

      // Get initial balance of second account
      const initialBalance = await mockERC20.balanceOf(secondAccount).call();

      // Get current timestamp
      const currentBlock = await testHelpers.ownerWeb.trx.getCurrentBlock();
      const currentTimestamp = currentBlock.block_header.raw_data.timestamp;

      // Set deadline to 1 hour in the future
      const deadline = currentTimestamp + (3600 * 1000);

      // Struct parameters
      const params = [
        '0x1234567890123456789012345678901234567890123456789012345678901234', // quoteHash (bytes32)
        secondAccount,
        mockERC20.address,
        TOKEN_AMOUNT
      ];

      // This should succeed
      await fulfillmentProxy3.strictFulfill(params, deadline).send({
        shouldPollResponse: true
      });

      // Verify tokens WERE transferred
      const finalBalance = await mockERC20.balanceOf(secondAccount).call();
      const expectedBalance = BigInt(initialBalance) + BigInt(TOKEN_AMOUNT);

      assert.equal(finalBalance.toString(), expectedBalance.toString(),
        'Second account should have received tokens');
    });

    it('should not strictFulfill if paused (even with valid deadline)', async () => {
      // Approve tokens to fulfillment proxy from third account
      await mockERC20_3.approve(fulfillmentProxy.address, TOKEN_AMOUNT).send();

      // Get initial balance of second account
      const initialBalance = await mockERC20.balanceOf(secondAccount).call();

      // Get current timestamp
      const currentBlock = await testHelpers.ownerWeb.trx.getCurrentBlock();
      const currentTimestamp = currentBlock.block_header.raw_data.timestamp;

      // Set deadline to 1 hour in the future (valid deadline)
      const deadline = currentTimestamp + (3600 * 1000);

      // Struct parameters
      const params = [
        '0x1234567890123456789012345678901234567890123456789012345678901234', // quoteHash (bytes32)
        secondAccount,
        mockERC20.address,
        TOKEN_AMOUNT
      ];

      // Pause the contract
      await fulfillmentProxy.pause().send();

      // Call strictFulfill with valid deadline - should still revert because contract is paused
      await expectRevert(
        async () => {
          await fulfillmentProxy3.strictFulfill(params, deadline).send({
            shouldPollResponse: true
          });
        }
      );

      // Unpause the contract
      await fulfillmentProxy.unpause().send();

      // Verify tokens were NOT transferred
      const finalBalance = await mockERC20.balanceOf(secondAccount).call();
      assert.equal(finalBalance.toString(), initialBalance.toString(),
        `Second account should still have ${initialBalance.toString()} tokens`);
    });

  });
});
