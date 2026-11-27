// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

contract MockTokenCustomDecimals is ERC20, Ownable, IMintable {
    uint8 private _decimals;

    constructor(string memory name, string memory symbol, uint8 tokenDecimals) ERC20(name, symbol) Ownable(msg.sender) {
        _decimals = tokenDecimals;
    }

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}

contract MockToken is ERC20, Ownable, IMintable {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) Ownable(msg.sender) {}

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }
}

contract MockToken2Decimals is ERC20, Ownable, IMintable {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) Ownable(msg.sender) {}

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 2;
    }
}

/// @notice Mock token without EIP-2612 permit functionality for testing error cases
contract MockToken6Decimals is ERC20, Ownable, IMintable {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) Ownable(msg.sender) {}

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract MockToken8Decimals is ERC20, Ownable, IMintable {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) Ownable(msg.sender) {}

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 8;
    }
}

/// @notice DANGEROUS: Token with fallback that returns malicious decimals
/// @dev Creates a minimal ERC20-like contract without inheriting OpenZeppelin's ERC20
contract MaliciousTokenWithFallback is IMintable {
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;
    uint256 private _totalSupply;
    string private _name;
    string private _symbol;
    uint8 private s_fakeDecimals;
    address public owner;

    constructor(string memory n, string memory s, uint8 fakeDecimals) {
        _name = n;
        _symbol = s;
        s_fakeDecimals = fakeDecimals;
        owner = msg.sender;
    }

    // Basic ERC20 functions
    function name() public view returns (string memory) {
        return _name;
    }

    function symbol() public view returns (string memory) {
        return _symbol;
    }

    function totalSupply() public view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) public view returns (uint256) {
        return _balances[account];
    }

    function transfer(address to, uint256 amount) public returns (bool) {
        _balances[msg.sender] -= amount;
        _balances[to] += amount;
        return true;
    }

    function allowance(address owner_, address spender) public view returns (uint256) {
        return _allowances[owner_][spender];
    }

    function approve(address spender, uint256 amount) public returns (bool) {
        _allowances[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        _allowances[from][msg.sender] -= amount;
        _balances[from] -= amount;
        _balances[to] += amount;
        return true;
    }

    function mint(address to, uint256 amount) public {
        require(msg.sender == owner, "Only owner");
        _balances[to] += amount;
        _totalSupply += amount;
    }

    // NO decimals() function implemented - deliberately missing!

    /// @notice Malicious fallback that returns fake decimals when decimals() is called
    fallback(bytes calldata) external payable returns (bytes memory) {
        // Check if the call was for decimals() selector: 0x313ce567
        if (msg.data.length >= 4 && bytes4(msg.data) == 0x313ce567) {
            // Return fake decimals encoded as uint8
            return abi.encode(s_fakeDecimals);
        }
        // For other calls, revert
        revert("Function not supported");
    }

    // receive function
    receive() external payable {}
}

/// @notice Token without decimals() and no fallback - should revert cleanly
contract TokenWithoutDecimalsNoFallback {
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;
    uint256 private _totalSupply;
    string private _name;
    string private _symbol;
    address public owner;

    constructor(string memory n, string memory s) {
        _name = n;
        _symbol = s;
        owner = msg.sender;
    }

    // Basic ERC20 functions
    function name() public view returns (string memory) {
        return _name;
    }

    function symbol() public view returns (string memory) {
        return _symbol;
    }

    function totalSupply() public view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) public view returns (uint256) {
        return _balances[account];
    }

    function transfer(address to, uint256 amount) public returns (bool) {
        _balances[msg.sender] -= amount;
        _balances[to] += amount;
        return true;
    }

    function allowance(address owner_, address spender) public view returns (uint256) {
        return _allowances[owner_][spender];
    }

    function approve(address spender, uint256 amount) public returns (bool) {
        _allowances[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        _allowances[from][msg.sender] -= amount;
        _balances[from] -= amount;
        _balances[to] += amount;
        return true;
    }

    function mint(address to, uint256 amount) public {
        require(msg.sender == owner, "Only owner");
        _balances[to] += amount;
        _totalSupply += amount;
    }

    // NO decimals() function implemented
    // NO fallback function - should revert cleanly
}

/// @notice Minimal view onto the escrow's booked fee revenue, so a mock token can read it from
/// inside a transfer without the mock file taking a dependency on the full ITokenConfig surface.
/// @dev The selector matches ITokenConfig.getFeeRevenue(IERC20): contract types canonicalise to
/// `address` in a function signature.
interface IFeeRevenueView {
    function getFeeRevenue(address token) external view returns (uint256 revenue);
}

