const express = require("express");
const sequelize = require("./util/database");
require("./models");

const app = express();
const authRoutes = require("./routes/auth");
const productRoutes = require("./routes/products");
const orderRoutes = require("./routes/users");
const addressRoutes = require("./routes/address");

app.use(express.json());

app.use("/auth", authRoutes);
app.use("/", productRoutes);
app.use("/user", orderRoutes);
app.use("/", addressRoutes);

sequelize
  .sync({ logging: false })
  .then(async () => {
    app.listen(3000);
  })
  .catch((err) => {
    console.log(err);
  });
