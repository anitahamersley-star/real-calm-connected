/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { defineSecret } = require("firebase-functions/params");

const sploseApiKey = defineSecret("SPLOSE_API_KEY");

if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();

/**
 * getClientAppointments
 *
 * Returns upcoming appointments for the logged-in client, based on a Splose patientId.
 * You can either:
 *  - store splosePatientId in Firestore under users/{uid}.splosePatientId, OR
 *  - pass patientId from the front-end in data.patientId
 */
exports.getClientAppointments = onCall(
    { secrets: [sploseApiKey] },
    async (request) => {
        const data = request.data;
        const context = request.auth;

        console.log(
            "getClientAppointments called. auth uid:",
            context && context.uid,
            "data.uid:",
            data.uid
        );

        // Extra debug logging to help diagnose missing uid issues
        try {
            console.log("context (serialized):", JSON.stringify(context || {}));
        } catch (e) {
            console.log("context (raw):", context);
        }
        try {
            console.log("data (serialized):", JSON.stringify(data || {}));
        } catch (e) {
            console.log("data (raw):", data);
        }

        // Determine uid securely. Prefer request.auth, otherwise verify the
        // incoming Authorization header ID token server-side using Admin SDK.
        let uid = context?.uid || null;

        if (!uid) {
            // Try to pull the Authorization header from the raw HTTP request
            try {
                const rawReq = request.rawRequest;
                const headers = rawReq && rawReq.headers;
                const authHeader = headers && (headers.authorization || headers.Authorization);

                if (authHeader && typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
                    const idToken = authHeader.split("Bearer ")[1].trim();
                    if (idToken) {
                        try {
                            const verified = await admin.auth().verifyIdToken(idToken);
                            if (verified && verified.uid) {
                                uid = verified.uid;
                                console.log("Verified idToken fallback; uid:", uid);
                            }
                        } catch (verifyErr) {
                            console.error("Failed to verify id token fallback:", verifyErr && verifyErr.toString());
                        }
                    }
                }
            } catch (e) {
                console.error("Error extracting Authorization header from rawRequest:", e && e.toString());
            }
        }

        // Do not trust client-provided `data.uid` unless it matches a verified token.
        if (!uid) {
            console.error("No uid found after context.auth and Authorization header verification");
            throw new HttpsError(
                "unauthenticated",
                "You must be logged in to view appointments."
            );
        }

        console.log("Using uid:", uid);

        // 1) Try to get Splose patientId from Firestore
        let splosePatientId = data.patientId || null;

        if (!splosePatientId) {
            // Try lookup by uid first
            let userDoc = await db.collection("clients").doc(uid).get();
            console.log("Looking up clients by uid:", uid, "exists:", userDoc.exists);

            if (userDoc.exists) {
                splosePatientId = userDoc.get("splosePatientId") || null;
                console.log("Found splosePatientId by uid:", splosePatientId);
            } else {
                // Try lookup by email if uid didn't work
                console.log("Uid lookup failed, trying by email:", context?.email);
                const snap = await db.collection("clients")
                    .where("email", "==", context?.email)
                    .limit(1)
                    .get();
                if (!snap.empty) {
                    userDoc = snap.docs[0];
                    splosePatientId = userDoc.get("splosePatientId") || null;
                    console.log("Found splosePatientId by email:", splosePatientId);
                } else {
                    console.log("No client found for uid:", uid, "or email:", context?.email);
                }
            }
        }

        if (!splosePatientId) {
            throw new HttpsError(
                "failed-precondition",
                "No Splose patientId is configured for this user."
            );
        }

        const token = sploseApiKey.value();
        if (!token) {
            throw new HttpsError(
                "internal",
                "Splose API key is not configured."
            );
        }

        // 2) Build query: patientId + only future appointments (start_gt = now)
        const nowIso = new Date().toISOString();
        const params = new URLSearchParams({
            patientId: String(splosePatientId),
            start_gt: nowIso,
            include_archived: "false",
        });

        const url = `https://api.splose.com/v1/appointments?${params.toString()}`;

        try {
            const response = await fetch(url, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
            });

            if (!response.ok) {
                const text = await response.text();
                console.error("Splose API error:", response.status, text);
                throw new HttpsError(
                    "internal",
                    "Error fetching appointments from Splose."
                );
            }

            const json = await response.json();

            // Extract appointments from Splose
            const rawAppointments = Array.isArray(json.data) ? json.data : [];

            const appointments = rawAppointments.map((appt) => {
                const firstPatient = (appt.appointmentPatients || [])[0] || {};
                return {
                    id: appt.id,
                    start: appt.start,
                    end: appt.end,
                    isUnavailableBlock: appt.isUnavailableBlock,
                    pricing: appt.pricing,
                    total: appt.total,
                    status: firstPatient.status || null,
                    cancellationReason: firstPatient.cancellationReason || null,
                    cancellationRate: firstPatient.cancellationRate || null,
                    note: appt.note || "",
                    // ➜ NEW: include location & practitioner so we can use them!
                    location: appt.location || null,
                    practitioner: appt.practitioner || null,
                };
            });

            // ⭐️ LOG HERE — right after mapping
            console.log(
                "Splose appointments for",
                context.auth.uid,
                JSON.stringify(appointments, null, 2)
            );

            appointments.sort((a, b) => new Date(a.start) - new Date(b.start));

            return { appointments };

        } catch (err) {
            console.error("Unexpected error from Splose:", err);
            throw new HttpsError(
                "internal",
                "Unexpected error fetching appointments."
            );
        }
    });

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
setGlobalOptions({ maxInstances: 10 });

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

