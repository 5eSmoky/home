import { createTruviBooking, normalizeTruviWebhook } from "./truvi.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), request, env);
      const url = new URL(request.url);

      let response;
      if (request.method === "GET" && url.pathname === "/availability") response = await proxyAvailability(env);
      else if (request.method === "POST" && url.pathname === "/requests") response = await createRequest(request, env);
      else if (request.method === "POST" && url.pathname === "/webhooks/truvi") response = await handleTruviWebhook(request, env);
      else if (request.method === "POST" && url.pathname === "/webhooks/stripe") response = await handleStripeWebhook(request, env);
      else if (request.method === "GET" && url.pathname === "/owner/review") response = await showOwnerReview(url, env);
      else if (request.method === "POST" && url.pathname === "/owner/decision") response = await ownerDecision(request, env);
      else response = json({ ok: false, message: "Not found." }, 404);

      return cors(response, request, env);
    } catch (error) {
      console.error(error);
      return cors(json({ ok: false, message: "The booking service could not complete that request." }, 500), request, env);
    }
  },
};

async function createRequest(request, env) {
  requireAllowedOrigin(request, env);
  const body = await request.json();
  validateRequest(body, env);
  await verifyTurnstile(body.turnstileToken, request.headers.get("CF-Connecting-IP"), env);

  const availability = await fetchAvailability(env);
  if (rangeBlocked(body.arrival, body.departure, availability.blockedDates || [])) {
    return json({ ok: false, message: "Those dates are no longer available." }, 409);
  }

  const quoteCents = await calculateQuote(body.arrival, body.departure, Boolean(body.pets), env);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const booking = {
    id,
    arrival: body.arrival,
    departure: body.departure,
    guestName: clean(body.guestName, 120),
    email: clean(body.email, 254).toLowerCase(),
    phone: clean(body.phone, 40),
    adults: Number(body.adults),
    teens: Number(body.teens),
    children: Number(body.children),
    guests: Number(body.guests),
    pets: Boolean(body.pets),
    message: clean(body.message, 2000),
    quoteCents,
  };

  await env.DB.prepare(`INSERT INTO booking_requests
    (id,status,created_at,updated_at,arrival,departure,guest_name,email,phone,adults,teens,children,guests,pets,message,quote_cents,verification_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, "verification_pending", now, now, booking.arrival, booking.departure, booking.guestName,
      booking.email, booking.phone, booking.adults, booking.teens, booking.children, booking.guests,
      booking.pets ? 1 : 0, booking.message, quoteCents, "pending").run();

  const verificationMode = env.VERIFICATION_MODE || "disabled";
  if (verificationMode === "disabled") {
    const token = randomToken();
    const expires = new Date(Date.now() + 48 * 3600000).toISOString();
    await env.DB.prepare("UPDATE booking_requests SET status='owner_review',verification_status='not_enabled',owner_token_hash=?,owner_token_expires_at=?,updated_at=? WHERE id=?")
      .bind(await sha256(token), expires, now, id).run();
    const unverifiedBooking = {
      ...booking,
      guest_name: booking.guestName,
      quote_cents: booking.quoteCents,
      verification_status: "not_enabled",
      verification_report_url: "",
    };
    try {
      await sendOwnerReviewEmail(unverifiedBooking, token, env);
    } catch (error) {
      await env.DB.prepare("UPDATE booking_requests SET status='notification_error',last_error=?,updated_at=? WHERE id=?")
        .bind(String(error.message || error), new Date().toISOString(), id).run();
      throw error;
    }
    await sendEmail(booking.email, "Stay request received", `Thanks, ${booking.guestName}. Your request is awaiting owner review. No payment has been taken.`, env)
      .catch((error) => console.error("Guest request email failed", error));
    return json({ ok: true, requestId: id, message: "Request sent for owner review." });
  }

  if (verificationMode !== "truvi") {
    throw new Error("VERIFICATION_MODE must be either disabled or truvi.");
  }

  try {
    const verification = await createTruviBooking(env, booking);
    await env.DB.prepare(`UPDATE booking_requests SET verification_id=?,verification_url=?,verification_report_url=?,verification_status=?,updated_at=? WHERE id=?`)
      .bind(verification.id, verification.verificationUrl, verification.reportUrl, verification.status, now, id).run();
    return json({ ok: true, requestId: id, verificationUrl: verification.verificationUrl });
  } catch (error) {
    await env.DB.prepare("UPDATE booking_requests SET status='verification_error',last_error=?,updated_at=? WHERE id=?")
      .bind(String(error.message || error), now, id).run();
    throw error;
  }
}

async function handleTruviWebhook(request, env) {
  const supplied = request.headers.get("x-webhook-secret") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!env.TRUVI_WEBHOOK_SECRET || !safeEqual(supplied, env.TRUVI_WEBHOOK_SECRET)) return json({ ok: false }, 401);
  const payload = await request.json();
  const event = normalizeTruviWebhook(payload);
  if (!event.verificationId && !event.externalReference) return json({ ok: false }, 400);

  const duplicate = await eventSeen(env, "truvi", event.eventId);
  if (duplicate) return json({ ok: true, duplicate: true });
  const booking = event.externalReference
    ? await row(env, "SELECT * FROM booking_requests WHERE id=?", event.externalReference)
    : await row(env, "SELECT * FROM booking_requests WHERE verification_id=?", event.verificationId);
  if (!booking) return json({ ok: false }, 404);

  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE booking_requests SET verification_status=?,verification_report_url=COALESCE(NULLIF(?,''),verification_report_url),updated_at=? WHERE id=?")
    .bind(event.status, event.reportUrl, now, booking.id).run();

  if (["approved", "flagged"].includes(event.status) && ["verification_pending", "owner_review"].includes(booking.status)) {
    const token = randomToken();
    const expires = new Date(Date.now() + 48 * 3600000).toISOString();
    await env.DB.prepare("UPDATE booking_requests SET status='owner_review',owner_token_hash=?,owner_token_expires_at=?,updated_at=? WHERE id=?")
      .bind(await sha256(token), expires, now, booking.id).run();
    try {
      await sendOwnerReviewEmail({ ...booking, verification_status: event.status, verification_report_url: event.reportUrl }, token, env);
      await sendEmail(booking.email, "Identity verification received", `Thanks, ${booking.guest_name}. Your verified request is now awaiting owner review. No payment has been taken.`, env);
    } catch (error) {
      await forgetEvent(env, "truvi", event.eventId);
      throw error;
    }
  } else if (event.status === "rejected") {
    await env.DB.prepare("UPDATE booking_requests SET status='verification_rejected',updated_at=? WHERE id=?").bind(now, booking.id).run();
    try {
      await sendEmail(booking.email, "Unable to submit your stay request", "We could not complete the required guest verification, so the stay request was not sent for approval. No payment has been taken.", env);
    } catch (error) {
      await forgetEvent(env, "truvi", event.eventId);
      throw error;
    }
  }
  return json({ ok: true });
}

async function showOwnerReview(url, env) {
  const booking = await authorizedOwnerBooking(url.searchParams.get("id"), url.searchParams.get("token"), env);
  if (!booking) return html("<h1>This review link is invalid or expired.</h1>", 403);
  const report = booking.verification_report_url ? `<p><a href="${escapeHtml(booking.verification_report_url)}" rel="noreferrer">Open Truvi report</a></p>` : "";
  const heading = booking.verification_status === "not_enabled" ? "Review unverified request" : "Review verified request";
  return html(`<!doctype html><meta name="viewport" content="width=device-width"><title>Review booking</title><style>body{font:16px system-ui;max-width:680px;margin:40px auto;padding:20px;color:#17352d}button{padding:12px 20px;margin-right:12px}.reject{color:#8b1e1e}.warning{padding:12px;background:#fff2cc;border:1px solid #d6a600}</style><h1>${heading}</h1>${booking.verification_status === "not_enabled" ? '<p class="warning"><b>Identity verification is currently disabled.</b> Review this guest manually before approving.</p>' : ""}<p><b>${escapeHtml(booking.guest_name)}</b> · ${escapeHtml(booking.email)} · ${escapeHtml(booking.phone)}</p><p>${booking.arrival} to ${booking.departure} · ${booking.guests} guests · ${money(booking.quote_cents)}</p><p>Verification: <b>${escapeHtml(booking.verification_status)}</b></p>${report}<p>${escapeHtml(booking.message || "No message.")}</p><form method="post" action="/owner/decision"><input type="hidden" name="id" value="${booking.id}"><input type="hidden" name="token" value="${escapeHtml(url.searchParams.get("token"))}"><button name="decision" value="approve">Approve and send Stripe invoice</button><button class="reject" name="decision" value="reject">Reject</button></form>`);
}

async function ownerDecision(request, env) {
  const form = await request.formData();
  const booking = await authorizedOwnerBooking(form.get("id"), form.get("token"), env);
  if (!booking || booking.status !== "owner_review") return html("<h1>This request was already handled or the link expired.</h1>", 409);
  const decision = form.get("decision");
  const now = new Date().toISOString();
  if (decision === "reject") {
    await env.DB.prepare("UPDATE booking_requests SET status='rejected',owner_token_hash=NULL,updated_at=? WHERE id=? AND status='owner_review'").bind(now, booking.id).run();
    await sendEmail(booking.email, "Five Elements Smoky request update", "Thank you for your interest. The owner was unable to approve this stay request. No payment has been taken.", env);
    return html("<h1>Request rejected</h1><p>The guest has been notified.</p>");
  }
  if (decision !== "approve") return html("<h1>Invalid decision.</h1>", 400);

  const availability = await fetchAvailability(env);
  if (rangeBlocked(booking.arrival, booking.departure, availability.blockedDates || [])) return html("<h1>Dates are no longer available.</h1>", 409);
  const expires = new Date(Date.now() + Number(env.PAYMENT_WINDOW_HOURS || 24) * 3600000).toISOString();
  const claimed = await env.DB.prepare("UPDATE booking_requests SET status='invoice_creating',updated_at=? WHERE id=? AND status='owner_review'")
    .bind(now, booking.id).run();
  if (!claimed.meta.changes) return html("<h1>This request is already being handled.</h1>", 409);

  try {
    await reservePaymentNights(booking, expires, env);
  } catch (error) {
    await env.DB.prepare("UPDATE booking_requests SET status='owner_review',updated_at=? WHERE id=? AND status='invoice_creating'").bind(now, booking.id).run();
    return html("<h1>An overlapping request is already awaiting payment.</h1>", 409);
  }

  let invoice;
  try {
    invoice = await createStripeInvoice(booking, env);
  } catch (error) {
    await releasePaymentNights(booking.id, env);
    await env.DB.prepare("UPDATE booking_requests SET status='owner_review',last_error=?,updated_at=? WHERE id=? AND status='invoice_creating'")
      .bind(String(error.message || error), now, booking.id).run();
    throw error;
  }

  await env.DB.prepare("UPDATE booking_requests SET status='awaiting_payment',stripe_customer_id=?,stripe_invoice_id=?,payment_expires_at=?,owner_token_hash=NULL,updated_at=? WHERE id=? AND status='invoice_creating'")
    .bind(invoice.customer, invoice.id, expires, now, booking.id).run();
  return html("<h1>Approved</h1><p>Stripe has emailed the guest a secure invoice. Dates will be blocked only after confirmed payment.</p>");
}

async function handleStripeWebhook(request, env) {
  const raw = await request.text();
  if (!await verifyStripeSignature(raw, request.headers.get("stripe-signature") || "", env.STRIPE_WEBHOOK_SECRET)) return json({ ok: false }, 401);
  const event = JSON.parse(raw);
  if (await eventSeen(env, "stripe", event.id)) return json({ received: true, duplicate: true });
  if (event.type !== "invoice.paid") return json({ received: true, ignored: true });

  const invoice = event.data.object;
  const booking = await row(env, "SELECT * FROM booking_requests WHERE stripe_invoice_id=?", invoice.id);
  if (!booking || booking.status === "paid") return json({ received: true });
  if (booking.status === "refund_required") {
    try {
      await refundInvoice(invoice, booking, env);
      await env.DB.prepare("UPDATE booking_requests SET status='refunded_conflict',updated_at=? WHERE id=?")
        .bind(new Date().toISOString(), booking.id).run();
      await releasePaymentNights(booking.id, env);
      await Promise.allSettled([
        sendEmail(booking.email, "Booking payment refunded", "We could not safely block the requested dates. Your payment has been refunded automatically.", env),
        sendEmail(env.OWNER_EMAIL, "Direct booking refund completed", `${booking.id}: the previously failed automatic refund has now completed.`, env),
      ]);
      return json({ received: true, status: "refunded_conflict" });
    } catch (error) {
      await forgetEvent(env, "stripe", event.id);
      throw error;
    }
  }
  const claimed = await env.DB.prepare("UPDATE booking_requests SET status='payment_processing',updated_at=? WHERE id=? AND status='awaiting_payment'")
    .bind(new Date().toISOString(), booking.id).run();
  if (!claimed.meta.changes) return json({ received: true });

  try {
    const calendar = await createCalendarHold(booking, env);
    await env.DB.prepare("UPDATE booking_requests SET status='paid',calendar_event_id=?,updated_at=? WHERE id=?")
      .bind(calendar.eventId, new Date().toISOString(), booking.id).run();
    await releasePaymentNights(booking.id, env);
  } catch (error) {
    try {
      await refundInvoice(invoice, booking, env);
    } catch (refundError) {
      await env.DB.prepare("UPDATE booking_requests SET status='refund_required',last_error=?,updated_at=? WHERE id=?")
        .bind(String(refundError.message || refundError), new Date().toISOString(), booking.id).run();
      await forgetEvent(env, "stripe", event.id);
      throw refundError;
    }
    await env.DB.prepare("UPDATE booking_requests SET status='refunded_conflict',last_error=?,updated_at=? WHERE id=?")
      .bind(String(error.message || error), new Date().toISOString(), booking.id).run();
    await releasePaymentNights(booking.id, env);
    await Promise.allSettled([
      sendEmail(booking.email, "Booking payment refunded", "The dates became unavailable while payment was completing. Your payment has been refunded automatically.", env),
      sendEmail(env.OWNER_EMAIL, "Direct booking conflict refunded", `${booking.id}: ${String(error.message || error)}`, env),
    ]);
    return json({ received: true, status: "refunded_conflict" });
  }

  // Email delivery must never undo a successfully paid and calendar-blocked booking.
  const notices = await Promise.allSettled([
    sendEmail(booking.email, "Five Elements Smoky booking confirmed", `Your payment was received and your stay from ${booking.arrival} to ${booking.departure} is confirmed. Booking reference: ${booking.id}`, env),
    sendEmail(env.OWNER_EMAIL, "Paid direct booking confirmed", `${booking.guest_name} paid for ${booking.arrival} to ${booking.departure}. The calendar is blocked. Reference: ${booking.id}`, env),
  ]);
  notices.filter((notice) => notice.status === "rejected").forEach((notice) => console.error("Confirmation email failed", notice.reason));
  return json({ received: true });
}

async function createStripeInvoice(booking, env) {
  const customer = await stripe("customers", { email: booking.email, name: booking.guest_name, phone: booking.phone, "metadata[booking_id]": booking.id }, env);
  await stripe("invoiceitems", { customer: customer.id, amount: booking.quote_cents, currency: "usd", description: `Five Elements Smoky stay: ${booking.arrival} to ${booking.departure}`, "metadata[booking_id]": booking.id }, env);
  const invoice = await stripe("invoices", { customer: customer.id, collection_method: "send_invoice", days_until_due: "1", description: `Booking ${booking.id}`, "metadata[booking_id]": booking.id, auto_advance: "true" }, env);
  const finalized = await stripe(`invoices/${invoice.id}/finalize`, {}, env);
  await stripe(`invoices/${invoice.id}/send`, {}, env);
  return finalized;
}

async function refundInvoice(invoice, booking, env) {
  const paymentIntent = invoice.payment_intent || invoice.payments?.data?.find((item) => item.payment?.payment_intent)?.payment?.payment_intent;
  const charge = invoice.charge || invoice.payments?.data?.find((item) => item.payment?.charge)?.payment?.charge;
  if (!paymentIntent && !charge) throw new Error("Calendar failed and Stripe did not provide a refundable payment reference.");
  return stripe("refunds", { ...(paymentIntent ? { payment_intent: paymentIntent } : { charge }), "metadata[booking_id]": booking.id }, env);
}

async function stripe(path, params, env) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, { method: "POST", headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `Stripe returned ${response.status}.`);
  return data;
}

async function createCalendarHold(booking, env) {
  const response = await fetch(env.CALENDAR_API_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "createPaidCalendarHold", token: env.CALENDAR_COMMAND_TOKEN, bookingId: booking.id, arrival: booking.arrival, departure: booking.departure, guestName: booking.guest_name, email: booking.email }) });
  const data = await response.json();
  if (!data.ok) throw new Error(data.message || "Calendar hold failed.");
  return data;
}

