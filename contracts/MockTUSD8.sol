// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal 6-decimal ERC-20 used ONLY as a stand-in for tUSD8 in tests.
///         On Aevum Testnet the real tUSD8 (0x456569838f1d43009A91ebA4263147Afd7233483)
///         is used instead; this mock is never deployed to testnet.
contract MockTUSD8 is ERC20 {
    constructor() ERC20("Mock tUSD8", "tUSD8") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
