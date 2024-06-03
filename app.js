const express = require("express");

const sequelize = require("./util/database");
require("./models");

const app = express();
const authRoutes = require("./routes/auth");
app.use(express.json());

app.use("/auth", authRoutes);

sequelize
  .sync({ logging: false })
  .then(async () => {
    app.listen(3000);
  })
  .catch((err) => {
    console.log(err);
  });
