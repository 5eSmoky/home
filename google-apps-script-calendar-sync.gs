const CONFIG = {
  // Paste Airbnb's exported iCal URL here. Airbnb already imports Vrbo,
  // so this can be the single inbound calendar source.
  AIRBNB_ICAL_URL: "https://www.airbnb.com/calendar/ical/1573531294967079291.ics?t=7ffa0daec1d949fcbc66c9b52f923a2f&locale=en",

  // Paste the Google Calendar ID for approved website/direct-booking holds here.
  // This is the calendar Airbnb will import.
  DIRECT_BOOKING_CALENDAR_ID: "463fc018ad6d0f35a3f2b2c8fbf4a1e5119802b6ac597beac5ca1ed8196cf38f@group.calendar.google.com",

  // Optional: booking request notifications will be emailed here.
  OWNER_EMAIL: "fiveelementssmoky@gmail.com",

  // Stripe secret keys must stay in Apps Script, never in website JavaScript.
  // Use a test key while testing, then replace it with the live secret key.
  STRIPE_SECRET_KEY: "sk_test_51TpTE29eCKmHydxwksNYwiC0hc58GLtuJGBk65qZc2FzF3qxvwaY5T5zrYpEPUuCKGFEHBUSCygBZlVVL6PA8o2p001rEgbWSg",

  // Public website URL, without a trailing slash.
  SITE_URL: "https://fiveelementssmoky.com",

  // Public URL where the website serves price-calendar.js.
  PRICE_CALENDAR_URL: "https://fiveelementssmoky.com/price-calendar.js",

  CLEANING_FEE: 450,
  PET_FEE: 150,
  STR_TAX_RATE: 0.1275,
  MIN_NIGHTS: 3,
};

function doGet(event) {
  const action = event.parameter.action || "availability";

  if (action !== "availability") {
    return jsonResponse({ ok: false, message: "Unknown action." });
  }

  return jsonResponse({
    ok: true,
    blockedDates: getBlockedDates(),
    generatedAt: new Date().toISOString(),
  });
}

function doPost(event) {
  const payload = JSON.parse(event.postData.contents || "{}");

  if (payload.action === "createCheckoutSession") {
    return createCheckoutSession(payload);
  }

  if (payload.action !== "bookingRequest") {
    return jsonResponse({ ok: false, message: "Unknown action." });
  }

  const arrival = payload.arrival;
  const departure = payload.departure;

  if (!arrival || !departure || departure <= arrival) {
    return jsonResponse({ ok: false, message: "Choose valid arrival and departure dates." });
  }

  if (getNightCount(arrival, departure) < CONFIG.MIN_NIGHTS) {
    return jsonResponse({ ok: false, message: `${CONFIG.MIN_NIGHTS}-night minimum. Please choose a longer stay.` });
  }

  const guestCount = Number(payload.guests || 0);
  if (guestCount < 1 || guestCount > 12) {
    return jsonResponse({ ok: false, message: "Choose between 1 and 12 guests." });
  }

  if (rangeTouchesBlockedDate(arrival, departure)) {
    return jsonResponse({ ok: false, message: "Those dates are no longer available." });
  }

  const priceLines = Array.isArray(payload.estimatedPriceLines)
    ? payload.estimatedPriceLines.map((line) => `${line.label}: ${line.value}`)
    : [];
  const description = [
    `Guest email: ${payload.email || "Not provided"}`,
    `Guests: ${payload.guests || "Not provided"} total`,
    `Adults: ${payload.adults || 0}`,
    `Teens: ${payload.teens || 0}`,
    `Children: ${payload.children || 0}`,
    `Pets: ${payload.pets ? "Yes" : "No"}`,
    `Arrival: ${arrival}`,
    `Departure: ${departure}`,
    `Nights: ${payload.estimatedNights || "Not provided"}`,
    "",
    "Price estimate:",
    priceLines.length ? priceLines.join("\n") : "Rate estimate needs confirmation.",
    "",
    "Approval note:",
    "These dates were not blocked automatically. Add an approved hold or booking to the direct-booking calendar before confirming with the guest.",
    "",
    "Guest message:",
    payload.message || "No message.",
  ].join("\n");

  if (CONFIG.OWNER_EMAIL && !CONFIG.OWNER_EMAIL.includes("PASTE_")) {
    MailApp.sendEmail({
      to: CONFIG.OWNER_EMAIL,
      subject: `Five Elements Smoky booking request: ${arrival} to ${departure}`,
      body: description,
    });
  }

  return jsonResponse({
    ok: true,
    message: "Booking request sent for owner approval.",
  });
}