/// @notice Fee-on-transfer ("skimming") token: the recipient receives strictly LESS than the amount
/// the transfer was asked to move, while the sender is still debited in full. This is exactly the
/// shape USDT takes if its owner ever raises `basisPointsRate` above its current zero, and both the
/// EVM and TVM escrows name USDT as a supported token.
/// @dev The skim is deliberately observable without the escrow in the picture, so
/// test_skimmingToken_shortDelivers can prove the mock really short-delivers. Without that proof a
/// passing NonExactTransfer test would be worthless -- it would pass identically against a mock
/// that silently behaved like a plain ERC20 and reverted for some unrelated reason.
contract SkimmingToken is ERC20, Ownable, IMintable {
    /// @notice Fee removed from every transfer, in basis points of the requested amount
    uint256 public immutable i_feeBasisPoints;
    /// @notice Where the skim lands. Anywhere but the recipient, so the recipient comes up short.
    address public constant FEE_SINK = address(uint160(0xFEE5));

    constructor(string memory name, string memory symbol, uint256 feeBasisPoints)
        ERC20(name, symbol)
        Ownable(msg.sender)
    {
        i_feeBasisPoints = feeBasisPoints;
    }

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        // Mints and burns route through _update as well; only genuine transfers are skimmed.
        if (from == address(0) || to == address(0) || i_feeBasisPoints == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * i_feeBasisPoints) / 10_000;
        super._update(from, FEE_SINK, fee);
        super._update(from, to, value - fee);
    }
}

/// @notice A token that delivers exactly on its first transfer and skims on every transfer after.
/// @dev Exists to pin the balance snapshot to a PER-DEPOSIT window. A single snapshot hoisted
/// outside the depositMany loop would compare one aggregate delta against the last item's source
/// amount, so it cannot tell which item short-delivered; this token makes the first item honest and
/// the second one short, and the assertion names the second item's amounts.
contract SkimsAfterFirstTransferToken is ERC20, Ownable, IMintable {
    /// @notice Fee removed from the second and every subsequent transfer, in basis points
    uint256 public constant FEE_BASIS_POINTS = 100; // 1%
    address public constant FEE_SINK = address(uint160(0xFEE6));

    /// @notice Count of genuine transfers so far (mints and burns are not counted)
    uint256 public s_transferCount;

    constructor(string memory name, string memory symbol) ERC20(name, symbol) Ownable(msg.sender) {}

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        s_transferCount++;
        if (s_transferCount == 1) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * FEE_BASIS_POINTS) / 10_000;
        super._update(from, FEE_SINK, fee);
        super._update(from, to, value - fee);
    }
}

/// @notice A token that over-delivers: the recipient receives MORE than the transfer asked to move.
/// @dev The mirror image of SkimmingToken, and the reason the escrow's received-amount guard is an
/// equality rather than a `>=`. A `>=` check accepts this token, and the surplus becomes pool dust
/// that no release or refund witness can ever account for.
contract InflatingToken is ERC20, Ownable, IMintable {
    /// @notice Extra units minted to the recipient on every transfer
    uint256 public immutable i_bonus;

    constructor(string memory name, string memory symbol, uint256 bonus) ERC20(name, symbol) Ownable(msg.sender) {
        i_bonus = bonus;
    }

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        super._update(from, to, value);
        // Mint the bonus straight to the recipient, so the recipient's balance moves by more than
        // `value` while the sender is debited exactly `value`.
        super._update(address(0), to, i_bonus);
    }
}

/// @notice A plain ERC20 that, whenever the escrow pushes tokens OUT, records the escrow's booked
/// fee revenue at that instant.
/// @dev Used to assert Checks-Effects-Interactions on the release path: the fee accrual must
/// already be in storage by the time the outbound transfer hands control to the token. Only the
/// push leg (`transfer`, called by the escrow) is observed -- the deposit pull runs through
/// `transferFrom` from Permit2 and is left alone.
contract FeeRevenueObserverToken is ERC20, Ownable, IMintable {
    /// @notice The escrow whose accounting is observed
    address public s_escrow;
    /// @notice Fee revenue booked for this token at the moment of the escrow's outbound transfer
    uint256 public s_feeRevenueDuringTransfer;
    /// @notice True once an outbound transfer from the escrow has been observed
    bool public s_observed;

    constructor(string memory name, string memory symbol) ERC20(name, symbol) Ownable(msg.sender) {}

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    function setEscrow(address escrow) external onlyOwner {
        s_escrow = escrow;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (s_escrow != address(0) && msg.sender == s_escrow) {
            s_feeRevenueDuringTransfer = IFeeRevenueView(s_escrow).getFeeRevenue(address(this));
            s_observed = true;
        }
        return super.transfer(to, value);
    }
}
