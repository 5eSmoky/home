function initBookingCalendar() {
const fallbackBlockedDates = [
  "2026-07-04",
  "2026-07-05",
  "2026-07-12",
  "2026-07-13",
  "2026-07-19",
  "2026-07-20",
  "2026-08-01",
  "2026-08-02",
  "2026-08-15",
  "2026-08-16",
  "2026-08-29",
  "2026-08-30",
];

const calendarConfig = window.FES_CALENDAR_CONFIG || {};
const nightlyPrices = window.FES_NIGHTLY_PRICES || {};
const blockedDates = new Set(fallbackBlockedDates);

const monthLabel = document.querySelector("[data-month-label]");
const daysGrid = document.querySelector("[data-calendar-days]");
const calendarStatus = document.querySelector("[data-calendar-status]");
const prevButton = document.querySelector("[data-prev-month]");
const nextButton = document.querySelector("[data-next-month]");
const arrivalInput = document.querySelector("#arrival");
const departureInput = document.querySelector("#departure");
const form = document.querySelector(".booking-form");
const formNote = document.querySelector("[data-form-note]");
const bookingPanel = document.querySelector("[data-booking-panel]");
const selectedRangeLabel = document.querySelector("[data-selected-range]");
const selectedPriceLabel = document.querySelector("[data-selected-price]");
const guestCountFields = document.querySelectorAll("[data-guest-count]");
const petField = document.querySelector("[data-pet-field]");
const heroVideo = document.querySelector(".hero-media");
const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const CLEANING_FEE = 450;
const PET_FEE = 150;
const STR_TAX_RATE = 0.1275;
const MIN_NIGHTS = 3;

const today = new Date();
let visibleMonth = new Date(today.getFullYear(), today.getMonth(), 1);
let selectedDates = [];
let availabilityLoaded = false;

const checkoutParams = new URLSearchParams(window.location.search);
const checkoutStatus = checkoutParams.get("stripe_checkout");
const checkoutBookingId = checkoutParams.get("booking");

if (heroVideo) {
  const startTime = Number(heroVideo.dataset.startTime || 0);

  const skipOpeningTitle = () => {
    if (startTime > 0 && heroVideo.currentTime < startTime) {
      heroVideo.currentTime = startTime;
    }
  };

  heroVideo.addEventListener("loadedmetadata", skipOpeningTitle);
  heroVideo.addEventListener("timeupdate", () => {
    if (startTime > 0 && heroVideo.currentTime < startTime - 0.25) {
      skipOpeningTitle();
    }
  });
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function fromDateKey(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date, days) {
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() + days);
  return nextDate;
}

function expandRange(startKey, endKey) {
  const dates = [];
  let cursor = fromDateKey(startKey);
  const end = fromDateKey(endKey);

  while (cursor < end) {
    dates.push(toDateKey(cursor));
    cursor = addDays(cursor, 1);
  }

  return dates;
}

function hasBlockedNight(arrival, departure) {
  return expandRange(arrival, departure).some((date) => blockedDates.has(date));
}

function getNightCount(arrival, departure) {
  return expandRange(arrival, departure).length;
}

function getNightlyPrice(key) {
  const price = nightlyPrices[key];
  return typeof price === "number" && Number.isFinite(price) ? price : null;
}

function formatPrice(amount) {
  return currencyFormatter.format(amount);
}

function formatTaxRate(rate) {
  return `${(rate * 100).toFixed(2)}%`;
}

function hasPetSelected(source) {
  if (source instanceof FormData) {
    return source.get("pets") === "yes";
  }

  return Boolean(petField?.checked);
}

function getGuestCounts(formData) {
  const adults = Number(formData.get("adults") || 0);
  const teens = Number(formData.get("teens") || 0);
  const children = Number(formData.get("children") || 0);
  const total = adults + teens + children;

  return { adults, teens, children, total };
}

function getRangeQuote(arrival, departure, options = {}) {
  const includesPet = Boolean(options.includesPet);
  const nights = expandRange(arrival, departure);
  const nightlyRates = nights.map((date) => ({
    date,
    rate: getNightlyPrice(date),
  }));
  const pricedNights = nightlyRates.filter((night) => night.rate !== null);
  const nightlySubtotal = pricedNights.reduce((sum, night) => sum + night.rate, 0);
  const cleaningFee = nights.length ? CLEANING_FEE : 0;
  const petFee = nights.length && includesPet ? PET_FEE : 0;
  const taxableSubtotal = nightlySubtotal + cleaningFee + petFee;
  const taxAmount = Math.round(taxableSubtotal * STR_TAX_RATE);
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

function getQuoteLineItems(quote) {
  const feeLines = [
    { label: "Cleaning fee", value: formatPrice(quote.cleaningFee) },
  ];

  if (quote.petFee) {
    feeLines.push({ label: "Pet fee", value: formatPrice(quote.petFee) });
  }

  return [
    {
      label: `${quote.nights.length} night${quote.nights.length === 1 ? "" : "s"} lodging`,
      value: formatPrice(quote.nightlySubtotal),
    },
    ...feeLines,
    {
      label: `Estimated STR taxes (${formatTaxRate(STR_TAX_RATE)})`,
      value: formatPrice(quote.taxAmount),
    },
    { label: "Estimated total", value: formatPrice(quote.finalTotal), isTotal: true },
  ];
}

function renderRangeQuote(arrival, departure) {
  const quote = getRangeQuote(arrival, departure, { includesPet: hasPetSelected() });

  if (!quote.nights.length) {
    selectedPriceLabel.textContent = "Choose a checkout date after arrival.";
    return;
  }

  if (quote.nights.length < MIN_NIGHTS) {
    selectedPriceLabel.textContent = `${MIN_NIGHTS}-night minimum. Please choose a longer stay.`;
    return;
  }

  if (quote.missingNights > 0) {
    selectedPriceLabel.textContent = `${quote.nights.length} nights selected. Rate estimate needs confirmation for ${quote.missingNights} night${quote.missingNights === 1 ? "" : "s"} before fees and taxes can be finalized.`;
    return;
  }

  selectedPriceLabel.innerHTML = "";

  const list = document.createElement("dl");
  list.className = "price-breakdown";

  getQuoteLineItems(quote).forEach((line) => {
    const label = document.createElement("dt");
    const value = document.createElement("dd");

    label.textContent = line.label;
    value.textContent = line.value;

    if (line.isTotal) {
      label.className = "price-total";
      value.className = "price-total";
    }

    list.append(label, value);
  });

  selectedPriceLabel.appendChild(list);
}

function formatMonth(date) {
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
  }).format(date);
}

