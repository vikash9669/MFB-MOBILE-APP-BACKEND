const jwt = require("jsonwebtoken");

exports.verifyToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res
      .status(401)
      .json({ message: "Access Denied: No Token Provided!" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
    req.user = decoded;
    next();
  } catch (error) {
    console.log("MFB-error-logs ~ error:", error);
    return res.status(403).json({ message: "Invalid Token" });
  }
};

// Guards the delivery-partner APIs: the access token must carry the
// delivery_partner role and a dp_id. Use after verifyToken.
exports.requirePartner = (req, res, next) => {
  if (req.user?.role !== "delivery_partner" || req.user?.dp_id == null) {
    return res.status(403).json({ message: "Delivery partner access only" });
  }
  next();
};
