async function xyz() {
  const response = await fetch(
    `https://mfb-mobile-app-backend.onrender.com/restaurant`
  );
  await response.json();
}

setInterval(async () => {
  await xyz();
}, 90 * 1000);
