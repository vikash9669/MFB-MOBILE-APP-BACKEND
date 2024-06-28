// const { phoneNumber } = require("../constants/regex");
const User = require("../models/user");
const { generateOtp } = require("../util/auth");
const { generateUserCode } = require("../util/user");


exports.getOtp = async (req, res) => {
  const { phone_number, user_name, user_email, user_password, user_landmark } = req.body;

  try {
    let user = await User.findOne({
      where: { user_phone: phone_number },
    });

    const otp = generateOtp();

    if (user) {
      await User.update(
        { user_otp: otp },
        {
          where: { user_phone: phone_number },
        }
      );
      res.json({ message: "OTP sent successfully" });
    } else {
      user = await User.create({
        user_phone: phone_number,
        user_name,
        user_email,
        user_otp: otp,
        user_code: generateUserCode(12),
        user_phone_1: "",
        user_landmark,
        user_password,
        user_city: "101",
        user_state: 29,
        user_zip: "312601",
      });
      res.json({ user });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


exports.updateUser = async (req, res) => {
  const { user_id } = req.params;
  const { user_name, user_email, user_password } = req.body;

  try {
    const [updated] = await User.update(
      { user_name, user_email, user_password },
      {
        where: { user_id },
      }
    );

    if (updated) {
      const updatedUser = await User.findByPk(user_id);
      res.status(200).json({ user: updatedUser });
    } else {
      throw new Error('User not found');
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};