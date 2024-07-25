const express = require("express");
const sequelize = require("./util/database");
require("./models");
require("./server");

const app = express();
const authRoutes = require("./routes/auth");
const productRoutes = require("./routes/products");
const userRoutes = require("./routes/users");
const addressRoutes = require("./routes/address");

app.use(express.json());

app.use("/auth", authRoutes);
app.use("/", productRoutes);
app.use("/user", userRoutes);
app.use("/", addressRoutes);

sequelize
  .sync({ logging: false })
  .then(async () => {
    app.listen(8080);
  })
  .catch((err) => {
    console.log(err);
  });
