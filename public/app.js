const form = document.getElementById("paymentForm");
const button = document.getElementById("payButton");
const message = document.getElementById("message");

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  button.disabled = true;
  button.textContent = "PROCESSING...";
  message.textContent = "";

  const payment = {
    name: document.getElementById("name").value.trim(),
    email: document.getElementById("email").value.trim(),
    phone: document.getElementById("phone").value.trim(),
    service: document.getElementById("service").value.trim(),
    amount: document.getElementById("amount").value
  };

  try {
    const response = await fetch("/api/pay", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payment)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Unable to start payment.");
    }

    window.location.href = data.authorization_url;
  } catch (error) {
    message.textContent = error.message;
    message.className = "error";

    button.disabled = false;
    button.textContent = "PAY NOW";
  }
});
