// const { phoneNumber } = require("../constants/regex");
const jwt = require("jsonwebtoken");
const User = require("../models/user");
const { generateOtp } = require("../util/auth");
const { generateUserCode } = require("../util/user");

exports.getOtp = async (req, res) => {
  try {
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
      return;
    }
    const otp = generateOtp();
    const newUser = await User.create({
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
      user: newUser,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ exports.getOtp= ~ err:", err);
    res.status(500).json({ message: "Otp sending failed", err });
  }
};

exports.updateUser = async (req, res) => {
  const { user_id } = req.user;
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
      throw new Error("User not found");
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.verifyOtp = async (req, res) => {
  try {
    const { phone_number, user_otp } = req.body;
    console.log("MFB-logs ~ exports.verifyOtp= ~ user_otp:", user_otp);
    console.log("MFB-logs ~ exports.verifyOtp= ~ phone_number:", phone_number);
    const user = await User.findOne({
      where: {
        user_phone: phone_number,
      },
    });
    if (user != null) {
      if (user.user_otp === user_otp) {
        const token = jwt.sign(user.toJSON(), process.env.JWT_SECRET_KEY, {
          expiresIn: "365d",
        });
        res.json({
          message: "OTP verified successfully",
          token,
          user,
        });
        return;
      }
    }
  } catch (err) {
    console.log("MFB-error-logs ~ exports.verifyOtp= ~ err:", err);
    res.status(500).json({ message: "Otp verification failed", err });
  }
};