function createCheckoutSession(payload) {
  const arrival = payload.arrival;
  const departure = payload.departure;

  if (!arrival || !departure || departure <= arrival) {
    return jsonResponse({ ok: false, message: "Choose valid arrival and departure dates." });
  }

  if (getNightCount(arrival, departure) < CONFIG.MIN_NIGHTS) {
    return jsonResponse({ ok: false, message: `${CONFIG.MIN_NIGHTS}-night minimum. Please choose a longer stay.` });
  }

  const guestCount = Number(payload.guests || 0);
  if (guestCount < 1 || guestCount > 12) {
    return jsonResponse({ ok: false, message: "Choose between 1 and 12 guests." });
  }

  if (rangeTouchesBlockedDate(arrival, departure)) {
    return jsonResponse({ ok: false, message: "Those dates are no longer available." });
  }

  if (!CONFIG.STRIPE_SECRET_KEY || CONFIG.STRIPE_SECRET_KEY.includes("PASTE_")) {
    return jsonResponse({ ok: false, message: "Stripe is not configured yet." });
  }

  let quote;
  try {
    quote = getServerQuote(arrival, departure, Boolean(payload.pets));
  } catch (error) {
    return jsonResponse({
      ok: false,
      message: "Rates could not be loaded for checkout. Please try again or email us directly.",
    });
  }

  if (quote.missingNights > 0) {
    return jsonResponse({
      ok: false,
      message: `Rate estimate needs confirmation for ${quote.missingNights} night${quote.missingNights === 1 ? "" : "s"}.`,
    });
  }

  const bookingId = Utilities.getUuid();
  const pageUrl = getSafeReturnUrl(payload.pageUrl);
  const priceLines = getQuoteLineItems(quote);
  const sessionPayload = buildStripeSessionPayload({
    bookingId,
    payload,
    quote,
    priceLines,
    successUrl: `${pageUrl}?stripe_checkout=success&booking=${encodeURIComponent(bookingId)}#calendar`,
    cancelUrl: `${pageUrl}?stripe_checkout=canceled#calendar`,
  });

  const stripeResponse = UrlFetchApp.fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "post",
    headers: {
      Authorization: `Bearer ${CONFIG.STRIPE_SECRET_KEY}`,
    },
    payload: sessionPayload,
    muteHttpExceptions: true,
  });
  const responseBody = JSON.parse(stripeResponse.getContentText() || "{}");

  if (stripeResponse.getResponseCode() >= 400 || !responseBody.url) {
    return jsonResponse({
      ok: false,
      message: responseBody.error && responseBody.error.message
        ? responseBody.error.message
        : "Stripe checkout could not be created.",
    });
  }

  sendOwnerCheckoutEmail(payload, quote, priceLines, bookingId, responseBody.id);

  return jsonResponse({
    ok: true,
    checkoutUrl: responseBody.url,
    checkoutSessionId: responseBody.id,
    bookingId,
  });
}

function getBlockedDates() {
  const blocked = {};

  getAirbnbIcalRanges().forEach((range) => {
    addRangeToBlockedMap(blocked, range.start, range.end);
  });

  getDirectCalendarRanges().forEach((range) => {
    addRangeToBlockedMap(blocked, range.start, range.end);
  });

  return Object.keys(blocked).sort();
}

function getServerQuote(arrival, departure, includesPet) {
  const nightlyPrices = getNightlyPrices();
  const nights = expandRange(arrival, departure);
  const nightlyRates = nights.map((date) => ({
    date,
    rate: typeof nightlyPrices[date] === "number" ? nightlyPrices[date] : null,
  }));
  const pricedNights = nightlyRates.filter((night) => night.rate !== null);
  const nightlySubtotal = pricedNights.reduce((sum, night) => sum + night.rate, 0);
  const cleaningFee = nights.length ? CONFIG.CLEANING_FEE : 0;
  const petFee = nights.length && includesPet ? CONFIG.PET_FEE : 0;
  const taxableSubtotal = nightlySubtotal + cleaningFee + petFee;
  const taxAmount = Math.round(taxableSubtotal * CONFIG.STR_TAX_RATE);
  const finalTotal = taxableSubtotal + taxAmount;

  return {
    nights,
    nightlyRates,
    pricedNights,
    nightlySubtotal,
    cleaningFee,
    petFee,
    taxableSubtotal,
    taxAmount,
    finalTotal,
    missingNights: nightlyRates.length - pricedNights.length,
  };
}

