// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test, console} from "forge-std/Test.sol";

/// @notice Verifies encoding-examples.json against the current source code.
/// @dev Pure hashing test — no fork or state required. Each digest is recomputed
///      from the exact inputs given in the JSON and compared with the JSON's
///      expectedDigest / expectedDepositId.
///
///      encoding-examples.json is the fixture offchain signers in other languages copy
///      from, so it is READ AT RUNTIME here: every value the Solidity side hardcodes is
///      asserted equal to the JSON's value before the digest math runs (see
///      `_bind*Fixture`). Before that binding existed the JSON was documentation only —
///      no test read it — so a wrong golden in the file could not fail CI. That is how
///      the stale ReserveWitness golden repaired in 630167a survived in the first place.
///      Reading the file needs the read-only `fs_permissions` entry for
///      `encoding-examples.json` in foundry.toml.
///
///      LIMIT OF THIS FILE: the digest math below is test-side. It never calls the escrow, so a
///      transposition applied consistently to src/Escrow.sol, test/helpers/Signatures.sol AND
///      the argument lists here would keep every golden self-consistent. The goldens are
///      therefore ALSO bound to the contract, in test/EncodingExamples.contractBound.t.sol:
///      it signs `deposit[i]`/`release[i]`/`refund[i]`'s `expectedDigest` straight out of the
///      JSON and requires deposit()/release()/refund() to accept it. Keep that file in mind
///      before "fixing" a mismatch here by editing the fixture.
contract EncodingExamplesVerifyTest is Test {
    /// @dev Relative to the project root, like the `src/Escrow.sol` read further down.
    string private constant FIXTURE_PATH = "encoding-examples.json";

    /// @dev Number of entries this test file covers per fixture group. Asserted against the
    ///      JSON so an entry (or a whole group) added to the fixture without a matching
    ///      Solidity check fails loudly instead of shipping unverified.
    uint256 private constant FIXTURE_GROUPS = 5;
    uint256 private constant DEPOSIT_ID_FIXTURES = 2;
    uint256 private constant DEPOSIT_FIXTURES = 2;
    uint256 private constant RESERVE_FIXTURES = 2;
    uint256 private constant RELEASE_FIXTURES = 2;
    uint256 private constant REFUND_FIXTURES = 2;

    bytes32 private constant PERMIT2_DOMAIN_TYPE_HASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 private constant PERMIT2_NAME_HASH = keccak256("Permit2");

    bytes32 private constant ESCROW_DOMAIN_TYPE_HASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant ESCROW_NAME_HASH = keccak256("Escrow");
    bytes32 private constant ESCROW_VERSION_HASH = keccak256("3");

    bytes32 private constant DEPOSIT_WITNESS_TYPE_HASH =
        keccak256("DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)");
    bytes32 private constant TOKEN_PERMISSIONS_TYPE_HASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 private constant RESERVE_WITNESS_TYPE_HASH =
        keccak256("ReserveWitness(bytes32 depositId,bytes32 quoteHash,address settler,uint256 sourceAmount)");
    bytes32 private constant RELEASE_WITNESS_TYPE_HASH = keccak256(
        "ReleaseWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)"
    );
    bytes32 private constant REFUND_WITNESS_TYPE_HASH = keccak256(
        "RefundWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)"
    );

    // Full deposit witness type hash (same as in Signatures.sol helper)
    bytes32 private constant FULL_DEPOSIT_TYPE_HASH = keccak256(
        abi.encodePacked(
            "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
            "DepositWitness witness)DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)TokenPermissions(address token,uint256 amount)"
        )
    );

    function _permit2DomainSeparator(uint256 chainId, address permit2) internal pure returns (bytes32) {
        return keccak256(abi.encode(PERMIT2_DOMAIN_TYPE_HASH, PERMIT2_NAME_HASH, chainId, permit2));
    }

    function _escrowDomainSeparator(uint256 chainId, address escrow) internal pure returns (bytes32) {
        return keccak256(abi.encode(ESCROW_DOMAIN_TYPE_HASH, ESCROW_NAME_HASH, ESCROW_VERSION_HASH, chainId, escrow));
    }

    // ---- fixture binding ----
    //
    // Each `_bind*` call ties one hardcoded Solidity value to the corresponding value in
    // encoding-examples.json. A mismatch means the published fixture and the verifier have
    // drifted; the fix is to work out which side is wrong, NOT to sync one to the other.

    function _fixture() private view returns (string memory) {
        return vm.readFile(FIXTURE_PATH);
    }

    function _path(string memory group, uint256 index, string memory field) private pure returns (string memory) {
        return string.concat(".", group, "[", vm.toString(index), "].", field);
    }

    function _drift(string memory path) private pure returns (string memory) {
        return string.concat(
            "encoding-examples.json ",
            path,
            " disagrees with the value hardcoded in test/EncodingExamples.verify.t.sol - the published cross-language fixture and this verifier have drifted"
        );
    }

    function _bindUint(string memory json, string memory path, uint256 hardcoded) private pure {
        assertEq(vm.parseJsonUint(json, path), hardcoded, _drift(path));
    }

    function _bindAddress(string memory json, string memory path, address hardcoded) private pure {
        assertEq(vm.parseJsonAddress(json, path), hardcoded, _drift(path));
    }

    function _bindBytes32(string memory json, string memory path, bytes32 hardcoded) private pure {
        assertEq(vm.parseJsonBytes32(json, path), hardcoded, _drift(path));
    }

    function _bindString(string memory json, string memory path, string memory hardcoded) private pure {
        assertEq(vm.parseJsonString(json, path), hardcoded, _drift(path));
    }

    function _bindBytes(string memory json, string memory path, bytes memory hardcoded) private pure {
        assertEq(vm.parseJsonBytes(json, path), hardcoded, _drift(path));
    }

    /// @dev Release and refund fixtures carry identical field sets, so they share one binder.
    function _bindSettlementFixture(
        string memory group,
        uint256 index,
        uint256 chainId,
        address escrow,
        bytes32 depositId,
        bytes32 quoteHash,
        bytes32 depositRequestHash,
        bytes32 destinationHash,
        address depositor,
        address token,
        uint256 amount,
        uint256 feeAmount,
        address reserver,
        address releaser,
        address settler,
        bytes32 expected
    ) private view {
        string memory json = _fixture();
        _bindUint(json, _path(group, index, "chainID"), chainId);
        _bindAddress(json, _path(group, index, "escrow"), escrow);
        _bindBytes32(json, _path(group, index, "depositId"), depositId);
        _bindBytes32(json, _path(group, index, "quoteHash"), quoteHash);
        _bindBytes32(json, _path(group, index, "depositRequestHash"), depositRequestHash);
        _bindBytes32(json, _path(group, index, "destinationHash"), destinationHash);
        _bindAddress(json, _path(group, index, "depositor"), depositor);
        _bindAddress(json, _path(group, index, "token"), token);
        _bindUint(json, _path(group, index, "amount"), amount);
        _bindUint(json, _path(group, index, "feeAmount"), feeAmount);
        _bindAddress(json, _path(group, index, "reserver"), reserver);
        _bindAddress(json, _path(group, index, "releaser"), releaser);
        _bindAddress(json, _path(group, index, "settler"), settler);
        _bindBytes32(json, _path(group, index, "expectedDigest"), expected);
    }

    /// @notice The fixture must not grow entries (or groups) that no test above checks.
    /// @dev Without this, adding a `release[1]` to encoding-examples.json would publish an
    ///      unverified golden — the same silent-drift shape the runtime binding closes.
    function test_fixtureCoverage_everyGroupAndEntryIsVerified() public view {
        string memory json = _fixture();

        assertEq(
            vm.parseJsonKeys(json, "$").length,
            FIXTURE_GROUPS,
            "encoding-examples.json gained or lost a top-level fixture group; add matching checks in test/EncodingExamples.verify.t.sol"
        );

        _assertEntryCount(json, "depositId", DEPOSIT_ID_FIXTURES);
        _assertEntryCount(json, "deposit", DEPOSIT_FIXTURES);
        _assertEntryCount(json, "reserve", RESERVE_FIXTURES);
        _assertEntryCount(json, "release", RELEASE_FIXTURES);
        _assertEntryCount(json, "refund", REFUND_FIXTURES);
    }

    function _assertEntryCount(string memory json, string memory group, uint256 expectedCount) private view {
        uint256 count;
        while (vm.keyExistsJson(json, string.concat(".", group, "[", vm.toString(count), "]"))) {
            count++;
        }
        assertEq(
            count,
            expectedCount,
            string.concat(
                "encoding-examples.json group `",
                group,
                "` no longer has the number of entries this file verifies; every published fixture entry needs a check here"
            )
        );
    }

    // ---- depositId ----

    function test_depositId_1() public view {
        _assertDepositId(
            0,
            0x1Ffc33f5E217b1CF95e713DB49Fcd86C8195666C,
            hex"380efd4e333d316a9f99e2d31c872459f9675e95eb6d12f8c9e11694ca49df0142254b2a658464302955fb29375b73cdcbf38be80164d0f1a58b247b2650ca131b",
            1,
            0xbbbf298f926ddc48a92871e25e7e223ba104de64fc827650963e8ec89e37d8ac
        );
    }

    function test_depositId_2() public view {
        _assertDepositId(
            1,
            0x1Ffc33f5E217b1CF95e713DB49Fcd86C8195666C,
            hex"705ffeeaa4eb2d2746cbd29b1efef2ad87bc4c533dd9531945890cb5cbfb051318e29ae18ce1bb8e3571bac6bf41944971def29861baa6d1523e610e0f682a701c",
            2,
            0x419d1a281d76364f19f4141f885f05041e7c8fba624fa727fe087fa48af2cb1c
        );
    }

    function _assertDepositId(uint256 index, address depositor, bytes memory signature, uint256 nonce, bytes32 expected)
        private
        view
    {
        string memory json = _fixture();
        _bindAddress(json, _path("depositId", index, "depositor"), depositor);
        _bindBytes(json, _path("depositId", index, "signature"), signature);
        _bindUint(json, _path("depositId", index, "nonce"), nonce);
        _bindBytes32(json, _path("depositId", index, "expectedDepositId"), expected);

        bytes32 computed = keccak256(abi.encode(depositor, signature, nonce));
        assertEq(computed, expected, "depositId mismatch");
    }

    // ---- deposit digest ----

    // The `deposit` destinations here and in encoding-examples.json are ARBITRARY abbreviated byte
    // strings (0xaaaa/0xbbbb) exercising the signing digest, NOT canonical-form examples; they feed
    // pinned digests, so they stay as-is — copy from test/Destination.canonicalExamples.t.sol
    // instead.
    function test_depositDigest_1() public view {
        _assertDepositDigest(
            0,
            1,
            0x000000000022D473030F116dDEE9F6B43aC78BA3,
            0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f,
            1000000000000000000000,
            1,
            1770395075,
            0x41AD713827f11837f06C065e9cd0Bb56CE1e06a0,
            0x2b52da99cb649092e2fc4ddf7f365d862ea53d0c123899d59707ab6092f0ae39,
            "eip155:8453/erc20:0xaaaa@0xbbbb",
            0x9139213bE0cF31C8B1bD609f1d953605e20bD2Cb,
            0x83743f550bcdb5bE905766E2E3CB9a86c6823cC9,
            0x8394727a442fa0baf5a8919fb8db4b4c03fab9c90696b77f77f70add43bfa0d1
        );
    }

    function test_depositDigest_2() public view {
        _assertDepositDigest(
            1,
            1,
            0x000000000022D473030F116dDEE9F6B43aC78BA3,
            0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f,
            1000000000000000000000,
            2,
            1770395087,
            0x41AD713827f11837f06C065e9cd0Bb56CE1e06a0,
            0x2b52da99cb649092e2fc4ddf7f365d862ea53d0c123899d59707ab6092f0ae39,
            "eip155:8453/erc20:0xaaaa@0xbbbb",
            0x9139213bE0cF31C8B1bD609f1d953605e20bD2Cb,
            0x83743f550bcdb5bE905766E2E3CB9a86c6823cC9,
            0xeadbd548b3d3dca9025b3ac493e35ebc376a3db2d45809559006abd85194e12e
        );
    }

    function _assertDepositDigest(
        uint256 index,
        uint256 chainId,
        address permit2,
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        address spender,
        bytes32 depositRequestHash,
        string memory destination,
        address reserver,
        address releaser,
        bytes32 expected
    ) private view {
        string memory json = _fixture();
        _bindUint(json, _path("deposit", index, "chainID"), chainId);
        _bindAddress(json, _path("deposit", index, "permit2"), permit2);
        _bindAddress(json, _path("deposit", index, "token"), token);
        _bindUint(json, _path("deposit", index, "amount"), amount);
        _bindUint(json, _path("deposit", index, "nonce"), nonce);
        _bindUint(json, _path("deposit", index, "deadline"), deadline);
        _bindAddress(json, _path("deposit", index, "spender"), spender);
        _bindBytes32(json, _path("deposit", index, "depositRequestHash"), depositRequestHash);
        _bindString(json, _path("deposit", index, "destination"), destination);
        _bindAddress(json, _path("deposit", index, "reserver"), reserver);
        _bindAddress(json, _path("deposit", index, "releaser"), releaser);
        _bindBytes32(json, _path("deposit", index, "expectedDigest"), expected);

        bytes32 tokenPermissionsHash = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPE_HASH, token, amount));
        // EIP-712 hashes a dynamic `string` member as keccak256(bytes(value)).
        bytes32 witnessHash = keccak256(
            abi.encode(DEPOSIT_WITNESS_TYPE_HASH, depositRequestHash, keccak256(bytes(destination)), reserver, releaser)
        );
        bytes32 structHash =
            keccak256(abi.encode(FULL_DEPOSIT_TYPE_HASH, tokenPermissionsHash, spender, nonce, deadline, witnessHash));
        bytes32 domainSep = _permit2DomainSeparator(chainId, permit2);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        assertEq(digest, expected, "deposit digest mismatch");
    }

    // ---- reserve digest ----

    function test_reserveDigest_1() public view {
        _assertReserveDigest(
            0,
            1,
            0x41AD713827f11837f06C065e9cd0Bb56CE1e06a0,
            0xbbbf298f926ddc48a92871e25e7e223ba104de64fc827650963e8ec89e37d8ac,
            0x095b62b4af754ec82a94c9e500313b362f073033c63d6d888b3c8f47dcbb33e9,
            0x1E85c6266C9EDf9e6BA293d780DcdDE76dC7Acf7,
            1000000000000000000000,
            0x7c0b1e2da8e7edd46fdfb4fd58f5a68f127c0face233f545e1e9174cf5d09252
        );
    }

    function test_reserveDigest_2() public view {
        _assertReserveDigest(
            1,
            1,
            0x41AD713827f11837f06C065e9cd0Bb56CE1e06a0,
            0x419d1a281d76364f19f4141f885f05041e7c8fba624fa727fe087fa48af2cb1c,
            0x287acc25473137e4efdbef4472b61811bec3e12a043bb52a77e41437b12cdad6,
            0x1E85c6266C9EDf9e6BA293d780DcdDE76dC7Acf7,
            1000000000000000000000,
            0xd50f9c8d72b470fc957d91d092727e7ce266d8498c166165ef36fbd213a0c707
        );
    }

    function _assertReserveDigest(
        uint256 index,
        uint256 chainId,
        address escrow,
        bytes32 depositId,
        bytes32 quoteHash,
        address settler,
        uint256 sourceAmount,
        bytes32 expected
    ) private view {
        string memory json = _fixture();
        _bindUint(json, _path("reserve", index, "chainID"), chainId);
        _bindAddress(json, _path("reserve", index, "escrow"), escrow);
        _bindBytes32(json, _path("reserve", index, "depositId"), depositId);
        _bindBytes32(json, _path("reserve", index, "quoteHash"), quoteHash);
        _bindAddress(json, _path("reserve", index, "settler"), settler);
        _bindUint(json, _path("reserve", index, "sourceAmount"), sourceAmount);
        _bindBytes32(json, _path("reserve", index, "expectedDigest"), expected);

        bytes32 structHash =
            keccak256(abi.encode(RESERVE_WITNESS_TYPE_HASH, depositId, quoteHash, settler, sourceAmount));
        bytes32 domainSep = _escrowDomainSeparator(chainId, escrow);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        assertEq(digest, expected, "reserve digest mismatch");
    }

    // ---- release digest ----

    function test_releaseDigest_1() public view {
        _assertReleaseDigest(
            0,
            1,
            0x41AD713827f11837f06C065e9cd0Bb56CE1e06a0,
            0xbbbf298f926ddc48a92871e25e7e223ba104de64fc827650963e8ec89e37d8ac,
            0x095b62b4af754ec82a94c9e500313b362f073033c63d6d888b3c8f47dcbb33e9,
            0x2b52da99cb649092e2fc4ddf7f365d862ea53d0c123899d59707ab6092f0ae39,
            0x6b78c33c43ff5e85f541499e795d93eb903ff73065af13033d9631631dff1e20,
            0x1Ffc33f5E217b1CF95e713DB49Fcd86C8195666C,
            0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f,
            1000000000000000000000,
            200000000000000000,
            0x9139213bE0cF31C8B1bD609f1d953605e20bD2Cb,
            0x83743f550bcdb5bE905766E2E3CB9a86c6823cC9,
            0x1E85c6266C9EDf9e6BA293d780DcdDE76dC7Acf7,
            0xa079ee2cbca99027691808373d61d3efe17c46d4a28d44b513be612702c5e957
        );
    }

    // `release[1]`/`refund[1]` are a STANDALONE settlement example, deliberately on a different
    // chain id (8453) and a different escrow address than `[0]`: those are the only two variable
    // terms of the escrow's EIP-712 domain separator, so a signer that hardcodes either one
    // reproduces `[0]` and fails `[1]`. The amounts are 6-decimal shaped (250 USDC, 0.05 fee) rather
    // than `[0]`'s 18-decimal 1000e18. They are NOT the settlement of any published
    // `deposit`/`reserve` entry - unlike `[0]`, which shares `depositId[0]`'s id - so nothing here
    // ties the two groups together. `destinationHash` is keccak256 of the plaintext destination
    // "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@0xc0ffee254729296a45a3885639AC7E10F9d54979".
    // That preimage is EIP-55 mixed-case in BOTH hex segments — NOT canonical under the ratified
    // all-lowercase-hex rule (ONCHAIN_SPEC.md) — and it feeds this pinned destinationHash, so it must
    // not be re-cased. The same logical destination, asset segment lowercase, is
    // test/Escrow.canonicalDigest.t.sol's DESTINATION; the two are deliberate, distinct byte strings,
    // each behind its own pinned digests. Copy canonical examples from
    // test/Destination.canonicalExamples.t.sol instead.
    // (Plain comments, not natspec: solc parses an `@` inside a doc block as a tag.)
    function test_releaseDigest_2() public view {
        _assertReleaseDigest(
            1,
            8453,
            0xc0dE212000000000000000000000000000002120,
            0x12f9fb0a8113f62a72eb49310afe8a3f23481f20f9448d66d75cfd26528791a8,
            0xcd8f1021fd9bb51adb11601e257fb5a0e6e229627096c760e0987babbda5f647,
            0x50bc4e304bf0116d918b1f705aeedcf235c40b211e51b50335fd8a9ab0836f62,
            0x7a271366eebefa42e0e31ceba3fcb469d02f6781104a66f208b8977032b38d51,
            0x70997970C51812dc3A010C7d01b50e0d17dc79C8,
            0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
            250000000,
            50000,
            0x9139213bE0cF31C8B1bD609f1d953605e20bD2Cb,
            0x83743f550bcdb5bE905766E2E3CB9a86c6823cC9,
            0x1E85c6266C9EDf9e6BA293d780DcdDE76dC7Acf7,
            0xe67a8082522f1fea13fc7cca6a4785786391f6d679f23b11a851bf5147daca4f
        );
    }

    function _assertReleaseDigest(
        uint256 index,
        uint256 chainId,
        address escrow,
        bytes32 depositId,
        bytes32 quoteHash,
        bytes32 depositRequestHash,
        bytes32 destinationHash,
        address depositor,
        address token,
        uint256 amount,
        uint256 feeAmount,
        address reserver,
        address releaser,
        address settler,
        bytes32 expected
    ) private view {
        _bindSettlementFixture(
            "release",
            index,
            chainId,
            escrow,
            depositId,
            quoteHash,
            depositRequestHash,
            destinationHash,
            depositor,
            token,
            amount,
            feeAmount,
            reserver,
            releaser,
            settler,
            expected
        );

        bytes32 structHash = keccak256(
            abi.encode(
                RELEASE_WITNESS_TYPE_HASH,
                depositId,
                quoteHash,
                depositRequestHash,
                destinationHash,
                depositor,
                token,
                amount,
                feeAmount,
                reserver,
                releaser,
                settler
            )
        );
        bytes32 domainSep = _escrowDomainSeparator(chainId, escrow);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        assertEq(digest, expected, "release digest mismatch");
    }

    // ---- refund digest ----

    function test_refundDigest_1() public view {
        _assertRefundDigest(
            0,
            1,
            0x41AD713827f11837f06C065e9cd0Bb56CE1e06a0,
            0xbbbf298f926ddc48a92871e25e7e223ba104de64fc827650963e8ec89e37d8ac,
            0x095b62b4af754ec82a94c9e500313b362f073033c63d6d888b3c8f47dcbb33e9,
            0x2b52da99cb649092e2fc4ddf7f365d862ea53d0c123899d59707ab6092f0ae39,
            0x6b78c33c43ff5e85f541499e795d93eb903ff73065af13033d9631631dff1e20,
            0x1Ffc33f5E217b1CF95e713DB49Fcd86C8195666C,
            0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f,
            1000000000000000000000,
            200000000000000000,
            0x9139213bE0cF31C8B1bD609f1d953605e20bD2Cb,
            0x83743f550bcdb5bE905766E2E3CB9a86c6823cC9,
            0x1E85c6266C9EDf9e6BA293d780DcdDE76dC7Acf7,
            0xe0757bd1fdab555273e2d24d849ab98949fb69a7830eee598d1906392bde0884
        );
    }

    /// @dev Same field set as `release[1]` (see its note), verified under the RefundWitness
    /// typehash: the two witnesses have identical members and differ only by type name, so the two
    /// digests must differ even though every input is the same.
    function test_refundDigest_2() public view {
        _assertRefundDigest(
            1,
            8453,
            0xc0dE212000000000000000000000000000002120,
            0x12f9fb0a8113f62a72eb49310afe8a3f23481f20f9448d66d75cfd26528791a8,
            0xcd8f1021fd9bb51adb11601e257fb5a0e6e229627096c760e0987babbda5f647,
            0x50bc4e304bf0116d918b1f705aeedcf235c40b211e51b50335fd8a9ab0836f62,
            0x7a271366eebefa42e0e31ceba3fcb469d02f6781104a66f208b8977032b38d51,
            0x70997970C51812dc3A010C7d01b50e0d17dc79C8,
            0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
            250000000,
            50000,
            0x9139213bE0cF31C8B1bD609f1d953605e20bD2Cb,
            0x83743f550bcdb5bE905766E2E3CB9a86c6823cC9,
            0x1E85c6266C9EDf9e6BA293d780DcdDE76dC7Acf7,
            0x939832b98360c40542aa59e87c9dfe3e67f59aab10d4997320afb769d7a46450
        );
    }

    function _assertRefundDigest(
        uint256 index,
        uint256 chainId,
        address escrow,
        bytes32 depositId,
        bytes32 quoteHash,
        bytes32 depositRequestHash,
        bytes32 destinationHash,
        address depositor,
        address token,
        uint256 amount,
        uint256 feeAmount,
        address reserver,
        address releaser,
        address settler,
        bytes32 expected
    ) private view {
        _bindSettlementFixture(
            "refund",
            index,
            chainId,
            escrow,
            depositId,
            quoteHash,
            depositRequestHash,
            destinationHash,
            depositor,
            token,
            amount,
            feeAmount,
            reserver,
            releaser,
            settler,
            expected
        );

        bytes32 structHash = keccak256(
            abi.encode(
                REFUND_WITNESS_TYPE_HASH,
                depositId,
                quoteHash,
                depositRequestHash,
                destinationHash,
                depositor,
                token,
                amount,
                feeAmount,
                reserver,
                releaser,
                settler
            )
        );
        bytes32 domainSep = _escrowDomainSeparator(chainId, escrow);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        assertEq(digest, expected, "refund digest mismatch");
    }

    // ---- typehash drift guards ----
    //
    // Independently-computed expected typehashes. These are LITERALS on purpose:
    // recomputing from a duplicated string and comparing against a regenerated
    // fixture is self-referential and is how the reserve typehash went stale.
    // CORE-2120 tasks 2-5 update these to the post-destination-commitment values.
    bytes32 private constant EXPECTED_DEPOSIT_WITNESS_TYPE_HASH =
        0x49bfb2c307c3a42001389497e5f5b9dc592052768c1f3cdf09aac3c58ec582b9;
    bytes32 private constant EXPECTED_RESERVE_WITNESS_TYPE_HASH =
        0x231586e09714868d376f25b00c3a8dc8e307d350b64e22fbeb6578bb7bc6fd87;
    bytes32 private constant EXPECTED_RELEASE_WITNESS_TYPE_HASH =
        0x7b53386f16fef70a2a3ea71bda140486e6167753168b12a94b218b94de37fe7b;
    bytes32 private constant EXPECTED_REFUND_WITNESS_TYPE_HASH =
        0x3b5d88b2664086649c47fb1bddafbc2c1f05c6be52fb1c1f11c53db3c608772d;

    function test_depositWitnessTypeHash_matchesEscrowConstant() public pure {
        assertEq(
            keccak256(
                "DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)"
            ),
            EXPECTED_DEPOSIT_WITNESS_TYPE_HASH,
            "deposit type string drifted from Escrow.sol"
        );
        assertEq(
            DEPOSIT_WITNESS_TYPE_HASH,
            EXPECTED_DEPOSIT_WITNESS_TYPE_HASH,
            "test-local DEPOSIT_WITNESS_TYPE_HASH is stale"
        );
    }

    function test_reserveWitnessTypeHash_matchesEscrowConstant() public pure {
        assertEq(
            keccak256("ReserveWitness(bytes32 depositId,bytes32 quoteHash,address settler,uint256 sourceAmount)"),
            EXPECTED_RESERVE_WITNESS_TYPE_HASH,
            "reserve type string drifted from Escrow.sol"
        );
        assertEq(
            RESERVE_WITNESS_TYPE_HASH,
            EXPECTED_RESERVE_WITNESS_TYPE_HASH,
            "test-local RESERVE_WITNESS_TYPE_HASH is stale"
        );
    }

    function test_releaseWitnessTypeHash_matchesEscrowConstant() public pure {
        assertEq(
            keccak256(
                "ReleaseWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)"
            ),
            EXPECTED_RELEASE_WITNESS_TYPE_HASH,
            "release type string drifted from Escrow.sol"
        );
        assertEq(
            RELEASE_WITNESS_TYPE_HASH,
            EXPECTED_RELEASE_WITNESS_TYPE_HASH,
            "test-local RELEASE_WITNESS_TYPE_HASH is stale"
        );
    }

    function test_refundWitnessTypeHash_matchesEscrowConstant() public pure {
        assertEq(
            keccak256(
                "RefundWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)"
            ),
            EXPECTED_REFUND_WITNESS_TYPE_HASH,
            "refund type string drifted from Escrow.sol"
        );
        assertEq(
            REFUND_WITNESS_TYPE_HASH, EXPECTED_REFUND_WITNESS_TYPE_HASH, "test-local REFUND_WITNESS_TYPE_HASH is stale"
        );
    }

    // ---- typehash drift guard: tie EXPECTED_* literals to Escrow.sol's own source ----
    //
    // The checks above are internally consistent (test-local type-string hash ==
    // EXPECTED_* literal) but never read Escrow.sol itself. If a future change edits
    // one of Escrow.sol's private typehash constants and forgets to touch this file at
    // all, the checks above stay mutually consistent (all stale together) and pass
    // silently — the exact gap that let RESERVE_WITNESS_TYPE_HASH go stale before.
    //
    // These tests close it by locating each constant's *declaration* in Escrow.sol
    // (the `constant` keyword, then its name, anchored so it can't be satisfied by a
    // longer identifier that merely contains it as a substring, then `=`) and reading
    // the 66-char 0x-prefixed hex literal assigned there — as opposed to a raw
    // whole-file substring search for the hex value, which a stray "previously was 0x…"
    // comment left behind after an edit could satisfy even though the real constant had
    // already changed. The source is put through `_codeOnly` first, so COMMENT TEXT IS
    // NOT SCANNED AT ALL: that closes the residual form of the same hole, where a
    // `NAME = 0x…` note above the constant — or a commented-out old declaration — was
    // still a candidate for the scan even though the raw substring search was gone.
    string private constant ESCROW_SOURCE_PATH = "src/Escrow.sol";
    /// @dev `EscrowReserveLib` carries its own copy of the deposit and reserve witness typehashes
    /// (it runs `reserve()` under delegatecall and cannot read `Escrow`'s private constants), so
    /// the same source tie applies to it.
    string private constant RESERVE_LIB_SOURCE_PATH = "src/EscrowReserveLib.sol";

    function _isIdentifierChar(bytes1 c) private pure returns (bool) {
        return (c >= "0" && c <= "9") || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c == "_";
    }

    function _isWhitespace(bytes1 c) private pure returns (bool) {
        return c == " " || c == "\t" || c == "\n" || c == "\r";
    }

    function _isHexChar(bytes1 c) private pure returns (bool) {
        return (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
    }

    /// @dev `source` with every comment replaced by a single space, so a scan over the result can
    ///      only match real code. Used by every source-scanning guard in this file, because a scan
    ///      that reads comments as if they were code is the exact hole that let a whole-file
    ///      substring search be satisfied by a leftover "previously was 0x…" note (80bfac9): the
    ///      declaration-anchored scan that replaced it still read comment text, so a comment ABOVE a
    ///      constant, or a commented-out old declaration, could still win.
    ///
    ///      A comment becomes ONE SPACE rather than being deleted, so it can never fuse the tokens
    ///      on either side of it into a single identifier, and a line comment's terminating newline
    ///      is preserved so line structure survives. String literals are respected: a `//` or `/*`
    ///      inside a string never starts a comment, and a `\`-escaped quote never ends the string.
    function _codeOnly(string memory source) private pure returns (string memory) {
        bytes memory src = bytes(source);
        uint256 srcLen = src.length;
        // Never longer than the input: a comment of >= 2 consumed characters emits at most 2.
        bytes memory out = new bytes(srcLen);
        uint256 outLen;

        for (uint256 i = 0; i < srcLen; i++) {
            bytes1 c = src[i];

            if (c == '"' || c == "'") {
                bytes1 quote = c;
                out[outLen++] = c;
                i++;
                while (i < srcLen) {
                    out[outLen++] = src[i];
                    if (src[i] == "\\" && i + 1 < srcLen) {
                        i++;
                        out[outLen++] = src[i]; // escaped character: never a terminator
                    } else if (src[i] == quote) {
                        break;
                    }
                    i++;
                }
                continue;
            }

            if (c == "/" && i + 1 < srcLen && src[i + 1] == "/") {
                while (i < srcLen && src[i] != "\n") i++;
                out[outLen++] = " ";
                if (i < srcLen) out[outLen++] = "\n"; // the loop's own i++ steps past it
                continue;
            }
            if (c == "/" && i + 1 < srcLen && src[i + 1] == "*") {
                i += 2;
                while (i + 1 < srcLen && !(src[i] == "*" && src[i + 1] == "/")) i++;
                i++; // land on the closing '/', which the loop's own i++ then steps past
                out[outLen++] = " ";
                continue;
            }

            out[outLen++] = c;
        }

        bytes memory trimmed = new bytes(outLen);
        for (uint256 n; n < outLen; n++) {
            trimmed[n] = out[n];
        }
        return string(trimmed);
    }

    /// @dev Scans `source` for a Solidity `constant constantName = 0x<64 hex>` DECLARATION: the
    ///      `constant` keyword, then `constantName`, then (after optional whitespace) a bare `=`
    ///      (not `==`), then a 66-char 0x-prefixed hex literal. The name is anchored against
    ///      identifier characters on both sides, so a hypothetical `FULL_RESERVE_WITNESS_TYPE_HASH`
    ///      can never satisfy a search for `RESERVE_WITNESS_TYPE_HASH`, and the `constant` keyword
    ///      is anchored on its left for the same reason.
    ///
    ///      TWO things make it a declaration scan rather than a text search, and the doc used to
    ///      claim more than the code delivered on both counts. First, `source` is expected to have
    ///      been through `_codeOnly`, so comment text cannot be matched at all - neither a
    ///      `NAME = 0x…` note above the constant nor a commented-out old declaration below it.
    ///      Second, the `constant` keyword is required, so prose or a string that happens to read
    ///      `NAME = 0x…` is not a candidate either.
    ///
    ///      Returns the NUMBER of matching declarations and the value of the LAST one, so the caller
    ///      can require exactly one and fail loudly instead of silently trusting whichever came
    ///      first. Candidates that fail validation (wrong punctuation, non-hex characters,
    ///      truncated) are skipped rather than aborting the scan. Hex parsing via vm.parseBytes32 is
    ///      case-insensitive, so a 0xABC…/0xabc… casing difference between the two files can never
    ///      cause a spurious result.
    function _findDeclaredTypeHash(string memory source, string memory constantName)
        private
        pure
        returns (uint256 declarations, bytes32 value)
    {
        bytes memory src = bytes(source);
        bytes memory name = bytes(constantName);
        bytes memory keyword = bytes("constant");
        uint256 srcLen = src.length;
        uint256 nameLen = name.length;
        uint256 keywordLen = keyword.length;
        if (nameLen == 0 || srcLen < nameLen) return (0, bytes32(0));

        for (uint256 i = 0; i + nameLen <= srcLen; i++) {
            if (i > 0 && _isIdentifierChar(src[i - 1])) continue;

            uint256 j = 0;
            while (j < nameLen && src[i + j] == name[j]) j++;
            if (j != nameLen) continue;

            uint256 afterName = i + nameLen;
            if (afterName < srcLen && _isIdentifierChar(src[afterName])) continue;

            // The `constant` keyword must sit immediately before the name (whitespace aside).
            uint256 back = i;
            while (back > 0 && _isWhitespace(src[back - 1])) back--;
            if (back < keywordLen) continue;
            uint256 keywordStart = back - keywordLen;
            if (keywordStart > 0 && _isIdentifierChar(src[keywordStart - 1])) continue;
            bool isConstant = true;
            for (uint256 q = 0; q < keywordLen; q++) {
                if (src[keywordStart + q] != keyword[q]) {
                    isConstant = false;
                    break;
                }
            }
            if (!isConstant) continue;

            uint256 k = afterName;
            while (k < srcLen && _isWhitespace(src[k])) k++;
            if (k >= srcLen || src[k] != "=") continue;
            k++;
            if (k < srcLen && src[k] == "=") continue; // skip `==` comparisons
            while (k < srcLen && _isWhitespace(src[k])) k++;

            if (k + 2 > srcLen || src[k] != "0" || (src[k + 1] != "x" && src[k + 1] != "X")) continue;
            uint256 hexStart = k + 2;
            if (hexStart + 64 > srcLen) continue;

            bool validHex = true;
            for (uint256 m = 0; m < 64; m++) {
                if (!_isHexChar(src[hexStart + m])) {
                    validHex = false;
                    break;
                }
            }
            if (!validHex) continue;

            bytes memory literal = new bytes(66);
            literal[0] = "0";
            literal[1] = "x";
            for (uint256 m = 0; m < 64; m++) {
                literal[2 + m] = src[hexStart + m];
            }
            declarations++;
            value = vm.parseBytes32(string(literal));
        }
    }

    function _assertTypeHashTiedToEscrowSource(bytes32 expected, string memory label) private view {
        _assertTypeHashTiedToSource(ESCROW_SOURCE_PATH, expected, label);
    }

    function _assertTypeHashTiedToSource(string memory path, bytes32 expected, string memory label) private view {
        string memory source = _codeOnly(vm.readFile(path));
        (uint256 declarations, bytes32 declared) = _findDeclaredTypeHash(source, label);
        assertEq(
            declarations,
            1,
            string.concat(
                "expected exactly ONE `constant ",
                label,
                " = 0x...;` declaration in ",
                path,
                " (comments excluded) - zero means it was renamed, removed, or is no longer a `constant`; more than one means the name is declared twice and this guard cannot tell which value ships"
            )
        );
        assertEq(
            declared,
            expected,
            string.concat(
                label, " typehash drifted: ", path, " and test/EncodingExamples.verify.t.sol disagree on the hex value"
            )
        );
    }

    function test_reserveWitnessTypeHash_tiedToReserveLibSource() public view {
        _assertTypeHashTiedToSource(
            RESERVE_LIB_SOURCE_PATH, EXPECTED_RESERVE_WITNESS_TYPE_HASH, "RESERVE_WITNESS_TYPE_HASH"
        );
    }

    function test_depositWitnessTypeHash_tiedToEscrowSource() public view {
        _assertTypeHashTiedToEscrowSource(EXPECTED_DEPOSIT_WITNESS_TYPE_HASH, "DEPOSIT_WITNESS_TYPE_HASH");
    }

    function test_reserveWitnessTypeHash_tiedToEscrowSource() public view {
        _assertTypeHashTiedToEscrowSource(EXPECTED_RESERVE_WITNESS_TYPE_HASH, "RESERVE_WITNESS_TYPE_HASH");
    }

    function test_releaseWitnessTypeHash_tiedToEscrowSource() public view {
        _assertTypeHashTiedToEscrowSource(EXPECTED_RELEASE_WITNESS_TYPE_HASH, "RELEASE_WITNESS_TYPE_HASH");
    }

    function test_refundWitnessTypeHash_tiedToEscrowSource() public view {
        _assertTypeHashTiedToEscrowSource(EXPECTED_REFUND_WITNESS_TYPE_HASH, "REFUND_WITNESS_TYPE_HASH");
    }

    // ---- declaration-order drift guard: tie each STRUCT DECLARATION to its type string ----
    //
    // Everything above pins the canonical TYPE STRINGS and the typehash constants. Nothing pinned
    // the STRUCT DECLARATIONS those type strings are supposed to describe, and the two can drift
    // apart silently: exchanging the adjacent `bytes32 depositRequestHash` and
    // `bytes32 destinationHash` members in the `ReleaseWitness` and `RefundWitness` DECLARATIONS in
    // src/interfaces/IEscrow.sol (1 file, 2 lines) leaves the WHOLE SUITE GREEN. Both members are
    // `bytes32`, so no function selector and no event topic0 moves; every digest and every
    // ActiveDeposit reconstruction in src/Escrow.sol is written as an explicit named-argument list,
    // so the contract keeps hashing the same values in the same order. Only `make check-abi`
    // noticed, by reporting the generated ABI as out of date.
    //
    // Why that is worth a test of its own: the ABI is what OTHER repositories encode against. A
    // consumer that builds the witness tuple BY POSITION against a stale ABI would fill the two
    // commitments swapped. The contract would then rebuild an ActiveDeposit that does not hash to
    // the stored one and revert `InvalidWitnessValues` - the deposit would be neither releasable
    // NOR refundable, and this escrow has no rescue function.
    //
    // The `ActiveDeposit` declaration already has this protection: its tuple hash is pinned to
    // out-of-band literals on both the write path (`DEPOSITED_ACTIVE_DEPOSIT_HASH`) and the read
    // path (`CANONICAL_ACTIVE_DEPOSIT_HASH`) in test/Escrow.canonicalDigest.t.sol, and five tests
    // fail if a member moves. The tests below give the four EIP-712 witnesses the same protection,
    // by REBUILDING each canonical type string from its declaration in src/interfaces/IEscrow.sol -
    // member by member, in declaration order - and requiring the result to hash to the pinned
    // typehash. Nothing is compared against a type string written in this file, so the tie is to
    // the interface source, in the same spirit as `_assertTypeHashTiedToEscrowSource` above.
    string private constant IESCROW_SOURCE_PATH = "src/interfaces/IEscrow.sol";

    /// @dev Rebuilds `StructName(type1 name1,type2 name2,...)` - the canonical EIP-712 type string
    ///      for a struct of elementary members - from the `struct StructName { ... }` declaration in
    ///      `source`, members in DECLARATION ORDER. Line and block comments inside the body are
    ///      stripped and each member's internal whitespace is collapsed to a single space, so the
    ///      result is independent of formatting. The struct name match is anchored against
    ///      identifier characters on both sides and must be followed by `{`, so a longer identifier
    ///      (`ReleaseWitnessV2`) cannot satisfy it; `source` is expected to have been through
    ///      `_codeOnly`, so a comment that quotes `struct ReleaseWitness {` cannot either.
    ///      Returns found=false when no such declaration exists anywhere in the file.
    function _typeStringFromDeclaration(string memory source, string memory structName)
        private
        pure
        returns (bool found, string memory typeString)
    {
        bytes memory src = bytes(source);
        bytes memory needle = bytes(string.concat("struct ", structName));
        uint256 srcLen = src.length;
        uint256 needleLen = needle.length;

        for (uint256 i = 0; i + needleLen <= srcLen; i++) {
            if (i > 0 && _isIdentifierChar(src[i - 1])) continue;

            uint256 j = 0;
            while (j < needleLen && src[i + j] == needle[j]) j++;
            if (j != needleLen) continue;

            uint256 k = i + needleLen;
            // Reject a longer identifier that merely starts with the name.
            if (k < srcLen && _isIdentifierChar(src[k])) continue;
            while (k < srcLen && _isWhitespace(src[k])) k++;
            if (k >= srcLen || src[k] != "{") continue;

            return (true, string.concat(structName, "(", _declaredMemberList(src, k + 1), ")"));
        }
        return (false, "");
    }

    /// @dev The comma-separated `type name` list of a struct body starting at `start` (just past the
    ///      opening brace) and ending at the first `}`.
    function _declaredMemberList(bytes memory src, uint256 start) private pure returns (string memory) {
        uint256 srcLen = src.length;
        // Never longer than the body it is built from: every emitted comma replaces a consumed `;`.
        bytes memory out = new bytes(srcLen - start);
        uint256 outLen;
        uint256 members;
        bool atMemberStart = true;
        bool pendingSpace;

        for (uint256 i = start; i < srcLen; i++) {
            bytes1 c = src[i];
            if (c == "}") break;

            if (c == "/" && i + 1 < srcLen && src[i + 1] == "/") {
                while (i < srcLen && src[i] != "\n") i++;
                continue;
            }
            if (c == "/" && i + 1 < srcLen && src[i + 1] == "*") {
                i += 2;
                while (i + 1 < srcLen && !(src[i] == "*" && src[i + 1] == "/")) i++;
                i++; // land on the closing '/', which the loop's own i++ then steps past
                continue;
            }

            if (c == ";") {
                if (!atMemberStart) members++;
                atMemberStart = true;
                pendingSpace = false;
                continue;
            }
            if (_isWhitespace(c)) {
                if (!atMemberStart) pendingSpace = true; // collapsed; dropped if the member ends here
                continue;
            }

            if (atMemberStart) {
                if (members > 0) {
                    out[outLen++] = ",";
                }
                atMemberStart = false;
            } else if (pendingSpace) {
                out[outLen++] = " ";
            }
            pendingSpace = false;
            out[outLen++] = c;
        }

        bytes memory trimmed = new bytes(outLen);
        for (uint256 m; m < outLen; m++) {
            trimmed[m] = out[m];
        }
        return string(trimmed);
    }

    function _assertDeclarationOrderMatchesTypeString(string memory structName, bytes32 expectedTypeHash) private view {
        (bool found, string memory declared) =
            _typeStringFromDeclaration(_codeOnly(vm.readFile(IESCROW_SOURCE_PATH)), structName);

        assertTrue(
            found,
            string.concat(
                "no `struct ",
                structName,
                " {` declaration found in ",
                IESCROW_SOURCE_PATH,
                " - renamed, removed, or moved to another file?"
            )
        );
        assertEq(
            keccak256(bytes(declared)),
            expectedTypeHash,
            string.concat(
                "THE `",
                structName,
                "` STRUCT DECLARATION ORDER IN ",
                IESCROW_SOURCE_PATH,
                " HAS DRIFTED FROM THE CANONICAL EIP-712 TYPE STRING. Rebuilt member by member from that declaration it reads `",
                declared,
                "`, which does not hash to the pinned typehash. A reordered member (a swap of two same-type members moves no selector and no event topic0, so nothing else in this suite notices), a rename, a retype, an added member or a removed one all land here. The declaration IS the ABI other repositories encode the witness tuple against: if it ships transposed, a consumer encoding by position fills the members swapped, the contract rebuilds an ActiveDeposit that does not hash to the stored one, and the deposit is neither releasable NOR refundable - this escrow has no rescue function. Do NOT repoint the typehash literal to match: re-derive it OUT OF BAND and treat a changed type string as a breaking change to every offchain signer."
            )
        );
    }

    function test_depositWitnessDeclarationOrder_matchesCanonicalTypeString() public view {
        _assertDeclarationOrderMatchesTypeString("DepositWitness", EXPECTED_DEPOSIT_WITNESS_TYPE_HASH);
    }

    function test_reserveWitnessDeclarationOrder_matchesCanonicalTypeString() public view {
        _assertDeclarationOrderMatchesTypeString("ReserveWitness", EXPECTED_RESERVE_WITNESS_TYPE_HASH);
    }

    function test_releaseWitnessDeclarationOrder_matchesCanonicalTypeString() public view {
        _assertDeclarationOrderMatchesTypeString("ReleaseWitness", EXPECTED_RELEASE_WITNESS_TYPE_HASH);
    }

    function test_refundWitnessDeclarationOrder_matchesCanonicalTypeString() public view {
        _assertDeclarationOrderMatchesTypeString("RefundWitness", EXPECTED_REFUND_WITNESS_TYPE_HASH);
    }

    // ---- declaration pins for the IEscrow structs that have NO EIP-712 type string ----
    //
    // The four guards above work because each of those declarations IS an EIP-712 type string, so
    // the typehash pins it. `DepositInput`, `ReleaseInput`, `RefundInput` and `ActiveDeposit` have no
    // typehash, and one of them carries the same hazard `DepositCommitments` does:
    //
    //     struct DepositInput { ...; bytes depositSignature; ReserveWitness reserveWitness;
    //                           bytes reserveSignature; }
    //
    // The two signature members are both `bytes`. Exchanging them in the DECLARATION leaves the ABI
    // TYPE SEQUENCE identical - `bytes` is still at index 3 and index 5, with the same tuple between
    // them - so `deposit()`'s selector does NOT move, and src/Escrow.sol reads both by name, so the
    // contract keeps working. Measured, not assumed: before the pin below existed, that swap left the
    // WHOLE SUITE GREEN under both `forge test` and `make test-gas-snapshot`, left the gas snapshot
    // byte-identical, and changed nothing anywhere except the parameter NAMES in generated/abi -
    // which `make check-abi` reports as "did you regenerate", not as wrong.
    //
    // Consequence, stated honestly because it is NOT the `DepositCommitments` consequence: a client
    // generated from a transposed ABI puts the reserver's signature where the depositor's Permit2
    // signature is expected, and the call REVERTS (Permit2 `InvalidSigner`) before any state change
    // or token movement. Loud, at the first integration test, and nothing is escrowed - so no deposit
    // is stranded. It is pinned because it is the same undetectable class, it was the last unguarded
    // instance of it in this file, and the pin costs one literal.
    //
    // `ActiveDeposit` is already covered on both settlement paths by the out-of-band tuple literals
    // in test/Escrow.canonicalDigest.t.sol: exchanging any two of its same-type members fails seven
    // tests there (verified for `depositRequestHash`/`destinationHash`, `amount`/`feeAmount` and
    // `reserver`/`releaser`). It is pinned here as well because those seven failures say "the tuple
    // does not hash to the out-of-band literal", while this one names the struct whose declaration
    // moved. `ReleaseInput` and `RefundInput` have no same-type pair today; they are pinned for the
    // same reason `Refunded` is - so that a member added next to one of theirs tomorrow does not
    // create the hazard silently and make a future editor redo this analysis.
    //
    // PROVENANCE: every literal below is `cast keccak` over the canonical string quoted above it,
    // computed OUTSIDE this repository. Do NOT repoint one to match a failure - re-derive it out of
    // band and treat a changed declaration as a breaking change for every generated client.

    /// @dev keccak256("DepositInput(ISignatureTransfer.PermitTransferFrom permit,address depositor,DepositWitness depositWitness,bytes depositSignature,ReserveWitness reserveWitness,bytes reserveSignature)")
    bytes32 private constant DEPOSIT_INPUT_DECLARATION_HASH =
        0x04a9fa1117c2ff03d2280a0479978bcb971609fcf488de6423ade9dcd4cef8a3;

    /// @dev keccak256("ReleaseInput(ReleaseWitness releaseWitness,bytes releaseSignature)")
    bytes32 private constant RELEASE_INPUT_DECLARATION_HASH =
        0xc2518cbb5a5f56d4948d87215bf34e71059fa095bbfb2dfb3943f5e2bba5f636;

    /// @dev keccak256("RefundInput(RefundWitness refundWitness,bytes refundSignature)")
    bytes32 private constant REFUND_INPUT_DECLARATION_HASH =
        0xa8ae41a2f4040c3f55f34b28a85dc581c76f725d8277f485175dcebc42a3285c;

    /// @dev keccak256("DirectDepositInput(address token,uint256 amount,uint256 nonce,DepositWitness depositWitness)")
    bytes32 private constant DIRECT_DEPOSIT_INPUT_DECLARATION_HASH =
        0xded459e8b091d8f85a4aea9b4522c42db3f5482f51b0d97ba59531e43e5f6589;

    /// @dev keccak256("ReserveInput(address depositor,address token,uint256 amount,DepositWitness depositWitness,ReserveWitness reserveWitness,bytes reserveSignature)")
    bytes32 private constant RESERVE_INPUT_DECLARATION_HASH =
        0xd4bf0a719c3d33d82ab92f838e5864bb9e250dca86e32ec07ff3a53417c9f166;

    /// @dev keccak256("RefundUnreservedInput(bytes32 depositId,bytes32 depositRequestHash,bytes32 destinationHash,address token,uint256 amount,address reserver,address releaser)")
    bytes32 private constant REFUND_UNRESERVED_INPUT_DECLARATION_HASH =
        0x646f1a4e0d1336fc2c9c415039edf8985317089f1b7a327c420df306fc2e9508;

    /// @dev keccak256("ActiveDeposit(address depositor,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)")
    bytes32 private constant ACTIVE_DEPOSIT_DECLARATION_HASH =
        0x2d740ed97170a5f2ced04ff90b7e5fe8cc8ed6879d907b2a3ba56586ac9cbb22;

    /// @dev Sibling of `_assertDeclarationOrderMatchesTypeString` for a struct with no typehash to
    ///      pin it: the rebuilt declaration is required to hash to an out-of-band literal instead.
    function _assertStructDeclarationPinned(string memory structName, bytes32 expectedDeclarationHash) private view {
        (bool found, string memory declared) =
            _typeStringFromDeclaration(_codeOnly(vm.readFile(IESCROW_SOURCE_PATH)), structName);

        assertTrue(
            found,
            string.concat(
                "no `struct ",
                structName,
                " {` declaration found in ",
                IESCROW_SOURCE_PATH,
                " - renamed, removed, or moved to another file?"
            )
        );
        assertEq(
            keccak256(bytes(declared)),
            expectedDeclarationHash,
            string.concat(
                "THE `",
                structName,
                "` STRUCT DECLARATION ORDER IN ",
                IESCROW_SOURCE_PATH,
                " HAS DRIFTED FROM THE PINNED DECLARATION. Rebuilt member by member from that declaration it reads `",
                declared,
                "`, which does not hash to the pinned literal (the canonical string it was derived from is quoted above that literal in this file). This struct has NO EIP-712 type string, so no typehash pins its member order: exchanging two same-type members leaves the ABI type sequence - and therefore the function selector - identical, and src/Escrow.sol reads every member by name, so the contract keeps working while the ABI other repositories generate a client from silently changes. Do NOT repoint the pinned literal to match: re-derive it OUT OF BAND and treat a changed declaration as a breaking change for every generated client."
            )
        );
    }

    // `DepositInput` is the reason this section exists: `depositSignature` and `reserveSignature` are
    // both `bytes`, and swapping them moves no selector, no topic0 and no gas-snapshot entry.
    function test_depositInputDeclaration_isPinned() public view {
        _assertStructDeclarationPinned("DepositInput", DEPOSIT_INPUT_DECLARATION_HASH);
    }

    function test_releaseInputDeclaration_isPinned() public view {
        _assertStructDeclarationPinned("ReleaseInput", RELEASE_INPUT_DECLARATION_HASH);
    }

    function test_refundInputDeclaration_isPinned() public view {
        _assertStructDeclarationPinned("RefundInput", REFUND_INPUT_DECLARATION_HASH);
    }

    // `DirectDepositInput`: `amount` and `nonce` are adjacent `uint256`s, the token amount and the
    // id-bound nonce, and a swap moves no selector.
    function test_directDepositInputDeclaration_isPinned() public view {
        _assertStructDeclarationPinned("DirectDepositInput", DIRECT_DEPOSIT_INPUT_DECLARATION_HASH);
    }

    // `ReserveInput`: `depositor` and `token` are adjacent `address`es.
    function test_reserveInputDeclaration_isPinned() public view {
        _assertStructDeclarationPinned("ReserveInput", RESERVE_INPUT_DECLARATION_HASH);
    }

    // `RefundUnreservedInput`: three adjacent `bytes32`s and the adjacent `reserver` and `releaser`
    // addresses; a swap moves no selector, and the depositor's call then reverts InvalidWitnessValues.
    function test_refundUnreservedInputDeclaration_isPinned() public view {
        _assertStructDeclarationPinned("RefundUnreservedInput", REFUND_UNRESERVED_INPUT_DECLARATION_HASH);
    }

    // Second detector for `ActiveDeposit`, whose tuple is already pinned out of band on both
    // settlement paths in test/Escrow.canonicalDigest.t.sol. This one names the struct.
    function test_activeDepositDeclaration_isPinned() public view {
        _assertStructDeclarationPinned("ActiveDeposit", ACTIVE_DEPOSIT_DECLARATION_HASH);
    }

    // ---- declaration-order drift guard: tie each EVENT DECLARATION to its published shape ----
    //
    // The struct guards above exist because swapping two adjacent SAME-TYPE members moves no
    // function selector and no event topic0. An event parameter list has the identical hazard, and
    // it was unguarded: transposing the two non-indexed `bytes32` parameters of
    //
    //     event DepositCommitments(bytes32 indexed depositId, bytes32 depositRequestHash, bytes32 destinationHash)
    //
    // in src/interfaces/IEscrow.sol - leaving the `emit` in src/Escrow.sol untouched - left the
    // WHOLE SUITE GREEN and `forge fmt --check` clean. topic0 is keccak256 of the TYPES-ONLY
    // signature, `DepositCommitments(bytes32,bytes32,bytes32)`, so it does not move; every producer
    // and consumer in this repository is POSITIONAL (the contract emits `emit
    // DepositCommitments(depositId, requestHash, destinationHash)` and the tests `abi.decode` the
    // log data by position), so both sides swap together and stay mutually consistent; and
    // `make check-abi` is only `git status --porcelain generated/abi/` - a "did you regenerate"
    // check, not a correctness check - so it passes as soon as the ABI is regenerated.
    //
    // Why that matters more here than anywhere else: `DepositCommitments` exists to make the
    // single-deposit REFUND path rebuildable from logs alone, and refund is the escape hatch - this
    // escrow has no rescue function. An ABI-driven consumer reading `depositRequestHash` and
    // `destinationHash` out of a shipped-transposed ABI fills both witness members swapped, the
    // contract rebuilds an `ActiveDeposit` that does not hash to the stored one, and the deposit is
    // neither releasable NOR refundable.
    //
    // Two assertions per event, and they catch different things:
    //   1. the DECLARATION - parameter order, `indexed` placement and parameter names - rebuilt from
    //      the source and required to hash to a pinned literal. This is the only detector for a
    //      same-type transposition and for a moved `indexed`;
    //   2. the TYPES-ONLY ABI signature, derived from that same declaration, required to hash to the
    //      pinned topic0 - the value deployed indexers filter on. `Escrow.commitmentEvents.t.sol`
    //      pins the same topic0s against logs the contract really emitted, which is a stronger tie
    //      but needs a mainnet fork; this one is pure and runs with no RPC.
    //
    // PROVENANCE OF THE PINNED LITERALS: every literal below was computed OUTSIDE this repository
    // with `cast keccak <string>` over the canonical string quoted above it, and the topic0s were
    // additionally cross-checked against ONCHAIN_SPEC.md's registry and against the ABI committed
    // before CORE-2120 (`git show 96c4a5a:generated/abi/Escrow.json`). Do NOT "fix" a failure here
    // by pasting the value the assertion printed: that converts the guard into a mirror of the
    // declaration it is supposed to check. Re-derive out of band, and treat any change to a
    // pre-existing event as a breaking change for every deployed indexer.

    /// @dev keccak256("DepositCommitments(bytes32 indexed depositId,bytes32 depositRequestHash,bytes32 destinationHash)")
    bytes32 private constant DEPOSIT_COMMITMENTS_DECLARATION_HASH =
        0xf32b79d5a66c08f25c8ed383de7377ed69ffcd70df71547b3c6f7e2528d5a0e5;
    /// @dev keccak256("DepositCommitments(bytes32,bytes32,bytes32)") - the emitted topic0.
    bytes32 private constant DEPOSIT_COMMITMENTS_TOPIC0 =
        0xdd71cfeda84126f075a6e6c4e6aacadc514806a79f1bccb0619818b7736eefc5;

    /// @dev keccak256("Deposited(bytes32 indexed depositId,bytes32 indexed quoteHash,address indexed depositor,address settler,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser)")
    bytes32 private constant DEPOSITED_DECLARATION_HASH =
        0xb17522e1118cbd91fdfcae405eb744f388878b0ff5b48001dae17be7a50228ec;
    /// @dev keccak256("Deposited(bytes32,bytes32,address,address,address,uint256,uint256,address,address)")
    bytes32 private constant DEPOSITED_TOPIC0 = 0x00d99cb530e2d4ecb11da22fd966de4bd68000fdbc6b822f902163642404000e;

    /// @dev keccak256("DepositReserved(bytes32 indexed depositId,bytes32 quoteHash,address settler,uint256 amount,uint256 feeAmount)")
    bytes32 private constant DEPOSIT_RESERVED_DECLARATION_HASH =
        0x389f36ba72733d7943fa26f088a7d08645a0c36fcdf7af83c8ee763d27e74b3f;
    /// @dev keccak256("DepositReserved(bytes32,bytes32,address,uint256,uint256)")
    bytes32 private constant DEPOSIT_RESERVED_TOPIC0 =
        0x8ec8539e4aa690c46d91ba68ed2cb99fde2d8d74a2bca737283bdacbc1735783;
    /// @dev keccak256("Released(bytes32 indexed depositId,address indexed settler,address token,uint256 amount,uint256 feeAmount)")
    bytes32 private constant RELEASED_DECLARATION_HASH =
        0xf89e31c2e959df7ee992769d6004c9912f649cd580b842992f2d5df7295df096;
    /// @dev keccak256("Released(bytes32,address,address,uint256,uint256)")
    bytes32 private constant RELEASED_TOPIC0 = 0x703d1f677dc7a240b8578621df4ac5a0d8323e943fcc50ce0ffd9dcc8f6974cc;

    /// @dev keccak256("Refunded(bytes32 indexed depositId,address indexed depositor,address token,uint256 amount)")
    bytes32 private constant REFUNDED_DECLARATION_HASH =
        0xd0ab84927f66e5dfaac7d32eebc698abf653433064ff888d39681b95cc570232;
    /// @dev keccak256("Refunded(bytes32,address,address,uint256)")
    bytes32 private constant REFUNDED_TOPIC0 = 0x2e0668a62a5f556368dca9c7113e20f2852c05155548243804bf714ce72b25a6;

    /// @dev keccak256("DepositedMany(bytes32[] depositIds,DepositWitness[] depositWitnesses,ReserveWitness[] reserveWitnesses,uint256[] feeAmounts)")
    bytes32 private constant DEPOSITED_MANY_DECLARATION_HASH =
        0xd9bde3b6335af7d1ad986f08e3779df0ffb4f0315e39039b622b36841f5d42b4;

    /// @dev keccak256("ReleasedMany(ReleaseWitness[] releaseWitnesses)")
    bytes32 private constant RELEASED_MANY_DECLARATION_HASH =
        0xf64c24672cf38f0bed0fadc31abd5dc7d861b9b2a33cef535b5fa31f482d7eb4;

    /// @dev keccak256("RefundedMany(RefundWitness[] refundWitnesses)")
    bytes32 private constant REFUNDED_MANY_DECLARATION_HASH =
        0x939ed5893c104d7316b8c2f96b77fa737ec206a5c6b7a274409d65ac6fb5f121;

    /// @dev Rebuilds `EventName(type1 [indexed] name1,type2 [indexed] name2,...)` - the event's
    ///      DECLARATION as written, `indexed` markers and parameter names included, parameters in
    ///      DECLARATION ORDER - from the `event EventName(...)` declaration in `source`. Line and
    ///      block comments inside the parameter list are stripped and each parameter's internal
    ///      whitespace is collapsed to a single space, so the result is independent of formatting
    ///      (a parameter list forge fmt has wrapped over several lines rebuilds identically to a
    ///      one-line one).
    ///
    ///      Returns the NUMBER of `event EventName(` occurrences found and the LAST one rebuilt, so
    ///      the caller can require exactly one and fail loudly rather than silently deciding which
    ///      of several texts to trust. The name match is anchored against identifier characters on
    ///      both sides and must be followed by `(`, so a longer identifier (`DepositCommitmentsV2`)
    ///      cannot satisfy it; `source` is expected to have been through `_codeOnly`, so a comment
    ///      that quotes the full signature cannot either.
    function _eventDeclarationFromSource(string memory source, string memory eventName)
        private
        pure
        returns (uint256 declarations, string memory declaration)
    {
        bytes memory src = bytes(source);
        bytes memory name = bytes(eventName);
        uint256 srcLen = src.length;
        uint256 nameLen = name.length;
        bytes memory keyword = bytes("event");
        uint256 keywordLen = keyword.length;

        for (uint256 i = 0; i + keywordLen <= srcLen; i++) {
            if (i > 0 && _isIdentifierChar(src[i - 1])) continue;

            uint256 j = 0;
            while (j < keywordLen && src[i + j] == keyword[j]) j++;
            if (j != keywordLen) continue;

            uint256 k = i + keywordLen;
            // `event` must be a keyword in its own right, not the head of a longer identifier.
            if (k >= srcLen || !_isWhitespace(src[k])) continue;
            while (k < srcLen && _isWhitespace(src[k])) k++;

            if (k + nameLen > srcLen) continue;
            uint256 m = 0;
            while (m < nameLen && src[k + m] == name[m]) m++;
            if (m != nameLen) continue;

            k += nameLen;
            if (k < srcLen && _isIdentifierChar(src[k])) continue;
            while (k < srcLen && _isWhitespace(src[k])) k++;
            if (k >= srcLen || src[k] != "(") continue;

            declarations++;
            declaration = string.concat(eventName, "(", _declaredParameterList(src, k + 1), ")");
        }
    }

    /// @dev The comma-separated parameter list of a declaration whose opening `(` is at `start - 1`,
    ///      ending at the matching `)`. Sibling of `_declaredMemberList`, for a `(`-delimited,
    ///      `,`-separated list rather than a `{`-delimited, `;`-terminated one.
    function _declaredParameterList(bytes memory src, uint256 start) private pure returns (string memory) {
        uint256 srcLen = src.length;
        // Never longer than the source it is built from: each emitted `,` replaces a consumed one,
        // and a space is emitted only where the source had whitespace.
        bytes memory out = new bytes(srcLen - start);
        uint256 outLen;
        uint256 depth;
        bool atParameterStart = true;
        bool pendingSpace;
        bool anyEmitted;

        for (uint256 i = start; i < srcLen; i++) {
            bytes1 c = src[i];
            if (c == ")" && depth == 0) break;

            if (c == "/" && i + 1 < srcLen && src[i + 1] == "/") {
                while (i < srcLen && src[i] != "\n") i++;
                continue;
            }
            if (c == "/" && i + 1 < srcLen && src[i + 1] == "*") {
                i += 2;
                while (i + 1 < srcLen && !(src[i] == "*" && src[i + 1] == "/")) i++;
                i++; // land on the closing '/', which the loop's own i++ then steps past
                continue;
            }

            if (c == "(") depth++;
            if (c == ")") depth--; // depth > 0 here: depth == 0 terminated the loop above

            if (c == "," && depth == 0) {
                atParameterStart = true;
                pendingSpace = false;
                continue;
            }
            if (_isWhitespace(c)) {
                if (!atParameterStart) pendingSpace = true; // collapsed; dropped if the parameter ends here
                continue;
            }

            if (atParameterStart) {
                if (anyEmitted) {
                    out[outLen++] = ",";
                }
                anyEmitted = true;
                atParameterStart = false;
            } else if (pendingSpace) {
                out[outLen++] = " ";
            }
            pendingSpace = false;
            out[outLen++] = c;
        }

        bytes memory trimmed = new bytes(outLen);
        for (uint256 n; n < outLen; n++) {
            trimmed[n] = out[n];
        }
        return string(trimmed);
    }

    /// @dev Strips `indexed` markers and parameter names from a declaration rebuilt by
    ///      `_eventDeclarationFromSource`, leaving the canonical types-only ABI event signature
    ///      topic0 is keccak256 of - e.g. `DepositCommitments(bytes32,bytes32,bytes32)`. Each
    ///      parameter contributes its leading whitespace-delimited token, which for an elementary
    ///      type is the ABI type itself. Struct-typed parameters are NOT expanded to tuples, so this
    ///      is only usable for events whose parameters are all elementary (see the callers).
    function _abiSignatureFromEventDeclaration(string memory declaration) private pure returns (string memory) {
        bytes memory decl = bytes(declaration);
        uint256 declLen = decl.length;
        bytes memory out = new bytes(declLen + 1);
        uint256 outLen;
        uint256 i;

        while (i < declLen && decl[i] != "(") {
            out[outLen++] = decl[i];
            i++;
        }
        require(i < declLen, "rebuilt event declaration has no `(`");
        out[outLen++] = decl[i];
        i++;

        bool inTypeToken = true;
        for (; i < declLen; i++) {
            bytes1 c = decl[i];
            if (c == ")") break;
            if (c == ",") {
                out[outLen++] = ",";
                inTypeToken = true;
                continue;
            }
            if (c == " ") {
                inTypeToken = false; // everything after the type token (`indexed`, the name) is dropped
                continue;
            }
            if (inTypeToken) out[outLen++] = c;
        }
        out[outLen++] = ")";

        bytes memory trimmed = new bytes(outLen);
        for (uint256 n; n < outLen; n++) {
            trimmed[n] = out[n];
        }
        return string(trimmed);
    }

    /// @dev Reads the one `event eventName(...)` declaration in src/interfaces/IEscrow.sol and
    ///      returns it rebuilt, failing if it is missing or if more than one occurrence matches.
    function _declaredEvent(string memory eventName) private view returns (string memory declaration) {
        uint256 declarations;
        (declarations, declaration) =
            _eventDeclarationFromSource(_codeOnly(vm.readFile(IESCROW_SOURCE_PATH)), eventName);
        assertEq(
            declarations,
            1,
            string.concat(
                "expected exactly ONE `event ",
                eventName,
                "(` in ",
                IESCROW_SOURCE_PATH,
                " - zero means it was renamed, removed or moved to another file; more than one means a comment quotes the signature and the guard can no longer tell which text is the declaration"
            )
        );
    }

    function _assertEventDeclarationPinned(string memory eventName, bytes32 expectedDeclarationHash) private view {
        string memory declared = _declaredEvent(eventName);
        assertEq(
            keccak256(bytes(declared)),
            expectedDeclarationHash,
            string.concat(
                "THE `",
                eventName,
                "` EVENT DECLARATION ORDER IN ",
                IESCROW_SOURCE_PATH,
                " HAS DRIFTED FROM THE PINNED DECLARATION. Rebuilt parameter by parameter from that declaration it reads `",
                declared,
                "`, which does not hash to the pinned literal (the canonical string it was derived from is quoted above that literal in this file). A transposed pair of same-type parameters, a moved `indexed`, a renamed, retyped, added or removed parameter all land here - and a same-type transposition lands ONLY here: topic0 is keccak256 of the TYPES-ONLY signature so it does not move, every producer and consumer in this repository is positional so both sides swap together, and `make check-abi` only asks whether the ABI was regenerated. The declaration IS the ABI other repositories decode this log against: shipped transposed, a consumer fills the two commitments swapped, the contract rebuilds an ActiveDeposit that does not hash to the stored one, and the deposit is neither releasable NOR refundable - this escrow has no rescue function. Do NOT repoint the pinned literal to match: re-derive it OUT OF BAND and treat a changed declaration as a breaking change for every deployed indexer."
            )
        );
    }

    function _assertEventTopic0FromDeclaration(string memory eventName, bytes32 expectedTopic0) private view {
        string memory declared = _declaredEvent(eventName);
        string memory signature = _abiSignatureFromEventDeclaration(declared);
        assertEq(
            keccak256(bytes(signature)),
            expectedTopic0,
            string.concat(
                "THE `",
                eventName,
                "` EVENT DECLARATION IN ",
                IESCROW_SOURCE_PATH,
                " NO LONGER PRODUCES THE PINNED topic0. Rebuilt from that declaration it reads `",
                declared,
                "`, whose types-only ABI signature is `",
                signature,
                "`. Deployed indexers filter on the pinned topic0; if this value has to change, that is a breaking change for every one of them."
            )
        );
    }

    // The two commitment parameters of `DepositCommitments` are the reason this whole section
    // exists: they are adjacent, both `bytes32` and both non-indexed, which is the exact shape no
    // other check in the repository can see move.
    function test_depositCommitmentsEventDeclaration_isPinned() public view {
        _assertEventDeclarationPinned("DepositCommitments", DEPOSIT_COMMITMENTS_DECLARATION_HASH);
    }

    function test_depositCommitmentsEventDeclaration_producesPinnedTopic0() public view {
        _assertEventTopic0FromDeclaration("DepositCommitments", DEPOSIT_COMMITMENTS_TOPIC0);
    }

    // `Deposited` carries the same hazard three times over: `settler`/`token` and
    // `reserver`/`releaser` are adjacent non-indexed `address`es, and `amount`/`feeAmount` are
    // adjacent non-indexed `uint256`s. A swap in either address pair or in the amount pair would
    // misprice or misdirect a rebuilt witness with nothing else in the suite noticing, because the
    // tests that assert this log build their expectation from the same declaration, positionally.
    function test_depositedEventDeclaration_isPinned() public view {
        _assertEventDeclarationPinned("Deposited", DEPOSITED_DECLARATION_HASH);
    }

    function test_depositedEventDeclaration_producesPinnedTopic0() public view {
        _assertEventTopic0FromDeclaration("Deposited", DEPOSITED_TOPIC0);
    }

    // `DepositReserved`: `amount` and `feeAmount` are adjacent non-indexed `uint256`s, the charged
    // amount and its fee, which a log-only consumer overlays on the deposit-time tuple.
    function test_depositReservedEventDeclaration_isPinned() public view {
        _assertEventDeclarationPinned("DepositReserved", DEPOSIT_RESERVED_DECLARATION_HASH);
    }

    function test_depositReservedEventDeclaration_producesPinnedTopic0() public view {
        _assertEventTopic0FromDeclaration("DepositReserved", DEPOSIT_RESERVED_TOPIC0);
    }

    // `Released`: `amount` and `feeAmount` are adjacent non-indexed `uint256`s.
    function test_releasedEventDeclaration_isPinned() public view {
        _assertEventDeclarationPinned("Released", RELEASED_DECLARATION_HASH);
    }

    function test_releasedEventDeclaration_producesPinnedTopic0() public view {
        _assertEventTopic0FromDeclaration("Released", RELEASED_TOPIC0);
    }

    // `Refunded` has no adjacent same-type non-indexed pair today (`address token`,
    // `uint256 amount`), so it is not currently exposed. Pinned anyway: the exposure is a property
    // of the parameter list, and a parameter added next to `token` or `amount` tomorrow would
    // create it silently. Pinning the whole declaration means nobody has to redo that analysis.
    function test_refundedEventDeclaration_isPinned() public view {
        _assertEventDeclarationPinned("Refunded", REFUNDED_DECLARATION_HASH);
    }

    function test_refundedEventDeclaration_producesPinnedTopic0() public view {
        _assertEventTopic0FromDeclaration("Refunded", REFUNDED_TOPIC0);
    }

    // The three batch events take struct arrays, so no two of their parameters share a type and the
    // transposition hazard does not reach them today; their declarations are pinned for the same
    // "don't make a future editor redo the analysis" reason as `Refunded`. No topic0 assertion:
    // deriving it would mean expanding `DepositWitness[]`/`ReleaseWitness[]`/`RefundWitness[]` into
    // ABI tuples, and their tuple shapes are already pinned twice over - by the four struct
    // declaration-order guards above, and by Escrow.commitmentEvents.t.sol asserting the topic0s the
    // contract actually emitted against out-of-band literals.
    function test_depositedManyEventDeclaration_isPinned() public view {
        _assertEventDeclarationPinned("DepositedMany", DEPOSITED_MANY_DECLARATION_HASH);
    }

    function test_releasedManyEventDeclaration_isPinned() public view {
        _assertEventDeclarationPinned("ReleasedMany", RELEASED_MANY_DECLARATION_HASH);
    }

    function test_refundedManyEventDeclaration_isPinned() public view {
        _assertEventDeclarationPinned("RefundedMany", REFUNDED_MANY_DECLARATION_HASH);
    }
}
