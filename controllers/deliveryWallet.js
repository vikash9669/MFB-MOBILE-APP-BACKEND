const { fn, col } = require("sequelize");
const { DeliveryWalletTxn, DeliveryPartner } = require("../models");
const { num, serializeTxn, recordWalletTxn } = require("../util/delivery");
const { notifyPartner } = require("../util/deliveryNotify");

// GET /delivery/wallet — balance, pending settlement, cash to deposit, txns.
exports.getWallet = async (req, res) => {
  try {
    const dpId = req.user.dp_id;
    const partner = await DeliveryPartner.findByPk(dpId);
    if (partner == null) {
      return res.status(404).json({ message: "Partner not found" });
    }

    const pendingRows = await DeliveryWalletTxn.findAll({
      where: { dp_id: dpId, status: "pending", direction: "credit" },
      attributes: [[fn("COALESCE", fn("SUM", col("amount")), 0), "pending"]],
      raw: true,
    });

    const txns = await DeliveryWalletTxn.findAll({
      where: { dp_id: dpId },
      order: [["created_at", "DESC"]],
      limit: 25,
    });

    res.json({
      balance: num(partner.dp_wallet_balance),
      pending_settlement: num(pendingRows[0]?.pending),
      cash_to_deposit: num(partner.dp_cash_in_hand),
      transactions: txns.map(serializeTxn),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getWallet ~ err:", err);
    res.status(500).json({ message: "Failed to load wallet", err });
  }
};

// POST /delivery/wallet/withdraw — move the requested amount out of the wallet.
exports.withdraw = async (req, res) => {
  try {
    const dpId = req.user.dp_id;
    const partner = await DeliveryPartner.findByPk(dpId);
    if (partner == null) {
      return res.status(404).json({ message: "Partner not found" });
    }

    // Default to a full withdrawal when no amount is supplied.
    const balance = num(partner.dp_wallet_balance);
    const amount = req.body.amount != null ? num(req.body.amount) : balance;

    if (amount <= 0) {
      return res.status(400).json({ message: "Enter a valid amount" });
    }
    if (amount > balance) {
      return res.status(400).json({ message: "Amount exceeds available balance" });
    }

    await recordWalletTxn(dpId, {
      type: "withdrawal",
      direction: "debit",
      amount,
      title: "Bank withdrawal",
      description: req.body.account ? `Sent to ${req.body.account}` : "Withdrawal to bank",
      status: "settled",
    });

    await partner.reload();

    await notifyPartner(dpId, {
      category: "payments",
      icon: "account_balance",
      title: `Payout of ₹${amount} initiated`,
      body: req.body.account ? `Sent to ${req.body.account}` : "Transfer to your bank is on the way.",
      data: { type: "withdrawal" },
    });

    res.json({
      message: "Withdrawal requested",
      amount,
      balance: num(partner.dp_wallet_balance),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery withdraw ~ err:", err);
    res.status(500).json({ message: "Failed to process withdrawal", err });
  }
};