async function sendOwnerReviewEmail(booking, token, env) {
  const url = `${env.PUBLIC_API_URL}/owner/review?id=${encodeURIComponent(booking.id)}&token=${encodeURIComponent(token)}`;
  const isUnverified = booking.verification_status === "not_enabled";
  const verificationLine = isUnverified
    ? "Identity verification is currently disabled. This guest has NOT been verified."
    : `${booking.guest_name} completed guest verification (${booking.verification_status}).`;
  const body = `${verificationLine}\n\nGuest: ${booking.guest_name}\nEmail: ${booking.email}\nPhone: ${booking.phone}\n${booking.arrival} to ${booking.departure}\n${booking.guests} guests\n${money(booking.quote_cents)}\n\nReview and decide: ${url}\n\nOpening this link does not approve or reject the request.`;
  const subject = `${isUnverified ? "Unverified" : "Verified"} stay request: ${booking.arrival} to ${booking.departure}`;
  return sendEmail(env.OWNER_EMAIL, subject, body, env);
}

async function sendEmail(to, subject, text, env) {
  if ((env.EMAIL_PROVIDER || "apps_script") === "apps_script") {
    const response = await fetch(env.CALENDAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "sendBookingEmail",
        token: env.CALENDAR_COMMAND_TOKEN,
        to,
        subject,
        body: text,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.message || `Apps Script email delivery returned ${response.status}.`);
    return;
  }

  if (env.EMAIL_PROVIDER !== "resend") throw new Error("EMAIL_PROVIDER must be apps_script or resend.");
  const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "User-Agent": "five-elements-bookings/1.0" }, body: JSON.stringify({ from: env.FROM_EMAIL, to: [to], subject, text }) });
  if (!response.ok) throw new Error(`Email delivery returned ${response.status}.`);
}

