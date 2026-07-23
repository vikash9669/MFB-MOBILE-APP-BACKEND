// (Re)seeds demo data for a delivery partner into the store_delivery_* tables.
//
//   npm run seed:delivery -- <phone>     # seed partner by 10-digit phone
//   npm run seed:delivery                # seed the dev partner (9999999999)
//
// Creates the partner row if it doesn't exist yet, then force-provisions a full
// set of demo orders, shifts, documents, wallet txns, and notifications.
const sequelize = require("../util/database");
const { DeliveryPartner } = require("../models");
const { provisionDemoData } = require("../util/deliveryDemo");
const { generateUserCode } = require("../util/user");

const phone = process.argv[2] || "9999999999";

async function seed() {
  // Ensure the tables exist before writing to them.
  await sequelize.sync({ logging: false });

  const [partner] = await DeliveryPartner.findOrCreate({
    where: { dp_phone: phone },
    defaults: {
      dp_phone: phone,
      dp_name: "",
      dp_email: "",
      dp_code: generateUserCode(12),
      dp_settings: {},
    },
  });

  const result = await provisionDemoData(partner, { force: true });
  console.log(
    `Seeded delivery partner +91${phone} (dp_id=${partner.dp_id}) — ${result.orders} orders.`
  );
}

seed()
  .then(() => sequelize.close())
  .catch(async (err) => {
    console.error("Delivery seed failed:", err);
    await sequelize.close();
    process.exit(1);
  });
