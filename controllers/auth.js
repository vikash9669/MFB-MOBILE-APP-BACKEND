const jwt = require("jsonwebtoken");
const User = require("../models/user");
const { generateUserCode } = require("../util/user");
const { StoreOrders, Address, Location } = require("../models");
const { initiateOtp, verifyOtp } = require("../util/otp");

// Sends the OTP via OTPless over the requested channel and stores the returned
// requestId on the user (in user_password) so verifyOtp can replay it.
const sendOtp = async (phoneNumber, channel, createUser = false) => {
  const data = await initiateOtp(phoneNumber, channel);

  if (createUser === true) {
    await User.create({
      user_phone: phoneNumber,
      user_name: "",
      user_email: "",
      user_password: data.requestId,
      user_code: generateUserCode(12),
      user_phone_1: "",
      user_landmark: "",
      user_otp: "",
      // need to check below three fields
      user_city: "101",
      user_state: 29,
      user_zip: "312601",
    });
  } else {
    await User.update(
      { user_password: data.requestId },
      {
        where: { user_phone: phoneNumber },
      }
    );
  }

  return data;
};

exports.getOtp = async (req, res) => {
  try {
    const { phone_number, channel } = req.body;
    const user = await User.findOne({
      where: {
        user_phone: phone_number,
      },
    });
    if (user != null) {
      await sendOtp(phone_number, channel, false);
      res.json({
        message: "OTP sent successfully",
      });
      return;
    }
    await sendOtp(phone_number, channel, true);
    res.json({
      message: "OTP sent successfully",
    });
  } catch (err) {
    console.log("MFB-error-logs ~ exports.getOtp= ~ err:", err);
    res.status(500).json({ message: "Otp sending failed" });
  }
};

exports.updateUser = async (req, res) => {
  const { user_id } = req.user;
  const { user_name, user_email, user_phone, user_phone_1 } = req.body;

  try {
    await User.update(
      { user_name, user_email, user_phone, user_phone_1 },
      {
        where: { user_id },
      }
    );

    const updatedUser = await User.findByPk(user_id);
    res.status(200).json({ user: updatedUser });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.verifyOtp = async (req, res) => {
  try {
    const { phone_number, user_otp } = req.body;
    const user = await User.findOne({
      where: {
        user_phone: phone_number,
      },
      attributes: [
        "user_password",
        "user_id",
        "user_name",
        "user_email",
        "user_phone",
        "user_phone_1",
      ],
    });

    // The user row (and its requestId) is created by getOtp, so a missing user
    // means no OTP was ever requested for this number.
    if (user == null || !user.user_password) {
      res.status(400).json({ message: "Please request an OTP first" });
      return;
    }

    const { verified } = await verifyOtp(phone_number, user.user_password, user_otp);
    if (!verified) {
      res.status(401).json({ message: "Invalid or expired OTP" });
      return;
    }

    const { user_id, user_name, user_email, user_phone, user_phone_1 } = user;
    const lastOrder = await StoreOrders.findOne({
      where: {
        customer_id: user.user_id,
      },
      order: [["order_received_time", "DESC"]],
      attributes: ["order_id"],
      include: [
        {
          model: Address,
          as: "address",
          include: [
            {
              model: Location,
              as: "location",
            },
          ],
        },
      ],
    });
    const userObject = {
      lastOrderAddress: lastOrder?.address,
      user_id,
      user_name,
      user_email,
      user_phone,
      user_phone_1,
    };
    const token = jwt.sign(userObject, process.env.JWT_SECRET_KEY, {
      expiresIn: "365d",
    });
    res.json({
      message: "OTP verified successfully",
      token,
      user: userObject,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ exports.verifyOtp= ~ err:", err);
    res.status(500).json({ message: "Otp verification failed" });
  }
};