function formatDateKey(key) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(fromDateKey(key));
}

function updateBookingRequestPanel({ reveal = false } = {}) {
  if (!bookingPanel || !selectedRangeLabel) return;

  const hasRange = Boolean(arrivalInput.value && departureInput.value);
  bookingPanel.hidden = !hasRange;

  if (!hasRange) {
    selectedRangeLabel.textContent = "Selected dates";
    if (selectedPriceLabel) {
      selectedPriceLabel.textContent = "Nightly estimate appears after dates are selected.";
    }
    return;
  }

  selectedRangeLabel.textContent = `${formatDateKey(arrivalInput.value)} to ${formatDateKey(departureInput.value)}`;
  if (selectedPriceLabel) {
    renderRangeQuote(arrivalInput.value, departureInput.value);
  }

  if (reveal) {
    bookingPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function setCalendarStatus(message, tone = "muted") {
  if (!calendarStatus) return;

  calendarStatus.textContent = message;
  calendarStatus.dataset.tone = tone;
}

function showCheckoutReturnStatus() {
  if (checkoutStatus === "success") {
    const bookingReference = checkoutBookingId ? ` Reference: ${checkoutBookingId}.` : "";
    setCalendarStatus(`Payment received through Stripe.${bookingReference} We will confirm your stay by email.`, "success");
    return;
  }

  if (checkoutStatus === "canceled") {
    setCalendarStatus("Stripe checkout was canceled. Your dates were not held.", "warning");
  }
}

function renderCalendar() {
  daysGrid.innerHTML = "";
  monthLabel.textContent = formatMonth(visibleMonth);

  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const totalDays = new Date(year, month + 1, 0).getDate();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  for (let index = 0; index < firstDay; index += 1) {
    const spacer = document.createElement("span");
    spacer.className = "day empty";
    daysGrid.appendChild(spacer);
  }

  for (let dayNumber = 1; dayNumber <= totalDays; dayNumber += 1) {
    const date = new Date(year, month, dayNumber);
    const key = toDateKey(date);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "day";
    button.dataset.date = key;

    const dayLabel = document.createElement("span");
    dayLabel.className = "day-number";
    dayLabel.textContent = dayNumber;
    button.appendChild(dayLabel);

    if (date < startOfToday || blockedDates.has(key)) {
      button.classList.add("blocked");
      button.disabled = true;
    }

    if (selectedDates.includes(key)) {
      button.classList.add("selected");
    }

    const nightlyPrice = getNightlyPrice(key);
    if (nightlyPrice !== null && date >= startOfToday && !blockedDates.has(key)) {
      const priceLabel = document.createElement("span");
      priceLabel.className = "day-price";
      priceLabel.textContent = formatPrice(nightlyPrice);
      button.appendChild(priceLabel);
    }

    button.addEventListener("click", () => selectDate(key));
    daysGrid.appendChild(button);
  }
}

function selectDate(key) {
  if (selectedDates.length >= 2) {
    selectedDates = [];
  }

  selectedDates.push(key);
  selectedDates.sort();

  if (selectedDates[0]) {
    arrivalInput.value = selectedDates[0];
  }

  if (selectedDates[1]) {
    departureInput.value = selectedDates[1];
  } else {
    departureInput.value = "";
  }

  renderCalendar();
  updateBookingRequestPanel({ reveal: selectedDates.length === 2 });
}

function syncCalendarToInput() {
  selectedDates = [arrivalInput.value, departureInput.value].filter(Boolean);
  const firstSelected = selectedDates[0] ? fromDateKey(selectedDates[0]) : visibleMonth;
  visibleMonth = new Date(firstSelected.getFullYear(), firstSelected.getMonth(), 1);
  renderCalendar();
  updateBookingRequestPanel();
}

async function loadAvailability() {
  if (!calendarConfig.apiUrl || calendarConfig.apiUrl.includes("PASTE_")) {
    console.debug("Availability calendar is not configured.");
    setCalendarStatus("Calendar is temporarily unavailable. Please email us for availability.", "warning");
    renderCalendar();
    return;
  }

  console.debug("Loading availability calendar.");
  setCalendarStatus("Loading calendar...");

  try {
    const response = await fetch(`${calendarConfig.apiUrl}?action=availability`, {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Availability request failed with ${response.status}`);
    }

    const data = await response.json();
    blockedDates.clear();

    (data.blockedDates || []).forEach((date) => blockedDates.add(date));
    availabilityLoaded = true;

    console.debug("Availability calendar loaded.", {
      unavailableNightCount: blockedDates.size,
      generatedAt: data.generatedAt,
    });
    setCalendarStatus("Select your dates.", "success");
    renderCalendar();
  } catch (error) {
    console.debug("Availability calendar failed to load.", error);
    setCalendarStatus("Calendar is temporarily unavailable. Please refresh or email us for availability.", "warning");
    renderCalendar();
  }
}

async function sendBookingRequest(formData) {
  const guestCounts = getGuestCounts(formData);
  const quote = getRangeQuote(formData.get("arrival"), formData.get("departure"), {
    includesPet: hasPetSelected(formData),
  });
  const estimatedPriceLines = quote.missingNights ? [] : getQuoteLineItems(quote).map((line) => ({
    label: line.label,
    value: line.value,
  }));

  const response = await fetch(calendarConfig.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
    },
    body: JSON.stringify({
      action: "createCheckoutSession",
      arrival: formData.get("arrival"),
      departure: formData.get("departure"),
      adults: guestCounts.adults,
      teens: guestCounts.teens,
      children: guestCounts.children,
      guests: guestCounts.total,
      pets: hasPetSelected(formData),
      email: formData.get("email"),
      message: formData.get("message"),
      estimatedNights: quote.nights.length,
      estimatedNightlySubtotal: quote.missingNights ? null : quote.nightlySubtotal,
      cleaningFee: quote.cleaningFee,
      petFee: quote.petFee,
      estimatedTaxRate: STR_TAX_RATE,
      estimatedTaxAmount: quote.missingNights ? null : quote.taxAmount,
      estimatedSubtotal: quote.missingNights ? null : quote.taxableSubtotal,
      estimatedTotal: quote.missingNights ? null : quote.finalTotal,
      estimatedMissingRates: quote.missingNights,
      estimatedPriceLines,
      pageUrl: window.location.href.split("#")[0].split("?")[0],
    }),
  });

  if (!response.ok) {
    throw new Error(`Booking request failed with ${response.status}`);
  }

  return response.json();
}

prevButton.addEventListener("click", () => {
  visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1);
  renderCalendar();
});

nextButton.addEventListener("click", () => {
  visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1);
  renderCalendar();
});

arrivalInput.addEventListener("change", syncCalendarToInput);
departureInput.addEventListener("change", syncCalendarToInput);
guestCountFields.forEach((field) => {
  field.addEventListener("change", updateBookingRequestPanel);
});
petField?.addEventListener("change", updateBookingRequestPanel);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const arrival = formData.get("arrival");
  const departure = formData.get("departure");
  const guestCounts = getGuestCounts(formData);

  if (!arrival || !departure) {
    formNote.textContent = "Choose arrival and departure dates before sending your request.";
    return;
  }

  if (departure <= arrival) {
    formNote.textContent = "Departure needs to be after arrival.";
    return;
  }

  if (getNightCount(arrival, departure) < MIN_NIGHTS) {
    formNote.textContent = `${MIN_NIGHTS}-night minimum. Please choose a longer stay.`;
    return;
  }

  if (hasBlockedNight(arrival, departure)) {
    formNote.textContent = "Those dates include an unavailable night. Please choose another range.";
    return;
  }

  if (guestCounts.total < 1) {
    formNote.textContent = "Add at least one guest before sending your request.";
    return;
  }

  if (guestCounts.total > 12) {
    formNote.textContent = "This home sleeps up to 12 guests. Please reduce the guest count.";
    return;
  }

  if (!calendarConfig.apiUrl || calendarConfig.apiUrl.includes("PASTE_")) {
    formNote.textContent = "Calendar connection is not configured yet. Paste your Apps Script URL into calendar-config.js.";
    return;
  }

  formNote.textContent = availabilityLoaded
    ? "Rechecking availability and preparing secure checkout..."
    : "Checking availability and preparing secure checkout...";

  try {
    const result = await sendBookingRequest(formData);

    if (!result.ok) {
      formNote.textContent = result.message || "Those dates are no longer available.";
      await loadAvailability();
      return;
    }

    if (result.checkoutUrl) {
      formNote.textContent = "Redirecting to Stripe secure checkout...";
      window.location.assign(result.checkoutUrl);
      return;
    }

    form.reset();
    selectedDates = [];
    renderCalendar();
    updateBookingRequestPanel();
    setCalendarStatus("Request received. Dates stay available until checkout is completed.", "success");
    formNote.textContent = "Request received. We will email you after the owner approves or declines the stay.";
  } catch (error) {
    formNote.textContent = "Something went wrong while preparing checkout. Please try again or email us directly.";
  }
});

renderCalendar();
loadAvailability().then(showCheckoutReturnStatus);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initBookingCalendar);
} else {
  initBookingCalendar();
}
