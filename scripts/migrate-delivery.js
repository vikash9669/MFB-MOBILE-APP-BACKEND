// Creates / updates every delivery-partner table (all store_delivery_*),
// keeping the delivery collections separate from the customer app's tables.
// The main app runs sequelize.sync() WITHOUT alter, so new columns / tables
// aren't applied automatically — run this once after pulling model changes:
//   npm run migrate:delivery
const sequelize = require("../util/database");
const {
  DeliveryPartner,
  DeliveryOrder,
  DeliveryOrderEvent,
  DeliveryWalletTxn,
  DeliveryShift,
  DeliveryDocument,
  DeliveryNotification,
  DeliveryDevice,
} = require("../models");

async function migrate() {
  // Order matters only loosely (no hard FKs across delivery tables), but sync
  // the partner table first for readability.
  await DeliveryPartner.sync({ alter: true });
  await DeliveryOrder.sync({ alter: true });
  await DeliveryOrderEvent.sync({ alter: true });
  await DeliveryWalletTxn.sync({ alter: true });
  await DeliveryShift.sync({ alter: true });
  await DeliveryDocument.sync({ alter: true });
  await DeliveryNotification.sync({ alter: true });
  await DeliveryDevice.sync({ alter: true });
  console.log("Delivery collections (store_delivery_*) are up to date.");
}

migrate()
  .then(() => sequelize.close())
  .catch(async (err) => {
    console.error("Delivery migration failed:", err);
    await sequelize.close();
    process.exit(1);
  });
