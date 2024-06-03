// const { phoneNumber } = require("../constants/regex");
const User = require("../models/user");
const { generateOtp } = require("../util/auth");
const { generateUserCode } = require("../util/user");

exports.getOtp = async (req, res) => {
  const { phone_number } = req.body;
  const user = await User.findOne({
    where: {
      user_phone: phone_number,
    },
  });
  if (user != null) {
    const otp = generateOtp();
    await User.update(
      { user_otp: otp },
      {
        where: { user_phone: phone_number },
      }
    );
    res.json({
      message: "OTP sent successfully",
    });
  } else {
    const otp = generateOtp();
    const user = await User.create({
      user_phone: phone_number,
      user_name: "",
      user_email: "",
      user_otp: otp,
      user_code: generateUserCode(12),
      user_phone_1: "",
      user_landmark: "",
      user_password: "",
      // need to check below three fields
      user_city: "101",
      user_state: 29,
      user_zip: "312601",
    });
    res.json({
      user,
    });
  }
};
