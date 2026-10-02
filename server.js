require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 10000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const BASE_URL =
  process.env.BASE_URL || `http://localhost:${PORT}`;
const CURRENCY = process.env.CURRENCY || "GHS";

const DATA_DIR = path.join(__dirname, "data");
const PAYMENTS_FILE = path.join(DATA_DIR, "payments.json");

// --------------------------------------------------
// Create data folder/file if they do not exist
// --------------------------------------------------

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(PAYMENTS_FILE)) {
  fs.writeFileSync(PAYMENTS_FILE, "[]");
}

// --------------------------------------------------
// Helper functions
// --------------------------------------------------

function getPayments() {
  try {
    return JSON.parse(fs.readFileSync(PAYMENTS_FILE, "utf8"));
  } catch (error) {
    console.error("Could not read payments file:", error);
    return [];
  }
}

function savePayments(payments) {
  fs.writeFileSync(
    PAYMENTS_FILE,
    JSON.stringify(payments, null, 2)
  );
}

function addPayment(payment) {
  const payments = getPayments();

  const existingIndex = payments.findIndex(
    (item) => item.reference === payment.reference
  );

  if (existingIndex >= 0) {
    payments[existingIndex] = {
      ...payments[existingIndex],
      ...payment
    };
  } else {
    payments.push(payment);
  }

  savePayments(payments);
}

// --------------------------------------------------
// Middleware
// --------------------------------------------------

app.use(express.json());

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(express.static(path.join(__dirname, "public")));

// --------------------------------------------------
// Basic Admin Authentication
// --------------------------------------------------

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Otansa Admin"');
    return res.status(401).send("Authentication required.");
  }

  const encoded = authHeader.split(" ")[1];

  let decoded;

  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch (error) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Otansa Admin"');
    return res.status(401).send("Invalid authentication.");
  }

  const separatorIndex = decoded.indexOf(":");

  if (separatorIndex === -1) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Otansa Admin"');
    return res.status(401).send("Invalid authentication.");
  }

  const username = decoded.substring(0, separatorIndex);
  const password = decoded.substring(separatorIndex + 1);

  if (
    username !== ADMIN_USER ||
    password !== ADMIN_PASSWORD
  ) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Otansa Admin"');
    return res.status(401).send("Incorrect username or password.");
  }

  next();
}

// --------------------------------------------------
// Home Page
// --------------------------------------------------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --------------------------------------------------
// Start Payment
// --------------------------------------------------

app.post("/api/pay", async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({
        message: "Paystack secret key has not been configured."
      });
    }

    const {
      name,
      email,
      phone,
      service,
      amount
    } = req.body;

    // Basic validation
    if (!name || !email || !amount) {
      return res.status(400).json({
        message: "Name, email and amount are required."
      });
    }

    const numericAmount = Number(amount);

    if (
      !Number.isFinite(numericAmount) ||
      numericAmount <= 0
    ) {
      return res.status(400).json({
        message: "Please enter a valid payment amount."
      });
    }

    // Paystack uses the smallest currency unit.
    // For GHS, this is pesewas.
    const amountInPesewas = Math.round(numericAmount * 100);

    const reference =
      "OTANSA_" +
      Date.now() +
      "_" +
      crypto.randomBytes(4).toString("hex");

    const payload = {
      email,
      amount: amountInPesewas,
      currency: CURRENCY,
      reference,
      callback_url: `${BASE_URL}/success.html`,

      // Save customer information with the Paystack transaction
      metadata: {
        name: name || "",
        phone: phone || "",
        service: service || ""
      }
    };

    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const data = await response.json();

    if (!response.ok || !data.status) {
      console.error("Paystack initialization error:", data);

      return res.status(400).json({
        message:
          data.message ||
          "Unable to initialize payment."
      });
    }

    // Save initial payment record
    addPayment({
      reference,
      name,
      email,
      phone,
      service,
      amount: numericAmount,
      currency: CURRENCY,
      status: "pending",
      created_at: new Date().toISOString()
    });

    return res.json({
      status: true,
      authorization_url: data.data.authorization_url,
      reference: data.data.reference
    });
  } catch (error) {
    console.error("Payment initialization error:", error);

    return res.status(500).json({
      message: "Something went wrong while starting payment."
    });
  }
});

// --------------------------------------------------
// Verify Payment
// --------------------------------------------------

