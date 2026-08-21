const getUser = async (req, res) => {
  try {
    res.json(req.user);
  } catch (error) {
    console.log("MFB-error-logs ~ profile ~ err:", error);
    res.status(400).json({ message: "Could not load your profile" });
  }
};

module.exports = {
  getUser,
};