function getNightlyPrices() {
  if (!CONFIG.PRICE_CALENDAR_URL || CONFIG.PRICE_CALENDAR_URL.includes("PASTE_")) {
    throw new Error("PRICE_CALENDAR_URL is not configured.");
  }

  const response = UrlFetchApp.fetch(CONFIG.PRICE_CALENDAR_URL, {
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() >= 400) {
    throw new Error("Price calendar could not be fetched.");
  }

  const match = response.getContentText().match(/window\.FES_NIGHTLY_PRICES\s*=\s*(\{[\s\S]*?\});?/);
  if (!match) {
    throw new Error("Price calendar format was not recognized.");
  }

  return JSON.parse(match[1]);
}

function expandRange(arrival, departure) {
  const dates = [];
  let cursor = parseDateKey(arrival);
  const end = parseDateKey(departure);

  while (cursor < end) {
    dates.push(dateToKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

function getNightCount(arrival, departure) {
  return expandRange(arrival, departure).length;
}

function getQuoteLineItems(quote) {
  const items = [
    {
      label: `${quote.nights.length} night${quote.nights.length === 1 ? "" : "s"} lodging`,
      amount: quote.nightlySubtotal,
    },
    {
      label: "Cleaning fee",
      amount: quote.cleaningFee,
    },
  ];

  if (quote.petFee) {
    items.push({
      label: "Pet fee",
      amount: quote.petFee,
    });
  }

  items.push(
    {
      label: `Estimated STR taxes (${formatTaxRate(CONFIG.STR_TAX_RATE)})`,
      amount: quote.taxAmount,
    },
    {
      label: "Estimated total",
      amount: quote.finalTotal,
    },
  );

  return items;
}

function buildStripeSessionPayload(options) {
  const payload = options.payload;
  const quote = options.quote;
  const lineItems = getStripeLineItems(quote);
  const params = {
    mode: "payment",
    success_url: options.successUrl,
    cancel_url: options.cancelUrl,
    client_reference_id: options.bookingId,
    "payment_intent_data[description]": `Five Elements Smoky booking ${payload.arrival} to ${payload.departure}`,
    "metadata[booking_id]": options.bookingId,
    "metadata[arrival]": payload.arrival,
    "metadata[departure]": payload.departure,
    "metadata[nights]": String(quote.nights.length),
    "metadata[guests]": String(payload.guests || ""),
    "metadata[pets]": payload.pets ? "yes" : "no",
    "metadata[email]": payload.email || "",
  };

  if (payload.email) {
    params.customer_email = payload.email;
  }

  lineItems.forEach((item, index) => {
    params[`line_items[${index}][quantity]`] = "1";
    params[`line_items[${index}][price_data][currency]`] = "usd";
    params[`line_items[${index}][price_data][unit_amount]`] = String(item.amount * 100);
    params[`line_items[${index}][price_data][product_data][name]`] = item.label;
  });

  return params;
}

function getStripeLineItems(quote) {
  const items = [
    {
      label: `${quote.nights.length} night${quote.nights.length === 1 ? "" : "s"} lodging`,
      amount: quote.nightlySubtotal,
    },
    {
      label: "Cleaning fee",
      amount: quote.cleaningFee,
    },
  ];

  if (quote.petFee) {
    items.push({
      label: "Pet fee",
      amount: quote.petFee,
    });
  }

  items.push({
    label: `Estimated STR taxes (${formatTaxRate(CONFIG.STR_TAX_RATE)})`,
    amount: quote.taxAmount,
  });

  return items;
}

function sendOwnerCheckoutEmail(payload, quote, priceLines, bookingId, checkoutSessionId) {
  if (!CONFIG.OWNER_EMAIL || CONFIG.OWNER_EMAIL.includes("PASTE_")) {
    return;
  }

  const description = [
    `Booking ID: ${bookingId}`,
    `Stripe Checkout Session: ${checkoutSessionId}`,
    `Guest email: ${payload.email || "Not provided"}`,
    `Guests: ${payload.guests || "Not provided"} total`,
    `Adults: ${payload.adults || 0}`,
    `Teens: ${payload.teens || 0}`,
    `Children: ${payload.children || 0}`,
    `Pets: ${payload.pets ? "Yes" : "No"}`,
    `Arrival: ${payload.arrival}`,
    `Departure: ${payload.departure}`,
    `Nights: ${quote.nights.length}`,
    "",
    "Checkout estimate:",
    priceLines.map((line) => `${line.label}: ${formatPrice(line.amount)}`).join("\n"),
    "",
    "Approval note:",
    "After payment is confirmed in Stripe, add the approved hold or booking to the direct-booking Google Calendar so Airbnb blocks the dates.",
    "",
    "Guest message:",
    payload.message || "No message.",
  ].join("\n");

  MailApp.sendEmail({
    to: CONFIG.OWNER_EMAIL,
    subject: `Five Elements Smoky Stripe checkout started: ${payload.arrival} to ${payload.departure}`,
    body: description,
  });
}

function getSafeReturnUrl(pageUrl) {
  const configuredUrl = CONFIG.SITE_URL && !CONFIG.SITE_URL.includes("PASTE_")
    ? CONFIG.SITE_URL
    : "";
  const fallbackUrl = configuredUrl || "https://fiveelementssmoky.com";

  if (!pageUrl) {
    return fallbackUrl;
  }

  const normalizedPageUrl = String(pageUrl).split("#")[0].split("?")[0].replace(/\/$/, "");
  const normalizedSiteUrl = fallbackUrl.replace(/\/$/, "");

  return normalizedPageUrl.indexOf(normalizedSiteUrl) === 0 ? normalizedPageUrl : normalizedSiteUrl;
}

function formatPrice(amount) {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

function formatTaxRate(rate) {
  return `${(rate * 100).toFixed(2)}%`;
}

function getAirbnbIcalRanges() {
  if (!CONFIG.AIRBNB_ICAL_URL || CONFIG.AIRBNB_ICAL_URL.includes("PASTE_")) {
    return [];
  }

  const response = UrlFetchApp.fetch(CONFIG.AIRBNB_ICAL_URL, {
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() >= 400) {
    throw new Error("Airbnb iCal could not be fetched.");
  }

  return parseIcalRanges(response.getContentText());
}

function getDirectCalendarRanges() {
  const calendar = CalendarApp.getCalendarById(CONFIG.DIRECT_BOOKING_CALENDAR_ID);
  const start = startOfToday();
  const end = new Date(start);
  end.setFullYear(end.getFullYear() + 2);

  return calendar.getEvents(start, end).map((event) => ({
    start: dateToKey(event.getStartTime()),
    end: dateToKey(event.getEndTime()),
  }));
}

function parseIcalRanges(icalText) {
  const unfolded = icalText.replace(/\r?\n[ \t]/g, "");
  const eventBlocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];

  return eventBlocks
    .map((eventBlock) => ({
      start: getIcalDate(eventBlock, "DTSTART"),
      end: getIcalDate(eventBlock, "DTEND"),
    }))
    .filter((range) => range.start && range.end && range.end > range.start);
}

function getIcalDate(eventBlock, fieldName) {
  const match = eventBlock.match(new RegExp(`^${fieldName}(?:;[^:]*)?:(.+)$`, "m"));
  if (!match) return "";

  const rawValue = match[1].trim();
  const dateOnly = rawValue.slice(0, 8);

  return `${dateOnly.slice(0, 4)}-${dateOnly.slice(4, 6)}-${dateOnly.slice(6, 8)}`;
}

function rangeTouchesBlockedDate(arrival, departure) {
  const blocked = getBlockedDates();
  return blocked.some((date) => date >= arrival && date < departure);
}

function addRangeToBlockedMap(blocked, startKey, endKey) {
  let cursor = parseDateKey(startKey);
  const end = parseDateKey(endKey);

  while (cursor < end) {
    blocked[dateToKey(cursor)] = true;
    cursor.setDate(cursor.getDate() + 1);
  }
}

function parseDateKey(key) {
  const parts = key.split("-").map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function dateToKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
