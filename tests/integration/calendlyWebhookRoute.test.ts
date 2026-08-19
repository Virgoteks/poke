import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { env } from "../../src/config/env.js";
import { truncateAll } from "../helpers/db.js";

function signedHeader(body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac("sha256", env.CALENDLY_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

async function makeContact(email: string): Promise<string> {
  const company = await pool.query<{ id: string }>(
    `INSERT INTO companies (google_place_id, name) VALUES ($1, 'Calendly Route Co') RETURNING id`,
    [`place-${Math.random()}`],
  );
  const contact = await pool.query<{ id: string }>(
    `INSERT INTO contacts (company_id, email, email_normalized, verification_status)
     VALUES ($1, $2, $3, 'valid') RETURNING id`,
    [company.rows[0]!.id, email, email.toLowerCase()],
  );
  return contact.rows[0]!.id;
}

const app = createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closePool();
  await closeRedis();
});

describe("POST /webhooks/calendly", () => {
  it("rejects a request with no signature header", async () => {
    const body = JSON.stringify({
      event: "invitee.created",
      payload: { uri: "u1", scheduled_event: { uri: "e1" } },
    });
    const res = await request(app).post("/webhooks/calendly").set("Content-Type", "application/json").send(body);
    expect(res.status).toBe(401);
  });

  it("rejects a request with an invalid signature", async () => {
    const body = JSON.stringify({
      event: "invitee.created",
      payload: { uri: "u1", scheduled_event: { uri: "e1" } },
    });
    const res = await request(app)
      .post("/webhooks/calendly")
      .set("Content-Type", "application/json")
      .set("calendly-webhook-signature", "t=1,v1=deadbeef")
      .send(body);
    expect(res.status).toBe(401);
  });

  it("processes a validly signed invitee.created event and creates a booking", async () => {
    const contactId = await makeContact("route-booker@calendly-route.example.com");
    const body = JSON.stringify({
      event: "invitee.created",
      payload: {
        uri: "https://api.calendly.com/scheduled_events/route-evt/invitees/route-inv",
        email: "route-booker@calendly-route.example.com",
        name: "Route Booker",
        scheduled_event: {
          uri: "https://api.calendly.com/scheduled_events/route-evt",
          start_time: "2026-09-05T16:00:00.000000Z",
        },
        tracking: { utm_content: contactId },
      },
    });

    const res = await request(app)
      .post("/webhooks/calendly")
      .set("Content-Type", "application/json")
      .set("calendly-webhook-signature", signedHeader(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("processed");
    expect(res.body.contactId).toBe(contactId);

    const booking = await pool.query("SELECT status FROM bookings WHERE contact_id = $1", [contactId]);
    expect(booking.rows[0].status).toBe("scheduled");
  });

  it("tolerates duplicate delivery of the same event", async () => {
    const contactId = await makeContact("dup-route@calendly-route.example.com");
    const body = JSON.stringify({
      event: "invitee.created",
      payload: {
        uri: "https://api.calendly.com/scheduled_events/dup-evt/invitees/dup-inv",
        email: "dup-route@calendly-route.example.com",
        scheduled_event: { uri: "https://api.calendly.com/scheduled_events/dup-evt" },
        tracking: { utm_content: contactId },
      },
    });

    const first = await request(app)
      .post("/webhooks/calendly")
      .set("Content-Type", "application/json")
      .set("calendly-webhook-signature", signedHeader(body))
      .send(body);
    const second = await request(app)
      .post("/webhooks/calendly")
      .set("Content-Type", "application/json")
      .set("calendly-webhook-signature", signedHeader(body))
      .send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("duplicate");

    const bookings = await pool.query("SELECT count(*)::int AS count FROM bookings WHERE contact_id = $1", [
      contactId,
    ]);
    expect(bookings.rows[0].count).toBe(1);
  });
});

describe("GET /booking/scheduling-link", () => {
  it("rejects requests without a valid internal API key", async () => {
    const res = await request(app).get("/booking/scheduling-link?contactId=00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown contact", async () => {
    const res = await request(app)
      .get("/booking/scheduling-link?contactId=00000000-0000-0000-0000-000000000000")
      .set("x-internal-api-key", env.INTERNAL_API_KEY);
    expect(res.status).toBe(404);
  });

  it("returns a booking link carrying the contactId via the mocked Calendly client", async () => {
    const contactId = await makeContact("link@calendly-route.example.com");
    const res = await request(app)
      .get(`/booking/scheduling-link?contactId=${contactId}`)
      .set("x-internal-api-key", env.INTERNAL_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.bookingUrl).toContain(`utm_content=${contactId}`);
  });
});
