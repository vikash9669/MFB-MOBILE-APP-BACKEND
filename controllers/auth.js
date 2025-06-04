// const { phoneNumber } = require("../constants/regex");
const jwt = require("jsonwebtoken");
const User = require("../models/user");
const { generateUserCode } = require("../util/user");
const { StoreOrders, Address, Location } = require("../models");
// const { transporter } = require("../util/email");

const sendOtp = async (phoneNumber, createUser = false) => {
  const apiUrl = "https://auth.otpless.app/auth/v1/initiate/otp";
  // const apiId = process.env.SMS_SERVICE_API_ID; // Your API Id
  // const apiPassword = process.env.SMS_SERVICE_PASSWORD; // Your API Password
  // const smsType = "OTP"; // SMS Type
  // const smsEncoding = 1; // SMS Encoding (1 for Text)
  // const senderId = process.env.SMS_SERVICE_SENDER_ID; // Your Sender ID

  // const message = `Welcome to My First Bite. ${otp} is your OTP.Do not share this OTP with anyone.`;

  const options = {
    method: "POST",
    headers: {
      clientId: process.env.OTPLESS_CLIENT_ID,
      clientSecret: process.env.OTPLESS_CLIENT_SECRET,
      "Content-Type": "application/json",
    },
    body: `{"phoneNumber":"+91${phoneNumber}","expiry":600,"otpLength":6,"channels":["SMS"]}`,
  };

  try {
    const response = await fetch(apiUrl, options);

    const data = await response.json();

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

    // send otp to vipul

    // await transporter.sendMail({
    //   from: process.env.EMAIL_USER, // sender address
    //   to: "Vipulgoyal.nbh@gmail.com", // list of receivers
    //   subject: `New Login`, // Subject line
    //   text: `Phone number: ${phoneNumber}, OTP: ${otp}`, // plain text body
    // });

    return data;
  } catch (error) {
    console.error("Error sending OTP:", error);
    throw error;
  }
};

exports.getOtp = async (req, res) => {
  try {
    const { phone_number } = req.body;
    const user = await User.findOne({
      where: {
        user_phone: phone_number,
      },
    });
    if (user != null) {
      await sendOtp(phone_number, false);
      res.json({
        message: "OTP sent successfully",
      });
      return;
    }
    await sendOtp(phone_number, true);
    res.json({
      message: "OTP sent successfully",
    });
  } catch (err) {
    console.log("MFB-error-logs ~ exports.getOtp= ~ err:", err);
    res.status(500).json({ message: "Otp sending failed", err });
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
    const { phone_number } = req.body;
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
    if (user != null) {
      // const apiUrl = "https://auth.otpless.app/auth/v1/verify/otp";
      // const options = {
      //   method: "POST",
      //   headers: {
      //     clientId: process.env.OTPLESS_CLIENT_ID,
      //     clientSecret: process.env.OTPLESS_CLIENT_SECRET,
      //     "Content-Type": "application/json",
      //   },
      //   body: `{"requestId":"${user.user_password}","otp":"${user_otp}"}`,
      // };

      // const response = await fetch(apiUrl, options);
      // const data = await response.json();

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
      // await transporter.sendMail({
      //   from: process.env.EMAIL_USER, // sender address
      //   to: "Vipulgoyal.nbh@gmail.com", // list of receivers
      //   subject: `Login Successful`, // Subject line
      //   text: `Phone number: ${user_phone}`, // plain text body
      // });
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
      return;
    } else {
      await User.create({
        user_phone: phone_number,
        user_name: "",
        user_email: "",
        user_password: "",
        user_code: generateUserCode(12),
        user_phone_1: "",
        user_landmark: "",
        user_otp: "",
        // need to check below three fields
        user_city: "101",
        user_state: 29,
        user_zip: "312601",
      });
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
      const { user_id, user_name, user_email, user_phone, user_phone_1 } = user;
      const userObject = {
        lastOrderAddress: undefined,
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
      return;
    }
  } catch (err) {
    console.log("MFB-error-logs ~ exports.verifyOtp= ~ err:", err);
    res.status(500).json({ message: "Otp verification failed", err });
  }
};
