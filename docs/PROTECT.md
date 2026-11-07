# Protect my loan (Mezo Testnet)

## Verified contract operations

The openTrove transaction supplied for discovery is
[`0x3ef7f0ce860647e798f7f8e3b9c4146ba36aad69238e46b37098e0bbf8b075f1`](https://explorer.test.mezo.org/tx/0x3ef7f0ce860647e798f7f8e3b9c4146ba36aad69238e46b37098e0bbf8b075f1).
It calls the BorrowerOperations proxy at
[`0xCdF7028ceAB81fA0C6971208e83fa7872994beE5`](https://explorer.test.mezo.org/address/0xCdF7028ceAB81fA0C6971208e83fa7872994beE5),
whose implementation was verified by the Mezo explorer as
[`0xc05Bf344BD5b58825784326dD3112fB6cC160dcC`](https://explorer.test.mezo.org/address/0xc05Bf344BD5b58825784326dD3112fB6cC160dcC).
The explorer API reports the implementation as fully verified.

The verified operations are:

```solidity
addColl(address _upperHint, address _lowerHint) external payable;
repayMUSD(uint256 _amount, address _upperHint, address _lowerHint) external;
```

`addColl` uses `msg.sender` as borrower and forwards `msg.value` as collateral.
`repayMUSD` uses `msg.sender` as borrower and caller; it is nonpayable and the
MUSD amount is in the token's base units (18 decimals on the deployed token).
Both operations update the trove's position in `SortedTroves`.

### Hints

The verified SortedTroves implementation exposes
`findInsertPosition(uint256 _NICR, address _prevId, address _nextId)`. The plan
builder computes the post-operation nominal collateral ratio using the
verified implementation's `NICR_PRECISION = 1e20`, then requests a position
with zero/zero starting hints. The sorted-list implementation descends the
list when both hints are zero, and its insertion routine searches again if
the supplied position is no longer valid. The transaction is additionally
simulated from the protected account before calldata is returned.

### Repayment restrictions and approval behavior

The verified source calculates net debt as total debt less
`MUSD_GAS_COMPENSATION`, which is `200e18` MUSD. A repayment must not exceed
that net debt and must leave at least the current `minNetDebt`. The
`MIN_NET_DEBT_MIN` protocol floor is `50e18`; `minNetDebt` is governance
adjustable. Its initializer sets it to `1800e18`, and the deployed testnet
view returned 1,800 MUSD when checked on 2026-11-04. The plan reads its current
value each time rather than relying on that observed value. The contract also
requires the caller's MUSD balance to cover the repayment.

**No MUSD approval transaction is needed or requested.** In the verified
BorrowerOperations implementation, repayment calls `musd.burn(_account,
principal + interest)` for the caller's account; it does not call
`transferFrom` and does not use allowance. Requesting an approval would be an
unnecessary permission, and would contradict the deployed implementation.
Repayment is therefore one user-reviewed transaction, not an approval-plus-
repayment sequence.

The source checks the trove is active, rejects zero adjustments, enforces
collateral/debt constraints and checks the caller's MUSD balance. Other
current protocol rules (including recovery-mode and sorted-list rules) are
enforced by simulating the exact planned call. Revert reasons known from the
verified source are mapped to plain-language messages. A failed simulation
does not return transaction calldata.

## Safety and limitations

- Mezo **TESTNET only** (chain ID 31611). Do not use this tool as a mainnet
  transaction interface.
- MUSD Guardian never handles private keys or seed phrases. It does not sign
  transactions; the connected wallet displays and signs the transaction.
- The server builds and simulates a plan and estimates gas. State, fees,
  oracle prices, and sorted-trove hints can change before a transaction is
  mined. Estimates are not guarantees.
- The contracts, dashboard, and transaction builder have **not been audited**.
  Verify the target, function, amount, and network in your wallet before
  signing. This is not financial advice.
- If an RPC call, gas estimate, or receipt lookup is unavailable, the UI
  reports a safe fallback or continues polling; after three minutes it points
  to the explorer rather than waiting indefinitely.

## Manual wallet test checklist

Use a test wallet and a testnet account with an active trove. Never enter a
private key or seed phrase into MUSD Guardian.

1. Open a protected active-trove detail card. Confirm the panel is absent for
   an inactive address.
2. Connect a different account and confirm the mismatch prevents planning.
3. Switch to a non-Mezo network. Confirm the panel offers a user-clicked
   switch/add action and does not build a plan until chain 31611 is selected.
4. Build a small collateral plan. Review the decoded `addColl` call, BTC
   value, before/after metrics, gas estimate, and target contract in the wallet.
   Reject once and confirm the friendly rejection message.
5. Build a repay plan. Confirm the panel explains that no allowance is used
   and only the single `repayMUSD` transaction is offered.
6. Submit a test transaction and confirm the UI shows the hash, receipt state,
   and explorer link, then refreshes the health card after confirmation.
7. Leave a transaction pending and confirm polling stops after about three
   minutes with an explorer-check message.