async function calculateQuote(arrival, departure, pets, env) {
  const response = await fetch(env.PRICE_CALENDAR_URL);
  const source = await response.text();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (!response.ok || start < 0 || end <= start) throw new Error("Price calendar could not be loaded.");
  const rates = JSON.parse(source.slice(start, end + 1));
  let nightly = 0;
  for (const date of dateRange(arrival, departure)) {
    if (!Number.isFinite(rates[date])) throw new Error(`No nightly rate is configured for ${date}.`);
    nightly += Math.round(rates[date] * 100);
  }
  const subtotal = nightly + Number(env.CLEANING_FEE_CENTS) + (pets ? Number(env.PET_FEE_CENTS) : 0);
  return subtotal + Math.round(subtotal * Number(env.STR_TAX_RATE));
}

async function proxyAvailability(env) { return json(await fetchAvailability(env)); }
async function fetchAvailability(env) {
  const response = await fetch(`${env.CALENDAR_API_URL}?action=availability`);
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error("Availability could not be loaded.");
  return data;
}

function validateRequest(body, env) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.arrival || "") || !/^\d{4}-\d{2}-\d{2}$/.test(body.departure || "") || body.departure <= body.arrival) throw new Error("Choose valid dates.");
  if (dateRange(body.arrival, body.departure).length < Number(env.MIN_NIGHTS || 3)) throw new Error("The minimum stay is three nights.");
  const counts = [body.adults, body.teens, body.children].map(Number);
  if (counts.some((count) => !Number.isInteger(count) || count < 0 || count > 12)) throw new Error("Guest counts are invalid.");
  const guests = counts.reduce((total, count) => total + count, 0);
  if (guests !== Number(body.guests) || guests < 1 || guests > 12) throw new Error("Choose between 1 and 12 guests.");
  if (!String(body.guestName || "").trim() || !/^\S+@\S+\.\S+$/.test(body.email || "") || !String(body.phone || "").trim()) throw new Error("Name, email, and phone are required.");
  if (env.VERIFICATION_MODE === "truvi" && body.screeningConsent !== true) throw new Error("Guest screening consent is required.");
}

