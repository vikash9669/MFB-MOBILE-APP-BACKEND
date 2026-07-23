const express = require("express");
const sequelize = require("./util/database");
require("./models");
require("./server");

const app = express();
const authRoutes = require("./routes/auth");
const productRoutes = require("./routes/products");
const userRoutes = require("./routes/users");
const addressRoutes = require("./routes/address");
const bannerRoutes = require("./routes/banner");
const deliveryAuthRoutes = require("./routes/deliveryAuth");
const deliveryRoutes = require("./routes/delivery");

app.use(express.json({ limit: "6mb" }));

app.use("/auth", authRoutes);
// Public partner auth first, then the token-guarded partner APIs. Keep this
// order so /delivery/auth/* isn't captured by the protected /delivery router.
app.use("/delivery/auth", deliveryAuthRoutes);
app.use("/delivery", deliveryRoutes);
app.use("/", productRoutes);
app.use("/user", userRoutes);
app.use("/", addressRoutes);
app.use("/banners", bannerRoutes);

sequelize
  .sync({ logging: false })
  .then(async () => {
    app.listen(8080);
  })
  .catch((err) => {
    console.log(err);
  });
