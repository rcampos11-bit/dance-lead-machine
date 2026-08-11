// ============================================================
// Setmore API integration — real calendar availability and
// real appointment booking. Uses OAuth refresh-token flow:
// exchange the long-lived refresh token for a short-lived
// access token before each batch of calls (access tokens
// expire, so we don't cache them across requests for now).
// ============================================================

const TOKEN_URL = "https://developer.setmore.com/api/v1/o/oauth2/token";
const API_BASE = "https://developer.setmore.com/api/v1/bookingapi";

async function getAccessToken(refreshToken, fetchImpl = fetch) {
  if (!refreshToken) throw new Error("Missing SETMORE_REFRESH_TOKEN.");
  const res = await fetchImpl(`${TOKEN_URL}?refreshToken=${encodeURIComponent(refreshToken)}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Setmore token exchange failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  const token = data?.data?.token?.access_token || data?.access_token;
  if (!token) throw new Error("Setmore token exchange succeeded but no access_token was found in the response.");
  return token;
}

async function setmoreGet(path, accessToken, fetchImpl = fetch) {
  const res = await fetchImpl(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Setmore GET ${path} failed (${res.status}): ${JSON.stringify(data)}`);
  return data;
}

async function setmorePost(path, body, accessToken, fetchImpl = fetch) {
  const res = await fetchImpl(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Setmore POST ${path} failed (${res.status}): ${JSON.stringify(data)}`);
  return data;
}

async function listStaff(refreshToken, fetchImpl = fetch) {
  const token = await getAccessToken(refreshToken, fetchImpl);
  const data = await setmoreGet("/staffs", token, fetchImpl);
  return data?.data?.staffs || data?.data || [];
}

async function listServices(refreshToken, fetchImpl = fetch) {
  const token = await getAccessToken(refreshToken, fetchImpl);
  const data = await setmoreGet("/services", token, fetchImpl);
  return data?.data?.services || data?.data || [];
}

async function getAvailableSlots({ refreshToken, staffKey, serviceKey, selectedDate }, fetchImpl = fetch) {
  const token = await getAccessToken(refreshToken, fetchImpl);
  const q = new URLSearchParams({ staff_key: staffKey, service_key: serviceKey, selected_date: selectedDate });
  const data = await setmoreGet(`/slots?${q.toString()}`, token, fetchImpl);
  return data?.data?.slots || [];
}

async function findOrCreateCustomer({ refreshToken, name, email, phone }, fetchImpl = fetch) {
  const token = await getAccessToken(refreshToken, fetchImpl);
  if (email) {
    const q = new URLSearchParams({ email });
    const existing = await setmoreGet(`/customer?${q.toString()}`, token, fetchImpl).catch(() => null);
    const found = existing?.data?.[0] || existing?.data?.customer?.[0];
    if (found?.key) return found.key;
  }
  const created = await setmorePost(
    "/customer/create",
    { first_name: name || "Website Lead", email: email || undefined, cell_phone: phone || undefined },
    token,
    fetchImpl
  );
  const key = created?.data?.customer?.key || created?.data?.key;
  if (!key) throw new Error("Setmore customer creation did not return a customer key.");
  return key;
}

async function bookAppointment({ refreshToken, staffKey, serviceKey, customerKey, startTime, endTime }, fetchImpl = fetch) {
  const token = await getAccessToken(refreshToken, fetchImpl);
  const data = await setmorePost(
    "/appointment/create",
    { staff_key: staffKey, service_key: serviceKey, customer_key: customerKey, start_time: startTime, end_time: endTime },
    token,
    fetchImpl
  );
  return data?.data?.appointment || data;
}

module.exports = { getAccessToken, listStaff, listServices, getAvailableSlots, findOrCreateCustomer, bookAppointment };