app.get("/api/verify/:reference", async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({
        message: "Paystack secret key has not been configured."
      });
    }

    const reference = req.params.reference;

    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(
        reference
      )}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const data = await response.json();

    if (!response.ok || !data.status) {
      return res.status(400).json({
        message:
          data.message ||
          "Unable to verify payment."
      });
    }

    const transaction = data.data;

    const metadata = transaction.metadata || {};

    // Save/update payment locally as well
    addPayment({
      reference: transaction.reference,
      name:
        metadata.name ||
        transaction.customer?.first_name ||
        "",
      email:
        transaction.customer?.email ||
        "",
      phone:
        metadata.phone ||
        transaction.customer?.phone ||
        "",
      service: metadata.service || "",
      amount: Number(transaction.amount || 0) / 100,
      currency: transaction.currency || CURRENCY,
      status: transaction.status,
      created_at:
        transaction.paid_at ||
        transaction.created_at ||
        new Date().toISOString()
    });

    return res.json({
      status: true,
      payment: {
        reference: transaction.reference,
        status: transaction.status,
        amount:
          Number(transaction.amount || 0) / 100,
        currency: transaction.currency,
        email:
          transaction.customer?.email || ""
      }
    });
  } catch (error) {
    console.error("Payment verification error:", error);

    return res.status(500).json({
      message: "Unable to verify payment."
    });
  }
});

// --------------------------------------------------
// Paystack Webhook
// --------------------------------------------------

app.post(
  "/api/paystack/webhook",
  (req, res) => {
    try {
      const signature =
        req.headers["x-paystack-signature"];

      if (!signature) {
        return res.status(401).send("Missing signature.");
      }

      const hash = crypto
        .createHmac("sha512", PAYSTACK_SECRET_KEY)
        .update(JSON.stringify(req.body))
        .digest("hex");

      if (hash !== signature) {
        return res.status(401).send("Invalid signature.");
      }

      const event = req.body;

      console.log(
        "Paystack webhook received:",
        event.event
      );

      // Successful payment
      if (
        event.event === "charge.success" &&
        event.data
      ) {
        const transaction = event.data;
        const metadata = transaction.metadata || {};

        addPayment({
          reference: transaction.reference,
          name:
            metadata.name ||
            transaction.customer?.first_name ||
            "",
          email:
            transaction.customer?.email ||
            "",
          phone:
            metadata.phone ||
            transaction.customer?.phone ||
            "",
          service: metadata.service || "",
          amount:
            Number(transaction.amount || 0) / 100,
          currency:
            transaction.currency || CURRENCY,
          status: transaction.status,
          created_at:
            transaction.paid_at ||
            transaction.created_at ||
            new Date().toISOString()
        });
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error("Webhook error:", error);
      return res.sendStatus(500);
    }
  }
);

// --------------------------------------------------
// ADMIN - Get Payments Directly From Paystack
// --------------------------------------------------

app.get(
  "/api/admin/payments",
  requireAdmin,
  async (req, res) => {
    try {
      if (!PAYSTACK_SECRET_KEY) {
        return res.status(500).json({
          message:
            "Paystack secret key has not been configured."
        });
      }

      /*
       * Get successful transactions directly from Paystack.
       * This avoids relying on Render's temporary filesystem.
       */

      const response = await fetch(
        "https://api.paystack.co/transaction?status=success&perPage=100&page=1",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
          }
        }
      );

      const data = await response.json();

      if (!response.ok || !data.status) {
        console.error(
          "Paystack transaction list error:",
          data
        );

        return res.status(500).json({
          message:
            data.message ||
            "Unable to load Paystack transactions."
        });
      }

      const transactions = data.data || [];

      const payments = transactions.map(
        (transaction) => {
          const metadata =
            transaction.metadata || {};

          return {
            reference:
              transaction.reference || "",
            name:
              metadata.name ||
              transaction.customer?.first_name ||
              "",
            email:
              transaction.customer?.email ||
              "",
            phone:
              metadata.phone ||
              transaction.customer?.phone ||
              "",
            service:
              metadata.service || "",
            amount:
              Number(transaction.amount || 0) / 100,
            currency:
              transaction.currency || CURRENCY,
            status:
              transaction.status || "success",
            created_at:
              transaction.paid_at ||
              transaction.created_at ||
              new Date().toISOString()
          };
        }
      );

      const totalReceived =
        payments.reduce(
          (total, payment) =>
            total +
            Number(payment.amount || 0),
          0
        );

      return res.json({
        totalReceived,
        payments
      });
    } catch (error) {
      console.error(
        "Admin payment error:",
        error
      );

      return res.status(500).json({
        message:
          "Unable to load payments."
      });
    }
  }
);

// --------------------------------------------------
// Admin Page
// --------------------------------------------------

app.get("/admin", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "admin.html")
  );
});

// --------------------------------------------------
// Health Check
// --------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Otansa Payment System"
  });
});

// --------------------------------------------------
// Start Server
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `Otansa payment system running on port ${PORT}`
  );
});