async function verifyTurnstile(token, ip, env) {
  if (!env.TURNSTILE_SECRET_KEY) throw new Error("Turnstile is not configured.");
  const body = new FormData(); body.set("secret", env.TURNSTILE_SECRET_KEY); body.set("response", token || ""); if (ip) body.set("remoteip", ip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const result = await response.json();
  if (!result.success) throw new Error("Security check failed. Please try again.");
}

async function authorizedOwnerBooking(id, token, env) {
  if (!id || !token) return null;
  const booking = await row(env, "SELECT * FROM booking_requests WHERE id=?", id);
  if (!booking || !booking.owner_token_hash || booking.owner_token_expires_at < new Date().toISOString()) return null;
  return safeEqual(await sha256(token), booking.owner_token_hash) ? booking : null;
}

async function reservePaymentNights(booking, expires, env) {
  await env.DB.prepare("DELETE FROM payment_holds WHERE expires_at<=?").bind(new Date().toISOString()).run();
  const statements = dateRange(booking.arrival, booking.departure).map((night) =>
    env.DB.prepare("INSERT INTO payment_holds(night,booking_id,expires_at) VALUES(?,?,?)").bind(night, booking.id, expires));
  await env.DB.batch(statements);
}

async function releasePaymentNights(bookingId, env) {
  await env.DB.prepare("DELETE FROM payment_holds WHERE booking_id=?").bind(bookingId).run();
}

async function eventSeen(env, provider, eventId) {
  const result = await env.DB.prepare("INSERT OR IGNORE INTO processed_events(provider,event_id,processed_at) VALUES(?,?,?)").bind(provider, eventId, new Date().toISOString()).run();
  return result.meta.changes === 0;
}

async function forgetEvent(env, provider, eventId) {
  await env.DB.prepare("DELETE FROM processed_events WHERE provider=? AND event_id=?").bind(provider, eventId).run();
}

async function verifyStripeSignature(payload, header, secret) {
  if (!secret) return false;
  const pieces = Object.fromEntries(header.split(",").map((part) => part.split("=", 2)));
  const timestamp = Number(pieces.t);
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${payload}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return safeEqual(signature, pieces.v1 || "");
}

function requireAllowedOrigin(request, env) { if (request.headers.get("origin") !== env.ALLOWED_ORIGIN) throw new Error("Origin is not allowed."); }
function cors(response, request, env) { const headers = new Headers(response.headers); const origin = request.headers.get("origin"); if (origin === env.ALLOWED_ORIGIN) { headers.set("Access-Control-Allow-Origin", origin); headers.set("Vary", "Origin"); headers.set("Access-Control-Allow-Headers", "Content-Type"); headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS"); } headers.set("X-Content-Type-Options", "nosniff"); headers.set("Referrer-Policy", "no-referrer"); return new Response(response.body, { status: response.status, headers }); }
function rangeBlocked(arrival, departure, blocked) { const set = new Set(blocked); return dateRange(arrival, departure).some((date) => set.has(date)); }
function dateRange(start, end) { const dates = []; for (let date = new Date(`${start}T00:00:00Z`); date < new Date(`${end}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1)) dates.push(date.toISOString().slice(0, 10)); return dates; }
function clean(value, max) { return String(value || "").trim().slice(0, max); }
function randomToken() { const bytes = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
async function sha256(value) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function safeEqual(a, b) { if (!a || a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
async function row(env, sql, ...values) { return env.DB.prepare(sql).bind(...values).first(); }
function money(cents) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); }
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS }); }
function html(value, status = 200) { return new Response(value, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } }); }
function escapeHtml(value) { return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }

export { dateRange, rangeBlocked, verifyStripeSignature };
