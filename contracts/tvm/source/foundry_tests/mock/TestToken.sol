// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title TestToken
 * @dev Simple mintable ERC20 token for testing purposes
 * Anyone can mint tokens to avoid permission complexity
 */
contract TestToken is ERC20 {
    uint8 private _decimals;

    constructor(string memory name, string memory symbol, uint8 tokenDecimals) ERC20(name, symbol) {
        _decimals = tokenDecimals;
    }

    /**
     * @dev Returns the number of decimals used to get its user representation.
     */
    function decimals() public view virtual override returns (uint8) {
        return _decimals;
    }

    /**
     * @dev Mint tokens to any address - open for testing
     * @param to Address to mint tokens to
     * @param amount Amount of tokens to mint
     */
    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }

    /**
     * @dev Burn tokens from any address - open for testing
     * @param from Address to burn tokens from
     * @param amount Amount of tokens to burn
     */
    function burn(address from, uint256 amount) public {
        _burn(from, amount);
    }

    /**
     * @dev Approve spender on behalf of any owner - for testing only
     * @param owner Address of the token owner
     * @param spender Address of the spender
     * @param amount Amount to approve
     */
    function approveFor(address owner, address spender, uint256 amount) public {
        _approve(owner, spender, amount);
    }
}
