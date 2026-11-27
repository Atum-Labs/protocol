// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

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

/// @notice Mock token without TIP-2612 permit functionality for testing error cases
contract MockToken6DecimalsTransferReturnsFalse is ERC20, Ownable, IMintable {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) Ownable(msg.sender) {}

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        super.transfer(to, amount);
        return false;
    }
}

/// @notice A token whose `transfer` returns WITHOUT moving any balance.
/// @dev Models the one outcome `Escrow._usdtTransfer`'s balance-delta check exists to catch: a call
/// that neither reverts nor moves funds. No known USDT build behaves this way — Tron USDT moves the
/// balance and returns false, and its failures revert — but a token upgrade could introduce it, and
/// the consequence is a deposit marked settled with the tokens still in the escrow and no rescue
/// function. Returns `false` like the real thing, so the test proves the guard is measuring the
/// BALANCE rather than reading the return value.
contract MockTokenTransferNoOp is ERC20, Ownable, IMintable {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) Ownable(msg.sender) {}

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }
}

/// @notice A token that delivers LESS than it is asked to transfer, and returns false like Tron USDT.
/// @dev Models fee-on-transfer. TetherToken carries an owner-settable transfer fee that is currently
/// zero, and the escrow's allowlist is checked at configuration time rather than per transfer — so a
/// token can acquire a fee after being allowlisted. `Escrow._deposit`'s balance-delta check is what
/// stops the shortfall being covered out of other depositors' pooled funds.
contract MockTokenSkimming is ERC20, Ownable, IMintable {
    uint256 public immutable i_skimBasisPoints;

    constructor(string memory name, string memory symbol, uint256 skimBasisPoints)
        ERC20(name, symbol)
        Ownable(msg.sender)
    {
        i_skimBasisPoints = skimBasisPoints;
    }

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 skim = (amount * i_skimBasisPoints) / 10_000;
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount - skim);
        _transfer(from, owner(), skim);
        // TRUE, unlike this file's USDT stand-in: the quirk is on `transfer`, and the caller here is
        // Permit2, whose SafeTransferLib rejects a falsy return before the escrow ever sees the
        // tokens. Returning false would make these tests fail inside Permit2 rather than at the
        // guard under test.
        return true;
    }
}

/// @notice A token that delivers MORE than it is asked to transfer.
/// @dev The reason `Escrow._deposit` checks EQUALITY rather than `>=`: an over-delivery leaves dust
/// in the pooled balance that no witness accounts for and no release or refund can move.
contract MockTokenInflating is ERC20, Ownable, IMintable {
    uint256 public immutable i_bonus;

    constructor(string memory name, string memory symbol, uint256 bonus) ERC20(name, symbol) Ownable(msg.sender) {
        i_bonus = bonus;
    }

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount);
        _mint(to, i_bonus);
        // TRUE, for the same reason as MockTokenSkimming: Permit2 is the caller.
        return true;
    }
}
