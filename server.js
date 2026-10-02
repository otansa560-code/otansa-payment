require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const CURRENCY = process.env.CURRENCY || "GHS";

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "payments.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, "[]");
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

function getPayments() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}

function savePayments(payments) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(payments, null, 2));
}

app.post("/api/pay", async (req, res) => {
  try {
    const { name, email, phone, service, amount } = req.body;

    if (!name || !email || !amount) {
      return res.status(400).json({
        message: "Name, email and amount are required."
      });
    }

    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({
        message: "Paystack secret key has not been configured."
      });
    }

    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        message: "Please enter a valid amount."
      });
    }

    const reference = `OTANSA-${Date.now()}-${crypto
      .randomBytes(4)
      .toString("hex")
      .toUpperCase()}`;

    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          amount: Math.round(numericAmount * 100),
          currency: CURRENCY,
          reference,
          callback_url: `${BASE_URL}/success.html`,
          metadata: {
            name,
            phone,
            service
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok || !data.status) {
      return res.status(400).json({
        message: data.message || "Unable to initialize payment."
      });
    }

    const payments = getPayments();

    payments.push({
      reference,
      name,
      email,
      phone: phone || "",
      service: service || "",
      amount: numericAmount,
      currency: CURRENCY,
      status: "pending",
      created_at: new Date().toISOString()
    });

    savePayments(payments);

    res.json({
      authorization_url: data.data.authorization_url,
      reference
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Something went wrong while starting the payment."
    });
  }
});

app.get("/api/verify/:reference", async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({
        message: "Paystack secret key has not been configured."
      });
    }

    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(
        req.params.reference
      )}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const data = await response.json();

    if (!response.ok || !data.status) {
      return res.status(400).json({
        message: data.message || "Unable to verify payment."
      });
    }

    const paymentStatus = data.data.status;

    const payments = getPayments();

    const index = payments.findIndex(
      (payment) => payment.reference === req.params.reference
    );

    if (index !== -1) {
      payments[index].status = paymentStatus;
      payments[index].verified_at = new Date().toISOString();
      savePayments(payments);
    }

    res.json({
      status: paymentStatus,
      reference: req.params.reference,
      amount: data.data.amount / 100,
      currency: data.data.currency
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Unable to verify payment."
    });
  }
});

app.post(
  "/api/paystack/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["x-paystack-signature"];

      if (!signature || !PAYSTACK_SECRET_KEY) {
        return res.sendStatus(401);
      }

      const hash = crypto
        .createHmac("sha512", PAYSTACK_SECRET_KEY)
        .update(req.body)
        .digest("hex");

      if (hash !== signature) {
        return res.sendStatus(401);
      }

      const event = JSON.parse(req.body.toString());

      if (event.event === "charge.success" && event.data) {
        const reference = event.data.reference;

        const payments = getPayments();

        const index = payments.findIndex(
          (payment) => payment.reference === reference
        );

        if (index !== -1) {
          payments[index].status = "success";
          payments[index].paid_at =
            event.data.paid_at || new Date().toISOString();

          savePayments(payments);
        }
      }

      res.sendStatus(200);
    } catch (error) {
      console.error(error);
      res.sendStatus(400);
    }
  }
);

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Otansa Admin"');
    return res.status(401).send("Authentication required.");
  }

  const decoded = Buffer.from(auth.split(" ")[1], "base64")
    .toString("utf8")
    .split(":");

  const username = decoded.shift();
  const password = decoded.join(":");

  if (
    username !== process.env.ADMIN_USER ||
    password !== process.env.ADMIN_PASSWORD
  ) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Otansa Admin"');
    return res.status(401).send("Invalid credentials.");
  }

  next();
}

app.get("/api/admin/payments", requireAdmin, (req, res) => {
  const payments = getPayments();

  const totalReceived = payments
    .filter((payment) => payment.status === "success")
    .reduce((total, payment) => total + Number(payment.amount || 0), 0);

  res.json({
    totalReceived,
    payments: payments.sort(
      (a, b) =>
        new Date(b.created_at).getTime() -
        new Date(a.created_at).getTime()
    )
  });
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Otansa Digital Creations Payment System"
  });
});

app.listen(PORT, () => {
  console.log(`Otansa payment system running on port ${PORT}`);
});
