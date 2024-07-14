// const { phoneNumber } = require("../constants/regex");
const jwt = require("jsonwebtoken");
const User = require("../models/user");
const { generateOtp } = require("../util/auth");
const { generateUserCode } = require("../util/user");

const sendOtp = async (phoneNumber, otp) => {
  const apiUrl = "https://www.bulksmsplans.com/api/send_sms";
  const apiId = process.env.SMS_SERVICE_API_ID; // Your API Id
  const apiPassword = process.env.SMS_SERVICE_PASSWORD; // Your API Password
  const smsType = "OTP"; // SMS Type
  const smsEncoding = 1; // SMS Encoding (1 for Text)
  const senderId = process.env.SMS_SERVICE_SENDER_ID; // Your Sender ID

  const message = `Welcome to My First Bite. ${otp} is your OTP.Do not share this OTP with anyone.`;

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_id: apiId,
        api_password: apiPassword,
        sms_type: smsType,
        sms_encoding: smsEncoding,
        sender: senderId,
        number: phoneNumber,
        message: message,
        template_id: 151011,
      }),
    });

    const data = await response.json();
    console.log("Response from BulkSMSPlans:", data);

    console.log(data);
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
      const otp = generateOtp();
      await sendOtp(phone_number, otp);
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
